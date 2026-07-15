import type { SolveProgressEvent } from "@opencae/solve-pipeline";
import { normalizeSolverBackend, trySolveOpenCaeCoreStudy } from "./opencaeCoreSolve";
import {
  isSolveWorkerResult,
  normalizeSolveWorkerError,
  transferablesForSolveResult,
  transferablesForVariant,
  type SolveWorkerRequest,
  type SolveWorkerResponse,
  type SolveWorkerSolvePayload
} from "./solveProtocol";

/**
 * Dedicated OpenCAE Core solve worker. One solve at a time; forwards real
 * solver progress hooks as interim messages and honors cooperative cancel
 * requests via shouldCancel. The client terminates + respawns this worker if a
 * blocking solve cannot observe the cancel message in time — that never
 * disturbs the shared performance worker (STL decode / playback).
 */

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<SolveWorkerRequest>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const workerScope = self as unknown as WorkerScope;
const cancelledRequestIds = new Set<string>();

// Forward at most ~20 progress messages per second per phase transition; the
// CG loop reports every 25 iterations which can be thousands of events.
const PROGRESS_FORWARD_INTERVAL_MS = 50;

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || typeof request !== "object") return;
  if (request.kind === "cancel") {
    cancelledRequestIds.add(request.id);
    return;
  }
  if (request.kind === "solve") {
    handleSolve(request.id, request.payload);
  }
});

function handleSolve(id: string, payload: SolveWorkerSolvePayload): void {
  let lastForwardedAt = 0;
  let lastPhase = "";
  // Peak worker-heap watermark, sampled where the blocked worker thread
  // actually runs code: inside the solver progress hook. Chrome-only
  // (performance.memory is non-standard); stays undefined elsewhere.
  let peakHeapBytes = sampleWorkerHeapBytes();
  const onProgress = (progress: SolveProgressEvent) => {
    const heapBytes = sampleWorkerHeapBytes();
    if (heapBytes !== undefined && (peakHeapBytes === undefined || heapBytes > peakHeapBytes)) peakHeapBytes = heapBytes;
    const now = Date.now();
    const phaseChanged = progress.phase !== lastPhase;
    const finished = progress.total > 0 && progress.completed >= progress.total;
    if (!phaseChanged && !finished && now - lastForwardedAt < PROGRESS_FORWARD_INTERVAL_MS) return;
    lastForwardedAt = now;
    lastPhase = progress.phase;
    postResponse({ kind: "progress", id, event: progress });
  };

  try {
    if (normalizeSolverBackend(payload.study) !== "opencae_core_local") {
      throw new Error("Unsupported solver backend for a local solve. Simulations run locally in your browser with OpenCAE Core (the cloud backend was retired).");
    }
    const outcome = trySolveOpenCaeCoreStudy({
      study: payload.study,
      runId: payload.runId,
      displayModel: payload.displayModel,
      customMaterials: payload.customMaterials,
      hooks: {
        onProgress,
        shouldCancel: () => cancelledRequestIds.has(id)
      },
      onVariantComplete: (variant, surfaceMesh) => {
        workerScope.postMessage({ kind: "variant", id, variant, surfaceMesh } satisfies SolveWorkerResponse, transferablesForVariant(variant));
      }
    });
    if (!outcome.ok) {
      postResponse({ kind: "result", id, ok: false, error: normalizeSolveWorkerError(outcome.reason, outcome.code) });
      return;
    }
    const finalHeapBytes = sampleWorkerHeapBytes();
    if (finalHeapBytes !== undefined && (peakHeapBytes === undefined || finalHeapBytes > peakHeapBytes)) peakHeapBytes = finalHeapBytes;
    const message: SolveWorkerResponse = {
      kind: "result",
      id,
      ok: true,
      solverBackend: outcome.solverBackend,
      result: outcome.result,
      ...(peakHeapBytes !== undefined ? { workerPeakHeapBytes: peakHeapBytes } : {})
    };
    workerScope.postMessage(message, transferablesForSolveResult(outcome.result));
  } catch (error) {
    postResponse({ kind: "result", id, ok: false, error: normalizeSolveWorkerError(error) });
  } finally {
    cancelledRequestIds.delete(id);
  }
}

function sampleWorkerHeapBytes(): number | undefined {
  const memory = (globalThis.performance as unknown as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
  return typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
    ? memory.usedJSHeapSize
    : undefined;
}

function postResponse(message: SolveWorkerResponse): void {
  if (message.kind === "result" && !isSolveWorkerResult(message)) return;
  workerScope.postMessage(message);
}
