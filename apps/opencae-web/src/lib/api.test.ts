import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DisplayModel, Project, RunEvent, Study } from "@opencae/schema";
import { addLoad, addSupport, assignMaterial, cancelRun, createProject, dynamicOutputFrameEstimate, generateMesh, getResults, importLocalProject, loadSampleProject, renameProject, runSimulation, subscribeToRun, updateStudy, uploadModel } from "./api";

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

const coreDisplayModel = {
  ...displayModel,
  bodyCount: 1,
  dimensions: { x: 120, y: 40, z: 20, units: "mm" },
  faces: [
    { id: "selection-face-1", label: "Fixed", color: "#94a3b8", center: [0, 20, 10], normal: [-1, 0, 0], stressValue: 0 },
    { id: "selection-face-2", label: "Load", color: "#94a3b8", center: [120, 20, 10], normal: [1, 0, 0], stressValue: 0 }
  ]
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

const apiSource = readFileSync(resolve(__dirname, "api.ts"), "utf8");

describe("api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  test("requests and loads seeded dynamic sample projects locally", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const sample of ["bracket", "plate", "cantilever"] as const) {
      const response = await loadSampleProject(sample, "dynamic_structural");
      const requestInit = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1];
      const requestBody = JSON.parse(requestInit?.body as string) as Record<string, unknown>;

      expect(requestBody).toEqual({ sample, analysisType: "dynamic_structural" });
      expect(response.project.studies[0]?.type).toBe("dynamic_structural");
      expect(response.project.studies[0]?.loads[0]?.parameters.direction).toEqual([0, -1, 0]);
      expect(response.project.studies[0]?.runs[0]?.id).toBe(`run-${sample}-dynamic-seeded`);
      expect(response.results).toBeUndefined();
    }
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
        direction: [0, -1, 0],
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

  test("loads the cantilever sample with markers anchored on the beam end faces", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await loadSampleProject("cantilever");
    const load = response.project.studies[0]?.loads[0];

    expect(response.project.name).toBe("Cantilever Demo");
    expect(response.displayModel.faces.find((face) => face.id === "face-base-left")?.center).toEqual([-1.9, 0.18, 0]);
    expect(response.displayModel.faces.find((face) => face.id === "face-load-top")?.center).toEqual([1.9, 0.18, 0]);
    expect(load).toMatchObject({
      type: "force",
      selectionRef: "selection-load-face",
      parameters: {
        value: 500,
        units: "N",
        direction: [0, -1, 0],
        applicationPoint: [1.9, 0.18, 0]
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
        analysisSampleCount: 19200,
        quality: "fine",
        warnings: ["Fine surface analysis sampling enabled for higher-quality local results."]
      }
    });
    expect(response.message).toBe("Mesh generated locally.");
  });

  test("runs explicit OpenCAE Core Local static solves without local estimate fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Study not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })));
    const readyStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "fine", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "opencae_core_local", fidelity: "standard" }
    } as unknown as Study;

    const response = await runSimulation("study-1", readyStudy, coreDisplayModel);
    const completed = await new Promise<RunEvent>((resolve) => {
      const source = subscribeToRun(response.run.id, (event) => {
        if (event.type === "complete") {
          source.close();
          resolve(event);
        }
      });
    });
    const results = await getResults(response.run.id);

    expect(response.message).toContain("OpenCAE Core Local");
    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-preview-tet4");
    expect(completed.progress).toBe(100);
    expect(results.fields.map((field) => field.runId)).toEqual([response.run.id, response.run.id, response.run.id]);
    expect(results.summary.provenance?.solver).toBe("opencae-core-preview-tet4");
    expect(results.summary.maxStress).toBeGreaterThanOrEqual(0);
  });

  test("does not route explicit local sample static solves through legacy beam estimates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Study not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })));
    const sample = await loadSampleProject("plate");
    const beamStudy = {
      ...sample.project.studies[0]!,
      solverSettings: { ...sample.project.studies[0]!.solverSettings, backend: "opencae_core_local" }
    } as Study;

    const response = await runSimulation(beamStudy.id, beamStudy, sample.displayModel);
    const terminal = await new Promise<RunEvent>((resolve) => {
      const source = subscribeToRun(response.run.id, (event) => {
        if (event.type === "complete" || event.type === "error") {
          source.close();
          resolve(event);
        }
      });
    });

    expect(terminal.progress).toBe(100);
    expect((response.run as { solverBackend?: string }).solverBackend).not.toBe("local-beam-demo-euler-bernoulli");
    expect(terminal.message).not.toContain("Euler-Bernoulli");
  });

  test("runs explicit local backend selections in browser OpenCAE Core without cloud route calls", async () => {
    const coreDisplayModel: DisplayModel = {
      ...displayModel,
      bodyCount: 1,
      dimensions: { x: 0.12, y: 0.04, z: 0.02, units: "m" }
    };
    const coreStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "opencae_core_local", fidelity: "ultra" }
    } as unknown as Study;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => Promise.reject(new TypeError("API unavailable")));
    vi.stubGlobal("fetch", fetchMock);
    const healthLogs: string[] = [];

    const response = await runSimulation("study-1", coreStudy, coreDisplayModel, { onRunStatus: (message) => healthLogs.push(message) });
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true), { timeout: 3000 });
    source.close();
    const results = await getResults(response.run.id);

    expect(healthLogs).toEqual([]);
    expect(response.streamUrl).toMatch(/^local:run-local-/);
    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-preview-tet4");
    expect(seen.map((event) => event.message).join(" ")).toContain("OpenCAE Core");
    expect(results.summary.provenance?.solver).toBe("opencae-core-preview-tet4");
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("/api/cloud-fea"))).toBe(true);
  });

  test("routes production cloud solves to OpenCAE Core Cloud without CalculiX payloads", async () => {
    const cloudStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "cloudflare_fea", fidelity: "ultra" }
    } as unknown as Study;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/cloud-core/runs/run-cloud-core/start") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      expect(String(input)).toBe("/api/cloud-core/runs");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        study: expect.objectContaining({ id: cloudStudy.id }),
        analysisType: "static_stress",
        solverSettings: expect.objectContaining({ backend: "opencae_core_cloud" }),
        coreVolumeMesh: null,
        geometry: expect.objectContaining({
          kind: "structured_block",
          descriptor: expect.objectContaining({
            length: 120,
            width: 20,
            height: 40
          })
        }),
        resultSettings: expect.any(Object)
      });
      expect(body.coreModel).toBeUndefined();
      expect(JSON.stringify(body).toLowerCase()).not.toMatch(/calculix|cloudflare-fea-calculix|\.inp|\.dat|\.frd/);
      return new Response(JSON.stringify({
        run: { id: "run-cloud-core", solverBackend: "opencae-core-cloud" },
        streamUrl: "/api/cloud-core/runs/run-cloud-core/events",
        startUrl: "/api/cloud-core/runs/run-cloud-core/start",
        message: "OpenCAE Core Cloud simulation running."
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await runSimulation("study-1", cloudStudy, coreDisplayModel);

    expect(response.message).toContain("OpenCAE Core Cloud");
    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-cloud");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("dispatches Bracket Demo geometry to OpenCAE Core Cloud for container meshing", async () => {
    const sample = await loadSampleProject("bracket");
    const bracketStudy = {
      ...sample.project.studies[0]!,
      solverSettings: { ...sample.project.studies[0]!.solverSettings, backend: "opencae_core_cloud" }
    } as Study;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/cloud-core/runs/run-cloud-core-bracket/start") {
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        analysisType: "static_stress",
        coreVolumeMesh: null,
        geometry: {
          kind: "sample_procedural",
          sampleId: "bracket",
          units: "mm",
          descriptor: expect.objectContaining({
            base: expect.any(Object),
            upright: expect.any(Object),
            gusset: expect.any(Object),
            holes: expect.any(Array),
            surfaces: expect.any(Object)
          })
        }
      });
      expect(body.coreModel).toBeUndefined();
      expect(JSON.stringify(body).toLowerCase()).not.toMatch(/local_estimate|computed_preview|calculix|display_bounds_proxy/);
      return new Response(JSON.stringify({
        run: { id: "run-cloud-core-bracket", solverBackend: "opencae-core-cloud" },
        streamUrl: "/api/cloud-core/runs/run-cloud-core-bracket/events",
        startUrl: "/api/cloud-core/runs/run-cloud-core-bracket/start",
        message: "OpenCAE Core Cloud simulation running."
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSimulation(bracketStudy.id, bracketStudy, sample.displayModel);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("sends dynamic solver settings to OpenCAE Core Cloud", async () => {
    const dynamicCloudStudy = {
      ...study,
      type: "dynamic_structural",
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: {
        backend: "opencae_core_cloud",
        fidelity: "ultra",
        startTime: 0,
        endTime: 0.5,
        timeStep: 0.002,
        outputInterval: 0.01,
        dampingRatio: 0.04,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "sinusoidal"
      }
    } as unknown as Study;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/cloud-core/runs/run-cloud-core-dynamic/start") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, { [key: string]: unknown }>;
      expect(body.solverSettings).toMatchObject({
        backend: "opencae_core_cloud",
        timeStep: 0.002,
        outputInterval: 0.01,
        dampingRatio: 0.04,
        loadProfile: "sinusoidal"
      });
      expect(body.coreModel).toBeUndefined();
      expect(body.geometry).toMatchObject({
        kind: "structured_block",
        descriptor: expect.objectContaining({
          length: 120,
          width: 20,
          height: 40
        })
      });
      return new Response(JSON.stringify({
        run: { id: "run-cloud-core-dynamic", solverBackend: "opencae-core-cloud" },
        streamUrl: "/api/cloud-core/runs/run-cloud-core-dynamic/events",
        startUrl: "/api/cloud-core/runs/run-cloud-core-dynamic/start",
        message: "OpenCAE Core Cloud simulation running."
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSimulation("study-1", dynamicCloudStudy, coreDisplayModel);

    expect(fetchMock).toHaveBeenCalledWith("/api/cloud-core/runs", expect.any(Object));
  });

  test("does not fall back to local estimates when OpenCAE Core Cloud fails", async () => {
    const cloudStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "opencae_core_cloud", fidelity: "ultra" }
    } as unknown as Study;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "container unavailable" }), {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" }
    })));

    await expect(runSimulation("study-1", cloudStudy, coreDisplayModel)).rejects.toThrow(
      "POST /api/cloud-core/runs failed with HTTP 503 Service Unavailable: container unavailable. No local estimate fallback was used."
    );
  });

  test("fails explicit local OpenCAE Core runs for complex geometry instead of falling back silently", async () => {
    const complexDisplayModel: DisplayModel = {
      ...coreDisplayModel,
      id: "display-bracket-demo",
      name: "Bracket demo body",
      faces: [
        { id: "selection-face-1", label: "Base mounting holes", color: "#94a3b8", center: [0, 0, 0], normal: [0, 0, 1], stressValue: 0 },
        { id: "selection-face-2", label: "Rib side face", color: "#94a3b8", center: [1, 1, 0], normal: [0, 0, 1], stressValue: 0 }
      ]
    };
    const coreStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-2", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "opencae_core_local", fidelity: "standard" }
    } as unknown as Study;
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("API unavailable"))));

    const response = await runSimulation("study-1", coreStudy, complexDisplayModel);
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "error")).toBe(true), { timeout: 1000 });
    source.close();

    expect((response.run as { status?: string }).status).toBe("failed");
    expect(response.message).toMatch(/actual Core volume mesh|OpenCAE Core Cloud/i);
    expect(seen.map((event) => event.message).join(" ")).toMatch(/actual Core volume mesh|OpenCAE Core Cloud/i);
  });

  test("routes explicit local dynamic studies to OpenCAE Core dynamic locally", { timeout: 60000 }, async () => {
    const dynamicStudy = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: {
        backend: "opencae_core_local",
        fidelity: "ultra",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.001,
        outputInterval: 0.001,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    } as unknown as Study;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => Promise.reject(new TypeError("API unavailable")));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runSimulation("study-1", dynamicStudy, coreDisplayModel);
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true), { timeout: 3000 });
    source.close();
    const results = await getResults(response.run.id);

    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-preview-sdof");
    expect(response.message).toContain("OpenCAE Core Local simulation running");
    expect(seen.map((event) => event.message).join(" ")).toContain("OpenCAE Core dynamic");
    expect(results.summary.transient?.frameCount).toBe(21);
    expect(results.fields.some((field) => field.type === "stress" && field.frameIndex === 20)).toBe(true);
    expect(results.summary.provenance?.solver).toBe("opencae-core-preview-sdof");
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("/api/cloud-fea"))).toBe(true);
  });

  test("estimates fine dynamic OpenCAE Core fallback output frames from requested output interval", () => {
    const dynamicStudy = {
      ...study,
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core_local",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.001,
        outputInterval: 0.001,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    } as Study;

    expect(dynamicOutputFrameEstimate(dynamicStudy, { backend: "opencae_core_local" })).toBe(21);
  });

  test("defers local result solving until a queued run is subscribed", () => {
    expect(apiSource).toContain("localResultSolversByRunId.set(runId");
    expect(apiSource).toContain('if (event.type === "complete")');
    expect(apiSource).toContain("await computeLocalResults(event.runId);");
  });

  test("reports dynamic local frame-writing progress before completion", { timeout: 60000 }, async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Study not found" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })));
      const readyStudy = {
        ...study,
        name: "Dynamic",
        type: "dynamic_structural",
        materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
        constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
        loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
        meshSettings: { preset: "fine", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
        solverSettings: {
          backend: "opencae_core_local",
          startTime: 0,
          endTime: 0.5,
          timeStep: 0.001,
          outputInterval: 0.001,
          dampingRatio: 0.02,
          integrationMethod: "newmark_average_acceleration",
          loadProfile: "ramp"
        }
      } as Study;

      const response = await runSimulation("study-1", readyStudy, coreDisplayModel);
      const seen: RunEvent[] = [];
      const source = subscribeToRun(response.run.id, (event) => seen.push(event));
      await vi.runAllTimersAsync();
      source.close();

      const writeEvents = seen.filter((event) => event.message.includes("Writing dynamic result frames"));
      expect(writeEvents.length).toBeGreaterThan(1);
      expect(writeEvents.at(-1)?.message).toContain("101 / 101");
      expect(writeEvents.map((event) => event.progress)).toContain(98);
      expect(writeEvents.every((event) => typeof event.estimatedRemainingMs === "number")).toBe(true);
      expect(writeEvents.at(-1)?.estimatedRemainingMs).toBeLessThanOrEqual(writeEvents[0]?.estimatedRemainingMs ?? 0);
      expect(seen.at(-1)?.type).toBe("complete");
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels a local run so pending local run events stop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Study not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })));
    const readyStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "fine", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "opencae_core_local", fidelity: "standard" }
    } as Study;

    const response = await runSimulation("study-1", readyStudy);
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    const cancelled = await cancelRun(response.run.id);
    source.close();

    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.message).toBe("Simulation cancelled.");
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
