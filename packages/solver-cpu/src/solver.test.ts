import { describe, expect, test } from "vitest";
import { solveStaticLinearTet4Cpu } from "./solver";
import type { OpenCAEModelJson } from "@opencae/core";

describe("solveStaticLinearTet4Cpu", () => {
  test("solves a connected multi-Tet4 bracket-like block without separating supported nodes", () => {
    const model = blockModel();
    const solved = solveStaticLinearTet4Cpu(model, { maxDofs: 200 });

    expect(solved.ok).toBe(true);
    if (!solved.ok) throw new Error(solved.error.message);
    expect(solved.result.displacement.every(Number.isFinite)).toBe(true);
    expect(solved.result.vonMises.every(Number.isFinite)).toBe(true);

    for (const node of [0, 3, 6, 9]) {
      expect(nodeDisplacementMagnitude(solved.result.displacement, node)).toBeCloseTo(0, 12);
    }

    const loadedDisplacements = [2, 5, 8, 11].map((node) => solved.result.displacement[node * 3 + 1]);
    expect(loadedDisplacements.every((value) => value < 0)).toBe(true);
    const magnitudes = Array.from({ length: model.nodes.coordinates.length / 3 }, (_value, node) => nodeDisplacementMagnitude(solved.result.displacement, node));
    const max = Math.max(...magnitudes);
    const nonzero = magnitudes.filter((value) => value > 1e-12).sort((left, right) => left - right);
    expect(max / Math.max(nonzero[Math.floor(nonzero.length / 2)] ?? max, 1e-12)).toBeLessThan(20);
  });
});

function blockModel(): OpenCAEModelJson {
  const coordinates: number[] = [];
  for (const z of [0, 0.2]) {
    for (const y of [0, 0.2]) {
      for (const x of [0, 0.5, 1]) {
        coordinates.push(x, y, z);
      }
    }
  }
  return {
    schema: "opencae.model",
    schemaVersion: "0.1.0",
    nodes: { coordinates },
    materials: [{
      name: "aluminum",
      type: "isotropicLinearElastic",
      youngModulus: 68_900_000_000,
      poissonRatio: 0.33
    }],
    elementBlocks: [{
      name: "block",
      type: "Tet4",
      material: "aluminum",
      connectivity: [
        ...cellTets(0, 1, 3, 4, 6, 7, 9, 10),
        ...cellTets(1, 2, 4, 5, 7, 8, 10, 11)
      ]
    }],
    nodeSets: [
      { name: "fixed", nodes: [0, 3, 6, 9] },
      { name: "loaded", nodes: [2, 5, 8, 11] }
    ],
    elementSets: [{ name: "all", elements: Array.from({ length: 12 }, (_value, index) => index) }],
    boundaryConditions: [{ name: "fixedSupport", type: "fixed", nodeSet: "fixed", components: ["x", "y", "z"] }],
    loads: [{ name: "downward", type: "nodalForce", nodeSet: "loaded", vector: [0, -25, 0] }],
    steps: [{ name: "load", type: "staticLinear", boundaryConditions: ["fixedSupport"], loads: ["downward"] }]
  };
}

function cellTets(n000: number, n100: number, n010: number, n110: number, n001: number, n101: number, n011: number, n111: number): number[] {
  return [
    n000, n100, n110, n111,
    n000, n110, n010, n111,
    n000, n010, n011, n111,
    n000, n011, n001, n111,
    n000, n001, n101, n111,
    n000, n101, n100, n111
  ];
}

function nodeDisplacementMagnitude(displacement: Float64Array, node: number): number {
  return Math.hypot(displacement[node * 3] ?? 0, displacement[node * 3 + 1] ?? 0, displacement[node * 3 + 2] ?? 0);
}
