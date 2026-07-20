import type { SolverHooks } from "./types";
import {
  retainSparseAssemblyValue,
  sparseCurvatureTolerance,
  sparseDiagonalTolerance,
  SPARSE_ALGEBRA_POLICY,
  usableSparseDiagonal,
  validSparseSsorOmega
} from "./sparse-policy";

export type CsrMatrix = {
  rowCount: number;
  colCount: number;
  rowPtr: Int32Array;
  colInd: Int32Array;
  values: Float64Array;
};

/**
 * COO triplet accumulator backed by grow-by-doubling typed arrays.
 * Only the first `entryCount` slots of each buffer are valid.
 */
export type SparseMatrixBuilder = {
  rowCount: number;
  colCount: number;
  entryCount: number;
  rowIndices: Int32Array;
  colIndices: Int32Array;
  entryValues: Float64Array;
};

export type ConjugateGradientResult =
  | {
      ok: true;
      solution: Float64Array;
      iterations: number;
      residualNorm: number;
      relativeResidual: number;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
      iterations: number;
      residualNorm: number;
      relativeResidual: number;
    };

export type ConjugateGradientOptions = {
  tolerance?: number;
  maxIterations?: number;
  preconditioner?: "none" | "jacobi" | "ssor";
  ssorOmega?: number;
  initialGuess?: Float64Array;
  hooks?: SolverHooks;
};

export class CooAccumulator {
  private readonly builder: SparseMatrixBuilder;

  constructor(rowCount: number, colCount = rowCount) {
    this.builder = createSparseMatrixBuilder(rowCount, colCount);
  }

  addEntry(row: number, col: number, value: number): void {
    addSparseEntry(this.builder, row, col, value);
  }

  finalizeCsr(): CsrMatrix {
    return toCsrMatrix(this.builder);
  }
}

const INITIAL_TRIPLET_CAPACITY = 256;

export function createSparseMatrixBuilder(
  rowCount: number,
  colCount = rowCount,
  initialCapacity = INITIAL_TRIPLET_CAPACITY
): SparseMatrixBuilder {
  const capacity = Number.isFinite(initialCapacity)
    ? Math.max(Math.floor(initialCapacity), INITIAL_TRIPLET_CAPACITY)
    : INITIAL_TRIPLET_CAPACITY;
  return {
    rowCount,
    colCount,
    entryCount: 0,
    rowIndices: new Int32Array(capacity),
    colIndices: new Int32Array(capacity),
    entryValues: new Float64Array(capacity)
  };
}

export function addSparseEntry(builder: SparseMatrixBuilder, row: number, col: number, value: number): void {
  if (!retainSparseAssemblyValue(value)) return;
  if (builder.entryCount === builder.rowIndices.length) growTripletBuffers(builder);
  const index = builder.entryCount;
  builder.rowIndices[index] = row;
  builder.colIndices[index] = col;
  builder.entryValues[index] = value;
  builder.entryCount = index + 1;
}

function growTripletBuffers(builder: SparseMatrixBuilder): void {
  const capacity = Math.max(builder.rowIndices.length * 2, INITIAL_TRIPLET_CAPACITY);
  const rowIndices = new Int32Array(capacity);
  rowIndices.set(builder.rowIndices);
  const colIndices = new Int32Array(capacity);
  colIndices.set(builder.colIndices);
  const entryValues = new Float64Array(capacity);
  entryValues.set(builder.entryValues);
  builder.rowIndices = rowIndices;
  builder.colIndices = colIndices;
  builder.entryValues = entryValues;
}

/**
 * Sort-and-merge the COO triplets into CSR: duplicates summed in insertion order,
 * exact-zero sums dropped, column indices ascending within each row. This matches
 * the historical Map-per-row builder output bit for bit (same rowPtr/colInd/values).
 */
