import { afterEach, describe, expect, test, vi } from "vitest";
import type { SolveWorkerSolvePayload } from "./solveProtocol";

class ThrowingWorker {
  static instances: ThrowingWorker[] = [];

  readonly addEventListener = vi.fn();
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn(() => {
    throw new DOMException("The payload could not be cloned.", "DataCloneError");
  });

  constructor() {
    ThrowingWorker.instances.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  ThrowingWorker.instances = [];
});

describe("worker clients", () => {
  test("rejects performance requests when message dispatch fails", async () => {
    vi.stubGlobal("Worker", ThrowingWorker);
    const { postPerformanceWorkerRequest } = await import("./performanceClient");

    await expect(postPerformanceWorkerRequest("prepareResultFrame", { fields: [], framePosition: 0 })).rejects.toThrow("payload could not be cloned");
  });

  test("rejects mesh requests and releases the worker when message dispatch fails", async () => {
    vi.stubGlobal("Worker", ThrowingWorker);
    const { postMeshWorkerRequest } = await import("./meshWorkerClient");

    await expect(postMeshWorkerRequest("inspectStepFile", { stepContent: new ArrayBuffer(8) })).rejects.toThrow("payload could not be cloned");
    expect(ThrowingWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  test("returns a rejected solve completion when initial message dispatch fails", async () => {
    vi.stubGlobal("Worker", ThrowingWorker);
    const { startLocalSolve } = await import("./solveWorkerClient");

    const handle = startLocalSolve({} as SolveWorkerSolvePayload);

    await expect(handle.completion).rejects.toThrow("payload could not be cloned");
  });

  test("hard-cancels a solve when the cooperative cancel message cannot be sent", async () => {
    class CancelThrowingWorker extends ThrowingWorker {
      override readonly postMessage = vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new DOMException("The worker is no longer running.", "InvalidStateError");
        });
    }
    vi.stubGlobal("Worker", CancelThrowingWorker);
    const { isCancelledSolveError, startLocalSolve } = await import("./solveWorkerClient");
    const handle = startLocalSolve({} as SolveWorkerSolvePayload);

    handle.cancel();

    const error = await handle.completion.catch((reason: unknown) => reason);
    expect(isCancelledSolveError(error)).toBe(true);
    expect(CancelThrowingWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
});
