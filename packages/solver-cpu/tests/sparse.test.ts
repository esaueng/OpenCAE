import { describe, expect, test } from "vitest";
import {
  CooAccumulator,
  axpy,
  dot,
  jacobiPreconditioner,
  norm,
  solveConjugateGradient,
  sparseMatVec
} from "../src";

describe("sparse matrix utilities", () => {
  test("accumulates COO entries into CSR and multiplies vectors", () => {
    const coo = new CooAccumulator(2);
    coo.addEntry(0, 0, 4);
    coo.addEntry(0, 1, 1);
    coo.addEntry(1, 0, 1);
    coo.addEntry(1, 1, 3);
    coo.addEntry(1, 1, 2);

    const csr = coo.finalizeCsr();

    expect(Array.from(sparseMatVec(csr, new Float64Array([2, 1])))).toEqual([9, 7]);
    expect(Array.from(jacobiPreconditioner(csr))).toEqual([1 / 4, 1 / 5]);
  });

  test("scales the preconditioner diagonal floor with the matrix instead of physical units", () => {
    for (const scale of [1e-300, 1e-20, 1, 1e20, 1e200]) {
      const coo = new CooAccumulator(2);
      coo.addEntry(0, 0, 4 * scale);
      coo.addEntry(1, 1, 5 * scale);
      const inverse = jacobiPreconditioner(coo.finalizeCsr());
      expect(inverse[0] * scale).toBeCloseTo(1 / 4, 12);
      expect(inverse[1] * scale).toBeCloseTo(1 / 5, 12);
    }
  });

  test("solves symmetric positive definite systems with CG diagnostics", () => {
    const coo = new CooAccumulator(2);
    coo.addEntry(0, 0, 4);
    coo.addEntry(0, 1, 1);
    coo.addEntry(1, 0, 1);
    coo.addEntry(1, 1, 3);
    const csr = coo.finalizeCsr();

    const result = solveConjugateGradient(csr, new Float64Array([1, 2]), {
      tolerance: 1e-12,
      maxIterations: 20,
      preconditioner: "jacobi"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.solution[0]).toBeCloseTo(1 / 11);
    expect(result.solution[1]).toBeCloseTo(7 / 11);
    expect(result.iterations).toBeGreaterThan(0);
    expect(Number.isFinite(result.residualNorm)).toBe(true);
    expect(result.relativeResidual).toBeLessThan(1e-10);
  });

  test("solves an SPD system with the symmetric SSOR preconditioner", () => {
    const coo = new CooAccumulator(3);
    for (const [row, col, value] of [[0, 0, 4], [0, 1, -1], [1, 0, -1], [1, 1, 4], [1, 2, -1], [2, 1, -1], [2, 2, 3]] as const) {
      coo.addEntry(row, col, value);
    }
    const result = solveConjugateGradient(coo.finalizeCsr(), new Float64Array([15, 10, 10]), {
      tolerance: 1e-12,
      maxIterations: 20,
      preconditioner: "ssor",
      ssorOmega: 1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.solution)).toEqual(expect.arrayContaining([
      expect.closeTo(5, 9),
      expect.closeTo(5, 9),
      expect.closeTo(5, 9)
    ]));
  });

  test("keeps relative convergence invariant across right-hand-side scales", () => {
    const coo = new CooAccumulator(3);
    for (const [row, col, value] of [[0, 0, 4], [0, 1, -1], [1, 0, -1], [1, 1, 4], [1, 2, -1], [2, 1, -1], [2, 2, 3]] as const) {
      coo.addEntry(row, col, value);
    }
    const matrix = coo.finalizeCsr();
    const scales = [1e-18, 1e-9, 1, 1e9];
    const solved = scales.map((scale) => solveConjugateGradient(
      matrix,
      new Float64Array([15 * scale, 10 * scale, 10 * scale]),
      { tolerance: 1e-12, maxIterations: 20, preconditioner: "jacobi" }
    ));

    expect(solved.every((result) => result.ok)).toBe(true);
    const iterations = solved.map((result) => result.iterations);
    expect(new Set(iterations).size).toBe(1);
    solved.forEach((result, index) => {
      if (!result.ok) return;
      const scale = scales[index];
      expect(Array.from(result.solution, (value) => value / scale)).toEqual(expect.arrayContaining([
        expect.closeTo(5, 8),
        expect.closeTo(5, 8),
        expect.closeTo(5, 8)
      ]));
      expect(result.relativeResidual).toBeLessThanOrEqual(1e-12);
    });
  });

  test("returns the exact zero solution for a zero right-hand side", () => {
    const coo = new CooAccumulator(2);
    coo.addEntry(0, 0, 2);
    coo.addEntry(1, 1, 3);

    const result = solveConjugateGradient(coo.finalizeCsr(), new Float64Array(2));

    expect(result).toMatchObject({
      ok: true,
      iterations: 0,
      residualNorm: 0,
      relativeResidual: 0
    });
    expect(result.ok && Array.from(result.solution)).toEqual([0, 0]);
  });

  test("uses the initial residual as the zero-load reference when a guess is supplied", () => {
    const coo = new CooAccumulator(2);
    coo.addEntry(0, 0, 2);
    coo.addEntry(1, 1, 3);

    const result = solveConjugateGradient(coo.finalizeCsr(), new Float64Array(2), {
      initialGuess: new Float64Array([2, -3]),
      tolerance: 1e-12,
      maxIterations: 10
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.solution)).toEqual(expect.arrayContaining([
      expect.closeTo(0, 12),
      expect.closeTo(0, 12)
    ]));
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.relativeResidual).toBeLessThanOrEqual(1e-12);
  });

  test("reports dimensionless residuals for cancellation and singular systems", () => {
    const identity = new CooAccumulator(2);
    identity.addEntry(0, 0, 1);
    identity.addEntry(1, 1, 1);
    const cancelledWithHook = solveConjugateGradient(identity.finalizeCsr(), new Float64Array([1e-9, -2e-9]), {
      hooks: { shouldCancel: () => true }
    });
    expect(cancelledWithHook).toMatchObject({ ok: false, error: { code: "cancelled" }, relativeResidual: 1 });

    const singular = new CooAccumulator(2);
    singular.addEntry(1, 1, 1);
    const failed = solveConjugateGradient(singular.finalizeCsr(), new Float64Array([1e-9, 0]));
    expect(failed).toMatchObject({ ok: false, error: { code: "singular-system" }, relativeResidual: 1 });
    expect(Number.isFinite(failed.residualNorm)).toBe(true);
  });

  test("exposes vector primitives", () => {
    const x = new Float64Array([1, 2]);
    axpy(3, new Float64Array([2, -1]), x);

    expect(Array.from(x)).toEqual([7, -1]);
    expect(dot(x, x)).toBe(50);
    expect(norm(x)).toBeCloseTo(Math.sqrt(50));
  });
});
