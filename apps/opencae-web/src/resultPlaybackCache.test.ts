import type { ResultField } from "@opencae/schema";
import { describe, expect, test } from "vitest";
import {
  hydratePreparedPlaybackFrame,
  planPlaybackFrameCache,
  preparePlaybackFrames,
  playbackMemoryBudgetBytes
} from "./resultPlaybackCache";

function resultField(frameIndex: number, values: number[]): ResultField {
  return {
    id: `stress-${frameIndex}`,
    runId: "run-1",
    type: "stress",
    location: "face",
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    units: "MPa",
    frameIndex,
    timeSeconds: frameIndex * 0.01
  };
}

describe("result playback cache", () => {
  test("uses the desktop memory budget unless device memory is constrained", () => {
    expect(playbackMemoryBudgetBytes(8)).toBe(192 * 1024 * 1024);
    expect(playbackMemoryBudgetBytes(2)).toBe(64 * 1024 * 1024);
  });

  test("chooses full 60 fps presentation frames when they fit", () => {
    const fields = [resultField(0, [1, 2]), resultField(1, [3, 4]), resultField(2, [5, 6])];

    const plan = planPlaybackFrameCache({
      fields,
      frameIndexes: [0, 1, 2],
      playbackFps: 30,
      budgetBytes: 100_000
    });

    expect(plan.mode).toBe("full");
    expect(plan.presentationFps).toBe(60);
    expect(plan.framePositions.length).toBeGreaterThan(3);
  });

  test("falls back through reduced fps and integer solver frames before disabling cache", () => {
    const fields = [resultField(0, Array(100).fill(1)), resultField(1, Array(100).fill(2))];

    expect(planPlaybackFrameCache({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 3_600 }).mode).toBe("reducedFps");
    expect(planPlaybackFrameCache({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 1_900 }).mode).toBe("integerFrames");
    expect(planPlaybackFrameCache({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 900 }).mode).toBe("fallback");
  });

  test("prepares transferable typed-array frames and hydrates them back to result fields", () => {
    const prepared = preparePlaybackFrames({
      fields: [resultField(0, [0, 10]), resultField(1, [10, 30])],
      frameIndexes: [0, 1],
      playbackFps: 30,
      budgetBytes: 100_000
    });

    expect(prepared.mode).toBe("full");
    expect(prepared.frames[0]?.fields[0]?.values).toBeInstanceOf(Float64Array);
    expect(prepared.actualBytes).toBeGreaterThan(0);

    const halfway = prepared.frames.find((frame) => Math.abs(frame.framePosition - 0.5) < 0.001);
    expect(halfway).toBeTruthy();
    expect(hydratePreparedPlaybackFrame(halfway!).fields[0]?.values).toEqual([5, 20]);
  });
});
