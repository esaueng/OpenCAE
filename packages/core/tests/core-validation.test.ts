import { describe, expect, test } from "vitest";
import type { OpenCAEModelJson, SurfaceSetJson } from "../src";
import { solverSurfaceMeshFromModel } from "../src";
import {
  connectedComponents,
  extractBoundarySurfaceFacets,
  nodeSetFromSurfaceSet,
  orphanNodes
} from "../src/mesh";

const material = {
  name: "steel",
  type: "isotropicLinearElastic" as const,
  youngModulus: 210e9,
  poissonRatio: 0.3,
  density: 7850
};

describe("Core validation suite mesh topology", () => {
  test("connected Tet mesh component count is one", () => {
    const model = modelWith(
      [0, 1, 2, 3, 1, 2, 3, 4],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]
    );

    expect(connectedComponents(model)).toEqual({ componentCount: 1, components: [[0, 1]] });
  });

  test("disconnected Tet mesh component count is two", () => {
    const model = modelWith(
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0, 11, 0, 0, 10, 1, 0, 10, 0, 1]
    );

    expect(connectedComponents(model)).toEqual({ componentCount: 2, components: [[0], [1]] });
  });

  test("boundary surface extraction and surface-set node mapping work", () => {
    const model = modelWith([0, 1, 2, 3], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const facets = extractBoundarySurfaceFacets(model);
    const surfaceSet: SurfaceSetJson = { name: "loadFace", facets: [0] };
    const surfaceMesh = solverSurfaceMeshFromModel({ ...model, surfaceFacets: facets, surfaceSets: [surfaceSet] });

    expect(facets).toHaveLength(4);
    expect(nodeSetFromSurfaceSet(surfaceSet, facets)).toEqual([1, 2, 3]);
    expect(surfaceMesh.triangles).toHaveLength(4);
    expect(surfaceMesh.nodes).toHaveLength(4);
  });

  test("Tet10 boundary extraction keeps quadratic face nodes and triangulates solver surface", () => {
    const model = modelWith(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [
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
      ],
      "Tet10"
    );

    const facets = extractBoundarySurfaceFacets(model);
    const surfaceMesh = solverSurfaceMeshFromModel({ ...model, surfaceFacets: facets });

    expect(facets).toHaveLength(4);
    expect(facets[0]?.nodes).toHaveLength(6);
    expect(surfaceMesh.nodes).toHaveLength(10);
    expect(surfaceMesh.triangles).toHaveLength(16);
    expect(surfaceMesh.nodeMap).toHaveLength(surfaceMesh.nodes.length);
  });

  test("orphan nodes are detected before solve", () => {
    const model = modelWith([0, 1, 2, 3], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 9, 9, 9]);

    expect(orphanNodes(model)).toEqual([4]);
  });
});

function modelWith(connectivity: number[], coordinates: number[], type: "Tet4" | "Tet10" = "Tet4"): OpenCAEModelJson {
  return {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [material],
    elementBlocks: [{ name: "solid", type, material: "steel", connectivity }],
    nodeSets: [],
    elementSets: [],
    boundaryConditions: [],
    loads: [],
    steps: []
  };
}
