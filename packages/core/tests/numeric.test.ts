import { describe, expect, test } from "vitest";
import { finiteExtrema } from "../src";

describe("finiteExtrema", () => {
  test("returns null for empty and all-nonfinite ordinary or typed arrays", () => {
    expect(finiteExtrema([])).toBeNull();
    expect(finiteExtrema(new Float64Array())).toBeNull();
    expect(finiteExtrema([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toBeNull();
  });

  test("ignores nonfinite values consistently in ordinary and typed arrays", () => {
    const values = [Number.NaN, 4, Number.POSITIVE_INFINITY, -7, Number.NEGATIVE_INFINITY, 2];
    expect(finiteExtrema(values)).toEqual({ min: -7, max: 4 });
    expect(finiteExtrema(Float64Array.from(values))).toEqual({ min: -7, max: 4 });
    const sparse = new Array<number>(6);
    sparse[1] = 4;
    sparse[5] = -7;
    expect(finiteExtrema(sparse)).toEqual({ min: -7, max: 4 });
  });

  test("supports projected values without allocating a mapped array", () => {
    expect(finiteExtrema([{ value: -9 }, { value: Number.NaN }, { value: 3 }], (entry) => Math.abs(entry.value))).toEqual({
      min: 3,
      max: 9
    });
  });

  test("reduces displacement, reaction, and element stress arrays at browser scale", () => {
    const displacementDofs = new Float64Array(150_001);
    displacementDofs[15_000] = -0.25;
    displacementDofs[150_000] = 4.5;
    expect(() => finiteExtrema(displacementDofs)).not.toThrow();
    expect(finiteExtrema(displacementDofs)).toEqual({ min: -0.25, max: 4.5 });

    const reactionDofs = new Float64Array(150_001);
    reactionDofs[42] = -900;
    reactionDofs[149_999] = 750;
    expect(() => finiteExtrema(reactionDofs)).not.toThrow();
    expect(finiteExtrema(reactionDofs)).toEqual({ min: -900, max: 750 });

    const elementStress = new Array<number>(300_000).fill(125);
    elementStress[1] = -10;
    elementStress[299_999] = 250;
    elementStress[180_000] = Number.NaN;
    elementStress[180_001] = Number.POSITIVE_INFINITY;
    expect(() => finiteExtrema(elementStress)).not.toThrow();
    expect(finiteExtrema(elementStress)).toEqual({ min: -10, max: 250 });
  });
});
