import { describe, expect, test } from "vitest";
import {
  invalidConnectivityFixture,
  singleTetStaticFixture,
  twoTetStaticFixture
} from "@opencae/examples";
import { validateCoreResult, type OpenCAEModelJson } from "@opencae/core";
import { solveStaticLinearTet, solveStaticLinearTet4Cpu, solveStaticLinearTetSparse } from "../src";

describe("solveStaticLinearTet4Cpu", () => {
  test("solves single-tet-static", () => {
    const result = solveStaticLinearTet4Cpu(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.displacement.length).toBe(12);
    expect(result.result.reactionForce.length).toBe(12);
    expect(result.result.strain.length).toBe(6);
    expect(result.result.stress.length).toBe(6);
    expect(result.result.vonMises.length).toBe(1);
    expect(result.result.nodalStress?.length).toBe((singleTetStaticFixture.nodes.coordinates.length / 3) * 6);
    expect(Array.from(result.result.nodalStress ?? []).every(Number.isFinite)).toBe(true);
    expect(result.diagnostics.relativeResidual).toBeLessThan(1e-8);
    expect(result.diagnostics.dofs).toBe(12);
    expect(result.diagnostics.constrainedDofs).toBeGreaterThan(0);
    expect(result.diagnostics.freeDofs).toBeGreaterThan(0);
  });

  test("returns a valid Core result with surface mesh and fields", () => {
    const result = solveStaticLinearTet(singleTetStaticFixture, { method: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.coreResult?.surfaceMesh?.triangles.length).toBeGreaterThan(0);
    expect(result.result.coreResult?.fields.map((field) => field.type)).toEqual(
      expect.arrayContaining(["displacement", "stress"])
    );
    expect(result.result.coreResult?.fields.every((field) => field.values.length > 0)).toBe(true);
    const stressSurface = result.result.coreResult?.fields.find((field) => field.type === "stress" && field.location === "node");
    expect(stressSurface?.component).toBe("von_mises");
    expect(stressSurface?.tensorValues?.length).toBe((stressSurface?.values.length ?? 0) * 6);
    expect(Number.isFinite(result.result.coreResult?.summary.maxDisplacement)).toBe(true);
    expect(Number.isFinite(result.result.coreResult?.summary.maxStress)).toBe(true);
    expect(validateCoreResult(result.result.coreResult!).ok).toBe(true);
  });

  test("solves two-tet-static", () => {
    const result = solveStaticLinearTet4Cpu(twoTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.strain.length).toBe(12);
    expect(result.result.stress.length).toBe(12);
    expect(result.result.vonMises.length).toBe(2);
    expect(result.diagnostics.relativeResidual).toBeLessThan(1e-8);
  });

  test("matches dense and sparse results on a small Tet4 model", () => {
    const dense = solveStaticLinearTet(singleTetStaticFixture, { method: "dense" });
    const sparse = solveStaticLinearTet(singleTetStaticFixture, { method: "sparse", tolerance: 1e-12 });

    expect(dense.ok).toBe(true);
    expect(sparse.ok).toBe(true);
    if (!dense.ok || !sparse.ok) return;
    expect(dense.diagnostics.solverMode).toBe("dense");
    expect(sparse.diagnostics.solverMode).toBe("sparse");
    for (let index = 0; index < dense.result.displacement.length; index += 1) {
      expect(sparse.result.displacement[index]).toBeCloseTo(dense.result.displacement[index], 8);
    }
  });

  test("returns ok false for invalid connectivity", () => {
    const result = solveStaticLinearTet4Cpu(invalidConnectivityFixture);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("validation-failed");
  });

  test("keeps fixed DOFs at zero and finite reactions", () => {
    const result = solveStaticLinearTet4Cpu(singleTetStaticFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.displacement[0]).toBeCloseTo(0, 14);
    expect(result.result.displacement[1]).toBeCloseTo(0, 14);
    expect(result.result.displacement[2]).toBeCloseTo(0, 14);
    expect(Array.from(result.result.reactionForce).every(Number.isFinite)).toBe(true);
  });

  test("axial tension produces displacement in the loaded direction", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      loads: [
        {
          name: "axial",
          type: "nodalForce",
          nodeSet: "loadNodes",
          vector: [100, 0, 0]
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
          loads: ["axial"]
        }
      ]
    };

    const result = solveStaticLinearTet(model, { method: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.displacement[3 * 3]).toBeGreaterThan(0);
    expect(result.diagnostics.relativeResidual).toBeLessThan(1e-8);
  });

  test("cantilever tip load produces displacement in the load direction", () => {
    const result = solveStaticLinearTet(singleTetStaticFixture, { method: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.displacement[3 * 3 + 2]).toBeLessThan(0);
    expect(result.diagnostics.relativeResidual).toBeLessThan(1e-8);
  });

  test("fails when maxDofs is exceeded", () => {
    const result = solveStaticLinearTet4Cpu(singleTetStaticFixture, { maxDofs: 3 });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("max-dofs-exceeded");
  });

  test("fails for singular or underconstrained models", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      boundaryConditions: [],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: [],
          loads: ["tipLoad"]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("singular-system");
  });

  test("fails for conflicting prescribed displacements", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      boundaryConditions: [
        ...singleTetStaticFixture.boundaryConditions,
        {
          name: "conflict",
          type: "prescribedDisplacement",
          nodeSet: "fixedNodes",
          component: "z",
          value: 1
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "conflict"],
          loads: ["tipLoad"]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("conflicting-prescribed-displacement");
  });

  test("solves surface force loads with sparse CG and preserves reaction balance", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 1,
          element: 0,
          elementFace: 0,
          nodes: [1, 2, 3],
          area: 0.8660254037844386,
          normal: [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
          center: [1 / 3, 1 / 3, 1 / 3],
          sourceFaceId: "tip-face"
        }
      ],
      surfaceSets: [{ name: "tipFace", facets: [1] }],
      loads: [
        {
          name: "faceLoad",
          type: "surfaceForce",
          surfaceSet: "tipFace",
          totalForce: [0, 0, -90]
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
          loads: ["faceLoad"]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model, { solverMode: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.solverMode).toBe("sparse");
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(reaction[0]).toBeCloseTo(0, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(90, 8);
  });

  test("auto-selects sparse for surface loads", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 1,
          element: 0,
          elementFace: 0,
          nodes: [1, 2, 3],
          area: 0.8660254037844386,
          normal: [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
          center: [1 / 3, 1 / 3, 1 / 3]
        }
      ],
      surfaceSets: [{ name: "tipFace", facets: [1] }],
      loads: [
        {
          name: "faceLoad",
          type: "surfaceForce",
          surfaceSet: "tipFace",
          totalForce: [0, 0, -90]
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
          loads: ["faceLoad"]
        }
      ]
    };

    const result = solveStaticLinearTet(model, { method: "auto" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.solverMode).toBe("sparse");
  });

  test("solves pressure loads as pressure times facet area", () => {
    const area = 0.8660254037844386;
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 1,
          element: 0,
          elementFace: 0,
          nodes: [1, 2, 3],
          area,
          normal: [0, 0, 1],
          center: [1 / 3, 1 / 3, 1 / 3]
        }
      ],
      surfaceSets: [{ name: "tipFace", facets: [1] }],
      loads: [
        {
          name: "pressure",
          type: "pressure",
          surfaceSet: "tipFace",
          pressure: 50,
          direction: [0, 0, -1]
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
          loads: ["pressure"]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model, { solverMode: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(reaction[2]).toBeCloseTo(50 * area, 8);
  });

  test("resolves fixed supports from surface sets before applying constraints", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 1,
          element: 0,
          elementFace: 3,
          nodes: [0, 2, 1],
          area: 0.5,
          normal: [0, 0, 1],
          center: [1 / 3, 1 / 3, 0],
          sourceFaceId: "fixed-face"
        }
      ],
      surfaceSets: [{ name: "fixedFace", facets: [1] }],
      boundaryConditions: [
        {
          name: "surfaceFixed",
          type: "fixed",
          surfaceSet: "fixedFace",
          components: ["x", "y", "z"]
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["surfaceFixed"],
          loads: ["tipLoad"]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model, { solverMode: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.constrainedDofs).toBe(9);
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(reaction[2]).toBeCloseTo(100, 8);
  });

  test("reports reaction balance diagnostics for solved static systems", () => {
    const result = solveStaticLinearTet4Cpu(singleTetStaticFixture, { solverMode: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.matrixRows).toBe(singleTetStaticFixture.nodes.coordinates.length);
    expect(result.diagnostics.matrixNonZeros).toBeGreaterThan(0);
    expect(result.diagnostics.residualNorm).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.reactionBalance?.appliedLoad).toEqual([0, 0, -100]);
    expect(result.diagnostics.reactionBalance?.reaction).toEqual([0, 0, 100]);
    expect(result.diagnostics.reactionBalance?.relativeError).toBeLessThan(1e-8);
  });

  test("solves body gravity loads and balances reactions against mass acceleration", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      materials: [
        {
          ...singleTetStaticFixture.materials[0],
          density: 12
        }
      ],
      loads: [
        {
          name: "gravity",
          type: "bodyGravity",
          acceleration: [0, 0, -9.81]
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
          loads: ["gravity"]
        }
      ]
    };

    const result = solveStaticLinearTetSparse(model);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(reaction[0]).toBeCloseTo(0, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(19.62, 8);
    expect(Number.isFinite(result.diagnostics.relativeResidual)).toBe(true);
  });

  test("solves a Tet10 block instead of rejecting it", () => {
    const model = {
      ...singleTetStaticFixture,
      schemaVersion: "0.2.0",
      nodes: {
        coordinates: [
          ...singleTetStaticFixture.nodes.coordinates,
          0.5, 0, 0,
          0.5, 0.5, 0,
          0, 0.5, 0,
          0, 0, 0.5,
          0.5, 0, 0.5,
          0, 0.5, 0.5
        ]
      },
      elementBlocks: [
        {
          name: "tet10",
          type: "Tet10",
          material: "steel",
          connectivity: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.displacement.length).toBe(30);
    expect(result.result.vonMises.length).toBe(1);
    expect(result.diagnostics.relativeResidual).toBeLessThan(1e-8);
    expect(Array.from(result.result.displacement).every(Number.isFinite)).toBe(true);
  });

  test("handles a zero-load constrained model without producing nonzero displacement", () => {
    const model: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      loads: [],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
          loads: []
        }
      ]
    };

    const result = solveStaticLinearTet4Cpu(model, { solverMode: "sparse" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.max(...Array.from(result.result.displacement).map(Math.abs))).toBeLessThan(1e-14);
    expect(result.diagnostics.relativeResidual).toBe(0);
  });
});

function sumVectorDofs(values: Float64Array): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < values.length; index += 3) {
    sum[0] += values[index];
    sum[1] += values[index + 1];
    sum[2] += values[index + 2];
  }
  return sum;
}
