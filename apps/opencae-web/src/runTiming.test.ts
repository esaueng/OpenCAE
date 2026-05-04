import { describe, expect, test } from "vitest";
import { deriveRunTiming } from "./runTiming";

describe("deriveRunTiming", () => {
  test("keeps server-provided timing authoritative", () => {
    expect(deriveRunTiming({
      progress: 30,
      eventTiming: { elapsedMs: 1200, estimatedDurationMs: 6200, estimatedRemainingMs: 5000 },
      startedAtMs: 1000,
      nowMs: 10000
    })).toEqual({ elapsedMs: 1200, estimatedDurationMs: 6200, estimatedRemainingMs: 5000 });
  });

  test("estimates elapsed and remaining time from progress when event timing is missing", () => {
    expect(deriveRunTiming({
      progress: 30,
      eventTiming: null,
      startedAtMs: 1000,
      nowMs: 10000
    })).toEqual({ elapsedMs: 9000, estimatedRemainingMs: 21000 });
  });

  test("shows elapsed without remaining estimate before meaningful progress", () => {
    expect(deriveRunTiming({
      progress: 0,
      eventTiming: null,
      startedAtMs: 1000,
      nowMs: 10000
    })).toEqual({ elapsedMs: 9000 });
  });

  test("returns null when no valid run start time is available", () => {
    expect(deriveRunTiming({
      progress: 30,
      eventTiming: null,
      startedAtMs: null,
      nowMs: 10000
    })).toBeNull();
  });
});
