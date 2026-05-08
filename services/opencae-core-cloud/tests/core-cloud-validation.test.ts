import { describe, expect, test } from "vitest";
import { bracketActualMeshFixture } from "@opencae/examples";
import {
  connectedComponents,
  extractBoundarySurfaceFacets,
  nodeSetFromSurfaceSet,
  surfaceArea,
  type OpenCAEModelJson,
  type SolverSurfaceMesh,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";
import { handleRequest } from "../src/index";

const HEX_TETS = [
  0, 1, 3, 4,
  1, 2, 3, 6,
  1, 3, 4, 6,
  1, 4, 5, 6,
  3, 4, 6, 7
];

describe("OpenCAE Core Cloud end-to-end validation", () => {
  test("health exposes production Core Cloud capabilities and fallback guards", async () => {
    const response = await handleRequest(new Request("http://core-cloud/health"));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "opencae-core-cloud",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportedSolverMethods: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false,
      noCalculix: true,
      noLocalEstimateFallback: true
    });
  });

  test("solves simple cantilever static with reaction, displacement, stress, and safety checks", async () => {
    const force = 10;
    const model = createHexBarModel({
      length: 4,
      youngModulus: 1_000_000,
      loads: [{ name: "tipShear", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [0, -force, 0] }],
      stepType: "staticLinear"
    });
    const body = await solveOk({ runId: "validation-cantilever-static", analysisType: "static_stress", coreModel: model });

    expectProductionStaticResult(body, "structured_block_core");
    expect(body.summary.reactionForce).toBeCloseTo(force, 8);
    expect(body.summary.maxDisplacement).toBeGreaterThan(0);
    expect(body.summary.maxDisplacement).toBeLessThan(10);
    expect(body.summary.maxStress).toBeGreaterThan(0);
    expect(body.summary.maxStress).toBeLessThan(1_000);
    expect(body.summary.safetyFactor).toBeGreaterThan(1);
    expect(surfaceMeshComponentCount(body.surfaceMesh)).toBe(1);
  });

  test("solves simple cantilever dynamic with unique framed fields", async () => {
    const model = createHexBarModel({
      length: 4,
      youngModulus: 1_000_000,
      loads: [{ name: "tipShear", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [0, -10, 0] }],
      stepType: "dynamicLinear"
    });
    const body = await solveOk({
      runId: "validation-cantilever-dynamic",
      analysisType: "dynamic_structural",
      coreModel: model,
      solverSettings: { endTime: 0.03, timeStep: 0.005, outputInterval: 0.015, dampingRatio: 0, loadProfile: "step" }
    });

    expectProductionDynamicResult(body, "structured_block_core");
    expect(body.summary.transient.frameCount).toBe(3);
    expect(dynamicFrameIndexes(body.fields)).toEqual([0, 1, 2]);
    expect(uniqueFrameSignatures(body.fields, "displacement").size).toBeGreaterThan(1);
    expect(surfaceMeshComponentCount(body.surfaceMesh)).toBe(1);
  });

  test("solves pressure patch with reaction balance from pressure times area", async () => {
    const pressure = 25;
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1_000,
      loads: [{ name: "pressurePatch", type: "pressure", surfaceSet: "rightFace", pressure, direction: [1, 0, 0] }],
      stepType: "staticLinear"
    });
    const expectedForce = pressure * surfaceArea(surfaceSet(model, "rightFace"), model.surfaceFacets ?? []);
    const body = await solveOk({ runId: "validation-pressure-patch", analysisType: "static_stress", coreModel: model });

    expectProductionStaticResult(body, "structured_block_core");
    expect(expectedForce).toBeCloseTo(pressure);
    expect(body.summary.reactionForce).toBeCloseTo(expectedForce, 8);
  });

  test("solves payload mass gravity with reaction balance", async () => {
    const density = 7;
    const acceleration = -9.80665;
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1_000,
      density,
      loads: [{ name: "payloadMass", type: "bodyGravity", acceleration: [0, 0, acceleration] }],
      stepType: "staticLinear"
    });
    const body = await solveOk({ runId: "validation-payload-mass", analysisType: "static_stress", coreModel: model });

    expectProductionStaticResult(body, "structured_block_core");
    expect(body.summary.reactionForce).toBeCloseTo(Math.abs(density * acceleration), 8);
  });

  test("solves bracket actual mesh statically and dynamically with connected surface output", async () => {
    const staticBody = await solveOk({
      runId: "validation-bracket-static",
      analysisType: "static_stress",
      coreModel: bracketActualMeshFixture
    });
    const dynamicBody = await solveOk({
      runId: "validation-bracket-dynamic",
      analysisType: "dynamic_structural",
      coreModel: bracketActualMeshFixture,
      solverSettings: { endTime: 0.02, timeStep: 0.005, outputInterval: 0.01, dampingRatio: 0.02, loadProfile: "ramp" }
    });

    expect(connectedComponents(bracketActualMeshFixture).componentCount).toBe(1);
    expectProductionStaticResult(staticBody, "actual_volume_mesh");
    expectProductionDynamicResult(dynamicBody, "actual_volume_mesh");
    expect(surfaceMeshComponentCount(staticBody.surfaceMesh)).toBe(1);
    expect(surfaceMeshComponentCount(dynamicBody.surfaceMesh)).toBe(1);
  });

  test("rejects disconnected meshes before solving", async () => {
    const disconnected = disconnectedHexModel();
    const response = await solve({
      runId: "validation-disconnected",
      analysisType: "static_stress",
      coreModel: disconnected
    });
    const body = await response.json() as { diagnostics?: Array<{ id?: string; message?: string }> };

    expect(response.status).toBe(422);
    expect(body.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "disconnected-bodies-without-connections" })
    ]));
  });

  test("applies frame and result budgets only to visualization fields", async () => {
    const model = createHexBarModel({
      length: 4,
      youngModulus: 1_000_000,
      loads: [{ name: "tipShear", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [0, -10, 0] }],
      stepType: "dynamicLinear"
    });
    const body = await solveOk({
      runId: "validation-budget",
      analysisType: "dynamic_structural",
      coreModel: model,
      solverSettings: { endTime: 0.03, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0, loadProfile: "step" },
      resultSettings: { maxFrames: 2, maxFieldValues: 3 }
    });

    expectProductionDynamicResult(body, "structured_block_core");
    expect(body.summary.maxStress).toBeGreaterThan(0);
    expect(body.summary.maxDisplacement).toBeGreaterThan(0);
    expect(body.summary.safetyFactor).toBeGreaterThan(1);
    expect(body.summary.reactionForce).toBeCloseTo(10, 8);
    expect(body.summary.transient.frameCount).toBeGreaterThan(2);
    expect(dynamicFrameIndexes(body.fields)).toEqual([0, body.summary.transient.frameCount - 1]);
    expect(body.fields.every((field) => field.values.length <= 3)).toBe(true);
  });
});

