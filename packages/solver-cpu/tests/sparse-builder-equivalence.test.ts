import { describe, expect, test } from "vitest";
import { addSparseEntry, createSparseMatrixBuilder, toCsrMatrix, type CsrMatrix } from "../src/sparse";

/**
 * Reference copy of the historical Map-per-row builder (pre typed-array COO rewrite).
 * Kept here verbatim so the equivalence test compares the new implementation against
 * the exact algorithm that shipped before.
 */
type ReferenceBuilder = {
  rowCount: number;
  colCount: number;
  rows: Map<number, number>[];
};

function referenceCreateBuilder(rowCount: number, colCount = rowCount): ReferenceBuilder {
  return {
    rowCount,
    colCount,
    rows: Array.from({ length: rowCount }, () => new Map<number, number>())
  };
}

function referenceAddEntry(builder: ReferenceBuilder, row: number, col: number, value: number): void {
  if (value === 0) return;
  const rows = builder.rows[row];
  rows.set(col, (rows.get(col) ?? 0) + value);
}

function referenceToCsr(builder: ReferenceBuilder): CsrMatrix {
  const rowPtr = new Int32Array(builder.rowCount + 1);
  const columns: number[] = [];
  const values: number[] = [];
  for (let row = 0; row < builder.rowCount; row += 1) {
    const entries = [...builder.rows[row].entries()]
      .filter(([, value]) => value !== 0)
      .sort(([a], [b]) => a - b);
    rowPtr[row] = columns.length;
    for (const [col, value] of entries) {
      columns.push(col);
      values.push(value);
    }
  }
  rowPtr[builder.rowCount] = columns.length;
  return {
    rowCount: builder.rowCount,
    colCount: builder.colCount,
    rowPtr,
    colInd: new Int32Array(columns),
    values: new Float64Array(values)
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectIdenticalCsr(actual: CsrMatrix, expected: CsrMatrix): void {
  expect(actual.rowCount).toBe(expected.rowCount);
  expect(actual.colCount).toBe(expected.colCount);
  expect(Array.from(actual.rowPtr)).toEqual(Array.from(expected.rowPtr));
  expect(Array.from(actual.colInd)).toEqual(Array.from(expected.colInd));
  // Exact equality, not approximate: the new builder must sum duplicates in the
  // same floating-point order as the reference implementation.
  expect(actual.values.length).toBe(expected.values.length);
  for (let index = 0; index < expected.values.length; index += 1) {
    expect(actual.values[index]).toBe(expected.values[index]);
  }
}

describe("typed-array COO builder equivalence with the Map-per-row reference", () => {
  test("random small sparse symmetric matrices produce identical rowPtr/colInd/values", () => {
    const random = mulberry32(0x5eed);
    for (let trial = 0; trial < 50; trial += 1) {
      const size = 1 + Math.floor(random() * 30);
      const entryCount = Math.floor(random() * 400);
      const reference = referenceCreateBuilder(size);
      const builder = createSparseMatrixBuilder(size);
      for (let entry = 0; entry < entryCount; entry += 1) {
        const row = Math.floor(random() * size);
        const col = Math.floor(random() * size);
        const value = Math.round((random() - 0.5) * 2000) / 64;
        // Symmetric contribution, as FEM assembly produces.
        referenceAddEntry(reference, row, col, value);
        referenceAddEntry(reference, col, row, value);
        addSparseEntry(builder, row, col, value);
        addSparseEntry(builder, col, row, value);
        if (random() < 0.2) {
          // Exercise duplicate accumulation on the same cell.
          referenceAddEntry(reference, row, col, -value / 2);
          addSparseEntry(builder, row, col, -value / 2);
        }
        if (random() < 0.1) {
          // Exercise exact cancellation to zero (entry must be dropped).
          referenceAddEntry(reference, row, col, -value);
          addSparseEntry(builder, row, col, -value);
        }
      }
      expectIdenticalCsr(toCsrMatrix(builder), referenceToCsr(reference));
    }
  });

  test("skips explicit zeros and keeps empty rows empty", () => {
    const reference = referenceCreateBuilder(4, 5);
    const builder = createSparseMatrixBuilder(4, 5);
    const entries: [number, number, number][] = [
      [0, 3, 1.5],
      [0, 3, 2.5],
      [0, 1, 0],
      [2, 0, -4],
      [2, 4, 4],
      [2, 4, -4],
      [3, 2, 1e-300]
    ];
    for (const [row, col, value] of entries) {
      referenceAddEntry(reference, row, col, value);
      addSparseEntry(builder, row, col, value);
    }
    const actual = toCsrMatrix(builder);
    expectIdenticalCsr(actual, referenceToCsr(reference));
    expect(Array.from(actual.rowPtr)).toEqual([0, 1, 1, 2, 3]);
    expect(Array.from(actual.colInd)).toEqual([3, 0, 2]);
    expect(Array.from(actual.values)).toEqual([4, -4, 1e-300]);
  });

  test("builder is reusable: finalizing twice yields the same CSR", () => {
    const builder = createSparseMatrixBuilder(3);
    addSparseEntry(builder, 0, 0, 2);
    addSparseEntry(builder, 2, 1, -1);
    addSparseEntry(builder, 2, 1, 3);
    const first = toCsrMatrix(builder);
    const second = toCsrMatrix(builder);
    expectIdenticalCsr(second, first);
  });

  test("reserves a known FEM scatter capacity without changing growth behavior", () => {
    const builder = createSparseMatrixBuilder(4, 4, 512);
    expect(builder.rowIndices.length).toBe(512);
    for (let index = 0; index < 513; index += 1) {
      addSparseEntry(builder, index % 4, index % 4, index + 1);
    }
    expect(builder.rowIndices.length).toBe(1024);
    expect(toCsrMatrix(builder).values.length).toBe(4);
  });

  test("benchmark: ~25k-DOF FEM-pattern assembly, reference Map builder vs typed-array builder", { timeout: 60000 }, () => {
    // Structured 60x10x10 hex grid split into 5 tets per cube: 7381 nodes -> 22143 DOFs,
    // 30000 Tet4 elements, 144 stiffness entries scattered per element (4.32M triplets).
    const xDivisions = 60;
    const yDivisions = 10;
    const zDivisions = 10;
    const hexTets = [0, 1, 3, 4, 1, 2, 3, 6, 1, 3, 4, 6, 1, 4, 5, 6, 3, 4, 6, 7];
    const nodeIndex = (i: number, j: number, k: number) =>
      i * (yDivisions + 1) * (zDivisions + 1) + j * (zDivisions + 1) + k;
    const nodes = (xDivisions + 1) * (yDivisions + 1) * (zDivisions + 1);
    const dofs = nodes * 3;
    const connectivity: number[] = [];
    for (let i = 0; i < xDivisions; i += 1) {
      for (let j = 0; j < yDivisions; j += 1) {
        for (let k = 0; k < zDivisions; k += 1) {
          const cube = [
            nodeIndex(i, j, k),
            nodeIndex(i + 1, j, k),
            nodeIndex(i + 1, j + 1, k),
            nodeIndex(i, j + 1, k),
            nodeIndex(i, j, k + 1),
            nodeIndex(i + 1, j, k + 1),
            nodeIndex(i + 1, j + 1, k + 1),
            nodeIndex(i, j + 1, k + 1)
          ];
          for (let offset = 0; offset < hexTets.length; offset += 4) {
            connectivity.push(cube[hexTets[offset]!]!, cube[hexTets[offset + 1]!]!, cube[hexTets[offset + 2]!]!, cube[hexTets[offset + 3]!]!);
          }
        }
      }
    }
    const elementCount = connectivity.length / 4;
    const random = mulberry32(0xbeef);
    // One deterministic pseudo element stiffness reused for every element; the builder
    // cost being measured is scatter/accumulate/finalize, not element integration.
    const elementStiffness = Float64Array.from({ length: 144 }, () => (random() - 0.5) * 1e6);

    const scatterAll = (add: (row: number, col: number, value: number) => void): void => {
      for (let element = 0; element < elementCount; element += 1) {
        const offset = element * 4;
        for (let localRowNode = 0; localRowNode < 4; localRowNode += 1) {
          const rowNode = connectivity[offset + localRowNode]!;
          for (let rowComponent = 0; rowComponent < 3; rowComponent += 1) {
            const globalRow = rowNode * 3 + rowComponent;
            const localRow = localRowNode * 3 + rowComponent;
            for (let localColNode = 0; localColNode < 4; localColNode += 1) {
              const colNode = connectivity[offset + localColNode]!;
              for (let colComponent = 0; colComponent < 3; colComponent += 1) {
                add(globalRow, colNode * 3 + colComponent, elementStiffness[localRow * 12 + localColNode * 3 + colComponent]!);
              }
            }
          }
        }
      }
    };

    const heapBefore = memoryUsageMb();
    const referenceStart = performance.now();
    const reference = referenceCreateBuilder(dofs);
    scatterAll((row, col, value) => referenceAddEntry(reference, row, col, value));
    const referenceCsr = referenceToCsr(reference);
    const referenceMs = performance.now() - referenceStart;
    const heapAfterReference = memoryUsageMb();

    const typedStart = performance.now();
    const builder = createSparseMatrixBuilder(dofs);
    scatterAll((row, col, value) => addSparseEntry(builder, row, col, value));
    const typedCsr = toCsrMatrix(builder);
    const typedMs = performance.now() - typedStart;
    const heapAfterTyped = memoryUsageMb();

    console.log(
      `[sparse-builder benchmark] dofs=${dofs} elements=${elementCount} nnz=${typedCsr.values.length} ` +
        `oldMapBuilder=${referenceMs.toFixed(0)}ms newTypedBuilder=${typedMs.toFixed(0)}ms ` +
        `heapMb before=${heapBefore.toFixed(0)} afterOld=${heapAfterReference.toFixed(0)} afterNew=${heapAfterTyped.toFixed(0)}`
    );

    // Large arrays: compare with plain loops (per-index expect() calls are too slow here).
    expect(typedCsr.rowPtr.length).toBe(referenceCsr.rowPtr.length);
    expect(typedCsr.values.length).toBe(referenceCsr.values.length);
    let mismatches = 0;
    for (let index = 0; index < referenceCsr.rowPtr.length; index += 1) {
      if (typedCsr.rowPtr[index] !== referenceCsr.rowPtr[index]) mismatches += 1;
    }
    for (let index = 0; index < referenceCsr.values.length; index += 1) {
      if (typedCsr.colInd[index] !== referenceCsr.colInd[index]) mismatches += 1;
      if (typedCsr.values[index] !== referenceCsr.values[index]) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });
});

function memoryUsageMb(): number {
  const usage = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process?.memoryUsage?.();
  return usage ? usage.heapUsed / (1024 * 1024) : Number.NaN;
}
