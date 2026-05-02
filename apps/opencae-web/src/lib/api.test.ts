import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateAllowableLoadForSafetyFactor } from "@opencae/schema";
import type { DisplayModel, Project, RunEvent, Study } from "@opencae/schema";
import { addLoad, addSupport, assignMaterial, cancelRun, createProject, generateMesh, getResults, importLocalProject, loadSampleProject, renameProject, runSimulation, subscribeToRun, updateStudy, uploadModel } from "./api";

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

const apiSource = readFileSync(resolve(__dirname, "api.ts"), "utf8");

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

  test("requests and loads seeded dynamic sample projects locally", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const sample of ["bracket", "plate", "cantilever"] as const) {
      const response = await loadSampleProject(sample, "dynamic_structural");
      const requestInit = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1];
      const requestBody = JSON.parse(requestInit?.body as string) as Record<string, unknown>;

      expect(requestBody).toEqual({ sample, analysisType: "dynamic_structural" });
      expect(response.project.studies[0]?.type).toBe("dynamic_structural");
      expect(response.project.studies[0]?.runs[0]?.id).toBe(`run-${sample}-dynamic-seeded`);
      expect(response.results?.summary.transient).toMatchObject({
        analysisType: "dynamic_structural",
        integrationMethod: "newmark_average_acceleration",
        frameCount: 21
      });
      expect(response.results?.fields.some((field) => field.frameIndex === 1 && field.type === "velocity")).toBe(true);
      expect(response.results?.completedRunId).toBe(`run-${sample}-dynamic-seeded`);
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

  test("routes the Beam Demo local static solve to dense Euler-Bernoulli result fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Study not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })));
    const sample = await loadSampleProject("plate");
    const beamStudy = sample.project.studies[0]!;

    const response = await runSimulation(beamStudy.id, beamStudy, sample.displayModel);
    const completed = await new Promise<RunEvent>((resolve) => {
      const source = subscribeToRun(response.run.id, (event) => {
        if (event.type === "complete") {
          source.close();
          resolve(event);
        }
      });
    });
    const results = await getResults(response.run.id);
    const displacement = results.fields.find((field) => field.type === "displacement");
    const stress = results.fields.find((field) => field.type === "stress");

    expect(completed.progress).toBe(100);
    expect((response.run as { solverBackend?: string }).solverBackend).toBe("local-beam-demo-euler-bernoulli");
    expect(displacement?.location).toBe("node");
    expect(displacement?.samples?.length).toBeGreaterThan(64);
    expect(displacement?.samples?.every((sample) => sample.vector?.every(Number.isFinite))).toBe(true);
    expect(stress?.samples?.length).toBeGreaterThan(64);
    expect(results.summary.maxStress).toBeCloseTo(2.224, 3);
    expect(results.summary.maxDisplacement).toBeCloseTo(0.0467, 3);
    expect(estimateAllowableLoadForSafetyFactor(results.summary, 1.5).allowableLoad).toBeCloseTo(404, 0);
  });

  test("runs Cloud FEA through cloud orchestration endpoints", async () => {
    const cloudStudy = {
      ...study,
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "cloudflare_fea", fidelity: "ultra" }
    } as Study;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cloud-fea/runs" && init?.method === "POST") {
        return new Response(JSON.stringify({
          run: { id: "run-cloud-1", status: "queued" },
          streamUrl: "/api/cloud-fea/runs/run-cloud-1/events",
          message: "Cloud FEA simulation queued."
        }), { status: 202, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/cloud-fea/runs/run-cloud-1/events") {
        return new Response(JSON.stringify({
          events: [
            { runId: "run-cloud-1", type: "state", progress: 0, message: "Cloud FEA run queued.", timestamp: "2026-04-29T12:00:00.000Z" },
            { runId: "run-cloud-1", type: "complete", progress: 100, message: "Cloud FEA orchestration complete.", timestamp: "2026-04-29T12:00:01.000Z" }
          ]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/cloud-fea/runs/run-cloud-1/results") {
        return new Response(JSON.stringify({
          summary: {
            maxStress: 1440000,
            maxStressUnits: "Pa",
            maxDisplacement: 0.0038,
            maxDisplacementUnits: "m",
            safetyFactor: 172,
            reactionForce: 500,
            reactionForceUnits: "N"
          },
          fields: []
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await runSimulation("study-1", cloudStudy);
    const requestBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true));
    source.close();
    const results = await getResults(response.run.id);

    expect(requestBody).toMatchObject({ projectId: "project-1", studyId: "study-1", fidelity: "ultra" });
    expect(response.streamUrl).toBe("/api/cloud-fea/runs/run-cloud-1/events");
    expect(results.summary.maxStress).toBe(1440000);
    expect(fetchMock).toHaveBeenCalledWith("/api/cloud-fea/runs/run-cloud-1/results");
  });

  test("returns Cloud FEA request errors instead of masking them with local results", async () => {
    const cloudStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "cloudflare_fea", fidelity: "ultra" }
    } as Study;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Cloud FEA containers are not enabled for this deployment."
    }), {
      status: 503,
      headers: { "content-type": "application/json" }
    })));

    await expect(runSimulation("study-1", cloudStudy)).rejects.toThrow("Cloud FEA containers are not enabled for this deployment.");
  });

  test("sends dynamic Cloud FEA studies through cloud orchestration endpoints", async () => {
    const dynamicStudy = {
      ...study,
      name: "Dynamic",
      type: "dynamic_structural",
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "ultra", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: {
        backend: "cloudflare_fea",
        fidelity: "ultra",
        startTime: 0,
        endTime: 0.5,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration"
      }
    } as Study;
    const dynamicDisplayModel = {
      ...displayModel,
      visualMesh: {
        format: "stl",
        filename: "cantilever.stl",
        contentBase64: btoa(sizedAsciiStl)
      }
    } satisfies DisplayModel;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cloud-fea/runs" && init?.method === "POST") {
        return new Response(JSON.stringify({
          run: { id: "run-cloud-dynamic-1", status: "queued" },
          streamUrl: "/api/cloud-fea/runs/run-cloud-dynamic-1/events",
          message: "Cloud FEA simulation queued."
        }), { status: 202, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/cloud-fea/runs/run-cloud-dynamic-1/events") {
        return new Response(JSON.stringify({
          events: [
            { runId: "run-cloud-dynamic-1", type: "state", progress: 0, message: "Cloud FEA run queued.", timestamp: "2026-04-29T12:00:00.000Z" },
            { runId: "run-cloud-dynamic-1", type: "complete", progress: 100, message: "Cloud FEA transient solve complete.", timestamp: "2026-04-29T12:00:01.000Z" }
          ]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/cloud-fea/runs/run-cloud-dynamic-1/results") {
        return new Response(JSON.stringify({
          summary: {
            maxStress: 431400000,
            maxStressUnits: "Pa",
            maxDisplacement: 0.000761,
            maxDisplacementUnits: "m",
            safetyFactor: 0.64,
            reactionForce: 500,
            reactionForceUnits: "N",
            transient: { startTime: 0, endTime: 0.5, timeStep: 0.005, outputInterval: 0.005, frameCount: 2 }
          },
          fields: [
            { id: "stress-0", runId: "run-cloud-dynamic-1", type: "stress", location: "node", values: [120000], min: 120000, max: 431400000, units: "Pa", frameIndex: 0, time: 0, samples: [{ point: [0, 0, 0], value: 120000, source: "calculix", vonMisesStressPa: 120000 }] },
            { id: "stress-1", runId: "run-cloud-dynamic-1", type: "stress", location: "node", values: [431400000], min: 120000, max: 431400000, units: "Pa", frameIndex: 1, time: 0.005, samples: [{ point: [1, 0, 0], value: 431400000, source: "calculix", vonMisesStressPa: 431400000 }] },
            { id: "disp-1", runId: "run-cloud-dynamic-1", type: "displacement", location: "node", values: [0.000761], min: -0.000761, max: 0.000761, units: "m", frameIndex: 1, time: 0.005, samples: [{ point: [1, 0, 0], value: 0.000761, source: "calculix" }] }
          ]
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("unexpected cloud call", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await runSimulation("study-1", dynamicStudy, dynamicDisplayModel);
    const requestBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true));
    source.close();
    const results = await getResults(response.run.id);

    expect(requestBody).toMatchObject({
      projectId: "project-1",
      studyId: "study-1",
      fidelity: "ultra",
      study: { id: "study-1", type: "dynamic_structural" },
      displayModel: { id: "display-1" },
      geometry: { format: "stl", filename: "cantilever.stl", contentBase64: dynamicDisplayModel.visualMesh.contentBase64 },
      dynamicSettings: { endTime: 0.5, timeStep: 0.005, dampingRatio: 0.02 }
    });
    expect(response.message).toBe("Cloud FEA simulation queued.");
    expect(results.summary.transient?.frameCount).toBe(2);
    expect(results.fields.some((field) => field.type === "stress" && field.frameIndex === 1)).toBe(true);
  });

  test("defers local result solving until a queued run is subscribed", () => {
    expect(apiSource).toContain("localResultSolversByRunId.set(runId");
    expect(apiSource).toContain('if (event.type === "complete")');
    expect(apiSource).toContain("await computeLocalResults(event.runId);");
  });

  test("reports dynamic local frame-writing progress before completion", async () => {
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
          startTime: 0,
          endTime: 0.5,
          timeStep: 0.001,
          outputInterval: 0.001,
          dampingRatio: 0.02,
          integrationMethod: "newmark_average_acceleration"
        }
      } as Study;

      const response = await runSimulation("study-1", readyStudy);
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
      meshSettings: { preset: "fine", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" }
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
