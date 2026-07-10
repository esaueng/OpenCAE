import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DisplayModel, Project, RunEvent, Study } from "@opencae/schema";
import { addLoad, addSupport, assignMaterial, cancelRun, createProject, dynamicOutputFrameEstimate, generateMesh, geometryWithMeshPreset, getResults, importLocalProject, loadSampleProject, probeUploadedStepRepairAfterMeshFailure, renameProject, runSimulation, STEP_REPAIR_PROBE_MODEL_CHANGED_MESSAGE, STEP_REPAIR_UNAVAILABLE_MESSAGE, subscribeToRun, updateStudy, uploadedStepRepairProbeDecision, uploadModel } from "./api";

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

function uploadedStepProjectForRepairProbe(status: "solid" | "unchecked"): Project {
  return {
    ...project,
    geometryFiles: [{
      ...project.geometryFiles[0]!,
      filename: "nominal-solid.step",
      metadata: {
        source: "local-upload",
        embeddedModel: {
          filename: "nominal-solid.step",
          contentType: "model/step",
          size: 4,
          contentBase64: "U1RFUA=="
        },
        stepGeometry: { status }
      }
    }]
  };
}

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

  test("does not persist a model upload after its workspace generation is superseded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const file = new TestFile([sizedAsciiStl], "superseded.stl", { type: "model/stl" });
    await expect(uploadModel("project-1", file, project, {
      isCurrent: () => false
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends a conditional monotonic token with guarded model uploads", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ project, displayModel, message: "Uploaded." }), {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const file = new TestFile([sizedAsciiStl], "newer.stl", { type: "model/stl" });
    await uploadModel("project-1", file, project, {
      clientId: "workspace-session",
      generation: 7,
      isCurrent: () => true
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(requestInit.body as string) as Record<string, unknown>;
    expect(requestBody.modelMutation).toEqual({
      clientId: "workspace-session",
      generation: 7,
      expectedGeometryId: "geometry-1",
      expectedUpdatedAt: project.updatedAt
    });
  });

  test("does not fall back to a local stale upload when persistence is cancelled", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const rejectAsAborted = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) rejectAsAborted();
      else init?.signal?.addEventListener("abort", rejectAsAborted, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const file = new TestFile([sizedAsciiStl], "cancelled.stl", { type: "model/stl" });
    const upload = uploadModel("project-1", file, project, { signal: controller.signal });
    const rejectedUpload = expect(upload).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await rejectedUpload;
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

  test("rejects an incompatible explicit material and manufacturing process before calling the API", async () => {
    const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(assignMaterial(
      "study-1",
      "mat-abs",
      { manufacturingProcessId: "sla" },
      study
    )).rejects.toThrow(/SLA printing.*not compatible with ABS/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends and persists a compatible explicit material and manufacturing process", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const parameters = {
      manufacturingProcessId: "fdm",
      printed: true,
      infillDensity: 35,
      wallCount: 3,
      layerOrientation: "z"
    };

    const response = await assignMaterial("study-1", "mat-abs", parameters, study);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(JSON.parse(requestInit?.body as string)).toEqual({
      materialId: "mat-abs",
      parameters
    });
    expect(response.study.materialAssignments[0]).toMatchObject({
      materialId: "mat-abs",
      parameters
    });
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

  test("preserves the selected face-relative direction mode when adding locally", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await addLoad("study-1", "force", 500, "selection-face-1", [0, 0, -1], [1, 2, 3], null, study, {}, "Opposite normal");

    expect(response.study.loads[0]?.parameters.directionMode).toBe("Opposite normal");
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
        source: "preset_estimate",
        warnings: [
          "Node and element counts are preset planning estimates. The solver reports actual mesh statistics with the results.",
          "Fine surface analysis sampling enabled for higher-quality local results."
        ]
      }
    });
    expect(response.message).toBe("Mesh generated locally.");
  });

  test("does not mask a STEP topology failure with a completed preset estimate", async () => {
    const stepText = readFileSync(resolve(__dirname, "../../../../libs/opencae-mesh-intake/fixtures/box-with-bore.step"), "utf8");
    const progress: string[] = [];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    class FailingStepWorker {
      private listeners = new Map<string, (event: MessageEvent | ErrorEvent) => void>();

      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        this.listeners.set(type, listener);
      }

      postMessage(request: { id: string; operation: string }) {
        queueMicrotask(() => this.listeners.get("message")?.({
          data: {
            id: request.id,
            operation: request.operation,
            ok: false,
            error: { name: "StepGeometryError", message: "STEP geometry has open surfaces." }
          }
        } as MessageEvent));
      }

      terminate() {}
    }
    vi.stubGlobal("Worker", FailingStepWorker);
    const uploadedStepDisplay = {
      ...coreDisplayModel,
      id: "display-uploaded-step",
      nativeCad: {
        format: "step" as const,
        filename: "open-part.step",
        contentBase64: Buffer.from(stepText).toString("base64")
      }
    } satisfies DisplayModel;

    await expect(generateMesh("study-1", "medium", study, uploadedStepDisplay, (message) => progress.push(message)))
      .rejects.toMatchObject({ name: "StepGeometryError", message: "STEP geometry has open surfaces." });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(progress.some((message) => message.includes("Falling back to preset estimates"))).toBe(false);
  });

  test("force-probes a nominal STEP solid after meshing fails and stores an unrepairable result", async () => {
    const workerRequests: Array<{ payload: { probeRepairEvenIfSolid?: boolean } }> = [];
    class InspectingStepWorker {
      private listeners = new Map<string, (event: MessageEvent | ErrorEvent) => void>();

      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        this.listeners.set(type, listener);
      }

      postMessage(request: { id: string; operation: string; payload: { probeRepairEvenIfSolid?: boolean } }) {
        workerRequests.push(request);
        queueMicrotask(() => this.listeners.get("message")?.({
          data: {
            id: request.id,
            operation: request.operation,
            ok: true,
            result: {
              inspection: {
                status: "solid",
                volumeCount: 1,
                surfaceCount: 428,
                orphanSurfaceCount: 0,
                openBoundaryCurveCount: 8,
                surfaceMeshValid: true,
                repairable: false
              },
              repairProbe: "failed"
            }
          }
        } as MessageEvent));
      }

      terminate() {}
    }
    vi.stubGlobal("Worker", InspectingStepWorker);
    const nominalStepProject = uploadedStepProjectForRepairProbe("solid");

    const result = await probeUploadedStepRepairAfterMeshFailure(nominalStepProject, { isCurrent: () => true });

    expect(workerRequests[0]?.payload.probeRepairEvenIfSolid).toBe(true);
    expect(result?.stepGeometry).toMatchObject({
      status: "unrepairable",
      message: STEP_REPAIR_UNAVAILABLE_MESSAGE
    });
    expect(result?.project.geometryFiles[0]?.metadata.stepGeometry).toMatchObject({
      status: "unrepairable",
      message: STEP_REPAIR_UNAVAILABLE_MESSAGE
    });
  });

  test("keeps the repair probe eligible after project metadata changes without replacing the STEP model", () => {
    const sourceProject = uploadedStepProjectForRepairProbe("solid");
    const savedProject = {
      ...sourceProject,
      name: "Renamed while meshing",
      updatedAt: "2026-07-10T13:30:58.000Z"
    };

    const decision = uploadedStepRepairProbeDecision(sourceProject, savedProject);

    expect(decision.shouldProbe).toBe(true);
    if (decision.shouldProbe) expect(decision.project).toBe(savedProject);
  });

  test("rejects the repair probe when the embedded STEP model changed", () => {
    const sourceProject = uploadedStepProjectForRepairProbe("solid");
    const replacedProject: Project = {
      ...sourceProject,
      geometryFiles: sourceProject.geometryFiles.map((geometry) => ({
        ...geometry,
        metadata: {
          ...geometry.metadata,
          embeddedModel: {
            filename: "replacement.step",
            contentType: "model/step",
            size: 7,
            contentBase64: "TkVXU1RFUA=="
          }
        }
      }))
    };

    expect(uploadedStepRepairProbeDecision(sourceProject, replacedProject)).toEqual({
      shouldProbe: false,
      reason: STEP_REPAIR_PROBE_MODEL_CHANGED_MESSAGE
    });
  });

  test("discards a forced STEP repair probe when the workspace generation changes", async () => {
    let current = true;
    class SupersededProbeWorker {
      private listeners = new Map<string, (event: MessageEvent | ErrorEvent) => void>();

      addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
        this.listeners.set(type, listener);
      }

      postMessage(request: { id: string; operation: string }) {
        queueMicrotask(() => {
          current = false;
          this.listeners.get("message")?.({
            data: {
              id: request.id,
              operation: request.operation,
              ok: true,
              result: {
                inspection: {
                  status: "solid",
                  volumeCount: 1,
                  surfaceCount: 428,
                  orphanSurfaceCount: 0,
                  openBoundaryCurveCount: 8,
                  surfaceMeshValid: true,
                  repairable: true
                },
                repairProbe: "succeeded"
              }
            }
          } as MessageEvent);
        });
      }

      terminate() {}
    }
    vi.stubGlobal("Worker", SupersededProbeWorker);

    await expect(probeUploadedStepRepairAfterMeshFailure(uploadedStepProjectForRepairProbe("solid"), {
      isCurrent: () => current
    })).rejects.toMatchObject({ name: "AbortError" });
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
    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-sparse-tet");
    expect(completed.progress).toBe(100);
    // Cloud-parity contract: five surface/element fields, all stamped with the run id.
    expect(results.fields).toHaveLength(5);
    expect(results.fields.every((field) => field.runId === response.run.id)).toBe(true);
    expect(results.summary.provenance?.solver).toBe("opencae-core-cloud");
    expect((results.summary.provenance as { runnerVersion?: string })?.runnerVersion).toBe("browser-0.1.0");
    expect(results.summary.maxStress).toBeGreaterThanOrEqual(0);
  });

  test("runs studies with a retired legacy cloud backend locally without touching cloud routes", async () => {
    // B4a: "opencae_core_cloud" is a retired alias. Old projects that saved it
    // must still run — locally, with zero requests to the removed client
    // cloud endpoints.
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => Promise.reject(new TypeError("retired cloud backend must not touch the network")));
    vi.stubGlobal("fetch", fetchMock);
    const readyStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "fine", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      // Retired cloud choice from an old save: treated as never-chose (auto).
      solverSettings: { backend: "opencae_core_cloud", fidelity: "standard" }
    } as unknown as Study;

    const response = await runSimulation("study-1", readyStudy, coreDisplayModel);
    const completed = await new Promise<RunEvent>((resolve) => {
      const source = subscribeToRun(response.run.id, (event) => {
        if (event.type === "complete" || event.type === "error") {
          source.close();
          resolve(event);
        }
      });
    });
    const results = await getResults(response.run.id);

    expect(response.streamUrl).toMatch(/^local:run-local-/);
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("/api/cloud-core"))).toBe(true);
    expect(completed.type).toBe("complete");
    // The in-browser pipeline computed this (browser runner stamp), honestly
    // labeled as a real computed FEA result, not a preview estimate.
    expect(results.summary.provenance?.solver).toBe("opencae-core-cloud");
    expect((results.summary.provenance as { runnerVersion?: string })?.runnerVersion).toBe("browser-0.1.0");
    expect(results.summary.provenance?.resultSource).toBe("computed");
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

  test("runs explicit local backend selections in browser OpenCAE Core without cloud route calls", { timeout: 60000 }, async () => {
    const coreDisplayModel: DisplayModel = {
      ...displayModel,
      bodyCount: 1,
      dimensions: { x: 0.12, y: 0.04, z: 0.02, units: "m" },
      // The cloud-fidelity model builder maps selections onto real display
      // faces (no silent nearest-node fallback), so the fixture carries them.
      faces: [
        { id: "selection-face-1", label: "Fixed", color: "#94a3b8", center: [0, 0.02, 0.01], normal: [-1, 0, 0], stressValue: 0 },
        { id: "selection-face-2", label: "Load", color: "#94a3b8", center: [0.12, 0.02, 0.01], normal: [1, 0, 0], stressValue: 0 }
      ]
    };
    const coreStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      // Medium keeps the shared cloud-density structured grid solveable in
      // seconds for this test; density is preset-driven, not backend-driven.
      meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "opencae_core_local", fidelity: "standard" }
    } as unknown as Study;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => Promise.reject(new TypeError("API unavailable")));
    vi.stubGlobal("fetch", fetchMock);
    const healthLogs: string[] = [];

    const response = await runSimulation("study-1", coreStudy, coreDisplayModel, { onRunStatus: (message) => healthLogs.push(message) });
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true), { timeout: 45000 });
    source.close();
    const results = await getResults(response.run.id);

    expect(healthLogs).toEqual([]);
    expect(response.streamUrl).toMatch(/^local:run-local-/);
    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-sparse-tet");
    expect(seen.map((event) => event.message).join(" ")).toContain("OpenCAE Core");
    expect(results.summary.provenance?.solver).toBe("opencae-core-cloud");
    expect((results.summary.provenance as { runnerVersion?: string })?.runnerVersion).toBe("browser-0.1.0");
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("/api/cloud-fea"))).toBe(true);
  });

  test("fails bracket runs honestly when meshing on demand is unavailable, without cloud calls", async () => {
    // Complex geometry without a stored mesh artifact meshes in-browser first
    // (A-M4). This vitest environment has no Worker, so the run must FAIL
    // with the actionable mesh-required reason -- never dispatch to the
    // retired cloud endpoints and never estimate.
    const sample = await loadSampleProject("bracket");
    const bracketStudy = sample.project.studies[0]!;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => Promise.reject(new TypeError("local-only runs must not touch the network")));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runSimulation(bracketStudy.id, bracketStudy, sample.displayModel);

    expect((response.run as { status?: string }).status).toBe("failed");
    expect(response.message).toMatch(/needs a volume mesh|in-browser meshing is unavailable/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("auto-routes eligible studies to the local browser solver without any network calls", { timeout: 60000 }, async () => {
    const eligibleDisplayModel: DisplayModel = {
      ...displayModel,
      bodyCount: 1,
      dimensions: { x: 0.12, y: 0.04, z: 0.02, units: "m" },
      faces: [
        { id: "selection-face-1", label: "Fixed", color: "#94a3b8", center: [0, 0.02, 0.01], normal: [-1, 0, 0], stressValue: 0 },
        { id: "selection-face-2", label: "Load", color: "#94a3b8", center: [0.12, 0.02, 0.01], normal: [1, 0, 0], stressValue: 0 }
      ]
    };
    const autoStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      // No explicit backend: per-model routing solves eligible studies locally.
      solverSettings: { fidelity: "standard" }
    } as unknown as Study;
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => Promise.reject(new TypeError("auto-local runs must not touch the network")));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runSimulation("study-1", autoStudy, eligibleDisplayModel);
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true), { timeout: 45000 });
    source.close();

    expect(response.streamUrl).toMatch(/^local:run-local-/);
    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-sparse-tet");
    expect(fetchMock).not.toHaveBeenCalled();
    // The persisted study keeps its non-choice; only the run's dispatch copy is stamped local.
    expect(autoStudy.solverSettings.backend).toBeUndefined();
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
    expect(response.message).toMatch(/needs a volume mesh|in-browser meshing is unavailable/i);
    expect(seen.map((event) => event.message).join(" ")).toMatch(/needs a volume mesh|in-browser meshing is unavailable/i);
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
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true), { timeout: 45000 });
    source.close();
    const results = await getResults(response.run.id);

    expect((response.run as { solverBackend?: string }).solverBackend).toBe("opencae-core-mdof-tet");
    expect(response.message).toContain("OpenCAE Core Local simulation running");
    expect(seen.map((event) => event.message).join(" ")).toContain("OpenCAE Core dynamic");
    expect(results.summary.transient?.frameCount).toBe(21);
    expect(results.fields.some((field) => field.type === "stress" && field.frameIndex === 20)).toBe(true);
    expect(results.summary.provenance?.solver).toBe("opencae-core-cloud");
    expect((results.summary.provenance as { runnerVersion?: string })?.runnerVersion).toBe("browser-0.1.0");
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

  test("rejects a second local solve while one is running", () => {
    // Single-flight mirrors the run-button UX string exactly.
    expect(apiSource).toContain("if (activeLocalRun()) throw new Error(\"Simulation is already running.\");");
  });

  test("fails the run instead of hanging when the local solver rejects", () => {
    expect(apiSource).toContain('messageFromUnknownError(error) || "Local solve failed."');
    expect(apiSource).toContain('finishLocalRun(record, "failed"');
  });

  test("persists completed local results and surfaces storage failures visibly", () => {
    expect(apiSource).toContain("persistLocalRunResults");
    expect(apiSource).toContain("local-results-persistence");
    expect(apiSource).toContain("restoreLocalRunResults");
  });

  test("reports real dynamic frame-writing progress with a derivable ETA before completion", { timeout: 60000 }, async () => {
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
      meshSettings: { preset: "coarse", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: {
        backend: "opencae_core_local",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.001,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    } as Study;

    const response = await runSimulation("study-1", readyStudy, coreDisplayModel);
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.some((event) => event.type === "complete")).toBe(true), { timeout: 45000 });
    source.close();

    const writeEvents = seen.filter((event) => event.message.includes("Writing dynamic result frames"));
    expect(writeEvents.length).toBeGreaterThan(1);
    // Real frame counter from the solver's frames-phase hook (21 output frames
    // at endTime 0.1 s / 0.005 s output interval).
    expect(writeEvents.at(-1)?.message).toMatch(/Writing dynamic result frames 21 \/ \d+\./);
    // Frame progress lives in the 30-90% band; postprocess owns 90-100%.
    expect(writeEvents.every((event) => (event.progress ?? 0) <= 90)).toBe(true);
    expect(Math.max(...writeEvents.map((event) => event.progress ?? 0))).toBeGreaterThanOrEqual(80);
    // estimatedRemainingMs only exists where derivable (dynamic frames), and
    // trends downward as frames complete.
    expect(writeEvents.slice(1).every((event) => typeof event.estimatedRemainingMs === "number")).toBe(true);
    expect(writeEvents.at(-1)?.estimatedRemainingMs).toBeLessThanOrEqual(writeEvents[1]?.estimatedRemainingMs ?? 0);
    // Elapsed time is real wall clock, not a pre-scripted estimate.
    expect(writeEvents.every((event) => typeof event.elapsedMs === "number")).toBe(true);
    expect(seen.at(-1)?.type).toBe("complete");
    expect(seen.at(-1)?.progress).toBe(100);
  });

  test("cancels a local run so pending local run events stop", async () => {
    // Reject fetch outright: the whole flow then runs on microtasks only, so
    // the deferred inline solve cannot start before the cancel below.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("API unavailable"))));
    const readyStudy = {
      ...study,
      materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", status: "complete" }],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-face-1", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-1", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }],
      meshSettings: { preset: "fine", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      solverSettings: { backend: "opencae_core_local", fidelity: "standard" }
    } as Study;

    const response = await runSimulation("study-1", readyStudy, coreDisplayModel);
    const seen: RunEvent[] = [];
    const source = subscribeToRun(response.run.id, (event) => seen.push(event));

    // Single-flight: a second local solve is rejected while the first runs.
    await expect(runSimulation("study-1", readyStudy, coreDisplayModel)).rejects.toThrow("Simulation is already running.");

    const cancelled = await cancelRun(response.run.id);
    await vi.waitFor(() => expect(seen.some((event) => event.type === "cancelled")).toBe(true), { timeout: 2000 });
    source.close();

    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.message).toBe("Simulation cancelled.");
    // Exactly one terminal event, and it is the cancellation.
    const terminalEvents = seen.filter((event) => event.type === "cancelled" || event.type === "complete" || event.type === "error");
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe("cancelled");

    // A new run may start after cancellation.
    const rerun = await runSimulation("study-1", readyStudy, coreDisplayModel);
    expect(rerun.run.id).not.toBe(response.run.id);
    await cancelRun(rerun.run.id);
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

  test("rejects project files that are not JSON with a friendly import error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const file = new TestFile(["this is not json"], "broken.opencae.json", { type: "application/json" });

    await expect(importLocalProject(file)).rejects.toThrow("The selected file is not a valid OpenCAE project file.");
  });

  test("carries no client cloud-solve plumbing (retired in B4a)", () => {
    // Token headers, cloud cancel-URL derivation, and cloud run dispatch all
    // left with the client cloud path; only historical run-id recognition stays.
    expect(apiSource).not.toContain("x-opencae-run-token");
    expect(apiSource).not.toContain("/api/cloud-core");
    expect(apiSource).not.toContain("cloudResultsUrlByRunId");
    expect(apiSource).toContain("run-cloud-core-");
  });
});

