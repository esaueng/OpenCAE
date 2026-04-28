import { afterEach, describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project, RunEvent, Study } from "@opencae/schema";
import { addLoad, addSupport, assignMaterial, createProject, generateMesh, getResults, importLocalProject, loadSampleProject, renameProject, runSimulation, subscribeToRun, updateStudy, uploadModel } from "./api";

const TestFile = globalThis.File ?? class extends Blob {
  name: string;
  lastModified: number;
  webkitRelativePath = "";

  constructor(bits: BlobPart[], name: string, options?: FilePropertyBag) {
    super(bits, options);
    this.name = name;
    this.lastModified = options?.lastModified ?? Date.now();
  }
};

const project = {
  id: "project-1",
  name: "Uploaded Project",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [{
    id: "geometry-1",
    projectId: "project-1",
    filename: "uploaded-bracket.stl",
    localPath: "uploads/uploaded-bracket.stl",
    artifactKey: "project-1/geometry/uploaded-display.json",
    status: "ready",
    metadata: { source: "local-upload" }
  }],
  studies: [],
  createdAt: "2026-04-24T12:00:00.000Z",
  updatedAt: "2026-04-24T12:00:00.000Z"
} satisfies Project;

const displayModel = {
  id: "display-1",
  name: "Display",
  bodyCount: 0,
  faces: []
} satisfies DisplayModel;

const study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
  materialAssignments: [],
  namedSelections: [{
    id: "selection-body-1",
    name: "Imported body",
    entityType: "body",
    geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
    fingerprint: "body-1"
  }],
  contacts: [],
  constraints: [],
  loads: [],
  meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: {},
  validation: [],
  runs: []
} satisfies Study;

const sizedAsciiStl = `
solid tray
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 268.8 0 0
vertex 0 289.9 246.05
endloop
endfacet
endsolid tray
`;

