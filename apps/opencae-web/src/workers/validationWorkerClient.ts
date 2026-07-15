import type { ValidationBenchmarkId, ValidationBenchmarkResult } from "../validation/benchmarkRegistry";

type ValidationWorkerResponse =
  | { ok: true; result: ValidationBenchmarkResult }
  | { ok: false; error: string };

let activeWorker: Worker | null = null;
let activeReject: ((reason: Error) => void) | null = null;

export function cancelValidationBenchmark(): void {
  activeWorker?.terminate();
  activeWorker = null;
  const reject = activeReject;
  activeReject = null;
  reject?.(new Error("Validation benchmark cancelled."));
}

export function runValidationBenchmarkInWorker(id: ValidationBenchmarkId): Promise<ValidationBenchmarkResult> {
  cancelValidationBenchmark();
  const worker = new Worker(new URL("./validationWorker.ts", import.meta.url), { type: "module" });
  activeWorker = worker;
  return new Promise((resolve, reject) => {
    activeReject = reject;
    worker.onmessage = (event: MessageEvent<ValidationWorkerResponse>) => {
      if (activeWorker === worker) {
        activeWorker = null;
        activeReject = null;
      }
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      if (activeWorker === worker) {
        activeWorker = null;
        activeReject = null;
      }
      worker.terminate();
      reject(new Error(event.message || "Validation worker failed."));
    };
    worker.postMessage({ id });
  });
}
