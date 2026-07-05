import { trySolveOpenCaeCoreStudy } from "./opencaeCoreSolve";
import {
  makeSolveRunEvent,
  type SolveWorkerRequest,
  type SolveWorkerResponse,
  type SolveWorkerResult
} from "./solveWorkerProtocol";
import type { DisplayModel, RunEvent, Study } from "@opencae/schema";

export type SolveWorkerPayload = {
  runId: string;
  study: Study;
  displayModel?: DisplayModel;
};

export type SolveWorkerHandlers = {
  onEvent: (event: RunEvent) => void;
  onResult: (result: SolveWorkerResult) => void;
  onError: (message: string) => void;
};

export type StartedSolveWorker = {
  cancel: () => void;
};

let requestCounter = 0;

export function startOpenCaeCoreSolveWorker(payload: SolveWorkerPayload, handlers: SolveWorkerHandlers): StartedSolveWorker {
  requestCounter += 1;
  const request: SolveWorkerRequest = {
    id: `solve-${Date.now().toString(36)}-${requestCounter.toString(36)}`,
    ...payload
  };

  if (typeof Worker === "undefined") {
    let cancelled = false;
    void runFallbackSolve(request, {
      onEvent: (event) => {
        if (!cancelled) handlers.onEvent(event);
      },
      onResult: (result) => {
        if (!cancelled) handlers.onResult(result);
      },
      onError: (message) => {
        if (!cancelled) handlers.onError(message);
      }
    });
    return {
      cancel() {
        cancelled = true;
      }
    };
  }

  const worker = new Worker(new URL("./solveWorker.ts", import.meta.url), { type: "module", name: "opencae-solve-worker" });
  let settled = false;
  const cleanup = () => {
    worker.removeEventListener("message", handleMessage);
    worker.removeEventListener("error", handleError);
    worker.terminate();
  };
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    callback();
    cleanup();
  };
  function handleMessage(event: MessageEvent<SolveWorkerResponse>) {
    const response = event.data;
    if (response.id !== request.id) return;
    if (response.type === "event") {
      handlers.onEvent(response.event);
      return;
    }
    if (response.type === "result") {
      finish(() => handlers.onResult(response.result));
      return;
    }
    finish(() => handlers.onError(response.message));
  }
  function handleError(event: ErrorEvent) {
    finish(() => handlers.onError(event.message || "OpenCAE Core solve worker failed."));
  }
  worker.addEventListener("message", handleMessage);
  worker.addEventListener("error", handleError);
  worker.postMessage(request);

  return {
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
    }
  };
}

async function runFallbackSolve(request: SolveWorkerRequest, handlers: SolveWorkerHandlers): Promise<void> {
  const startedAt = Date.now();
  const dynamic = request.study.type === "dynamic_structural";
  handlers.onEvent(makeSolveRunEvent(request.runId, "state", 0, dynamic ? "OpenCAE Core dynamic browser solve queued." : "OpenCAE Core browser solve queued.", startedAt));
  await Promise.resolve();
  handlers.onEvent(makeSolveRunEvent(request.runId, "progress", 30, dynamic ? "Building OpenCAE Core dynamic model and applying solver limits." : "Building OpenCAE Core model and applying solver limits.", startedAt));
  await Promise.resolve();
  const solved = trySolveOpenCaeCoreStudy({
    study: request.study,
    runId: request.runId,
    displayModel: request.displayModel
  });
  if (!solved.ok) {
    handlers.onError(solved.reason);
    return;
  }
  handlers.onEvent(makeSolveRunEvent(request.runId, "progress", 90, "Writing OpenCAE Core result fields.", startedAt));
  handlers.onResult(solved.result);
}
