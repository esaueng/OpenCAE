import type { DenseLinearSolveResult } from "./types";

export function solveDenseLinearSystem(
  matrix: Float64Array,
  rhs: Float64Array,
  singularTolerance = 1e-12
): DenseLinearSolveResult {
  const n = rhs.length;
  if (matrix.length !== n * n) {
    return {
      ok: false,
      error: {
        code: "invalid-linear-system",
        message: "Dense matrix dimensions do not match RHS length."
      }
    };
  }

  const a = new Float64Array(matrix);
  const b = new Float64Array(rhs);

  for (let pivot = 0; pivot < n; pivot += 1) {
    let pivotRow = pivot;
    let pivotAbs = Math.abs(a[pivot * n + pivot]);
    for (let row = pivot + 1; row < n; row += 1) {
      const candidateAbs = Math.abs(a[row * n + pivot]);
      if (candidateAbs > pivotAbs) {
        pivotAbs = candidateAbs;
        pivotRow = row;
      }
    }

    if (pivotAbs <= singularTolerance) {
      return {
        ok: false,
        error: {
          code: "singular-system",
          message: "Dense linear system is singular or ill-conditioned."
        }
      };
    }

    if (pivotRow !== pivot) {
      for (let col = pivot; col < n; col += 1) {
        const tmp = a[pivot * n + col];
        a[pivot * n + col] = a[pivotRow * n + col];
        a[pivotRow * n + col] = tmp;
      }
      const tmpRhs = b[pivot];
      b[pivot] = b[pivotRow];
      b[pivotRow] = tmpRhs;
    }

    for (let row = pivot + 1; row < n; row += 1) {
      const factor = a[row * n + pivot] / a[pivot * n + pivot];
      a[row * n + pivot] = 0;
      for (let col = pivot + 1; col < n; col += 1) {
        a[row * n + col] -= factor * a[pivot * n + col];
      }
      b[row] -= factor * b[pivot];
    }
  }

  const solution = new Float64Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let value = b[row];
    for (let col = row + 1; col < n; col += 1) {
      value -= a[row * n + col] * solution[col];
    }
    solution[row] = value / a[row * n + row];
  }

  return {
    ok: true,
    solution
  };
}
