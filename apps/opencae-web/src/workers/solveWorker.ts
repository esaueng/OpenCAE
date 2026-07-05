import { trySolveOpenCaeCoreStudy } from "./opencaeCoreSolve";
import { makeSolveRunEvent, type SolveWorkerRequest, type SolveWorkerResponse } from "./solveWorkerProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<SolveWorkerRequest>) => void): void;
  postMessage(message: SolveWorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.addEventListener("message", (event) => {
  void handleRequest(event.data);
});

async function handleRequest(request: SolveWorkerRequest): Promise<void> {
  const startedAt = Date.now();
  const dynamic = request.study.type === "dynamic_structural";
  try {
    postEvent(request, "state", 0, dynamic ? "OpenCAE Core dynamic browser solve queued." : "OpenCAE Core browser solve queued.", startedAt);
    await Promise.resolve();
    postEvent(request, "progress", 30, dynamic ? "Building OpenCAE Core dynamic model and applying solver limits." : "Building OpenCAE Core model and applying solver limits.", startedAt);
    await Promise.resolve();
    const solved = trySolveOpenCaeCoreStudy({
      study: request.study,
      runId: request.runId,
      displayModel: request.displayModel
    });
    if (!solved.ok) {
      workerScope.postMessage({ id: request.id, type: "error", message: solved.reason });
      return;
    }
    postEvent(request, "progress", 90, "Writing OpenCAE Core result fields.", startedAt);
    workerScope.postMessage({ id: request.id, type: "result", result: solved.result });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : "OpenCAE Core browser solve failed."
    });
  }
}

function postEvent(
  request: SolveWorkerRequest,
  type: "state" | "progress",
  progress: number,
  message: string,
  startedAt: number
): void {
  workerScope.postMessage({
    id: request.id,
    type: "event",
    event: makeSolveRunEvent(request.runId, type, progress, message, startedAt)
  });
}
