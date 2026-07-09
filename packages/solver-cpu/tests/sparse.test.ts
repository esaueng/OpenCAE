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

  test("exposes vector primitives", () => {
    const x = new Float64Array([1, 2]);
    axpy(3, new Float64Array([2, -1]), x);

    expect(Array.from(x)).toEqual([7, -1]);
    expect(dot(x, x)).toBe(50);
    expect(norm(x)).toBeCloseTo(Math.sqrt(50));
  });
});
