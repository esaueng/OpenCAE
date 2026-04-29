import type { ResultField, Study } from "@opencae/schema";
import { describe, expect, test } from "vitest";
import {
  createPerformanceWorkerRequest,
  isPerformanceWorkerFailure,
  isPerformanceWorkerSuccess,
  normalizePerformanceWorkerError
} from "./performanceProtocol";

describe("performance worker protocol", () => {
  test("creates typed requests with stable ids and operation names", () => {
    const request = createPerformanceWorkerRequest("prepareResultFrame", {
      fields: [] as ResultField[],
      framePosition: 0.5
    });

    expect(request.id).toMatch(/^perf-/);
    expect(request.operation).toBe("prepareResultFrame");
    expect(request.payload.framePosition).toBe(0.5);
  });

  test("creates typed playback-frame pre-render requests", () => {
    const request = createPerformanceWorkerRequest("preparePlaybackFrames", {
      fields: [] as ResultField[],
      frameIndexes: [0, 1, 2],
      playbackFps: 30,
      budgetBytes: 64 * 1024 * 1024,
      cacheKey: "run-1:stress"
    });

    expect(request.operation).toBe("preparePlaybackFrames");
    expect(request.payload.cacheKey).toBe("run-1:stress");
    expect(request.payload.frameIndexes).toEqual([0, 1, 2]);
  });

  test("narrows success and failure responses", () => {
    const success = {
      id: "perf-1",
      operation: "solveLocalStudy",
      ok: true,
      result: { summary: {}, fields: [] }
    };
    const failure = {
      id: "perf-2",
      operation: "solveLocalStudy",
      ok: false,
      error: { message: "cancelled", name: "AbortError" }
    };

    expect(isPerformanceWorkerSuccess(success)).toBe(true);
    expect(isPerformanceWorkerFailure(success)).toBe(false);
    expect(isPerformanceWorkerSuccess(failure)).toBe(false);
    expect(isPerformanceWorkerFailure(failure)).toBe(true);
  });

  test("normalizes thrown values for cross-thread delivery", () => {
    const error = normalizePerformanceWorkerError(new TypeError("bad mesh"));

    expect(error).toMatchObject({ name: "TypeError", message: "bad mesh" });
    expect(normalizePerformanceWorkerError("plain")).toEqual({ name: "Error", message: "plain" });
  });

  test("types solve requests without changing the study contract", () => {
    const study = { id: "study-1", type: "static_stress" } as Study;
    const request = createPerformanceWorkerRequest("solveLocalStudy", {
      runId: "run-1",
      study,
      analysisMesh: undefined
    });

    expect(request.payload.study).toBe(study);
  });
});
