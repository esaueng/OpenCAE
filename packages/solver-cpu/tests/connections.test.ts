import { describe, expect, test } from "vitest";
import { normalizeModelJson, OPENCAE_MODEL_SCHEMA_VERSION, type MeshConnectionJson, type OpenCAEModelJson } from "@opencae/core";
import { assembleMeshConnectionStiffness, createSparseMatrixBuilder, solveStaticLinearTet4Cpu, toCsrMatrix } from "../src";

function assemblyModel(connection: MeshConnectionJson): OpenCAEModelJson {
  return {
    schema: "opencae.model",
    schemaVersion: OPENCAE_MODEL_SCHEMA_VERSION,
    nodes: { coordinates: [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, -1,
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1
    ] },
    materials: [{ name: "steel", type: "isotropicLinearElastic", youngModulus: 200e9, poissonRatio: 0.29, density: 7850, yieldStrength: 250e6 }],
    elementBlocks: [{ name: "parts", type: "Tet4", material: "steel", connectivity: [0, 2, 1, 3, 4, 5, 6, 7] }],
    nodeSets: [{ name: "fixed", nodes: [0, 1, 2, 3] }, { name: "loaded", nodes: [7] }],
    elementSets: [],
    surfaceFacets: [
      { id: 0, element: 0, elementFace: 3, nodes: [0, 1, 2], normal: [0, 0, 1] },
      { id: 1, element: 1, elementFace: 3, nodes: [4, 6, 5], normal: [0, 0, -1] }
    ],
    surfaceSets: [{ name: "lower-top", facets: [0] }, { name: "upper-bottom", facets: [1] }],
    boundaryConditions: [{ name: "fixed", type: "fixed", nodeSet: "fixed", components: ["x", "y", "z"] }],
    loads: [{ name: "load", type: "nodalForce", nodeSet: "loaded", vector: [0, 0, 100] }],
    steps: [{ name: "load", type: "staticLinear", boundaryConditions: ["fixed"], loads: ["load"] }],
    meshConnections: [connection]
  };
}

describe("assembly mesh connections", () => {
  test("ties duplicated interface nodes with node-to-surface MPC equations", () => {
    const solved = solveStaticLinearTet4Cpu(assemblyModel({ type: "tie", source: "upper-bottom", target: "lower-top", searchTolerance: 1e-6 }), {
      solverMode: "sparse",
      tolerance: 1e-9
    });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.result.displacement[7 * 3 + 2]).toBeGreaterThan(0);
    const reactionZ = [0, 1, 2, 3].reduce((sum, node) => sum + solved.result.reactionForce[node * 3 + 2], 0);
    expect(reactionZ).toBeCloseTo(-100, 4);
  });

  test("frictionless contact assembles normal equations without tangential coupling", () => {
    const normalized = normalizeModelJson(assemblyModel({ type: "contact", source: "upper-bottom", target: "lower-top", searchTolerance: 1e-6 }));
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const builder = createSparseMatrixBuilder(normalized.model.counts.nodes * 3);
    const assembly = assembleMeshConnectionStiffness(builder, normalized.model);
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    const matrix = toCsrMatrix(builder);
    expect(assembly.diagnostics.equationCount).toBe(3);
    const xRows = [4 * 3, 5 * 3, 6 * 3];
    expect(xRows.every((row) => matrix.rowPtr[row] === matrix.rowPtr[row + 1])).toBe(true);
    expect(matrix.values.length).toBeGreaterThan(0);
  });
});
