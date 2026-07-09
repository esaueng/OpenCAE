import { describe, expect, test } from "vitest";
import type { OpenCAEModelJson, SurfaceFacetJson, SurfaceSetJson } from "../src";
import {
  assembleNodalLoadVector,
  assembleNodalLoadVectorWithDiagnostics
} from "../src/loads";
import { extractBoundarySurfaceFacets } from "../src/mesh";

const coordinates = [
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
  0, 0, 1
];

function baseModel(): OpenCAEModelJson {
  const model: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [
      {
        name: "steel",
        type: "isotropicLinearElastic",
        youngModulus: 210e9,
        poissonRatio: 0.3,
        density: 12
      }
    ],
    elementBlocks: [{ name: "solid", type: "Tet4", material: "steel", connectivity: [0, 1, 2, 3] }],
    nodeSets: [{ name: "tip", nodes: [1] }],
    elementSets: [{ name: "all", elements: [0] }],
    surfaceFacets: [],
    surfaceSets: [],
    boundaryConditions: [],
    loads: [],
    steps: []
  };
  model.surfaceFacets = extractBoundarySurfaceFacets(model);
  model.surfaceSets = [{ name: "sloped", facets: [0] }];
  return model;
}

describe("assembleNodalLoadVector", () => {
  test("assembles nodal force loads with matching total force", () => {
    const model = baseModel();
    model.loads = [{ name: "tipLoad", type: "nodalForce", nodeSet: "tip", vector: [1, 2, 3] }];

    const vector = assembleNodalLoadVector(model, ["tipLoad"]);

    expect(sumVector(vector)).toEqual([1, 2, 3]);
    expect(nodeForce(vector, 1)).toEqual([1, 2, 3]);
  });

  test("distributes surfaceForce by facet area while preserving requested total force", () => {
    const model = baseModel();
    model.loads = [{ name: "push", type: "surfaceForce", surfaceSet: "sloped", totalForce: [3, 6, 9] }];

    const { force, vector, diagnostics } = assembleNodalLoadVectorWithDiagnostics(model, ["push"]);

    expect(force).toBe(vector);
    expectApproxVector(sumVector(vector), [3, 6, 9]);
    expectApproxVector(diagnostics.totalAppliedForce, [3, 6, 9]);
    expect(diagnostics.totalAppliedForceMagnitude).toBeCloseTo(Math.hypot(3, 6, 9));
    expect(diagnostics.perLoad).toBe(diagnostics.loads);
    expect(diagnostics.perLoad[0]).toMatchObject({
      name: "push",
      type: "surfaceForce",
      surfaceArea: Math.sqrt(3) / 2,
      selectedArea: Math.sqrt(3) / 2,
      totalAppliedForceMagnitude: Math.hypot(3, 6, 9)
    });
    expect(diagnostics.perLoad[0]?.loadCentroid).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test("assembles explicit-direction pressure as pressure times area times direction", () => {
    const model = baseModel();
    model.loads = [{ name: "pressure", type: "pressure", surfaceSet: "sloped", pressure: 10, direction: [0, 0, -1] }];

    const { vector, diagnostics } = assembleNodalLoadVectorWithDiagnostics(model, ["pressure"]);

    expectApproxVector(sumVector(vector), [0, 0, -5 * Math.sqrt(3)]);
    expect(diagnostics.perLoad[0].surfaceArea).toBeCloseTo(Math.sqrt(3) / 2);
    expect(diagnostics.perLoad[0].selectedArea).toBeCloseTo(Math.sqrt(3) / 2);
  });

  test("uses facet normals when pressure direction is omitted", () => {
    const model = baseModel();
    model.loads = [{ name: "pressure", type: "pressure", surfaceSet: "sloped", pressure: 10 }];

    const vector = assembleNodalLoadVector(model, ["pressure"]);

    expectApproxVector(sumVector(vector), [5, 5, 5]);
  });

  test("assembles bodyGravity from material density and Tet4 volume", () => {
    const model = baseModel();
    model.loads = [{ name: "gravity", type: "bodyGravity", acceleration: [0, 0, -9.81] }];

    const { vector, diagnostics } = assembleNodalLoadVectorWithDiagnostics(model, ["gravity"]);

    expect(diagnostics.perLoad[0].mass).toBeCloseTo(2);
    expectApproxVector(sumVector(vector), [0, 0, -19.62]);
    expectApproxVector(diagnostics.totalAppliedForce, [0, 0, -19.62]);
  });

  test("fails clearly when a surface load references a missing surface set", () => {
    const model = baseModel();
    model.loads = [{ name: "push", type: "surfaceForce", surfaceSet: "missing", totalForce: [1, 0, 0] }];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["push"]);

    expect(result.diagnostics.errors).toContainEqual(
      expect.objectContaining({ code: "missing-surface-set", loadName: "push" })
    );
    expect(() => assembleNodalLoadVector(model, ["push"])).toThrow(/missing surface set/i);
  });

  test("fails clearly when a selected surface has zero area", () => {
    const model = baseModel();
    const zeroFacet: SurfaceFacetJson = {
      id: 99,
      element: 0,
      elementFace: 0,
      nodes: [0, 1, 2],
      area: 0,
      normal: [0, 0, 1],
      center: [0, 0, 0]
    };
    const zeroSet: SurfaceSetJson = { name: "zero", facets: [99] };
    model.surfaceFacets = [zeroFacet];
    model.surfaceSets = [zeroSet];
    model.loads = [{ name: "push", type: "surfaceForce", surfaceSet: "zero", totalForce: [1, 0, 0] }];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["push"]);

    expect(result.diagnostics.errors).toContainEqual(
      expect.objectContaining({ code: "zero-surface-area", loadName: "push" })
    );
    expect(() => assembleNodalLoadVector(model, ["push"])).toThrow(/zero surface area/i);
  });
});

function nodeForce(vector: Float64Array, node: number): [number, number, number] {
  return [vector[node * 3], vector[node * 3 + 1], vector[node * 3 + 2]];
}

function sumVector(vector: Float64Array): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < vector.length; index += 3) {
    sum[0] += vector[index];
    sum[1] += vector[index + 1];
    sum[2] += vector[index + 2];
  }
  return sum;
}

function expectApproxVector(actual: [number, number, number], expected: [number, number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0]);
  expect(actual[1]).toBeCloseTo(expected[1]);
  expect(actual[2]).toBeCloseTo(expected[2]);
}
