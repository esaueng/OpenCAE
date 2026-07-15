import { describe, expect, test } from "vitest";
import type { OpenCAEModelJson, SurfaceFacetJson, SurfaceSetJson } from "../src";
import {
  assembleNodalLoadVector,
  assembleNodalLoadVectorWithDiagnostics
} from "../src/loads";
import {
  extractBoundarySurfaceFacets,
  TET10_HRZ_EDGE_MASS_FRACTION,
  TET10_HRZ_VERTEX_MASS_FRACTION,
  tet10Volume
} from "../src/mesh";

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

  test("integrates uniform surface traction and uses the consistent Tri6 load vector", () => {
    const model = tet10Model();
    model.surfaceFacets = [{
      id: 40,
      element: 0,
      elementFace: 3,
      nodes: [0, 1, 2, 4, 5, 6],
      area: 0.5,
      normal: [0, 0, 1],
      center: [1 / 3, 1 / 3, 0]
    }];
    model.surfaceSets = [{ name: "quadraticFace", facets: [40] }];
    model.loads = [{ name: "traction", type: "surfaceTraction", surfaceSet: "quadraticFace", traction: [20, -4, 8] }];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["traction"]);

    expect(result.diagnostics.errors).toEqual([]);
    expectApproxVector(sumVector(result.vector), [10, -2, 4]);
    for (const node of [0, 1, 2]) expectApproxVector(nodeForce(result.vector, node), [0, 0, 0]);
    for (const node of [4, 5, 6]) expectApproxVector(nodeForce(result.vector, node), [10 / 3, -2 / 3, 4 / 3]);
    expect(result.diagnostics.perLoad).toHaveLength(1);
    expect(result.diagnostics.perLoad[0]).toMatchObject({
      distribution: "consistent_surface",
      surfaceArea: 0.5
    });
  });

  test("integrates Tet4 body-force density with exact resultant conservation", () => {
    const model = baseModel();
    model.schemaVersion = "0.3.0";
    model.loads = [{ name: "body", type: "bodyForceDensity", elementSet: "all", forceDensity: [12, -6, 3] }];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["body"]);

    expect(result.diagnostics.errors).toEqual([]);
    expectApproxVector(sumVector(result.vector), [2, -1, 0.5]);
    for (const node of [0, 1, 2, 3]) expectApproxVector(nodeForce(result.vector, node), [0.5, -0.25, 0.125]);
    expect(result.diagnostics.perLoad[0]).toMatchObject({ volume: 1 / 6, distribution: "hrz_volume" });
  });

  test("uses positive HRZ Tet10 body-force weights and conserves the exact resultant", () => {
    const model = tet10Model();
    model.loads = [{ name: "body", type: "bodyForceDensity", elementSet: "all", forceDensity: [0, 0, 60] }];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["body"]);

    expect(result.diagnostics.errors).toEqual([]);
    expect(tet10Volume(model.nodes.coordinates, model.elementBlocks[0].connectivity)).toBeCloseTo(1 / 6, 12);
    expectApproxVector(sumVector(result.vector), [0, 0, 10]);
    for (const node of [0, 1, 2, 3]) {
      expect(nodeForce(result.vector, node)[2]).toBeCloseTo(10 * TET10_HRZ_VERTEX_MASS_FRACTION, 12);
      expect(nodeForce(result.vector, node)[2]).toBeGreaterThan(0);
    }
    for (const node of [4, 5, 6, 7, 8, 9]) {
      expect(nodeForce(result.vector, node)[2]).toBeCloseTo(10 * TET10_HRZ_EDGE_MASS_FRACTION, 12);
      expect(nodeForce(result.vector, node)[2]).toBeGreaterThan(0);
    }
  });

  test("distributes a remote force as an equilibrated six-component wrench", () => {
    const model = baseModel();
    model.schemaVersion = "0.3.0";
    model.loads = [{
      name: "remote",
      type: "remoteForce",
      surfaceSet: "sloped",
      totalForce: [4, -3, 7],
      remotePoint: [2, -1, 3]
    }];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["remote"]);

    expect(result.diagnostics.errors).toEqual([]);
    expectApproxVector(sumVector(result.vector), [4, -3, 7]);
    expectApproxVector(momentAboutOrigin(model.nodes.coordinates, result.vector), [2, -2, -2]);
    expect(result.diagnostics.perLoad[0]).toMatchObject({
      distribution: "area_weighted_minimum_norm",
      forceBalanceError: expect.any(Number),
      momentBalanceError: expect.any(Number)
    });
    expect(result.diagnostics.perLoad[0].forceBalanceError).toBeLessThan(1e-10);
    expect(result.diagnostics.perLoad[0].momentBalanceError).toBeLessThan(1e-10);
  });

  test("rejects rank-deficient remote-force selections", () => {
    const model = baseModel();
    model.schemaVersion = "0.3.0";
    model.surfaceFacets = [{
      id: 7,
      element: 0,
      elementFace: 0,
      nodes: [0, 1, 1],
      area: 1,
      normal: [0, 0, 1],
      center: [0.5, 0, 0]
    }];
    model.surfaceSets = [{ name: "line", facets: [7] }];
    model.loads = [{ name: "remote", type: "remoteForce", surfaceSet: "line", totalForce: [1, 0, 0], remotePoint: [0, 1, 0] }];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["remote"]);

    expect(result.diagnostics.errors).toContainEqual(expect.objectContaining({
      code: "degenerate-remote-selection",
      loadName: "remote"
    }));
  });

  test("assembles an equilibrated bonded-linear bolt preload pair", () => {
    const model = boltModel();

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["preload"]);

    expect(result.diagnostics.errors).toEqual([]);
    expectApproxVector(sumVector(result.vector), [0, 0, 0]);
    expectApproxVector(momentAboutOrigin(model.nodes.coordinates, result.vector), [0, 0, 0]);
    expect(result.diagnostics.perLoad[0]).toMatchObject({
      distribution: "bonded_linear_preload",
      approximation: expect.stringMatching(/without contact, slip, or fastener stiffness/i)
    });
  });

  test("rejects a bolt preload when face normals are not opposed", () => {
    const model = boltModel();
    model.surfaceFacets![1]!.normal = [0, 0, -1];

    const result = assembleNodalLoadVectorWithDiagnostics(model, ["preload"]);

    expect(result.diagnostics.errors).toContainEqual(expect.objectContaining({
      code: "bolt-preload-normals-not-opposed",
      loadName: "preload"
    }));
  });
});

