// Offline-readiness indicator state machine (Workstream C). Honest-results
// conventions: "Offline-ready" only after the SW has everything cached,
// nothing misleading when there is no SW at all.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  advanceOfflineReadiness,
  getOfflineReadiness,
  nextOfflineReadiness,
  offlineReadinessLabel,
  resetOfflineReadinessForTests,
  subscribeOfflineReadiness
} from "./offlineStatus";

afterEach(() => {
  resetOfflineReadinessForTests();
});

describe("nextOfflineReadiness", () => {
  test("follows the install lifecycle", () => {
    expect(nextOfflineReadiness("unknown", "preparing")).toBe("preparing");
    expect(nextOfflineReadiness("preparing", "ready")).toBe("ready");
    expect(nextOfflineReadiness("preparing", "failed")).toBe("failed");
    expect(nextOfflineReadiness("unknown", "unsupported")).toBe("unsupported");
  });

  test("never downgrades from ready (an updating SW does not uncache the current version)", () => {
    expect(nextOfflineReadiness("ready", "preparing")).toBe("ready");
    expect(nextOfflineReadiness("ready", "failed")).toBe("ready");
    expect(nextOfflineReadiness("ready", "unsupported")).toBe("ready");
  });
});

describe("offlineReadinessLabel", () => {
  test("only ever claims what is true", () => {
    expect(offlineReadinessLabel("ready")).toBe("Offline-ready");
    expect(offlineReadinessLabel("preparing")).toBe("Preparing offline assets…");
    // No SW, failed install, or not-yet-registered: say nothing rather than
    // anything misleading.
    expect(offlineReadinessLabel("unknown")).toBeNull();
    expect(offlineReadinessLabel("unsupported")).toBeNull();
    expect(offlineReadinessLabel("failed")).toBeNull();
  });
});

describe("readiness store", () => {
  test("starts unknown (dev and vitest never register a SW)", () => {
    expect(getOfflineReadiness()).toBe("unknown");
  });

  test("notifies subscribers on transitions and supports unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOfflineReadiness(listener);

    advanceOfflineReadiness("preparing");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getOfflineReadiness()).toBe("preparing");

    advanceOfflineReadiness("preparing"); // no-op transition: no notification
    expect(listener).toHaveBeenCalledTimes(1);

    advanceOfflineReadiness("ready");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getOfflineReadiness()).toBe("ready");

    unsubscribe();
    advanceOfflineReadiness("failed"); // ignored anyway (ready is sticky)
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getOfflineReadiness()).toBe("ready");
  });
});
