export const OPENCAE_MODEL_SCHEMA = "opencae.model";
export const OPENCAE_MODEL_SCHEMA_VERSION = "0.1.0";

export type OpenCAEModelJson = {
  schema: typeof OPENCAE_MODEL_SCHEMA;
  schemaVersion: typeof OPENCAE_MODEL_SCHEMA_VERSION;
  nodes: {
    coordinates: number[];
  };
  materials: IsotropicLinearElasticMaterialJson[];
  elementBlocks: Tet4ElementBlockJson[];
  nodeSets: NodeSetJson[];
  elementSets: ElementSetJson[];
  boundaryConditions: BoundaryConditionJson[];
  loads: LoadJson[];
  steps: StaticLinearStepJson[];
};

export type IsotropicLinearElasticMaterialJson = {
  name: string;
  type: "isotropicLinearElastic";
  youngModulus: number;
  poissonRatio: number;
};

export type Tet4ElementBlockJson = {
  name: string;
  type: "Tet4";
  material: string;
  connectivity: number[];
};

export type NodeSetJson = {
  name: string;
  nodes: number[];
};

export type ElementSetJson = {
  name: string;
  elements: number[];
};

export type BoundaryConditionJson = FixedBoundaryConditionJson | PrescribedDisplacementBoundaryConditionJson;

export type FixedBoundaryConditionJson = {
  name: string;
  type: "fixed";
  nodeSet: string;
  components: DisplacementComponent[];
};

export type PrescribedDisplacementBoundaryConditionJson = {
  name: string;
  type: "prescribedDisplacement";
  nodeSet: string;
  component: DisplacementComponent;
  value: number;
};

export type DisplacementComponent = "x" | "y" | "z";

export type LoadJson = NodalForceLoadJson;

export type NodalForceLoadJson = {
  name: string;
  type: "nodalForce";
  nodeSet: string;
  vector: [number, number, number];
};

export type StaticLinearStepJson = {
  name: string;
  type: "staticLinear";
  boundaryConditions: string[];
  loads: string[];
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
  elementBlocks: NormalizedTet4ElementBlock[];
  nodeSets: NormalizedNodeSet[];
  elementSets: NormalizedElementSet[];
  boundaryConditions: BoundaryConditionJson[];
  loads: LoadJson[];
  steps: StaticLinearStepJson[];
  counts: {
    nodes: number;
    elements: number;
    materials: number;
    nodeSets: number;
    elementSets: number;
    loads: number;
    boundaryConditions: number;
    steps: number;
  };
};

export type NormalizedTet4ElementBlock = {
  name: string;
  type: "Tet4";
  material: string;
  materialIndex: number;
  connectivity: Uint32Array;
};

export type NormalizedNodeSet = {
  name: string;
  nodes: Uint32Array;
};

export type NormalizedElementSet = {
  name: string;
  elements: Uint32Array;
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
