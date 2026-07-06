// In-browser gmsh-wasm meshing worker (plan A-M1 spike skeleton).
// Mirrors performanceWorker.ts conventions. gmsh-wasm (and the whole
// @opencae/mesh-intake meshing path) is loaded via dynamic import inside the
// worker so the initial app bundle never pays for the ~44 MB WASM asset.
import {
  normalizeMeshWorkerError,
  packCoreVolumeMeshArtifact,
  transferablesForMeshWorkerResult,
  type MeshWorkerPhase,
  type MeshWorkerRequest,
  type MeshWorkerResponse
} from "./meshProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<MeshWorkerRequest>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

async function handleRequest(request: MeshWorkerRequest): Promise<void> {
  const started = Date.now();
  const reportPhase = (phase: MeshWorkerPhase, elapsedMs?: number) => {
    workerScope.postMessage({
      id: request.id,
      operation: request.operation,
      kind: "progress",
      phase,
      elapsedMs: elapsedMs ?? Date.now() - started
    } satisfies MeshWorkerResponse);
  };
  try {
    const result = await runOperation(request, reportPhase);
    const response = {
      id: request.id,
      operation: request.operation,
      ok: true,
      result
    } as MeshWorkerResponse;
    workerScope.postMessage(response, transferablesForMeshWorkerResult(result));
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      operation: request.operation,
      ok: false,
      error: normalizeMeshWorkerError(error)
    } satisfies MeshWorkerResponse);
  }
}

async function runOperation(request: MeshWorkerRequest, reportPhase: (phase: MeshWorkerPhase, elapsedMs?: number) => void) {
  // Lazy-load the meshing library (which itself lazy-loads the gmsh WASM
  // module) only when the first meshing request arrives.
  const intake = await import("@opencae/mesh-intake");
  const onPhase = (event: { phase: MeshWorkerPhase; elapsedMs: number }) => reportPhase(event.phase, event.elapsedMs);

  if (request.operation === "meshGeoScript") {
    const meshed = await intake.meshGeoScriptToMshV2(request.payload.geoScript, {
      elementOrder: request.payload.elementOrder,
      onPhase
    });
    reportPhase("parse");
    const artifact = intake.parseGmshMeshToCoreVolumeMesh(meshed.msh, {
      units: request.payload.units ?? "mm",
      sourceSelectionRefs: request.payload.sourceSelectionRefs,
      diagnostics: ["gmsh-wasm worker meshGeoScript"]
    });
    return {
      packed: packCoreVolumeMeshArtifact(artifact),
      timings: meshed.timings,
      totalMs: meshed.totalMs
    };
  }

  const meshed = await intake.meshStepToMshV2(new Uint8Array(request.payload.stepContent), {
    elementOrder: request.payload.elementOrder,
    meshSizeMm: request.payload.meshSizeMm,
    onPhase
  });
  reportPhase("parse");
  const artifact = intake.parseGmshMeshToCoreVolumeMesh(meshed.msh, {
    units: request.payload.units ?? "mm",
    diagnostics: [`gmsh-wasm worker meshStepFile (algorithm3D=${meshed.algorithm3D})`]
  });
  return {
    packed: packCoreVolumeMeshArtifact(artifact),
    timings: meshed.timings,
    totalMs: meshed.totalMs,
    algorithm3D: meshed.algorithm3D
  };
}
