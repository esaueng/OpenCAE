// Mirrored from opencae-core@5fff277 services/opencae-core-cloud/src/types.ts — pure parsing only.
// Upstream extraction into a shared package is planned (plan 016, A-M2). Do not diverge without syncing.
//
// Only the types needed by the pure msh parser are mirrored here; request/solve
// payload types (CloudSolveRequest etc.) stay in the cloud service because they
// pull in @opencae/solver-cpu, which the browser intake path must not depend on.
import type { ElementType, SurfaceFacetJson, SurfaceSetJson } from "@opencae/core";

export type SourceSelectionMetadata = {
  sourceSelectionRef?: string;
  sourceFaceId?: string;
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
    };
    diagnostics: string[];
    units: "m";
  };
};