export function toCsrMatrix(builder: SparseMatrixBuilder): CsrMatrix {
  const { rowCount, colCount, entryCount } = builder;

  // Counting sort by row; iterating in insertion order keeps the bucketing stable.
  const rowStart = new Int32Array(rowCount + 1);
  for (let i = 0; i < entryCount; i += 1) rowStart[builder.rowIndices[i] + 1] += 1;
  for (let row = 0; row < rowCount; row += 1) rowStart[row + 1] += rowStart[row];
  const cursor = rowStart.slice(0, rowCount);
  const bucketedCols = new Int32Array(entryCount);
  const bucketedValues = new Float64Array(entryCount);
  for (let i = 0; i < entryCount; i += 1) {
    const slot = cursor[builder.rowIndices[i]];
    cursor[builder.rowIndices[i]] = slot + 1;
    bucketedCols[slot] = builder.colIndices[i];
    bucketedValues[slot] = builder.entryValues[i];
  }

  const rowPtr = new Int32Array(rowCount + 1);
  let nonZeroCount = 0;
  let keyScratch = new Float64Array(0);
  let valueScratch = new Float64Array(0);
  for (let row = 0; row < rowCount; row += 1) {
    rowPtr[row] = nonZeroCount;
    const start = rowStart[row];
    const length = rowStart[row + 1] - start;
    if (length === 0) continue;
    if (keyScratch.length < length) {
      keyScratch = new Float64Array(length);
      valueScratch = new Float64Array(length);
    }
    // Pack (col, local insertion index) into one number so the typed-array numeric
    // sort orders by column with insertion order preserved among duplicates. Values
    // stay below 2^53 (col < colCount, local < length), so decoding is exact.
    for (let local = 0; local < length; local += 1) {
      keyScratch[local] = bucketedCols[start + local] * length + local;
      valueScratch[local] = bucketedValues[start + local];
    }
    const keys = keyScratch.subarray(0, length);
    keys.sort();
    let currentCol = -1;
    let sum = 0;
    let hasEntry = false;
    for (let k = 0; k < length; k += 1) {
      const key = keys[k];
      const local = key % length;
      const col = (key - local) / length;
      const value = valueScratch[local];
      if (hasEntry && col === currentCol) {
        sum += value;
      } else {
        if (hasEntry && retainSparseAssemblyValue(sum)) {
          bucketedCols[nonZeroCount] = currentCol;
          bucketedValues[nonZeroCount] = sum;
          nonZeroCount += 1;
        }
        currentCol = col;
        sum = value;
        hasEntry = true;
      }
    }
    if (hasEntry && retainSparseAssemblyValue(sum)) {
      bucketedCols[nonZeroCount] = currentCol;
      bucketedValues[nonZeroCount] = sum;
      nonZeroCount += 1;
    }
  }
  rowPtr[rowCount] = nonZeroCount;
  return {
    rowCount,
    colCount,
    rowPtr,
    colInd: bucketedCols.slice(0, nonZeroCount),
    values: bucketedValues.slice(0, nonZeroCount)
  };
}

export function csrMatVec(matrix: CsrMatrix, vector: Float64Array): Float64Array {
  const result = new Float64Array(matrix.rowCount);
  for (let row = 0; row < matrix.rowCount; row += 1) {
    let sum = 0;
    for (let entry = matrix.rowPtr[row]; entry < matrix.rowPtr[row + 1]; entry += 1) {
      sum += matrix.values[entry] * vector[matrix.colInd[entry]];
    }
    result[row] = sum;
  }
  return result;
}

export const sparseMatVec = csrMatVec;

export function csrDiagonal(matrix: CsrMatrix): Float64Array {
  const diagonal = new Float64Array(matrix.rowCount);
  for (let row = 0; row < matrix.rowCount; row += 1) {
    for (let entry = matrix.rowPtr[row]; entry < matrix.rowPtr[row + 1]; entry += 1) {
      if (matrix.colInd[entry] === row) {
        diagonal[row] = matrix.values[entry];
        break;
      }
    }
  }
  return diagonal;
}

export function jacobiPreconditioner(matrix: CsrMatrix): Float64Array {
  const diagonal = csrDiagonal(matrix);
  const diagonalTolerance = sparseDiagonalTolerance(diagonal);
  const inverse = new Float64Array(diagonal.length);
  for (let i = 0; i < diagonal.length; i += 1) {
    inverse[i] = usableSparseDiagonal(diagonal[i], diagonalTolerance) ? 1 / diagonal[i] : 1;
  }
  return inverse;
}

export function conjugateGradient(
  matrix: CsrMatrix,
  rhs: Float64Array,
  options: { tolerance?: number; maxIterations?: number; jacobi?: boolean; preconditioner?: "none" | "jacobi" | "ssor"; ssorOmega?: number; initialGuess?: Float64Array; hooks?: SolverHooks } = {}
): ConjugateGradientResult {
  return solveConjugateGradient(matrix, rhs, {
    tolerance: options.tolerance,
    maxIterations: options.maxIterations,
    preconditioner: options.preconditioner ?? (options.jacobi === false ? "none" : "jacobi"),
    ssorOmega: options.ssorOmega,
    initialGuess: options.initialGuess,
    hooks: options.hooks
  });
}