async function solve(body: unknown): Promise<Response> {
  return handleRequest(new Request("http://core-cloud/solve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
}

async function solveOk(body: unknown): Promise<CoreCloudResult> {
  const response = await solve(body);
  const result = await response.json();
  expect(response.status, JSON.stringify(result, null, 2)).toBe(200);
  return result as CoreCloudResult;
}

function expectProductionStaticResult(result: CoreCloudResult, meshSource: "actual_volume_mesh" | "structured_block_core") {
  expect(result.provenance).toMatchObject({
    kind: "opencae_core_fea",
    solver: "opencae-core-cloud",
    coreSolver: "sparse_static",
    resultSource: "computed",
    meshSource
  });
  expect(result.fields.length).toBeGreaterThan(0);
  expect(result.fields.every((field) => field.values.length > 0)).toBe(true);
  expect(Number.isFinite(result.summary.maxStress)).toBe(true);
  expect(Number.isFinite(result.summary.maxDisplacement)).toBe(true);
  expect(Number.isFinite(result.summary.safetyFactor)).toBe(true);
  expect(Number.isFinite(result.summary.reactionForce)).toBe(true);
}

function expectProductionDynamicResult(result: CoreCloudResult, meshSource: "actual_volume_mesh" | "structured_block_core") {
  expect(result.provenance).toMatchObject({
    kind: "opencae_core_fea",
    solver: "opencae-core-cloud",
    coreSolver: "mdof_dynamic",
    resultSource: "computed",
    meshSource
  });
  expect(result.fields.length).toBeGreaterThan(0);
  expect(result.fields.every((field) => field.values.length > 0)).toBe(true);
  expect(result.summary.transient.frameCount).toBeGreaterThan(1);
  expect(dynamicFrameIndexes(result.fields).length).toBeGreaterThan(1);
}

function createHexBarModel(options: {
  length: number;
  youngModulus: number;
  density?: number;
  loads: OpenCAEModelJson["loads"];
  stepType: "staticLinear" | "dynamicLinear";
}): OpenCAEModelJson {
  const coordinates = [
    0, 0, 0,
    options.length, 0, 0,
    options.length, 1, 0,
    0, 1, 0,
    0, 0, 1,
    options.length, 0, 1,
    options.length, 1, 1,
    0, 1, 1
  ];
  const base: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [{
      name: "validation",
      type: "isotropicLinearElastic",
      youngModulus: options.youngModulus,
      poissonRatio: 0,
      density: options.density ?? 1,
      yieldStrength: 1_000_000_000
    }],
    elementBlocks: [{ name: "hexTet", type: "Tet4", material: "validation", connectivity: HEX_TETS }],
    nodeSets: [],
    elementSets: [{ name: "all", elements: [0, 1, 2, 3, 4] }],
    boundaryConditions: [],
    loads: options.loads,
    steps: [],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "structured_block_core"
    }
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base);
  const leftFace = surfaceSetByX("leftFace", surfaceFacets, coordinates, 0);
  const rightFace = surfaceSetByX("rightFace", surfaceFacets, coordinates, options.length);
  const leftNodes = nodeSetFromSurfaceSet(leftFace, surfaceFacets);
  const rightNodes = nodeSetFromSurfaceSet(rightFace, surfaceFacets);
  const boundaryConditions: OpenCAEModelJson["boundaryConditions"] = [
    { name: "fixedLeft", type: "fixed", nodeSet: "leftNodes", components: ["x", "y", "z"] }
  ];

  return {
    ...base,
    surfaceFacets,
    surfaceSets: [leftFace, rightFace],
    nodeSets: [
      { name: "leftNodes", nodes: leftNodes },
      { name: "rightNodes", nodes: rightNodes }
    ],
    boundaryConditions,
    steps: [
      options.stepType === "staticLinear"
        ? { name: "loadStep", type: "staticLinear", boundaryConditions: ["fixedLeft"], loads: options.loads.map((load) => load.name) }
        : {
            name: "loadStep",
            type: "dynamicLinear",
            boundaryConditions: ["fixedLeft"],
            loads: options.loads.map((load) => load.name),
            startTime: 0,
            endTime: 0.03,
            timeStep: 0.005,
            outputInterval: 0.015,
            loadProfile: "step",
            dampingRatio: 0
          }
    ]
  };
}

