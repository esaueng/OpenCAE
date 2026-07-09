import { describe, expect, test } from "vitest";
import type { OpenCAEModelJson, SurfaceSetJson } from "../src";
import {
  connectedComponents,
  elementFaces,
  elementNodeCount,
  extractBoundarySurfaceFacets,
  meshQualitySummary,
  nodeSetFromSurfaceSet,
  orphanNodes,
  surfaceArea,
  surfaceNormalAverage,
  tet4Volume
} from "../src/mesh";

const material = {
  name: "steel",
  type: "isotropicLinearElastic" as const,
  youngModulus: 210e9,
  poissonRatio: 0.3
};

function modelWith(connectivity: number[], coordinates: number[]): OpenCAEModelJson {
  return {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [material],
    elementBlocks: [{ name: "solid", type: "Tet4", material: "steel", connectivity }],
    nodeSets: [],
    elementSets: [],
    boundaryConditions: [],
    loads: [],
    steps: []
  };
}

describe("mesh topology utilities", () => {
  test("reports element node counts and Tet4 volume", () => {
    expect(elementNodeCount("Tet4")).toBe(4);
    expect(elementNodeCount("Tet10")).toBe(10);
    expect(tet4Volume([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2, 3])).toBeCloseTo(1 / 6);
  });

  test("extracts four boundary facets from one Tet4", () => {
    const model = modelWith([0, 1, 2, 3], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);

    const facets = extractBoundarySurfaceFacets(model);

    expect(facets).toHaveLength(4);
    expect(facets.map((facet) => facet.id)).toEqual([0, 1, 2, 3]);
    expect(facets[0]).toMatchObject({
      element: 0,
      elementFace: 0,
      nodes: expect.arrayContaining([1, 2, 3])
    });
    expect(facets.every((facet) => facet.area !== undefined && facet.area > 0)).toBe(true);
    expect(facets.every((facet) => facet.center?.length === 3 && facet.normal?.length === 3)).toBe(true);
  });

  test("extracts six boundary facets from two Tet4s sharing a face", () => {
    const model = modelWith(
      [0, 1, 2, 3, 1, 2, 3, 4],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]
    );

    expect(extractBoundarySurfaceFacets(model)).toHaveLength(6);
  });

  test("returns Tet4 and Tet10 element faces", () => {
    expect(elementFaces("Tet4", [0, 1, 2, 3]).map((face) => face.nodes)).toEqual([
      [1, 2, 3],
      [0, 3, 2],
      [0, 1, 3],
      [0, 2, 1]
    ]);
    expect(elementFaces("Tet10", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).map((face) => face.nodes)).toEqual([
      [1, 2, 3, 5, 9, 8],
      [0, 3, 2, 7, 9, 6],
      [0, 1, 3, 4, 8, 7],
      [0, 2, 1, 6, 5, 4]
    ]);
  });

  test("computes surface area, averaged normal, and unique sorted nodes for a surface set", () => {
    const model = modelWith([0, 1, 2, 3], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const facets = extractBoundarySurfaceFacets(model);
    const surfaceSet: SurfaceSetJson = { name: "twoFaces", facets: [0, 1] };

    expect(nodeSetFromSurfaceSet(surfaceSet, facets)).toEqual([0, 1, 2, 3]);
    expect(surfaceArea(surfaceSet, facets)).toBeCloseTo((1 + Math.sqrt(3)) / 2);
    expect(surfaceNormalAverage(surfaceSet, facets)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    ]);
    expect(Math.hypot(...surfaceNormalAverage(surfaceSet, facets))).toBeCloseTo(1);
  });

  test("computes connected and disconnected element components", () => {
    const connected = modelWith(
      [0, 1, 2, 3, 1, 2, 3, 4],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]
    );
    const disconnected = modelWith(
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0, 11, 0, 0, 10, 1, 0, 10, 0, 1]
    );

    expect(connectedComponents(connected)).toEqual({ componentCount: 1, components: [[0, 1]] });
    expect(connectedComponents(disconnected)).toEqual({ componentCount: 2, components: [[0], [1]] });
  });

  test("detects orphan nodes", () => {
    const model = modelWith([0, 1, 2, 3], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2]);

    expect(orphanNodes(model)).toEqual([4]);
  });

  test("summarizes mesh quality including zero and inverted Tet4 volumes", () => {
    const model = modelWith(
      [0, 1, 2, 3, 0, 2, 1, 3, 4, 5, 6, 7],
      [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        10, 0, 0,
        11, 0, 0,
        10, 1, 0,
        11, 1, 0,
        9, 9, 9
      ]
    );

    expect(meshQualitySummary(model)).toMatchObject({
      elementCount: 3,
      nodeCount: 9,
      connectedComponentCount: 2,
      invertedElementCount: 2,
      orphanNodeCount: 1,
      minTetVolume: -1 / 6,
      maxTetVolume: 1 / 6
    });
  });
});