export function solveConjugateGradient(
  matrix: CsrMatrix,
  rhs: Float64Array,
  options: ConjugateGradientOptions = {}
): ConjugateGradientResult {
  const tolerance = options.tolerance ?? SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance;
  const maxIterations = options.maxIterations ?? Math.max(100, matrix.rowCount * 20);
  const onProgress = options.hooks?.onProgress;
  const shouldCancel = options.hooks?.shouldCancel;
  const emitProgress = (iteration: number, relativeResidual: number): void => {
    onProgress?.({ phase: "solve", completed: iteration, total: maxIterations, iteration, relativeResidual });
  };
  const hasGuess = options.initialGuess !== undefined && options.initialGuess.length === rhs.length;
  const x = hasGuess ? Float64Array.from(options.initialGuess!) : new Float64Array(rhs.length);
  const r = Float64Array.from(rhs);
  if (hasGuess) {
    const ax = csrMatVec(matrix, x);
    for (let i = 0; i < r.length; i += 1) r[i] -= ax[i];
  }
  const z = new Float64Array(rhs.length);
  const p = new Float64Array(rhs.length);
  const preconditioner = options.preconditioner ?? "jacobi";
  const diagonal = preconditioner === "none" ? undefined : csrDiagonal(matrix);
  const diagonalTolerance = diagonal ? sparseDiagonalTolerance(diagonal) : 0;
  const ssorOmega = validSparseSsorOmega(options.ssorOmega);
  applyPreconditioner(matrix, r, z, diagonal, diagonalTolerance, preconditioner, ssorOmega);
  p.set(z);
  let rzOld = dot(r, z);
  const rhsNorm = norm(rhs);
  const initialResidualNorm = norm(r);
  const residualReference = rhsNorm > 0 ? rhsNorm : initialResidualNorm;
  const relativeResidualFor = (residualNorm: number): number =>
    residualReference > 0 ? residualNorm / residualReference : 0;
  const initialRelativeResidual = relativeResidualFor(initialResidualNorm);
  if (initialRelativeResidual <= tolerance) {
    emitProgress(0, initialRelativeResidual);
    return {
      ok: true,
      solution: x,
      iterations: 0,
      residualNorm: initialResidualNorm,
      relativeResidual: initialRelativeResidual
    };
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (shouldCancel?.()) {
      const residualNorm = norm(r);
      const relativeResidual = relativeResidualFor(residualNorm);
      emitProgress(iteration - 1, relativeResidual);
      return {
        ok: false,
        error: {
          code: "cancelled",
          message: "Solve cancelled."
        },
        iterations: iteration - 1,
        residualNorm,
        relativeResidual
      };
    }
    const ap = csrMatVec(matrix, p);
    const denominator = dot(p, ap);
    const denominatorTolerance = sparseCurvatureTolerance(norm(p), norm(ap));
    if (!Number.isFinite(denominator) || denominator <= denominatorTolerance) {
      const residualNorm = norm(r);
      const relativeResidual = relativeResidualFor(residualNorm);
      emitProgress(iteration, relativeResidual);
      return {
        ok: false,
        error: {
          code: "singular-system",
          message: "Sparse CG encountered a singular or indefinite system."
        },
        iterations: iteration,
        residualNorm,
        relativeResidual
      };
    }
    const alpha = rzOld / denominator;
    for (let i = 0; i < x.length; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    const residualNorm = norm(r);
    const relativeResidual = relativeResidualFor(residualNorm);
    if (relativeResidual <= tolerance) {
      emitProgress(iteration, relativeResidual);
      return { ok: true, solution: x, iterations: iteration, residualNorm, relativeResidual };
    }
    if (iteration % 25 === 0) {
      emitProgress(iteration, relativeResidual);
    }
    applyPreconditioner(matrix, r, z, diagonal, diagonalTolerance, preconditioner, ssorOmega);
    const rzNew = dot(r, z);
    const beta = rzNew / rzOld;
    for (let i = 0; i < p.length; i += 1) {
      p[i] = z[i] + beta * p[i];
    }
    rzOld = rzNew;
  }

  const residualNorm = norm(r);
  const relativeResidual = relativeResidualFor(residualNorm);
  emitProgress(maxIterations, relativeResidual);
  return {
    ok: false,
    error: {
      code: "cg-not-converged",
      message: "Sparse CG did not converge within maxIterations."
    },
    iterations: maxIterations,
    residualNorm,
    relativeResidual
  };
}

export function reduceCsrSystem(
  matrix: CsrMatrix,
  rhs: Float64Array,
  free: Int32Array,
  constraints: Map<number, number>
): { matrix: CsrMatrix; rhs: Float64Array } {
  const freeIndexByDof = new Map<number, number>();
  free.forEach((dof, index) => freeIndexByDof.set(dof, index));
  // At most every full-system nonzero survives the free-DOF reduction. Reserving
  // that upper bound avoids a grow-and-copy peak while both matrices are live.
  const builder = createSparseMatrixBuilder(free.length, free.length, matrix.values.length);
  const reducedRhs = reduceCsrRhs(matrix, rhs, free, constraints);

  for (let reducedRow = 0; reducedRow < free.length; reducedRow += 1) {
    const fullRow = free[reducedRow];
    for (let entry = matrix.rowPtr[fullRow]; entry < matrix.rowPtr[fullRow + 1]; entry += 1) {
      const fullCol = matrix.colInd[entry];
      const value = matrix.values[entry];
      const reducedCol = freeIndexByDof.get(fullCol);
      if (reducedCol !== undefined) {
        addSparseEntry(builder, reducedRow, reducedCol, value);
      }
    }
  }

  return {
    matrix: toCsrMatrix(builder),
    rhs: reducedRhs
  };
}

/** Reduce only the right-hand side against a previously reduced stiffness matrix. */
export function reduceCsrRhs(
  matrix: CsrMatrix,
  rhs: Float64Array,
  free: Int32Array,
  constraints: Map<number, number>
): Float64Array {
  const reducedRhs = new Float64Array(free.length);
  for (let reducedRow = 0; reducedRow < free.length; reducedRow += 1) {
    const fullRow = free[reducedRow];
    reducedRhs[reducedRow] = rhs[fullRow];
    for (let entry = matrix.rowPtr[fullRow]; entry < matrix.rowPtr[fullRow + 1]; entry += 1) {
      const constrainedValue = constraints.get(matrix.colInd[entry]);
      if (constrainedValue !== undefined) reducedRhs[reducedRow] -= matrix.values[entry] * constrainedValue;
    }
  }
  return reducedRhs;
}

function applyPreconditioner(
  matrix: CsrMatrix,
  source: Float64Array,
  target: Float64Array,
  diagonal: Float64Array | undefined,
  diagonalTolerance: number,
  preconditioner: "none" | "jacobi" | "ssor",
  omega: number
): void {
  if (preconditioner === "ssor" && diagonal) {
    applySsorPreconditioner(matrix, source, target, diagonal, omega, diagonalTolerance);
    return;
  }
  for (let i = 0; i < source.length; i += 1) {
    const d = diagonal?.[i];
    target[i] = d !== undefined && usableSparseDiagonal(d, diagonalTolerance) ? source[i] / d : source[i];
  }
}

/** Apply M^-1 for M=(D+wL)D^-1(D+wU)/(w(2-w)); suitable for SPD CG. */
export function applySsorPreconditioner(
  matrix: CsrMatrix,
  source: Float64Array,
  target: Float64Array,
  diagonal = csrDiagonal(matrix),
  omega = 1,
  diagonalTolerance = sparseDiagonalTolerance(diagonal)
): void {
  const forward = new Float64Array(source.length);
  for (let row = 0; row < matrix.rowCount; row += 1) {
    let value = source[row];
    for (let entry = matrix.rowPtr[row]; entry < matrix.rowPtr[row + 1]; entry += 1) {
      const col = matrix.colInd[entry];
      if (col < row) value -= omega * matrix.values[entry] * forward[col];
    }
    const d = diagonal[row];
    forward[row] = usableSparseDiagonal(d, diagonalTolerance) ? value / d : value;
  }
  const factor = omega * (2 - omega);
  for (let row = matrix.rowCount - 1; row >= 0; row -= 1) {
    let value = diagonal[row] * forward[row];
    for (let entry = matrix.rowPtr[row]; entry < matrix.rowPtr[row + 1]; entry += 1) {
      const col = matrix.colInd[entry];
      if (col > row) value -= omega * matrix.values[entry] * target[col];
    }
    const d = diagonal[row];
    target[row] = factor * (usableSparseDiagonal(d, diagonalTolerance) ? value / d : value);
  }
}

export function estimateCsrMemoryBytes(matrix: CsrMatrix): number {
  return matrix.rowPtr.byteLength + matrix.colInd.byteLength + matrix.values.byteLength;
}

export function dot(a: Float64Array, b: Float64Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result += a[i] * b[i];
  return result;
}

export function axpy(alpha: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < y.length; i += 1) {
    y[i] += alpha * x[i];
  }
}

export function norm(values: Float64Array): number {
  return Math.sqrt(dot(values, values));
}
