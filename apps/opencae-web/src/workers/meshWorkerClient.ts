// Main-thread client for the gmsh-wasm meshing worker (plan A-M1 spike skeleton).
// Mirrors performanceClient.ts, with three additions:
//   - phase-based progress callbacks per request,
//   - hard cancel via terminate + respawn (gmsh has no cooperative cancel), and
//   - eager teardown: the worker is terminated as soon as its request queue
//     drains, returning the several-hundred-MB gmsh wasm arena to the OS.
//     wasmMesher.ts must instantiate a fresh gmsh module per mesh anyway
//     (module reuse crashes gmsh-wasm 0.1.2), so a kept-alive worker only
//     saved ~100 ms of spawn + a service-worker-cached wasm fetch while
//     pinning the dead arena in the tab's footprint (measured ~1.1 GB during
//     meshing on the 100k-DOF bench) — a bad trade on iOS-class devices.
import type { MeshAttemptContext } from "@opencae/mesh-intake";
import {
  createMeshWorkerRequest,
  isMeshWorkerFailure,
  isMeshWorkerProgress,
  isMeshWorkerSuccess,
  transferablesForMeshWorkerRequest,
  type MeshWorkerOperation,
  type MeshWorkerPayloads,
  type MeshWorkerPhase,
  type MeshWorkerResponse,
  type MeshWorkerResults
} from "./meshProtocol";
import { workerClientError } from "./workerClientError";

export type MeshProgressListener = (progress: { phase: MeshWorkerPhase; elapsedMs: number; attempt?: MeshAttemptContext }) => void;

type PendingRequest<Operation extends MeshWorkerOperation = MeshWorkerOperation> = {
  operation: Operation;
  resolve: (result: MeshWorkerResults[Operation]) => void;
  reject: (error: Error) => void;
  onProgress?: MeshProgressListener;
};

let workerInstance: Worker | null = null;
const pendingRequests = new Map<string, PendingRequest>();

export function wasmMeshingEnabled(): boolean {
  // Default ON (plan A-M4): only an explicit VITE_WASM_MESHING=0 opt-out
  // build disables in-browser meshing (that build swaps this module for
  // meshWorkerClient.disabled.ts at bundle time anyway).
  return import.meta.env.VITE_WASM_MESHING !== "0";
}

export async function meshGeoScriptInWorker(
  payload: MeshWorkerPayloads["meshGeoScript"],
  onProgress?: MeshProgressListener
): Promise<MeshWorkerResults["meshGeoScript"]> {
  return postMeshWorkerRequest("meshGeoScript", payload, onProgress);
}

export async function meshStepFileInWorker(
  payload: MeshWorkerPayloads["meshStepFile"],
  onProgress?: MeshProgressListener
): Promise<MeshWorkerResults["meshStepFile"]> {
  return postMeshWorkerRequest("meshStepFile", payload, onProgress);
}

export async function inspectStepFileInWorker(
  payload: MeshWorkerPayloads["inspectStepFile"],
  onProgress?: MeshProgressListener
): Promise<MeshWorkerResults["inspectStepFile"]> {
  return postMeshWorkerRequest("inspectStepFile", payload, onProgress);
}

export async function repairStepFileInWorker(
  payload: MeshWorkerPayloads["repairStepFile"],
  onProgress?: MeshProgressListener
): Promise<MeshWorkerResults["repairStepFile"]> {
  return postMeshWorkerRequest("repairStepFile", payload, onProgress);
}

export async function postMeshWorkerRequest<Operation extends MeshWorkerOperation>(
  operation: Operation,
  payload: MeshWorkerPayloads[Operation],
  onProgress?: MeshProgressListener
): Promise<MeshWorkerResults[Operation]> {
  if (!wasmMeshingEnabled()) {
    throw new Error("In-browser wasm meshing is disabled in this build (VITE_WASM_MESHING=0 opt-out).");
  }
  const worker = getMeshWorker();
  if (!worker) {
    throw new Error("Browser workers are not available for wasm meshing.");
  }
  const request = createMeshWorkerRequest(operation, payload);
  return new Promise((resolve, reject) => {
    pendingRequests.set(request.id, { operation, resolve, reject, onProgress } as PendingRequest);
    try {
      worker.postMessage(request, transferablesForMeshWorkerRequest(request));
    } catch (error) {
      pendingRequests.delete(request.id);
      releaseMeshWorkerIfIdle();
      reject(workerClientError(error, "Could not send work to the mesh worker."));
    }
  });
}

/**
 * Hard-cancel all in-flight meshing work. gmsh-wasm runs synchronously inside
 * the worker, so the only reliable cancel is terminating the worker; the next
 * request spawns a fresh one (paying WASM init again, ~100 ms plus fetch).
 */
export function cancelMeshWork(reason = "Meshing was cancelled."): void {
  const error = new Error(reason);
  error.name = "AbortError";
  for (const pending of pendingRequests.values()) {
    pending.reject(error);
  }
  pendingRequests.clear();
  workerInstance?.terminate();
  workerInstance = null;
}

function getMeshWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (workerInstance) return workerInstance;
  workerInstance = new Worker(new URL("./meshWorker.ts", import.meta.url), { type: "module", name: "opencae-mesh-worker" });
  workerInstance.addEventListener("message", handleMeshWorkerMessage);
  workerInstance.addEventListener("error", handleMeshWorkerError);
  return workerInstance;
}

function handleMeshWorkerMessage(event: MessageEvent<MeshWorkerResponse>) {
  const response = event.data;
  if (isMeshWorkerProgress(response)) {
    pendingRequests.get(response.id)?.onProgress?.({ phase: response.phase, elapsedMs: response.elapsedMs, ...(response.attempt ? { attempt: response.attempt } : {}) });
    return;
  }
  if (!isMeshWorkerSuccess(response) && !isMeshWorkerFailure(response)) return;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;
  pendingRequests.delete(response.id);
  if (isMeshWorkerFailure(response)) {
    const error = new Error(response.error.message);
    // Preserve the error identity across the worker boundary so callers can
    // distinguish quality-gate rejections (MeshQualityError) from transient
    // meshing failures.
    if (response.error.name) error.name = response.error.name;
    pending.reject(error);
    releaseMeshWorkerIfIdle();
    return;
  }
  pending.resolve(response.result as never);
  releaseMeshWorkerIfIdle();
}

/**
 * Terminate the worker once no requests are in flight. The mesh result has
 * already been transferred to the main thread at this point; keeping the
 * worker alive would only pin the dead gmsh module arena (fresh module per
 * mesh is mandatory regardless). The next request respawns via getMeshWorker.
 */
function releaseMeshWorkerIfIdle(): void {
  if (pendingRequests.size > 0) return;
  workerInstance?.terminate();
  workerInstance = null;
}

function handleMeshWorkerError(event: ErrorEvent) {
  const error = new Error(event.message || "Mesh worker failed.");
  for (const pending of pendingRequests.values()) {
    pending.reject(error);
  }
  pendingRequests.clear();
  workerInstance?.terminate();
  workerInstance = null;
}
