import { describe, expect, test } from "vitest";
import {
  buildSurfaceFacets,
  connectedComponents,
  createSolverSurfaceMesh,
  deriveNodeSetFromSurfaceSet,
  mapSelectionToSurfaceSet,
  volumeMeshToModelJson
} from "../src";

const coordinates = [
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
  1, 1, 1
];

describe("actual volume mesh adapter", () => {
  test("converts a Tet4 volume mesh into a v0.2 model with surface facets and sets", () => {
    const model = volumeMeshToModelJson({
      nodes: { coordinates },
      materials: [
        {
          name: "steel",
          type: "isotropicLinearElastic",
          youngModulus: 210e9,
          poissonRatio: 0.3
        }
      ],
      elementBlocks: [
        {
          name: "solid",
          type: "Tet4",
          material: "steel",
          connectivity: [0, 1, 2, 3, 1, 2, 3, 4]
        }
      ],
      surfaceSets: [
        {
          name: "top",
          sourceSelectionRef: "load-face"
        }
      ]
    });

    expect(model.schemaVersion).toBe("0.2.0");
    expect(model.surfaceFacets?.length).toBe(6);
    expect(model.surfaceSets?.[0].facets.length).toBeGreaterThan(0);
    expect(model.meshProvenance?.meshSource).toBe("actual_volume_mesh");
  });

  test("builds connected component ids from shared Tet4 faces or nodes", () => {
    const fused = connectedComponents({
      elementBlocks: [
        {
          name: "solid",
          type: "Tet4",
          material: "steel",
          connectivity: [0, 1, 2, 3, 1, 2, 3, 4]
        }
      ]
    });

    const disconnected = connectedComponents({
      elementBlocks: [
        {
          name: "solid",
          type: "Tet4",
          material: "steel",
          connectivity: [0, 1, 2, 3, 5, 6, 7, 8]
        }
      ]
    });

    expect(fused.componentCount).toBe(1);
    expect(Array.from(fused.elementComponentIds)).toEqual([0, 0]);
    expect(disconnected.componentCount).toBe(2);
  });

  test("maps confident source face selections to surface sets and derives node sets", () => {
    const facets = buildSurfaceFacets({
      coordinates,
      elementBlocks: [
        {
          name: "solid",
          type: "Tet4",
          material: "steel",
          connectivity: [0, 1, 2, 3]
        }
      ],
      sourceFaces: [
        {
          sourceFaceId: "base",
          element: 0,
          elementFace: 0
        }
      ]
    });

    const surfaceSet = mapSelectionToSurfaceSet("base", { surfaceFacets: facets }, { minConfidence: 0.99 });
    const nodeSet = deriveNodeSetFromSurfaceSet("fixed", surfaceSet, facets);

    expect(surfaceSet.name).toBe("base");
    expect(surfaceSet.facets).toEqual([facets[0].id]);
    expect(nodeSet).toEqual({ name: "fixed", nodes: expect.arrayContaining(facets[0].nodes) });
  });

  test("rejects low-confidence complex selection mapping instead of nearest-node fallback", () => {
    expect(() => mapSelectionToSurfaceSet("missing-face", { surfaceFacets: [] })).toThrow(
      "OpenCAE Core requires an actual volume mesh for complex geometry. Use Cloud FEA or generate a Core mesh."
    );
  });

  test("creates a solver surface mesh from boundary facets without projecting to display primitives", () => {
    const facets = buildSurfaceFacets({
      coordinates,
      elementBlocks: [
        {
          name: "solid",
          type: "Tet4",
          material: "steel",
          connectivity: [0, 1, 2, 3]
        }
      ]
    });

    const surface = createSolverSurfaceMesh({ coordinates, surfaceFacets: facets });

    expect(surface.surfaceNodes.length).toBe(12);
    expect(surface.surfaceTriangles.length).toBe(12);
    expect(surface.coordinateSpace).toBe("solver");
  });

  test("preserves imported physical groups as material, element, and surface identity", () => {
    const model = volumeMeshToModelJson({
      nodes: { coordinates },
      materials: [
        {
          name: "steel",
          type: "isotropicLinearElastic",
          youngModulus: 210e9,
          poissonRatio: 0.3
        }
      ],
      elementBlocks: [
        {
          name: "solid",
          type: "Tet4",
          material: "steel",
          connectivity: [0, 1, 2, 3]
        }
      ],
      physicalGroups: [
        { name: "fixed_face", dimension: 2, sourceSelectionRef: "base" },
        { name: "solid_region", dimension: 3, elements: [0], material: "steel" }
      ],
      sourceFaces: [
        {
          sourceSelectionRef: "base",
          element: 0,
          elementFace: 0
        }
      ],
      meshProvenance: {
        kind: "opencae_core_fea",
        solver: "gmsh",
        resultSource: "computed",
        meshSource: "gmsh_volume_mesh"
      }
    });

    expect(model.meshProvenance?.meshSource).toBe("gmsh_volume_mesh");
    expect(model.surfaceSets?.find((set) => set.name === "fixed_face")?.facets).toEqual([0]);
    expect(model.elementSets.find((set) => set.name === "solid_region")?.elements).toEqual([0]);
    expect(model.elementBlocks[0].material).toBe("steel");
  });
});
