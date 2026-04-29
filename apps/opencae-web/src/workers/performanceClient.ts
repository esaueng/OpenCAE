import type { ResultField } from "@opencae/schema";
import {
  createPerformanceWorkerRequest,
  isPerformanceWorkerFailure,
  isPerformanceWorkerSuccess,
  type PerformanceWorkerOperation,
  type PerformanceWorkerPayloads,
  type PerformanceWorkerResponse,
  type PerformanceWorkerResults
} from "./performanceProtocol";
import { fallbackSolveLocalStudy } from "./localSolve";

type PendingRequest<Operation extends PerformanceWorkerOperation = PerformanceWorkerOperation> = {
  operation: Operation;
  resolve: (result: PerformanceWorkerResults[Operation]) => void;
  reject: (error: Error) => void;
};

let workerInstance: Worker | null = null;
const pendingRequests = new Map<string, PendingRequest>();

export { fallbackSolveLocalStudy };

export async function solveLocalStudyInWorker(
  payload: PerformanceWorkerPayloads["solveLocalStudy"]
): Promise<PerformanceWorkerResults["solveLocalStudy"]> {
  return postPerformanceWorkerRequest("solveLocalStudy", payload);
}

export async function prepareResultFrameInWorker(fields: ResultField[], framePosition: number): Promise<ResultField[]> {
  const result = await postPerformanceWorkerRequest("prepareResultFrame", { fields, framePosition });
  return result.fields;
}

export async function postPerformanceWorkerRequest<Operation extends PerformanceWorkerOperation>(
  operation: Operation,
  payload: PerformanceWorkerPayloads[Operation],
  transfer: Transferable[] = []
): Promise<PerformanceWorkerResults[Operation]> {
  const worker = getPerformanceWorker();
  if (!worker) {
    throw new Error("Browser performance workers are not available.");
  }
  const request = createPerformanceWorkerRequest(operation, payload);
  return new Promise((resolve, reject) => {
    pendingRequests.set(request.id, { operation, resolve, reject } as PendingRequest);
    worker.postMessage(request, transfer);
  });
}

function getPerformanceWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (workerInstance) return workerInstance;
  workerInstance = new Worker(new URL("./performanceWorker.ts", import.meta.url), { type: "module", name: "opencae-performance-worker" });
  workerInstance.addEventListener("message", handlePerformanceWorkerMessage);
  workerInstance.addEventListener("error", handlePerformanceWorkerError);
  return workerInstance;
}

function handlePerformanceWorkerMessage(event: MessageEvent<PerformanceWorkerResponse>) {
  const response = event.data;
  if (!isPerformanceWorkerSuccess(response) && !isPerformanceWorkerFailure(response)) return;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;
  pendingRequests.delete(response.id);
  if (isPerformanceWorkerFailure(response)) {
    pending.reject(new Error(response.error.message));
    return;
  }
  pending.resolve(response.result as never);
}

function handlePerformanceWorkerError(event: ErrorEvent) {
  const error = new Error(event.message || "Performance worker failed.");
  for (const pending of pendingRequests.values()) {
    pending.reject(error);
  }
  pendingRequests.clear();
  workerInstance?.terminate();
  workerInstance = null;
}
