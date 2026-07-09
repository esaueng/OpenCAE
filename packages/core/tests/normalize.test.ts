import { describe, expect, test } from "vitest";
import { normalizeModelJson } from "../src/normalize";
import { createSingleTetModel, createTwoTetModel } from "./fixtures";

describe("normalizeModelJson", () => {
  test("returns ok false when validation has errors", () => {
    const model = createSingleTetModel();
    model.elementBlocks[0].connectivity = [0, 1, 2, 99];

    const result = normalizeModelJson(model);

    expect(result.ok).toBe(false);
    expect(result.model).toBeUndefined();
    expect(result.report.errors.map((issue) => issue.code)).toContain("node-index-out-of-range");
  });

  test("normalizes typed arrays for a valid single-tet model", () => {
    const result = normalizeModelJson(createSingleTetModel());

    expect(result.ok).toBe(true);
    expect(result.model?.nodes.coordinates).toBeInstanceOf(Float64Array);
    expect(result.model?.elementBlocks[0].connectivity).toBeInstanceOf(Uint32Array);
    expect(result.model?.nodeSets[0].nodes).toBeInstanceOf(Uint32Array);
    expect(result.model?.elementSets[0].elements).toBeInstanceOf(Uint32Array);
  });

  test("resolves material names to material indices", () => {
    const result = normalizeModelJson(createTwoTetModel());

    expect(result.ok).toBe(true);
    expect(result.model?.elementBlocks.map((block) => block.materialIndex)).toEqual([0, 1]);
  });

  test("computes counts for a valid single-tet model", () => {
    const result = normalizeModelJson(createSingleTetModel());

    expect(result.model?.counts).toEqual({
      nodes: 4,
      elements: 1,
      materials: 1,
      nodeSets: 2,
      elementSets: 1,
      loads: 1,
      boundaryConditions: 2,
      steps: 1,
      surfaceFacets: 0,
      surfaceSets: 0
    });
    expect(result.model?.schemaVersion).toBe("0.2.0");
  });

  test("computes counts for a valid two-tet model", () => {
    const result = normalizeModelJson(createTwoTetModel());

    expect(result.model?.counts).toEqual({
      nodes: 5,
      elements: 2,
      materials: 2,
      nodeSets: 2,
      elementSets: 1,
      loads: 1,
      boundaryConditions: 2,
      steps: 1,
      surfaceFacets: 0,
      surfaceSets: 0
    });
  });

  test("normalizes v0.2 surface facets, surface sets, and coordinate metadata", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 7,
          element: 0,
          elementFace: 0,
          nodes: [1, 2, 3],
          area: Math.sqrt(3) / 2,
          normal: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
          center: [1 / 3, 1 / 3, 1 / 3],
          sourceFaceId: "base"
        }
      ],
      surfaceSets: [{ name: "baseFace", facets: [7] }],
      coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "display_model" }
    };

    const result = normalizeModelJson(model);

    expect(result.ok).toBe(true);
    expect(result.model?.schemaVersion).toBe("0.2.0");
    expect(result.model?.surfaceFacets[0].nodes).toBeInstanceOf(Uint32Array);
    expect(result.model?.surfaceSets[0].facets).toBeInstanceOf(Uint32Array);
    expect(result.model?.coordinateSystem.solverUnits).toBe("m-N-s-Pa");
    expect(result.model?.coordinateSystem.renderCoordinateSpace).toBe("display_model");
    expect(result.model?.counts.surfaceFacets).toBe(1);
    expect(result.model?.counts.surfaceSets).toBe(1);
  });

  test("normalizes legacy sinusoidal dynamic profile to canonical half_sine", () => {
    const model = createSingleTetModel();
    model.materials = [{ ...model.materials[0], density: 7850 }];
    model.steps = [
      {
        name: "transient",
        type: "dynamicLinear",
        boundaryConditions: ["fixedSupport"],
        loads: ["tipLoad"],
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.01,
        outputInterval: 0.02,
        loadProfile: "sinusoidal"
      }
    ];

    const result = normalizeModelJson(model);

    expect(result.ok).toBe(true);
    expect(result.model?.steps[0].type).toBe("dynamicLinear");
    expect(result.model?.steps[0].loadProfile).toBe("half_sine");
  });
});
