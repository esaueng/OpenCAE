import { describe, expect, test } from "vitest";
import { automaticTetSolverBackend, buildTet4DofAdjacency, buildTet4ElementData, tet4MatrixFreeInternalForce, tet4MatrixFreeMatVec, type Tet4MatrixFreeData } from "../src";

describe("matrix-free Tet4 backend", () => {
  test("keeps the readback-heavy WebGPU CG route out of automatic execution", () => {
    expect(automaticTetSolverBackend({ elementType: "Tet4", dofs: 150_000, webGpuAvailable: true })).toBe("cpu");
    expect(automaticTetSolverBackend({ elementType: "Tet4", dofs: 150_001, webGpuAvailable: true })).toBe("unsupported");
    expect(automaticTetSolverBackend({ elementType: "Tet4", dofs: 500_001, webGpuAvailable: true })).toBe("unsupported");
    expect(automaticTetSolverBackend({ elementType: "Tet10", dofs: 200_000, webGpuAvailable: true })).toBe("unsupported");
  });

  test("matches symmetry and positive energy without assembling a global matrix", () => {
    const connectivity = new Uint32Array([0, 1, 2, 3]);
    const coordinates = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const element = buildTet4ElementData({ coordinates, connectivity, youngModulus: new Float64Array([200e9]), poissonRatio: new Float64Array([0.29]) });
    const adjacency = buildTet4DofAdjacency(connectivity, 12);
    const data: Tet4MatrixFreeData = { dofs: 12, connectivity, ...element, ...adjacency, constrained: new Uint32Array(12) };
    const x = new Float32Array([0.1, -0.2, 0.05, 0.2, 0.1, 0, -0.1, 0.15, 0.1, 0.05, 0, -0.1]);
    const y = new Float32Array([-0.03, 0.1, 0.2, 0.15, -0.1, 0.04, 0.1, 0.2, -0.05, -0.1, 0.02, 0.08]);
    const kx = tet4MatrixFreeMatVec(data, x), ky = tet4MatrixFreeMatVec(data, y);
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, index) => sum + value * b[index], 0);
    expect(dot(x, kx)).toBeGreaterThanOrEqual(0);
    expect(dot(x, ky)).toBeCloseTo(dot(y, kx), -2);
  });

  test("recovers physical constrained-row force instead of the Dirichlet identity row", () => {
    const connectivity = new Uint32Array([0, 1, 2, 3]);
    const coordinates = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const element = buildTet4ElementData({ coordinates, connectivity, youngModulus: new Float64Array([200e9]), poissonRatio: new Float64Array([0.29]) });
    const adjacency = buildTet4DofAdjacency(connectivity, 12);
    const constrained = new Uint32Array(12);
    constrained[0] = 1;
    const data: Tet4MatrixFreeData = { dofs: 12, connectivity, ...element, ...adjacency, constrained };
    const displacement = new Float32Array(12);
    displacement[3] = 1e-6;
    expect(tet4MatrixFreeMatVec(data, displacement)[0]).toBe(0);
    expect(Math.abs(tet4MatrixFreeInternalForce(data, displacement)[0])).toBeGreaterThan(0);
  });
});
