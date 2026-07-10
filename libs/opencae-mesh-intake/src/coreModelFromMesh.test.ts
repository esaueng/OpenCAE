import { describe, expect, it } from "vitest";
import { mapSelectionToSurfaceSet, type SelectionMappingDiagnostic } from "./coreModelFromMesh";
import type { CoreVolumeMeshArtifact } from "./types";

describe("mapSelectionToSurfaceSet", () => {
  it("maps a temporary STEP picked-point face from preview space onto the mesh surface", () => {
    const selectionRef = "selection-face-upload-picked-m0p72-0p48-0p00-0p00-1p00-0p00";
    const faceId = "face-upload-picked-m0p72-0p48-0p00-0p00-1p00-0p00";
    const diagnostics: SelectionMappingDiagnostic[] = [];

    const mapped = mapSelectionToSurfaceSet({
      study: {
        namedSelections: [{
          id: selectionRef,
          name: "FS 1",
          entityType: "face",
          geometryRefs: [{ entityType: "face", entityId: faceId }]
        }]
      },
      displayModel: {
        faces: [{ id: faceId, center: [-0.72, 0.48, 0], normal: [0, 1, 0] }]
      },
      volumeMesh: boxSurfaceArtifact(),
      selectionRef,
      role: "fixed_support",
      diagnostics
    });

    expect(mapped.name).toBe("surface_top");
    expect(diagnostics).toEqual([{
      selectionRef,
      role: "fixed_support",
      mode: "geometric",
      surfaceSet: "surface_top",
      matchedFacetCount: 2
    }]);
  });

  it("does not guess between equally close coplanar picked-point surfaces", () => {
    const artifact = boxSurfaceArtifact();
    artifact.surfaceSets = [
      { name: "top_a", facets: [0, 1] },
      { name: "top_b", facets: [0, 1] }
    ];
    expect(() => mapSelectionToSurfaceSet({
      displayModel: {
        faces: [{ id: "face-upload-picked-ambiguous", center: [-0.72, 0.48, 0], normal: [0, 1, 0] }]
      },
      volumeMesh: artifact,
      selectionRef: "face-upload-picked-ambiguous",
      role: "fixed_support"
    })).toThrow(/could not map selection/);
  });
});

function boxSurfaceArtifact(): CoreVolumeMeshArtifact {
  return {
    nodes: {
      coordinates: [
        0, 0.04, 0,
        0.1, 0.04, 0,
        0.1, 0.04, 0.02,
        0, 0.04, 0.02,
        0, 0, 0,
        0.1, 0, 0,
        0.1, 0, 0.02,
        0, 0, 0.02
      ]
    },
    elements: [],
    surfaceFacets: [
      { id: 0, element: 0, elementFace: 0, nodes: [0, 1, 2], center: [0.066, 0.04, 0.006], normal: [0, 1, 0] },
      { id: 1, element: 0, elementFace: 1, nodes: [0, 2, 3], center: [0.033, 0.04, 0.013], normal: [0, 1, 0] },
      { id: 2, element: 1, elementFace: 0, nodes: [4, 6, 5], center: [0.066, 0, 0.006], normal: [0, -1, 0] },
      { id: 3, element: 1, elementFace: 1, nodes: [4, 7, 6], center: [0.033, 0, 0.013], normal: [0, -1, 0] }
    ],
    surfaceSets: [
      { name: "surface_top", facets: [0, 1] },
      { name: "surface_bottom", facets: [2, 3] }
    ],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    metadata: {
      source: "gmsh",
      nodeCount: 8,
      elementCount: 0,
      surfaceFacetCount: 4,
      physicalGroups: [],
      connectedComponentCount: 1,
      meshQuality: { minTetVolume: 1, maxTetVolume: 1, invertedElementCount: 0 },
      diagnostics: [],
      units: "m"
    }
  };
}
