import { describe, expect, it } from "vitest";
import { buildCoreModelFromCloudMesh, mapSelectionToSurfaceSet, type SelectionMappingDiagnostic } from "./coreModelFromMesh";
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

describe("buildCoreModelFromCloudMesh", () => {
  it("builds modal models without inventing a fallback L1 load surface", () => {
    const model = buildCoreModelFromCloudMesh({
      study: {
        id: "modal-study",
        type: "modal_analysis",
        materialAssignments: [{ materialId: "mat-aluminum-6061" }],
        namedSelections: [
          { id: "bottom", name: "Bottom", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "step-face-4" }] }
        ],
        constraints: [{ id: "fixed", type: "fixed", selectionRef: "bottom", parameters: {} }],
        loads: [],
        solverSettings: { modeCount: 4 }
      },
      volumeMesh: singleTetArtifact(),
      analysisType: "modal_analysis",
      solverSettings: {}
    });

    expect(model.loads).toEqual([]);
    expect(model.meshProvenance?.solver).toBe("opencae-core-local");
    expect(model.steps).toEqual([{
      name: "modalStep",
      type: "modal",
      boundaryConditions: ["fixedSupport0"],
      modeCount: 4
    }]);
  });

  it("rejects an explicit dangling material assignment instead of substituting aluminum", () => {
    expect(() => buildCoreModelFromCloudMesh({
      study: {
        id: "study-unknown-material",
        type: "static_stress",
        materialAssignments: [{ id: "assign-1", materialId: "deleted-custom-material", selectionRef: "selection-body", parameters: {}, status: "complete" }],
        namedSelections: [],
        constraints: [],
        loads: []
      },
      volumeMesh: singleTetArtifact(),
      analysisType: "static_stress",
      solverSettings: {}
    })).toThrow('Unknown material "deleted-custom-material".');
  });

  it("shares one node set when two supports resolve to the same face", () => {
    // Two picks on the same face (e.g. both supports healed onto the tray
    // bottom) must not emit duplicate node-set names — the model validator
    // rejects those with "Names must be unique".
    const model = buildCoreModelFromCloudMesh({
      study: {
        id: "study-1",
        type: "static_stress",
        materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body", parameters: {}, status: "complete" }],
        namedSelections: [
          { id: "selection-fs-a", name: "FS 1", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "step-face-4" }] },
          { id: "selection-fs-b", name: "FS 2", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "step-face-4" }] },
          { id: "selection-l1", name: "L 1", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "step-face-9" }] }
        ],
        constraints: [
          { id: "constraint-1", type: "fixed", selectionRef: "selection-fs-a", parameters: {}, status: "complete" },
          { id: "constraint-2", type: "fixed", selectionRef: "selection-fs-b", parameters: {}, status: "complete" }
        ],
        loads: [
          { id: "load-1", type: "force", selectionRef: "selection-l1", parameters: { value: 5, units: "N", direction: [0, 0, -1] }, status: "complete" }
        ]
      },
      volumeMesh: singleTetArtifact(),
      analysisType: "static_stress",
      solverSettings: {}
    });

    const bottomNodeSets = model.nodeSets.filter((set) => set.name === "surface_bottom_nodes");
    expect(bottomNodeSets).toHaveLength(1);
    expect(model.boundaryConditions.map((condition) => condition.nodeSet)).toEqual([
      "surface_bottom_nodes",
      "surface_bottom_nodes"
    ]);
  });

  it("round-trips advanced load primitives through the meshed-model contract", () => {
    const volumeMesh = singleTetArtifact();
    volumeMesh.surfaceFacets[2]!.normal = [0, 0, 1];
    const model = buildCoreModelFromCloudMesh({
      study: {
        id: "advanced-loads",
        type: "static_stress",
        materialAssignments: [{ materialId: "mat-aluminum-6061" }],
        namedSelections: [
          { id: "body", name: "Body", entityType: "body", geometryRefs: [{ entityType: "body", entityId: "body" }] },
          { id: "bottom", name: "Bottom", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "step-face-4" }] },
          { id: "load", name: "Load", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "step-face-9" }] }
        ],
        constraints: [{ id: "fixed", type: "fixed", selectionRef: "bottom", parameters: {} }],
        loads: [
          { id: "traction", type: "surface_traction", selectionRef: "load", parameters: { value: 2, units: "kPa", direction: [1, 0, 0] } },
          { id: "body-force", type: "volume_force", selectionRef: "body", parameters: { value: 3, units: "kN/m^3", direction: [0, 1, 0] } },
          { id: "remote", type: "remote_force", selectionRef: "load", parameters: { value: 4, units: "N", direction: [0, 0, -1], remotePoint: [0.1, 0.2, 0.3] } }
        ]
      },
      displayModel: { bodyCount: 1 },
      volumeMesh,
      analysisType: "static_stress",
      solverSettings: {}
    });

    expect(model.loads).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "surfaceTraction", traction: [2000, 0, 0] }),
      expect.objectContaining({ type: "bodyForceDensity", elementSet: "allElements", forceDensity: [0, 3000, 0] }),
      expect.objectContaining({ type: "remoteForce", totalForce: [0, 0, -4], remotePoint: [0.1, 0.2, 0.3] })
    ]));
  });
});

/** One positive-volume Tet4 in meters with canonical face facets (TET_CORNER_FACES order). */
function singleTetArtifact(): CoreVolumeMeshArtifact {
  return {
    nodes: {
      coordinates: [0, 0, 0, 0.04, 0, 0, 0, 0.04, 0, 0, 0, 0.04]
    },
    elements: [{ type: "Tet4", connectivity: [0, 1, 2, 3] }],
    surfaceFacets: [
      { id: 0, element: 0, elementFace: 0, nodes: [1, 2, 3], center: [0.0133, 0.0133, 0.0133], normal: [0.577, 0.577, 0.577] },
      { id: 1, element: 0, elementFace: 1, nodes: [0, 3, 2], center: [0, 0.0133, 0.0133], normal: [-1, 0, 0] },
      { id: 2, element: 0, elementFace: 2, nodes: [0, 1, 3], center: [0.0133, 0, 0.0133], normal: [0, -1, 0], sourceFaceId: "step-face-9" },
      { id: 3, element: 0, elementFace: 3, nodes: [0, 2, 1], center: [0.0133, 0.0133, 0], normal: [0, 0, -1], sourceFaceId: "step-face-4" }
    ],
    surfaceSets: [
      { name: "surface_bottom", facets: [3] },
      { name: "surface_load", facets: [2] }
    ],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    metadata: {
      source: "gmsh",
      nodeCount: 4,
      elementCount: 1,
      surfaceFacetCount: 4,
      physicalGroups: [],
      connectedComponentCount: 1,
      meshQuality: { minTetVolume: 1e-8, maxTetVolume: 1e-8, invertedElementCount: 0 },
      diagnostics: [],
      units: "m"
    }
  };
}

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
