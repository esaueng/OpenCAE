export const OPENCAE_CORE_VERSION = "0.1.5";
export type {
  BoundaryConditionJson,
  BodyForceDensityLoadJson,
  BodyGravityLoadJson,
  CoordinateSystemJson,
  DisplacementComponent,
  DynamicLinearStepJson,
  DynamicLoadProfileJson,
  DynamicStepJson,
  ElementSetJson,
  ElementBlockJson,
  ElementType,
  FixedBoundaryConditionJson,
  EquivalentBoltPreloadLoadJson,
  IsotropicLinearElasticMaterialJson,
  LoadJson,
  MeshConnectionJson,
  MeshProvenanceJson,
  ModalStepJson,
  ModelNormalizationResult,
  NodalForceLoadJson,
  NodeSetJson,
  NormalizedElementBlock,
  NormalizedElementSet,
  NormalizedNodeSet,
  NormalizedOpenCAEModel,
  NormalizedSurfaceFacet,
  NormalizedSurfaceSet,
  NormalizedTet4ElementBlock,
  OpenCAEModelJson,
  PhysicalGroupJson,
  PressureLoadJson,
  PrescribedDisplacementBoundaryConditionJson,
  ResultFieldJson,
  ResultSampleLocation,
  SolverSurfaceMeshJson,
  StaticLinearStepJson,
  StepJson,
  SurfaceFacetJson,
  SurfaceForceLoadJson,
  SurfaceTractionLoadJson,
  SurfaceSetJson,
  RemoteForceLoadJson,
  Tet10ElementBlockJson,
  Tet4ElementBlockJson,
  ValidationIssue,
  ValidationReport
} from "./model-json";
export {
  OPENCAE_LEGACY_MODEL_SCHEMA_VERSION,
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION,
  OPENCAE_PREVIOUS_MODEL_SCHEMA_VERSION
} from "./model-json";
export type {
  BuildSurfaceFacetsInput,
  ConnectedComponentsResult,
  MeshLike,
  SelectionMappingOptions,
  SolverSurfaceMeshInput
} from "./topology";
export {
  buildSurfaceFacets,
  COMPLEX_GEOMETRY_REQUIRES_VOLUME_MESH,
  computeTet4SignedVolume,
  connectedComponents,
  createSolverSurfaceMesh,
  deriveNodeSetFromSurfaceSet,
  mapSelectionToSurfaceSet,
  nodesPerElement
} from "./topology";
export type { ElevateTet4MeshInput, ElevateTet4MeshResult } from "./mesh-elevate";
export { elevateTet4MeshToTet10, TET10_EDGE_VERTEX_PAIRS } from "./mesh-elevate";
export type { DisplayModelLike, VolumeMeshSurfaceSetInput, VolumeMeshToModelInput } from "./mesh-adapter";
export {
  assertCoreCanUseDisplayModel,
  deriveFixedSupportNodeSetFromSurface,
  isSimpleBlockLikeDisplayModel,
  volumeMeshToModelJson
} from "./mesh-adapter";
export type { ElementFace, MeshConnectedComponents, MeshQualitySummary, MeshUtilityModel } from "./mesh";
export * as mesh from "./mesh";
export {
  elementFaces,
  elementNodeCount,
  extractBoundarySurfaceFacets,
  meshQualitySummary,
  nodeSetFromSurfaceSet,
  orphanNodes,
  surfaceArea,
  surfaceNormalAverage,
  TET10_HRZ_EDGE_MASS_FRACTION,
  TET10_HRZ_VERTEX_MASS_FRACTION,
  tet4Volume,
  tet10Volume
} from "./mesh";
export type {
  LoadAssemblyDiagnostics,
  LoadAssemblyError,
  LoadAssemblyModel,
  LoadAssemblyPerLoadDiagnostics,
  LoadAssemblyResult
} from "./loads";
export type {
  CoreModelPreflightDiagnostics,
  CoreModelPreflightOptions,
  CoreModelPreflightReport
} from "./validation";
export {
  assembleNodalLoadVector,
  assembleNodalLoadVectorWithDiagnostics
} from "./loads";
export type {
  CoreResultField,
  CoreResultValidationIssue,
  CoreResultValidationReport,
  CoreModalModeSummary,
  CoreModalSolveResult,
  CoreModalSolveSummary,
  CoreSolveDiagnostics,
  CoreSolveResult,
  CoreSolveProvenance,
  CoreSolveSummary,
  CoreStructuralSolveResult,
  CoreStructuralSolveSummary,
  CoreTransientSummary,
  ProductionSurfaceFieldInvariantInput,
  ProductionSurfaceFieldInvariantOptions,
  SolverSurfaceMesh
} from "./results";
export {
  assertProductionSurfaceFieldInvariant,
  createCoreResultField,
  solverSurfaceMeshFromModel,
  validateProductionSurfaceFieldInvariant,
  validateCoreResult
} from "./results";
export { normalizeModelJson } from "./normalize";
export { preflightCoreModel, validateModelJson } from "./validation";
