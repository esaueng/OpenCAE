// In-browser gmsh-wasm meshing worker (plan A-M1 spike skeleton).
// Mirrors performanceWorker.ts conventions. gmsh-wasm (and the whole
// @opencae/mesh-intake meshing path) is loaded via dynamic import inside the
// worker so the initial app bundle never pays for the ~44 MB WASM asset.
import type { MeshAttemptContext } from "@opencae/mesh-intake";
import {
  normalizeMeshWorkerError,
  packCoreVolumeMeshArtifact,
  shouldProbeStepRepair,
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
  const reportPhase = (phase: MeshWorkerPhase, elapsedMs?: number, attempt?: MeshAttemptContext) => {
    workerScope.postMessage({
      id: request.id,
      operation: request.operation,
      kind: "progress",
      phase,
      elapsedMs: elapsedMs ?? Date.now() - started,
      ...(attempt ? { attempt } : {})
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

async function runOperation(request: MeshWorkerRequest, reportPhase: (phase: MeshWorkerPhase, elapsedMs?: number, attempt?: MeshAttemptContext) => void) {
  // Lazy-load the meshing library (which itself lazy-loads the gmsh WASM
  // module) only when the first meshing request arrives.
  const intake = await import("@opencae/mesh-intake");
  // Production deploys serve gmsh-core.wasm gzip-precompressed (Cloudflare's
  // 25 MiB per-asset cap); hand the intake loader the browser-side fetch +
  // gunzip strategy before any gmsh module is instantiated.
  const { gmshWasmModuleOptions } = await import("./gmshWasmBinary");
  intake.configureGmshWasmModuleOptions(gmshWasmModuleOptions);
  const onPhase = (event: { phase: MeshWorkerPhase; elapsedMs: number; attempt?: MeshAttemptContext }) => reportPhase(event.phase, event.elapsedMs, event.attempt);

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
    // First-class wasm-session quality gate (A-M4): reject near-degenerate
    // meshes, record marginal quality onto artifact metadata.
    intake.enforceWasmMeshQualityGate(artifact, meshed.qualityMinSICN, "In-browser meshing");
    return {
      packed: packCoreVolumeMeshArtifact(artifact),
      timings: meshed.timings,
      totalMs: meshed.totalMs
    };
  }

  if (request.operation === "inspectStepFile") {
    reportPhase("import");
    const stepContent = new Uint8Array(request.payload.stepContent);
    const inspection = await intake.inspectStepGeometry(stepContent);
    if (!shouldProbeStepRepair(inspection, request.payload.probeRepairEvenIfSolid)) return { inspection };
    // Do not infer repairability from face/edge counts. Prove it with the same
    // explicit repair operation the Fix model button will run, then discard
    // the trial bytes; the original upload remains untouched.
    try {
      await intake.repairStepGeometry(stepContent);
      return { inspection: { ...inspection, repairable: true }, repairProbe: "succeeded" as const };
    } catch {
      return { inspection: { ...inspection, repairable: false }, repairProbe: "failed" as const };
    }
  }

  if (request.operation === "repairStepFile") {
    reportPhase("import");
    return intake.repairStepGeometry(new Uint8Array(request.payload.stepContent));
  }

  const meshed = await intake.meshStepToMshV2(new Uint8Array(request.payload.stepContent), {
    elementOrder: request.payload.elementOrder,
    meshSizeMm: request.payload.meshSizeMm,
    structuralBodyBounds: request.payload.structuralBodyBounds,
    onPhase
  });
  reportPhase("parse");
  const artifact = intake.parseGmshMeshToCoreVolumeMesh(meshed.msh, {
    units: request.payload.units ?? "mm",
    diagnostics: [`gmsh-wasm worker meshStepFile (algorithm3D=${meshed.algorithm3D})`]
  });
  intake.enforceWasmMeshQualityGate(artifact, meshed.qualityMinSICN, "In-browser STEP meshing");
  // Facet -> B-rep face attribution (plan A-M3): stamp sourceFaceIds from the
  // STEP display tessellation BEFORE packing, so the ids ride along inside the
  // packed artifact's surface facets.
  const attribution = request.payload.attribution
    ? intake.attributeFacetsToStepFaces(artifact, request.payload.attribution)
    : undefined;
  return {
    packed: packCoreVolumeMeshArtifact(artifact),
    timings: meshed.timings,
    totalMs: meshed.totalMs,
    algorithm3D: meshed.algorithm3D,
    ...(meshed.elevation ? { elevation: meshed.elevation } : {}),
    ...(meshed.optimizer ? { optimizer: meshed.optimizer } : {}),
    ...(meshed.qualityRefinement ? { qualityRefinement: meshed.qualityRefinement } : {}),
    ...(meshed.qualityRepair ? { qualityRepair: meshed.qualityRepair } : {}),
    ...(meshed.geometryRepair ? { geometryRepair: meshed.geometryRepair } : {}),
    ...(meshed.multiBodyFusion ? { multiBodyFusion: meshed.multiBodyFusion } : {}),
    ...(meshed.elementOrderFallback ? { elementOrderFallback: meshed.elementOrderFallback } : {}),
    ...(attribution ? { attribution } : {})
  };
}
