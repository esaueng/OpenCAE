import type { ResultField } from "@opencae/schema";
import { describe, expect, test } from "vitest";
import {
  createPerformanceWorkerRequest,
  isPerformanceWorkerFailure,
  isPerformanceWorkerSuccess,
  normalizePerformanceWorkerError,
  transferablesForPerformanceWorkerRequest
} from "./performanceProtocol";
import { packResultFieldsForPlayback } from "../resultPlaybackCache";

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

  test("creates typed local solve requests for the performance worker", () => {
    const request = createPerformanceWorkerRequest("solveLocalStudy", {
      runId: "run-local-1",
      study: {
        id: "study-1",
        projectId: "project-1",
        name: "Static Stress",
        type: "static_stress",
        geometryScope: [],
        materialAssignments: [],
        namedSelections: [],
        contacts: [],
        constraints: [],
        loads: [],
        meshSettings: { preset: "medium", status: "complete" },
        solverSettings: {},
        validation: [],
        runs: []
      },
      debugResults: true
    });

    expect(request.operation).toBe("solveLocalStudy");
    expect(request.payload.runId).toBe("run-local-1");
    expect(request.payload.debugResults).toBe(true);
  });

  test("includes packed playback input buffers as worker request transferables", () => {
    const packedFields = packResultFieldsForPlayback([
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [10, 30], min: 0, max: 100, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [30, 70], min: 0, max: 100, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ]);

    expect(packedFields).not.toBeNull();
    const request = createPerformanceWorkerRequest("preparePlaybackFrames", {
      packedFields: packedFields!,
      frameIndexes: [0, 1],
      playbackFps: 30,
      budgetBytes: 64 * 1024 * 1024,
      cacheKey: "run-1:stress"
    });

    expect("fields" in request.payload).toBe(false);
    expect(transferablesForPerformanceWorkerRequest(request)).toEqual(expect.arrayContaining([
      packedFields!.frameIndexes.buffer,
      packedFields!.times.buffer,
      packedFields!.fieldOffsets.buffer,
      packedFields!.fieldLengths.buffer,
      packedFields!.fieldMins.buffer,
      packedFields!.fieldMaxes.buffer,
      packedFields!.values.buffer
    ]));
  });

  test("narrows success and failure responses", () => {
    const success = {
      id: "perf-1",
      operation: "prepareResultFrame",
      ok: true,
      result: { fields: [] }
    };
    const failure = {
      id: "perf-2",
      operation: "prepareResultFrame",
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
});
