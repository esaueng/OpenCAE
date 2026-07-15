// Mirrored from opencae-core@5fff277 services/opencae-core-cloud/src/types.ts — pure parsing only.
// Upstream extraction into a shared package is planned (plan 016, A-M2). Do not diverge without syncing.
//
// Only the types needed by the pure msh parser and the pure model builder
// (coreModelFromMesh.ts) are mirrored here; request/solve payload types
// (CloudSolveRequest etc.) stay in the cloud service because they pull in
// @opencae/solver-cpu, which the browser intake path must not depend on.
import type { ElementType, SurfaceFacetJson, SurfaceSetJson } from "@opencae/core";

export type CloudAnalysisType = "static_stress" | "dynamic_structural" | "modal_analysis" | "steady_state_thermal";

export type CloudStudyLike = {
  id?: string;
  type?: CloudAnalysisType;
  materialAssignments?: Array<{
    materialId?: string;
    parameters?: Record<string, unknown>;
  }>;
  namedSelections?: Array<{
    id?: string;
    name?: string;
    entityType?: string;
    geometryRefs?: Array<{
      entityType?: string;
      entityId?: string;
      label?: string;
    }>;
  }>;
  constraints?: Array<{
    id?: string;
    type?: string;
    selectionRef?: string;
    parameters?: Record<string, unknown>;
  }>;
  loads?: Array<{
    id?: string;
    type?: string;
    selectionRef?: string;
    parameters?: Record<string, unknown>;
  }>;
  contacts?: Array<{
    id?: string;
    type?: "tie" | "contact" | "fuse";
    source?: string;
    target?: string;
    searchTolerance?: number;
    penaltyScale?: number;
    kinematics?: "small_sliding";
  }>;
  solverSettings?: Record<string, unknown>;
};

export type SourceSelectionMetadata = {
  sourceSelectionRef?: string;
  sourceFaceId?: string;
};

/**
 * Records an intentional reduction from quadratic to linear tetrahedra when
 * the quadratic node count would exceed the in-browser solver's DOF budget.
 * The mesh quality gate still applies to the retained Tet4 mesh.
 */
export type ElementOrderFallbackMetadata = {
  requested: 2;
  used: 1;
  reason: "browser_dof_limit";
  quadraticNodeCount: number;
};

export type CloudVolumeElement = {
  type: ElementType;
  connectivity: number[];
  material?: string;
  physicalName?: string;
};

export type CoreVolumeMeshArtifact = {
  nodes: {
    coordinates: number[];
  };
  elements: CloudVolumeElement[];
  surfaceFacets: SurfaceFacetJson[];
  surfaceSets: SurfaceSetJson[];
  coordinateSystem: {
    solverUnits: "m-N-s-Pa" | "mm-N-s-MPa";
    renderCoordinateSpace: "solver";
  };
  metadata: {
    source: "gmsh" | "structured_block" | "uploaded_mesh";
    nodeCount: number;
    elementCount: number;
    surfaceFacetCount: number;
    physicalGroups: Array<{
      dimension: 2 | 3;
      tag: number;
      name: string;
      entityCount: number;
    }>;
    connectedComponentCount: number;
    meshQuality: {
      minTetVolume: number;
      maxTetVolume: number;
      invertedElementCount: number;
      /** Min signed inverse condition number (gmsh minSICN); stamped by the wasm-session quality gate. */
      minSICN?: number;
      /** Quality-gate warnings (e.g. minSICN below the warn threshold). */
      warnings?: string[];
    };
    diagnostics: string[];
    units: "m";
  };
};
