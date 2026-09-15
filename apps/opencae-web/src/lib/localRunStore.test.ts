import { describe, expect, test } from "vitest";
import { createLocalRunStore, emitLocalRunEvent, finishLocalRun, LOCAL_RUN_EVENT_BUFFER_LIMIT } from "./localRunStore";

describe("localRunStore", () => {
  test("creates records with capped bookkeeping and single-flight lookup", () => {
    const store = createLocalRunStore(2);
    const first = store.createRecord("run-1");
    store.createRecord("run-2");
    expect(store.activeRun()?.runId).toBe("run-1");
    finishLocalRun(first, "complete", { type: "complete", message: "done" });
    expect(store.activeRun()?.runId).toBe("run-2");
    store.createRecord("run-3");
    // Cap-2 eviction drops the oldest record.
    expect(store.records.has("run-1")).toBe(false);
    expect(store.records.has("run-3")).toBe(true);
  });

  test("emits exactly one terminal event per run", () => {
    const store = createLocalRunStore();
    const record = store.createRecord("run-1");
    finishLocalRun(record, "complete", { type: "complete", message: "done" });
    finishLocalRun(record, "failed", { type: "error", message: "late" });
    const terminals = record.events.filter((event) => event.type === "complete" || event.type === "error" || event.type === "cancelled");
    expect(terminals).toHaveLength(1);
    expect(record.status).toBe("complete");
  });

  test("bounds the replay buffer while keeping the initial event", () => {
    const store = createLocalRunStore();
    const record = store.createRecord("run-1");
    emitLocalRunEvent(record, { type: "state", message: "start" });
    for (let index = 0; index < LOCAL_RUN_EVENT_BUFFER_LIMIT + 50; index += 1) {
      emitLocalRunEvent(record, { type: "progress", progress: index, message: `p${index}` });
    }
    expect(record.events.length).toBeLessThanOrEqual(LOCAL_RUN_EVENT_BUFFER_LIMIT);
    expect(record.events[0]?.type).toBe("state");
  });

  test("clamps progress monotonically", () => {
    const store = createLocalRunStore();
    const record = store.createRecord("run-1");
    emitLocalRunEvent(record, { type: "progress", progress: 50, message: "half" });
    emitLocalRunEvent(record, { type: "progress", progress: 10, message: "rewind" });
    expect(record.events.at(-1)?.progress).toBe(50);
  });
});
