import { describe, expect, test } from "vitest";
import { solveDenseLinearSystem } from "../src";

describe("dense direct solve", () => {
  test("solves a dense system with partial pivoting", () => {
    const result = solveDenseLinearSystem(new Float64Array([0, 2, 1, 1]), new Float64Array([4, 3]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.solution)).toEqual([1, 2]);
  });

  test("returns singular failure for singular systems", () => {
    const result = solveDenseLinearSystem(new Float64Array([1, 2, 2, 4]), new Float64Array([1, 2]));

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("singular-system");
  });
});
