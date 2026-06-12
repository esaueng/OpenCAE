import { describe, expect, test, vi } from "vitest";
import { InMemoryJobQueueProvider, LocalRunStateProvider } from "./index";

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("InMemoryJobQueueProvider", () => {
  test("runs queued jobs to completion", async () => {
    const queue = new InMemoryJobQueueProvider();
    let ran = false;
    await queue.enqueue("job-1", async () => {
      ran = true;
    });
    await flushAsync();
    expect(ran).toBe(true);
    expect(queue.getStatus("job-1")).toBe("complete");
  });

  test("reports worker failures instead of swallowing them", async () => {
    const onError = vi.fn();
    const queue = new InMemoryJobQueueProvider({ onError });
    await queue.enqueue("job-1", async () => {
      throw new Error("disk full");
    });
    await flushAsync();
    expect(queue.getStatus("job-1")).toBe("failed");
    expect(onError).toHaveBeenCalledWith("job-1", expect.any(Error));
  });

  test("cancel before enqueue prevents the job from running", async () => {
    const queue = new InMemoryJobQueueProvider();
    await queue.cancel("job-1");
    let ran = false;
    await queue.enqueue("job-1", async () => {
      ran = true;
    });
    await flushAsync();
    expect(ran).toBe(false);
    expect(queue.getStatus("job-1")).toBe("cancelled");
  });

  test("cancel during a run keeps the cancelled status", async () => {
    const queue = new InMemoryJobQueueProvider();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await queue.enqueue("job-1", async () => {
      await gate;
    });
    await queue.cancel("job-1");
    release();
    await flushAsync();
    expect(queue.getStatus("job-1")).toBe("cancelled");
  });
});

describe("LocalRunStateProvider", () => {
  test("replays published events and notifies subscribers", () => {
    const runState = new LocalRunStateProvider();
    const seen: string[] = [];
    runState.publish("run-1", { runId: "run-1", type: "state", message: "queued", timestamp: "t0" });
    const unsubscribe = runState.subscribe("run-1", (event) => seen.push(event.message));
    runState.publish("run-1", { runId: "run-1", type: "complete", message: "done", timestamp: "t1" });
    unsubscribe();
    runState.publish("run-1", { runId: "run-1", type: "state", message: "ignored", timestamp: "t2" });
    expect(seen).toEqual(["done"]);
    expect(runState.getEvents("run-1").map((event) => event.message)).toEqual(["queued", "done", "ignored"]);
  });

  test("evicts the oldest listener-free runs once the tracked-run cap is reached", () => {
    const runState = new LocalRunStateProvider();
    for (let index = 0; index < 205; index += 1) {
      runState.publish(`run-${index}`, { runId: `run-${index}`, type: "state", message: "queued", timestamp: "t" });
    }
    expect(runState.getEvents("run-0")).toEqual([]);
    expect(runState.getEvents("run-204").length).toBe(1);
  });
});
