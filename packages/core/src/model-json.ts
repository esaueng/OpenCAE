export const OPENCAE_MODEL_SCHEMA = "opencae.model";
export const OPENCAE_MODEL_SCHEMA_VERSION = "0.2.0";
export const OPENCAE_LEGACY_MODEL_SCHEMA_VERSION = "0.1.0";

export type OpenCAEModelSchemaVersion =
  | typeof OPENCAE_MODEL_SCHEMA_VERSION
  | typeof OPENCAE_LEGACY_MODEL_SCHEMA_VERSION;

export type ElementType = "Tet4" | "Tet10";

export type OpenCAEModelJson = {
  schema: typeof OPENCAE_MODEL_SCHEMA;
  schemaVersion: OpenCAEModelSchemaVersion;
  nodes: {
    coordinates: number[];
  };
  materials: IsotropicLinearElasticMaterialJson[];
  elementBlocks: ElementBlockJson[];
  nodeSets: NodeSetJson[];
  elementSets: ElementSetJson[];
  boundaryConditions: BoundaryConditionJson[];
  loads: LoadJson[];
  steps: StepJson[];
  surfaceFacets?: SurfaceFacetJson[];
  surfaceSets?: SurfaceSetJson[];
  coordinateSystem?: CoordinateSystemJson;
  meshProvenance?: MeshProvenanceJson;
  meshConnections?: MeshConnectionJson[];
};

export type IsotropicLinearElasticMaterialJson = {
  name: string;
  type: "isotropicLinearElastic";
  youngModulus: number;
  poissonRatio: number;
  yieldStrength?: number;
  density?: number;
};

export type ElementBlockJson = {
  name: string;
  type: ElementType;
  material: string;
  connectivity: number[];
};

export type Tet4ElementBlockJson = ElementBlockJson & {
  type: "Tet4";
};

export type Tet10ElementBlockJson = ElementBlockJson & {
  type: "Tet10";
};

export type NodeSetJson = {
  name: string;
  nodes: number[];
};

export type ElementSetJson = {
  name: string;
  elements: number[];
};

export type SurfaceFacetJson = {
  id: number;
  element: number;
  elementFace: number;
  nodes: number[];
  area?: number;
  normal?: [number, number, number];
  center?: [number, number, number];
  sourceFaceId?: string;
  sourceSelectionRef?: string;
};

export type SurfaceSetJson = {
  name: string;
  facets: number[];
};

export type CoordinateSystemJson = {
  solverUnits: "m-N-s-Pa" | "mm-N-s-MPa";
  renderCoordinateSpace?: "solver" | "display_model";
};

export type MeshProvenanceJson = {
  meshSource:
    | "actual_volume_mesh"
    | "structured_block_core"
    | "uploaded_volume_mesh"
    | "gmsh_volume_mesh"
    | "display_bounds_proxy";
  solver?: string;
  resultSource?: string;
  kind?: string;
};

export type MeshConnectionJson = {
  type: "tie" | "contact" | "fuse";
  source: string;
  target: string;
};

export type PhysicalGroupJson = {
  name: string;
  dimension: 2 | 3;
  sourceSelectionRef?: string;
  sourceFaceId?: string;
  facets?: number[];
  elements?: number[];
  material?: string;
};

export type BoundaryConditionJson = FixedBoundaryConditionJson | PrescribedDisplacementBoundaryConditionJson;

export type FixedBoundaryConditionJson = {
  name: string;
  type: "fixed";
  components: DisplacementComponent[];
} & (
  | {
      nodeSet: string;
      surfaceSet?: never;
    }
  | {
      surfaceSet: string;
      nodeSet?: never;
    }
);

export type PrescribedDisplacementBoundaryConditionJson = {
  name: string;
  type: "prescribedDisplacement";
  nodeSet: string;
  component: DisplacementComponent;
  value: number;
};

export type DisplacementComponent = "x" | "y" | "z";

export type LoadJson = NodalForceLoadJson | SurfaceForceLoadJson | PressureLoadJson | BodyGravityLoadJson;

