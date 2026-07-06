// Build-time stub for meshWorkerClient.ts, swapped in by vite.config.ts when
// VITE_WASM_MESHING is off. Rollup resolves and transforms dynamically
// imported modules before tree-shaking, so merely dead-branching the
// import("./meshWorkerClient") call sites still triggers vite's worker
// sub-build — which emits the meshWorker chunk plus the ~44 MB
// gmsh-core.wasm asset into dist. Redirecting the module here keeps flag-off
// builds free of those assets (Cloudflare caps static assets at 25 MiB).
//
// Keep the exported surface in sync with meshWorkerClient.ts.
import type {
  MeshWorkerOperation,
  MeshWorkerPayloads,
  MeshWorkerResults
} from "./meshProtocol";

export type MeshProgressListener = (progress: { phase: string; elapsedMs: number }) => void;

const DISABLED_MESSAGE = "In-browser wasm meshing is disabled in this build (VITE_WASM_MESHING=0 opt-out). Rebuild without the opt-out to enable it.";

export function wasmMeshingEnabled(): boolean {
  return false;
}

export async function meshGeoScriptInWorker(
  _payload: MeshWorkerPayloads["meshGeoScript"],
  _onProgress?: MeshProgressListener
): Promise<MeshWorkerResults["meshGeoScript"]> {
  throw new Error(DISABLED_MESSAGE);
}

export async function meshStepFileInWorker(
  _payload: MeshWorkerPayloads["meshStepFile"],
  _onProgress?: MeshProgressListener
): Promise<MeshWorkerResults["meshStepFile"]> {
  throw new Error(DISABLED_MESSAGE);
}

export async function postMeshWorkerRequest<Operation extends MeshWorkerOperation>(
  _operation: Operation,
  _payload: MeshWorkerPayloads[Operation],
  _onProgress?: MeshProgressListener
): Promise<MeshWorkerResults[Operation]> {
  throw new Error(DISABLED_MESSAGE);
}

export function cancelMeshWork(_reason?: string): void {
  // Nothing to cancel: no worker is ever spawned in flag-off builds.
}