function disconnectedHexModel(): OpenCAEModelJson {
  const first = createHexBarModel({
    length: 1,
    youngModulus: 1_000,
    loads: [{ name: "tipLoad", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [1, 0, 0] }],
    stepType: "staticLinear"
  });
  const offset = 8;
  return {
    ...first,
    nodes: {
      coordinates: [
        ...first.nodes.coordinates,
        ...first.nodes.coordinates.map((value, index) => index % 3 === 0 ? value + 3 : value)
      ]
    },
    elementBlocks: [{
      name: "disconnectedHexes",
      type: "Tet4",
      material: "validation",
      connectivity: [
        ...HEX_TETS,
        ...HEX_TETS.map((node) => node + offset)
      ]
    }],
    elementSets: [{ name: "all", elements: Array.from({ length: 10 }, (_, index) => index) }]
  };
}

function surfaceSetByX(name: string, facets: SurfaceFacetJson[], coordinates: number[], x: number): SurfaceSetJson {
  const facetIds = facets
    .filter((facet) => facet.nodes.every((node) => Math.abs((coordinates[node * 3] ?? 0) - x) < 1e-10))
    .map((facet) => facet.id);
  return { name, facets: facetIds };
}

function surfaceSet(model: OpenCAEModelJson, name: string): SurfaceSetJson {
  const set = model.surfaceSets?.find((candidate) => candidate.name === name);
  if (!set) throw new Error(`Missing surface set ${name}`);
  return set;
}

function dynamicFrameIndexes(fields: CoreCloudResult["fields"]): number[] {
  return [...new Set(fields.map((field) => field.frameIndex).filter((frame): frame is number => Number.isInteger(frame)))]
    .sort((left, right) => left - right);
}

function uniqueFrameSignatures(fields: CoreCloudResult["fields"], type: string): Set<string> {
  return new Set(
    fields
      .filter((field) => field.type === type && Number.isInteger(field.frameIndex))
      .map((field) => field.values.map((value) => value.toExponential(6)).join(","))
  );
}

function surfaceMeshComponentCount(mesh: SolverSurfaceMesh): number {
  const parent = Array.from({ length: mesh.nodes.length }, (_, index) => index);
  const find = (node: number): number => {
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]!;
      node = parent[node]!;
    }
    return node;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (const [a, b, c] of mesh.triangles) {
    union(a, b);
    union(b, c);
  }
  return new Set(mesh.triangles.flatMap((triangle) => triangle).map(find)).size;
}

type CoreCloudResult = {
  summary: {
    maxStress: number;
    maxDisplacement: number;
    safetyFactor: number;
    reactionForce: number;
    transient: { frameCount: number };
  };
  fields: Array<{
    type: string;
    values: number[];
    frameIndex?: number;
    timeSeconds?: number;
  }>;
  surfaceMesh: SolverSurfaceMesh;
  provenance: {
    kind: string;
    solver: string;
    coreSolver: string;
    resultSource: string;
    meshSource: string;
  };
};