function tet10Model(): OpenCAEModelJson {
  const model = baseModel();
  model.schemaVersion = "0.3.0";
  model.nodes.coordinates = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
    0.5, 0, 0,
    0.5, 0.5, 0,
    0, 0.5, 0,
    0, 0, 0.5,
    0.5, 0, 0.5,
    0, 0.5, 0.5
  ];
  model.elementBlocks = [{
    name: "solid",
    type: "Tet10",
    material: "steel",
    connectivity: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  }];
  model.elementSets = [{ name: "all", elements: [0] }];
  model.surfaceFacets = [];
  model.surfaceSets = [];
  return model;
}

function boltModel(): OpenCAEModelJson {
  return {
    ...baseModel(),
    schemaVersion: "0.3.0",
    nodes: {
      coordinates: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        1, 0, 1,
        0, 1, 1,
        0, 0, 0.5
      ]
    },
    elementBlocks: [
      { name: "lower", type: "Tet4", material: "steel", connectivity: [0, 1, 2, 6] },
      { name: "upper", type: "Tet4", material: "steel", connectivity: [3, 4, 5, 6] }
    ],
    elementSets: [{ name: "all", elements: [0, 1] }],
    surfaceFacets: [
      { id: 20, element: 0, elementFace: 0, nodes: [0, 1, 2], area: 0.5, normal: [0, 0, -1], center: [1 / 3, 1 / 3, 0] },
      { id: 21, element: 1, elementFace: 0, nodes: [3, 4, 5], area: 0.5, normal: [0, 0, 1], center: [1 / 3, 1 / 3, 1] }
    ],
    surfaceSets: [
      { name: "lowerFace", facets: [20] },
      { name: "upperFace", facets: [21] }
    ],
    loads: [{
      name: "preload",
      type: "equivalentBoltPreload",
      surfaceSetA: "lowerFace",
      surfaceSetB: "upperFace",
      axis: [0, 0, 1],
      preloadForce: 900
    }]
  };
}

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

function momentAboutOrigin(coordinates: number[], vector: Float64Array): [number, number, number] {
  const moment: [number, number, number] = [0, 0, 0];
  for (let node = 0; node < coordinates.length / 3; node += 1) {
    const x = coordinates[node * 3];
    const y = coordinates[node * 3 + 1];
    const z = coordinates[node * 3 + 2];
    const fx = vector[node * 3];
    const fy = vector[node * 3 + 1];
    const fz = vector[node * 3 + 2];
    moment[0] += y * fz - z * fy;
    moment[1] += z * fx - x * fz;
    moment[2] += x * fy - y * fx;
  }
  return moment;
}

function expectApproxVector(actual: [number, number, number], expected: [number, number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0]);
  expect(actual[1]).toBeCloseTo(expected[1]);
  expect(actual[2]).toBeCloseTo(expected[2]);
}
