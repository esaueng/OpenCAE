import { describe, expect, test } from "vitest";
import {
  advancePlaybackTimeline,
  boundedPlaybackOrdinalDelta,
  frameIndexForPlaybackOrdinal,
  loopedPlaybackOrdinalPosition,
  playbackOrdinalForSolverFramePosition,
  PLAYBACK_ENDPOINT_HOLD_MS,
  solverFramePositionForPlaybackOrdinal
} from "./resultPlaybackTimeline";

describe("result playback timeline", () => {
  test("maps sparse solver frames onto dense display ordinals", () => {
    const frames = [0, 7, 12];

    expect(playbackOrdinalForSolverFramePosition(frames, 0)).toBe(0);
    expect(playbackOrdinalForSolverFramePosition(frames, 7)).toBe(1);
    expect(playbackOrdinalForSolverFramePosition(frames, 12)).toBe(2);
    expect(frameIndexForPlaybackOrdinal(frames, 1.2)).toBe(7);
  });

  test("converts display ordinals back to interpolated solver frame positions", () => {
    const frames = [0, 7, 12];

    expect(solverFramePositionForPlaybackOrdinal(frames, 0)).toBe(0);
    expect(solverFramePositionForPlaybackOrdinal(frames, 1)).toBe(7);
    expect(solverFramePositionForPlaybackOrdinal(frames, 1.5)).toBe(9.5);
  });

  test("loops by display frame count instead of sparse solver span", () => {
    expect(loopedPlaybackOrdinalPosition(3, 3)).toBe(0);
    expect(loopedPlaybackOrdinalPosition(3, 4.25)).toBe(1.25);
  });

  test("caps elapsed playback to one visible frame so slow renders do not skip labels", () => {
    expect(boundedPlaybackOrdinalDelta(16, 100)).toBeCloseTo(0.16);
    expect(boundedPlaybackOrdinalDelta(500, 100)).toBe(1);
  });

  test("holds the last and first frame in restart loops", () => {
    const frameDurationMs = 100;
    const atLast = advancePlaybackTimeline({
      frameCount: 3,
      frameDurationMs,
      elapsedMs: 100,
      mode: "restart",
      state: { ordinalPosition: 1, direction: 1, endpointHoldRemainingMs: 0 }
    });

    expect(atLast).toEqual({ ordinalPosition: 2, direction: 1, endpointHoldRemainingMs: PLAYBACK_ENDPOINT_HOLD_MS });

    const stillHoldingLast = advancePlaybackTimeline({
      frameCount: 3,
      frameDurationMs,
      elapsedMs: 250,
      mode: "restart",
      state: atLast
    });

    expect(stillHoldingLast).toEqual({ ordinalPosition: 2, direction: 1, endpointHoldRemainingMs: 250 });

    const wrappedToFirst = advancePlaybackTimeline({
      frameCount: 3,
      frameDurationMs,
      elapsedMs: 350,
      mode: "restart",
      state: stillHoldingLast
    });

    expect(wrappedToFirst).toEqual({ ordinalPosition: 0, direction: 1, endpointHoldRemainingMs: PLAYBACK_ENDPOINT_HOLD_MS });
  });

  test("reverses direction after holding endpoints in reverse loops", () => {
    const frameDurationMs = 100;
    const atLast = advancePlaybackTimeline({
      frameCount: 3,
      frameDurationMs,
      elapsedMs: 100,
      mode: "reverse",
      state: { ordinalPosition: 1, direction: 1, endpointHoldRemainingMs: 0 }
    });

    expect(atLast).toEqual({ ordinalPosition: 2, direction: -1, endpointHoldRemainingMs: PLAYBACK_ENDPOINT_HOLD_MS });

    const movingBackward = advancePlaybackTimeline({
      frameCount: 3,
      frameDurationMs,
      elapsedMs: 600,
      mode: "reverse",
      state: atLast
    });

    expect(movingBackward).toEqual({ ordinalPosition: 1, direction: -1, endpointHoldRemainingMs: 0 });

    const atFirst = advancePlaybackTimeline({
      frameCount: 3,
      frameDurationMs,
      elapsedMs: 100,
      mode: "reverse",
      state: movingBackward
    });

    expect(atFirst).toEqual({ ordinalPosition: 0, direction: 1, endpointHoldRemainingMs: PLAYBACK_ENDPOINT_HOLD_MS });
  });
});
