import type { SolveProgressEvent } from "@opencae/solve-pipeline";
import { trySolveOpenCaeCoreStudy } from "./opencaeCoreSolve";
import type { LocalSolveResult } from "./performanceProtocol";
import {
  createSolveWorkerRequestId,
  isSolveWorkerProgress,
  isSolveWorkerResult,
  type SolveWorkerRequest,
  type SolveWorkerResponse,
  type SolveWorkerSolvePayload
} from "./solveProtocol";
import { workerClientError } from "./workerClientError";

/**
 * Client for the dedicated solve worker. Mirrors performanceClient's worker
 * lifecycle handling, plus:
 * - interim progress callbacks from the solver hooks,
 * - cooperative cancel with a terminate+respawn fallback: a blocked worker
 *   thread cannot observe the cancel message, so after
 *   CANCEL_TERMINATE_TIMEOUT_MS the worker is killed and recreated lazily.
 *   Only solve work lives on this worker, so termination never disturbs STL
 *   decode/playback on the shared performance worker.
 * - an inline fallback when Workers are unavailable (tests, SSR), running the
 *   same adapter path with the same hooks.
 */

export const CANCEL_TERMINATE_TIMEOUT_MS = 2000;

export class LocalSolveError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "LocalSolveError";
    this.code = code;
  }
}

export function isCancelledSolveError(error: unknown): boolean {
  return error instanceof LocalSolveError && error.code === "cancelled";
}

export type LocalSolveCompletion = {
  result: LocalSolveResult;
  solverBackend: string;
  /** Peak worker-heap bytes (Chrome-only performance.memory sampling in the worker); measurement telemetry, absent elsewhere. */
  workerPeakHeapBytes?: number;
};

export type LocalSolveHandle = {
  completion: Promise<LocalSolveCompletion>;
  cancel: () => void;
};

type PendingSolve = {
  id: string;
  resolve: (completion: LocalSolveCompletion) => void;
  reject: (error: Error) => void;
  onProgress?: (event: SolveProgressEvent) => void;
  cancelTimer?: ReturnType<typeof setTimeout>;
};

let workerInstance: Worker | null = null;
const pendingSolves = new Map<string, PendingSolve>();

export function startLocalSolve(
  payload: SolveWorkerSolvePayload,
  onProgress?: (event: SolveProgressEvent) => void
): LocalSolveHandle {
  if (typeof Worker === "undefined") return startInlineSolve(payload, onProgress);

  const id = createSolveWorkerRequestId();
  let worker: Worker;
  try {
    worker = getSolveWorker();
  } catch (error) {
    return rejectedSolveHandle(workerClientError(error, "Could not start the solve worker."));
  }
  const completion = new Promise<LocalSolveCompletion>((resolve, reject) => {
    pendingSolves.set(id, { id, resolve, reject, onProgress });
  });
  const request: SolveWorkerRequest = { kind: "solve", id, payload };
  try {
    worker.postMessage(request);
  } catch (error) {
    rejectPending(id, workerClientError(error, "Could not send work to the solve worker."));
  }

  return {
    completion,
    cancel: () => {
      const pending = pendingSolves.get(id);
      if (!pending) return;
      // Cooperative first: the solver hooks check shouldCancel between CG
      // iterations / time steps if the worker event loop ever yields.
      try {
        workerInstance?.postMessage({ kind: "cancel", id } satisfies SolveWorkerRequest);
      } catch {
        workerInstance?.terminate();
        workerInstance = null;
        rejectPending(id, new LocalSolveError("OpenCAE Core solve cancelled.", "cancelled"));
        return;
      }
      if (pending.cancelTimer) return;
      pending.cancelTimer = setTimeout(() => {
        if (!pendingSolves.has(id)) return;
        // The worker is still blocked in the solve: terminate it. It respawns
        // lazily on the next solve; no other work runs on this worker.
        workerInstance?.terminate();
        workerInstance = null;
        rejectPending(id, new LocalSolveError("OpenCAE Core solve cancelled.", "cancelled"));
      }, CANCEL_TERMINATE_TIMEOUT_MS);
    }
  };
}

function rejectedSolveHandle(error: Error): LocalSolveHandle {
  return {
    completion: Promise.reject(error),
    cancel: () => undefined
  };
}

function startInlineSolve(
  payload: SolveWorkerSolvePayload,
  onProgress?: (event: SolveProgressEvent) => void
): LocalSolveHandle {
  let cancelled = false;
  const completion = new Promise<LocalSolveCompletion>((resolve, reject) => {
    // Deferred one tick so callers can subscribe/cancel before the synchronous
    // solve blocks this thread.
    setTimeout(() => {
      if (cancelled) {
        reject(new LocalSolveError("OpenCAE Core solve cancelled.", "cancelled"));
        return;
      }
      try {
        const outcome = trySolveOpenCaeCoreStudy({
          study: payload.study,
          runId: payload.runId,
          displayModel: payload.displayModel,
          hooks: {
            onProgress,
            shouldCancel: () => cancelled
          }
        });
        if (!outcome.ok) {
          reject(new LocalSolveError(outcome.reason, outcome.code));
          return;
        }
        resolve({ result: outcome.result, solverBackend: outcome.solverBackend });
      } catch (error) {
        reject(error instanceof Error ? error : new LocalSolveError(String(error)));
      }
    }, 0);
  });
  return {
    completion,
    cancel: () => {
      cancelled = true;
    }
  };
}

function getSolveWorker(): Worker {
  if (workerInstance) return workerInstance;
  workerInstance = new Worker(new URL("./solveWorker.ts", import.meta.url), { type: "module", name: "opencae-solve-worker" });
  workerInstance.addEventListener("message", handleSolveWorkerMessage);
  workerInstance.addEventListener("error", handleSolveWorkerError);
  return workerInstance;
}

function handleSolveWorkerMessage(event: MessageEvent<SolveWorkerResponse>): void {
  const response = event.data;
  if (isSolveWorkerProgress(response)) {
    pendingSolves.get(response.id)?.onProgress?.(response.event);
    return;
  }
  if (!isSolveWorkerResult(response)) return;
  const pending = pendingSolves.get(response.id);
  if (!pending) return;
  clearPending(pending);
  if (response.ok) {
    pending.resolve({
      result: response.result,
      solverBackend: response.solverBackend,
      ...(response.workerPeakHeapBytes !== undefined ? { workerPeakHeapBytes: response.workerPeakHeapBytes } : {})
    });
    return;
  }
  pending.reject(new LocalSolveError(response.error.message, response.error.code));
}

function handleSolveWorkerError(event: ErrorEvent): void {
  const error = new LocalSolveError(event.message || "Solve worker failed.");
  for (const pending of [...pendingSolves.values()]) {
    clearPending(pending);
    pending.reject(error);
  }
  workerInstance?.terminate();
  workerInstance = null;
}

function rejectPending(id: string, error: Error): void {
  const pending = pendingSolves.get(id);
  if (!pending) return;
  clearPending(pending);
  pending.reject(error);
}

function clearPending(pending: PendingSolve): void {
  if (pending.cancelTimer) clearTimeout(pending.cancelTimer);
  pendingSolves.delete(pending.id);
}