describe("api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("keeps uploaded model bytes on the project returned from upload", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ project, displayModel, message: "Uploaded." }), {
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = new TestFile([new Uint8Array([1, 2, 3])], "uploaded-bracket.stl", { type: "model/stl" });
    const response = await uploadModel("project-1", file);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const requestBody = JSON.parse(requestInit?.body as string) as Record<string, unknown>;
    const expectedEmbeddedModel = {
      filename: "uploaded-bracket.stl",
      contentType: "model/stl",
      size: 3,
      contentBase64: "AQID"
    };

    expect(requestBody).toEqual(expectedEmbeddedModel);
    expect(response.project.geometryFiles[0]?.metadata.embeddedModel).toEqual(expectedEmbeddedModel);
  });

  test("uploads a model locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("NetworkError when attempting to fetch resource."))));

    const file = new TestFile([sizedAsciiStl], "seed-tray.stl", { type: "model/stl" });
    const response = await uploadModel("project-1", file, project);

    expect(response.project.geometryFiles[0]?.filename).toBe("seed-tray.stl");
    expect(response.project.geometryFiles[0]?.metadata.previewFormat).toBe("stl");
    expect(response.project.geometryFiles[0]?.metadata.embeddedModel).toMatchObject({
      filename: "seed-tray.stl",
      contentType: "model/stl",
      size: sizedAsciiStl.length
    });
    expect(response.displayModel.visualMesh?.filename).toBe("seed-tray.stl");
    expect(response.displayModel.dimensions).toEqual({ x: 268.8, y: 246.1, z: 289.9, units: "mm" });
    expect(response.message).toContain("Previewing the uploaded mesh");
  });

  test("uploads STEP locally without placeholder dimensions before browser measurement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("NetworkError when attempting to fetch resource."))));

    const file = new TestFile(["ISO-10303-21"], "seed-tray.step", { type: "model/step" });
    const response = await uploadModel("project-1", file, project);

    expect(response.project.geometryFiles[0]?.filename).toBe("seed-tray.step");
    expect(response.project.geometryFiles[0]?.metadata.previewFormat).toBe("step");
    expect(response.displayModel.nativeCad?.filename).toBe("seed-tray.step");
    expect(response.displayModel.dimensions).toBeUndefined();
    expect(response.message).toContain("Previewing a selectable STEP import body");
  });

  test("loads the sample project locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await loadSampleProject("bracket");

    expect(response.project.name).toBe("Bracket Demo");
    expect(response.displayModel.name).toBe("bracket demo body");
    expect(response.message).toBe("Bracket Demo loaded.");
  });

  test("loads the beam sample locally with a payload mass sitting on the free end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await loadSampleProject("plate");
    const load = response.project.studies[0]?.loads[0];

    expect(response.project.name).toBe("Beam Demo");
    expect(response.project.geometryFiles[0]?.filename).toBe("end-loaded-beam.step");
    expect(response.displayModel.name).toBe("end loaded beam assembly");
    expect(response.displayModel.faces.map((face) => face.label)).toEqual([
      "Fixed end face",
      "End payload mass",
      "Beam top face",
      "Beam body"
    ]);
    expect(response.displayModel.faces[0]?.center).toEqual([-1.9, 0.14, 0]);
    expect(load).toMatchObject({
      type: "gravity",
      selectionRef: "selection-load-face",
      parameters: {
        value: 0.497664,
        units: "kg",
        direction: [0, 0, -1],
        applicationPoint: [1.48, 0.49, 0],
        payloadMaterialId: "payload-aluminum-6061",
        payloadVolumeM3: 0.00018432,
        payloadMassMode: "material",
        payloadObject: {
          id: "payload-display-plate",
          label: "end payload mass",
          center: [1.48, 0.49, 0],
          volumeM3: 0.00018432,
          volumeSource: "bounds-fallback",
          volumeStatus: "estimated"
        }
      }
    });
  });

  test("creates a blank project locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));

    const response = await createProject();

    expect(response.project.name).toBe("Untitled Project");
    expect(response.project.geometryFiles).toHaveLength(0);
    expect(response.displayModel.name).toBe("No model loaded");
  });

  test("renames a project locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await renameProject("project-1", "Fixture Analysis", project);

    expect(response.project.name).toBe("Fixture Analysis");
    expect(response.project.id).toBe("project-1");
    expect(response.project.studies).toBe(project.studies);
    expect(response.project.updatedAt).not.toBe(project.updatedAt);
    expect(response.message).toBe("Project renamed locally.");
  });

  test("assigns material locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await assignMaterial("study-1", "mat-pla", { printed: true, infillDensity: 35 }, study);

    expect(response.study.materialAssignments).toEqual([{
      id: "assign-material-current",
      materialId: "mat-pla",
      selectionRef: "selection-body-1",
      parameters: { printed: true, infillDensity: 35 },
      status: "complete"
    }]);
    expect(response.message).toBe("Material assigned to Imported body.");
  });

  test("adds supports locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await addSupport("study-1", "selection-face-1", study);

    expect(response.study.constraints).toHaveLength(1);
    expect(response.study.constraints[0]).toMatchObject({
      type: "fixed",
      selectionRef: "selection-face-1",
      parameters: {},
      status: "complete"
    });
    expect(response.message).toBe("Fixed support added.");
  });

  test("adds loads locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await addLoad("study-1", "force", 500, "selection-face-1", [0, 0, -1], [1, 2, 3], null, study);

    expect(response.study.loads).toHaveLength(1);
    expect(response.study.loads[0]).toMatchObject({
      type: "force",
      selectionRef: "selection-face-1",
      parameters: { value: 500, units: "N", direction: [0, 0, -1], applicationPoint: [1, 2, 3] },
      status: "complete"
    });
    expect(response.message).toBe("Load added.");
  });

  test("adds payload material metadata locally while preserving value as mass", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await addLoad(
      "study-1",
      "gravity",
      2.7,
      "selection-face-1",
      [0, 0, -1],
      [1, 2, 3],
      { id: "payload-1", label: "Payload part", center: [1, 2, 3], volumeM3: 0.001, volumeSource: "mesh", volumeStatus: "available" },
      study,
      { payloadMaterialId: "payload-aluminum-6061", payloadVolumeM3: 0.001, payloadMassMode: "material" }
    );

    expect(response.study.loads[0]?.parameters).toMatchObject({
      value: 2.7,
      units: "kg",
      payloadMaterialId: "payload-aluminum-6061",
      payloadVolumeM3: 0.001,
      payloadMassMode: "material",
      payloadObject: {
        id: "payload-1",
        label: "Payload part",
        volumeM3: 0.001,
        volumeSource: "mesh",
        volumeStatus: "available"
      }
    });
  });

  test("generates mesh locally when the API does not know the restored study", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Study not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })));

    const response = await generateMesh("study-1", "fine", study);

    expect(response.study.meshSettings).toEqual({
      preset: "fine",
      status: "complete",
      meshRef: "project-1/mesh/mesh-summary.json",
      summary: {
        nodes: 88420,
        elements: 57102,
        warnings: ["Fine preset is mocked; no native mesher was run."]
      }
    });
    expect(response.message).toBe("Mesh generated locally.");
  });

  test("runs simulations locally when the API does not know the restored study", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Study not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })));
    const readyStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "fine", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" }
    } as Study;

    const response = await runSimulation("study-1", readyStudy);
    const completed = await new Promise<RunEvent>((resolve) => {
      const source = subscribeToRun(response.run.id, (event) => {
        if (event.type === "complete") {
          source.close();
          resolve(event);
        }
      });
    });
    const results = await getResults(response.run.id);

    expect(response.message).toBe("Simulation running locally.");
    expect(completed.progress).toBe(100);
    expect(results.fields.map((field) => field.runId)).toEqual([response.run.id, response.run.id, response.run.id]);
    expect(results.summary.maxStress).toBeGreaterThan(0);
  });

  test("updates studies locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await updateStudy("study-1", { constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }] }, "Support added.", study);

    expect(response.study.constraints).toHaveLength(1);
    expect(response.study.loads).toHaveLength(0);
    expect(response.message).toBe("Support added.");
  });

  test("opens a local project file without requiring the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const file = new TestFile([JSON.stringify({ project, displayModel })], "project.opencae.json", { type: "application/json" });

    const response = await importLocalProject(file);

    expect(response.project.name).toBe("Uploaded Project");
    expect(response.displayModel.name).toBe("Display");
    expect(response.message).toBe("Uploaded Project opened from local file.");
  });
});
