import { describe, expect, test } from "vitest";
import {
  elevateTet4MeshToTet10,
  normalizeModelJson,
  validateCoreResult,
  type OpenCAEModelJson
} from "@opencae/core";
import { singleTetStaticFixture } from "@opencae/examples";
import { solveModalLinearTet, solveModalSubspace, toCsrMatrix, createSparseMatrixBuilder, addSparseEntry } from "../src";
import { assembleLumpedMass, prepareStructuralSystem, type PreparedStructuralSystem } from "../src/structural-system";

function diagonalSystem(stiffness: number[], mass: number[]): PreparedStructuralSystem {
  const builder = createSparseMatrixBuilder(stiffness.length);
  stiffness.forEach((value, index) => addSparseEntry(builder, index, index, value));
  const matrix = toCsrMatrix(builder);
  return {
    stiffness: matrix,
    fullStiffness: matrix,
    fullLoad: new Float64Array(stiffness.length),
    load: new Float64Array(stiffness.length),
    mass: Float64Array.from(mass),
    fullMass: Float64Array.from(mass),
    totalMass: mass.reduce((sum, value) => sum + value, 0) / 3,
    free: Int32Array.from(stiffness.map((_value, index) => index)),
    constraints: new Map()
  };
}

const modalFixture: OpenCAEModelJson = {
  ...singleTetStaticFixture,
  schemaVersion: "0.3.0",
  materials: [{ ...singleTetStaticFixture.materials[0], density: 1200 }],
  loads: [],
  steps: [{
    name: "modes",
    type: "modal",
    boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
    modeCount: 3
  }]
};

describe("block shift-invert modal solver", () => {
  test("solves exact generalized eigenproblems with scaled residuals and M-orthogonality", () => {
    const system = diagonalSystem([4, 18, 48], [1, 2, 3]);
    const solved = solveModalSubspace(system, 3);

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.modes.map((mode) => mode.eigenvalue)).toEqual(expect.arrayContaining([
      expect.closeTo(4, 10),
      expect.closeTo(9, 10),
      expect.closeTo(16, 10)
    ]));
    for (const mode of solved.modes) expect(mode.scaledResidual).toBeLessThanOrEqual(1e-6);
    for (let left = 0; left < solved.modes.length; left += 1) {
      for (let right = 0; right < solved.modes.length; right += 1) {
        const product = massDot(system.mass, solved.modes[left].vector, solved.modes[right].vector);
        expect(product).toBeCloseTo(left === right ? 1 : 0, 10);
      }
    }
  });

  test("retains a repeated-mode subspace deterministically", () => {
    const first = solveModalSubspace(diagonalSystem([4, 4, 9, 16], [1, 1, 1, 1]), 3);
    const second = solveModalSubspace(diagonalSystem([4, 4, 9, 16], [1, 1, 1, 1]), 3);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.modes.map((mode) => mode.eigenvalue)).toEqual(second.modes.map((mode) => mode.eigenvalue));
    expect(first.modes[0].eigenvalue).toBeCloseTo(4, 10);
    expect(first.modes[1].eigenvalue).toBeCloseTo(4, 10);
    expect(Math.abs(dot(first.modes[0].vector, first.modes[1].vector))).toBeLessThan(1e-10);
  });

  test("maps singular constrained systems to the supports-step diagnostic", () => {
    const solved = solveModalSubspace(diagonalSystem([4, 0, 9], [1, 1, 1]), 2);
    expect(solved.ok).toBe(false);
    expect(solved.ok ? undefined : solved.error.code).toBe("insufficient-modal-constraints");
    expect(solved.ok ? undefined : solved.error.message).toContain("Supports step");
  });

  test("honors cooperative cancellation between subspace iterations", () => {
    const solved = solveModalSubspace(diagonalSystem([4, 9, 16], [1, 1, 1]), 2, { hooks: { shouldCancel: () => true } });
    expect(solved.ok).toBe(false);
    expect(solved.ok ? undefined : solved.error.code).toBe("cancelled");
  });

  test("exports normalized signed vector mode shapes and a valid modal result contract", () => {
    const solved = solveModalLinearTet(modalFixture, { maxDofs: 100_000 });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.result.modes.length).toBeGreaterThan(0);
    for (const mode of solved.result.modes) {
      let maxVector = 0;
      let largestComponent = 0;
      for (let node = 0; node < mode.shape.length / 3; node += 1) {
        maxVector = Math.max(maxVector, Math.hypot(mode.shape[node * 3], mode.shape[node * 3 + 1], mode.shape[node * 3 + 2]));
      }
      for (const component of mode.shape) {
        if (Math.abs(component) > Math.abs(largestComponent)) largestComponent = component;
      }
      expect(maxVector).toBeCloseTo(1, 10);
      expect(largestComponent).toBeGreaterThan(0);
    }
    expect(solved.result.coreResult?.analysisType).toBe("modal_analysis");
    expect(validateCoreResult(solved.result.coreResult!).ok).toBe(true);
  });

  test("conserves Tet4 and Tet10 mass under shared HRZ assembly", () => {
    const tet4 = normalizeModelJson(modalFixture);
    expect(tet4.ok).toBe(true);
    if (!tet4.ok) return;
    const tet4Mass = assembleLumpedMass(tet4.model, "Modal");
    expect(tet4Mass.ok).toBe(true);
    if (!tet4Mass.ok) return;
    expect(tet4Mass.totalMass).toBeCloseTo(200, 10);

    const elevated = elevateTet4MeshToTet10({
      coordinates: modalFixture.nodes.coordinates,
      elements: [modalFixture.elementBlocks[0].connectivity]
    });
    const tet10Model: OpenCAEModelJson = {
      ...modalFixture,
      nodes: { coordinates: elevated.coordinates },
      elementBlocks: [{ ...modalFixture.elementBlocks[0], type: "Tet10", connectivity: elevated.elements.flat() }]
    };
    const tet10 = normalizeModelJson(tet10Model);
    expect(tet10.ok).toBe(true);
    if (!tet10.ok) return;
    const tet10Mass = assembleLumpedMass(tet10.model, "Modal");
    expect(tet10Mass.ok).toBe(true);
    if (!tet10Mass.ok) return;
    expect(tet10Mass.totalMass).toBeCloseTo(tet4Mass.totalMass, 10);
  });

  test("keeps the compatibility frequency estimate within modal calibration tolerance", () => {
    const system = diagonalSystem([4, 100, 400], [1, 1, 1]);
    system.load.set([1, 1, 1]);
    const compatibility = solveModalSubspace(system, 1, {
      frequencyEstimateSeed: system.load,
      frequencyEstimateIterations: 4
    });
    const modal = solveModalSubspace(system, 1);
    expect(compatibility.ok && modal.ok).toBe(true);
    if (!compatibility.ok || !modal.ok) return;
    const compatibilityOmega = Math.sqrt(compatibility.modes[0].eigenvalue);
    const modalOmega = Math.sqrt(modal.modes[0].eigenvalue);
    expect(Math.abs(compatibilityOmega - modalOmega) / modalOmega).toBeLessThan(1e-6);
  });
});

function massDot(mass: Float64Array, left: Float64Array, right: Float64Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += mass[index] * left[index] * right[index];
  return result;
}

function dot(left: Float64Array, right: Float64Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}
