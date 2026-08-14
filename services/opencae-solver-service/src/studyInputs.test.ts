import { describe, expect, test } from "vitest";
import type { Load } from "@opencae/schema";
import { STANDARD_GRAVITY, loadForceNewtons } from "./studyInputs";

describe("loadForceNewtons", () => {
  test("derives gravity force from the visible mass and ignores hidden overrides", () => {
    const load: Load = {
      id: "payload",
      type: "gravity",
      selectionRef: "payload-face",
      parameters: { value: 100, units: "kg", equivalentForceN: 1 },
      status: "complete"
    };

    expect(loadForceNewtons(load)).toBeCloseTo(100 * STANDARD_GRAVITY);
  });

  test("preserves ordinary force loads", () => {
    const load: Load = {
      id: "force",
      type: "force",
      selectionRef: "load-face",
      parameters: { value: 500, units: "N" },
      status: "complete"
    };

    expect(loadForceNewtons(load)).toBe(500);
  });
});
