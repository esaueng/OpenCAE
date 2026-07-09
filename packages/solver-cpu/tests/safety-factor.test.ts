import { describe, expect, test } from "vitest";
import {
  nodalSafetyFactorValues,
  SAFETY_FACTOR_DISPLAY_CAP,
  SAFETY_FACTOR_DISPLAY_FLOOR
} from "../src/results";

// The node-located safety-factor contour feeds the web viewer's linear, min-anchored
// color palette. Undefined/unbounded ratios must therefore clamp to the display CAP
// (safest), never to 0 — 0 would paint an unstressed node as the MOST critical color
// and pin field.min to 0, squashing the engineering-relevant range. This matches the
// web app's derived-field convention (clampSafetyFactor).
describe("nodalSafetyFactorValues display convention", () => {
  test("zero-stress nodes map to the display cap (safest), not 0", () => {
    // e.g. every node of an unloaded/disconnected body, or frame 0 of a ramp load.
    const nodalYield = Float64Array.from([250e6, 250e6, 250e6]);
    const nodalVonMises = Float64Array.from([0, 0, 0]);
    const values = nodalSafetyFactorValues(nodalYield, nodalVonMises);
    expect(Array.from(values)).toEqual([
      SAFETY_FACTOR_DISPLAY_CAP,
      SAFETY_FACTOR_DISPLAY_CAP,
      SAFETY_FACTOR_DISPLAY_CAP
    ]);
  });

  test("nodes without a recovered yield limit map to the display cap", () => {
    const nodalYield = Float64Array.from([0, -1, Number.NaN]);
    const nodalVonMises = Float64Array.from([1e6, 1e6, 1e6]);
    const values = nodalSafetyFactorValues(nodalYield, nodalVonMises);
    for (const value of values) expect(value).toBe(SAFETY_FACTOR_DISPLAY_CAP);
  });

  test("finite ratios pass through and clamp into the display range", () => {
    const nodalYield = Float64Array.from([250e6, 250e6, 250e6]);
    const nodalVonMises = Float64Array.from([
      100e6, // ordinary ratio: 2.5
      1, // near-zero stress: unclamped ratio 2.5e8 exceeds the cap
      1e12 // absurd over-stress: unclamped ratio below the floor
    ]);
    const values = nodalSafetyFactorValues(nodalYield, nodalVonMises);
    expect(values[0]).toBeCloseTo(2.5, 12);
    expect(values[1]).toBe(SAFETY_FACTOR_DISPLAY_CAP);
    expect(values[2]).toBe(SAFETY_FACTOR_DISPLAY_FLOOR);
  });

  test("a mixed loaded/unloaded field keeps unstressed nodes at the safe end of the range", () => {
    // Regression for the unloaded-body scenario: the unstressed nodes must sit at the
    // maximum of the field so a linear min-anchored palette renders them as safest and
    // field.min stays the genuinely most critical ratio.
    const nodalYield = Float64Array.from([250e6, 250e6, 250e6, 250e6]);
    const nodalVonMises = Float64Array.from([200e6, 50e6, 0, 0]);
    const values = nodalSafetyFactorValues(nodalYield, nodalVonMises);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    expect(min).toBeCloseTo(1.25, 12);
    expect(max).toBe(SAFETY_FACTOR_DISPLAY_CAP);
    expect(values[2]).toBe(max);
    expect(values[3]).toBe(max);
  });
});
