export const OPENCAE_CORE_VERSION = "0.1.0";
export type {
  BoundaryConditionJson,
  DisplacementComponent,
  ElementSetJson,
  FixedBoundaryConditionJson,
  IsotropicLinearElasticMaterialJson,
  LoadJson,
  ModelNormalizationResult,
  NodalForceLoadJson,
  NodeSetJson,
  NormalizedElementSet,
  NormalizedNodeSet,
  NormalizedOpenCAEModel,
  NormalizedTet4ElementBlock,
  OpenCAEModelJson,
  PrescribedDisplacementBoundaryConditionJson,
  StaticLinearStepJson,
  Tet4ElementBlockJson,
  ValidationIssue,
  ValidationReport
} from "./model-json";
export { OPENCAE_MODEL_SCHEMA, OPENCAE_MODEL_SCHEMA_VERSION } from "./model-json";
export { normalizeModelJson } from "./normalize";
export { validateModelJson } from "./validation";