// Ported from the retired api.cloudSolveRequest.test.ts (B4a): mesh preset
// sizing on procedural geometry now feeds the in-browser wasm mesher.
describe("mesh preset sizing for procedural geometry", () => {
  test("applies the study mesh preset to procedural bracket geometry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const sample = await loadSampleProject("bracket");
    const bracketStudy = sample.project.studies[0]!;
    const { geometrySourceForStudy } = await import("../workers/opencaeCoreSolve");
    const geometry = geometrySourceForStudy(bracketStudy, sample.displayModel);
    expect(geometry).not.toBeNull();

    const medium = geometryWithMeshPreset(geometry!, bracketStudy);
    expect((medium.descriptor as { meshSize?: number }).meshSize).toBe(12);

    const fineStudy = { ...bracketStudy, meshSettings: { ...bracketStudy.meshSettings, preset: "fine" as const } };
    expect((geometryWithMeshPreset(geometry!, fineStudy).descriptor as { meshSize?: number }).meshSize).toBe(8);

    const coarseStudy = { ...bracketStudy, meshSettings: { ...bracketStudy.meshSettings, preset: "coarse" as const } };
    expect((geometryWithMeshPreset(geometry!, coarseStudy).descriptor as { meshSize?: number }).meshSize).toBe(18);
  });
});
