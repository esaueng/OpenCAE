// Main-thread client for the gmsh-wasm meshing worker (plan A-M1 spike skeleton).
// Mirrors performanceClient.ts, with two additions:
//   - phase-based progress callbacks per request, and
//   - hard cancel via terminate + respawn (gmsh has no cooperative cancel).
//
// The whole path is gated behind VITE_WASM_MESHING=1; nothing imports this
// module from app UI yet, so the initial bundle is untouched.
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

export type MeshProgressListener = (progress: { phase: MeshWorkerPhase; elapsedMs: number }) => void;

type PendingRequest<Operation extends MeshWorkerOperation = MeshWorkerOperation> = {
  operation: Operation;
  resolve: (result: MeshWorkerResults[Operation]) => void;
  reject: (error: Error) => void;
  onProgress?: MeshProgressListener;
};

let workerInstance: Worker | null = null;
const pendingRequests = new Map<string, PendingRequest>();

export function wasmMeshingEnabled(): boolean {
  return import.meta.env.VITE_WASM_MESHING === "1";
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

export async function postMeshWorkerRequest<Operation extends MeshWorkerOperation>(
  operation: Operation,
  payload: MeshWorkerPayloads[Operation],
  onProgress?: MeshProgressListener
): Promise<MeshWorkerResults[Operation]> {
  if (!wasmMeshingEnabled()) {
    throw new Error("In-browser wasm meshing is disabled. Set VITE_WASM_MESHING=1 to enable the spike path.");
  }
  const worker = getMeshWorker();
  if (!worker) {
    throw new Error("Browser workers are not available for wasm meshing.");
  }
  const request = createMeshWorkerRequest(operation, payload);
  return new Promise((resolve, reject) => {
    pendingRequests.set(request.id, { operation, resolve, reject, onProgress } as PendingRequest);
    worker.postMessage(request, transferablesForMeshWorkerRequest(request));
  });
}

/**
 * Hard-cancel all in-flight meshing work. gmsh-wasm runs synchronously inside
 * the worker, so the only reliable cancel is terminating the worker; the next
 * request spawns a fresh one (paying WASM init again, ~100 ms plus fetch).
 */
export function cancelMeshWork(reason = "Meshing was cancelled."): void {
  const error = new Error(reason);
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
    pendingRequests.get(response.id)?.onProgress?.({ phase: response.phase, elapsedMs: response.elapsedMs });
    return;
  }
  if (!isMeshWorkerSuccess(response) && !isMeshWorkerFailure(response)) return;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;
  pendingRequests.delete(response.id);
  if (isMeshWorkerFailure(response)) {
    pending.reject(new Error(response.error.message));
    return;
  }
  pending.resolve(response.result as never);
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