export type NodalForceLoadJson = {
  name: string;
  type: "nodalForce";
  nodeSet: string;
  vector: [number, number, number];
};

export type SurfaceForceLoadJson = {
  name: string;
  type: "surfaceForce";
  surfaceSet: string;
  totalForce: [number, number, number];
};

export type PressureLoadJson = {
  name: string;
  type: "pressure";
  surfaceSet: string;
  pressure: number;
  direction?: [number, number, number];
};

export type BodyGravityLoadJson = {
  name: string;
  type: "bodyGravity";
  acceleration: [number, number, number];
};

export type StepJson = StaticLinearStepJson | DynamicLinearStepJson;

export type StaticLinearStepJson = {
  name: string;
  type: "staticLinear";
  boundaryConditions: string[];
  loads: string[];
};

export type DynamicLoadProfileJson = "step" | "ramp" | "quasi_static" | "half_sine" | "sinusoidal";

export type DynamicLinearStepJson = {
  name: string;
  type: "dynamicLinear";
  boundaryConditions: string[];
  loads: string[];
  startTime: number;
  endTime: number;
  timeStep: number;
  outputInterval: number;
  loadProfile: DynamicLoadProfileJson;
  dampingRatio?: number;
  rayleighAlpha?: number;
  rayleighBeta?: number;
};

export type DynamicStepJson = DynamicLinearStepJson;

export type ResultSampleLocation = "node" | "element" | "integration_point";

export type ResultFieldJson = {
  name: string;
  values: number[] | Float64Array;
  samples: number[];
  frameIndex: number;
  timeSeconds: number;
  meshRef: string;
  coordinateSpace: string;
  surfaceMeshRef?: string;
  sampleLocation: ResultSampleLocation;
};

export type SolverSurfaceMeshJson = {
  surfaceNodes: number[];
  surfaceTriangles: number[];
  coordinateSpace: string;
  meshRef: string;
};

export type ValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export type ValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type NormalizedOpenCAEModel = {
  schema: typeof OPENCAE_MODEL_SCHEMA;
  schemaVersion: typeof OPENCAE_MODEL_SCHEMA_VERSION;
  nodes: {
    coordinates: Float64Array;
  };
  materials: IsotropicLinearElasticMaterialJson[];
  elementBlocks: NormalizedElementBlock[];
  nodeSets: NormalizedNodeSet[];
  elementSets: NormalizedElementSet[];
  surfaceFacets: NormalizedSurfaceFacet[];
  surfaceSets: NormalizedSurfaceSet[];
  boundaryConditions: BoundaryConditionJson[];
  loads: LoadJson[];
  steps: StepJson[];
  coordinateSystem: CoordinateSystemJson;
  meshProvenance?: MeshProvenanceJson;
  meshConnections: MeshConnectionJson[];
  counts: {
    nodes: number;
    elements: number;
    materials: number;
    nodeSets: number;
    elementSets: number;
    surfaceFacets: number;
    surfaceSets: number;
    loads: number;
    boundaryConditions: number;
    steps: number;
  };
};

export type NormalizedElementBlock = {
  name: string;
  type: ElementType;
  material: string;
  materialIndex: number;
  connectivity: Uint32Array;
};

export type NormalizedTet4ElementBlock = NormalizedElementBlock & {
  type: "Tet4";
};

export type NormalizedNodeSet = {
  name: string;
  nodes: Uint32Array;
};

export type NormalizedElementSet = {
  name: string;
  elements: Uint32Array;
};

export type NormalizedSurfaceFacet = Omit<SurfaceFacetJson, "nodes"> & {
  nodes: Uint32Array;
};

export type NormalizedSurfaceSet = {
  name: string;
  facets: Uint32Array;
};

export type ModelNormalizationResult =
  | {
      ok: true;
      report: ValidationReport;
      model: NormalizedOpenCAEModel;
    }
  | {
      ok: false;
      report: ValidationReport;
      model?: undefined;
    };
