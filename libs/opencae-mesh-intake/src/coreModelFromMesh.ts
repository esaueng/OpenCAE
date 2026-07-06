// Mirrored from opencae-core@5fff277 services/opencae-core-cloud/src/coreModelFromMesh.ts — pure model building only.
// Upstream extraction into a shared package is planned (plan 016, A-M2). Do not diverge without syncing.
//
// Two deliberate deviations:
//  1. The upstream `solverSettings?: DynamicTet4CpuOptions & Record<string, unknown>`
//     type is widened to plain `Record<string, unknown>` here so this browser-side
//     library never depends on @opencae/solver-cpu (type-only upstream; all reads go
//     through numberValue()/dynamicLoadProfile() either way).
//  2. A-M3 adds an OPTIONAL `diagnostics`/`mappingDiagnostics` sink that records which
//     branch of mapSelectionToSurfaceSet resolved each selection (bySelection/byFace/
//     byPhysical/geometric). Purely additive — when the sink is omitted, behavior is
//     byte-identical to upstream. Sync upstream when plan 016's extraction lands.
import {
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION,
  nodeSetFromSurfaceSet,
  preflightCoreModel,
  validateModelJson,
  type BoundaryConditionJson,
  type IsotropicLinearElasticMaterialJson,
  type LoadJson,
  type NodeSetJson,
  type OpenCAEModelJson,
  type StepJson,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";
import type { CloudAnalysisType, CloudStudyLike, CoreVolumeMeshArtifact } from "./types";

type BuildCoreModelInput = {
  study?: CloudStudyLike;
  displayModel?: unknown;
  volumeMesh: CoreVolumeMeshArtifact;
  material?: IsotropicLinearElasticMaterialJson | Record<string, unknown>;
  materials?: Array<IsotropicLinearElasticMaterialJson | Record<string, unknown>>;
  analysisType: CloudAnalysisType;
  solverSettings?: Record<string, unknown>;
  /** A-M3 deviation (see header): collects how each selection was mapped. */
  mappingDiagnostics?: SelectionMappingDiagnostic[];
};

export type SelectionMappingMode = "bySelection" | "byFace" | "byPhysical" | "geometric";

export type SelectionMappingDiagnostic = {
  selectionRef: string;
  role: "fixed_support" | "load_surface";
  mode: SelectionMappingMode;
  surfaceSet: string;
  matchedFacetCount: number;
};

type SelectionMappingInput = {
  study?: CloudStudyLike;
  displayModel?: unknown;
  volumeMesh: CoreVolumeMeshArtifact;
  selectionRef: string;
  role: "fixed_support" | "load_surface";
  /** A-M3 deviation (see header): receives one entry describing the resolved mapping. */
  diagnostics?: SelectionMappingDiagnostic[];
};

const STANDARD_GRAVITY = 9.80665;

type PrintMaterialProfile = {
  process: "FDM" | "SLS" | "SLA" | "Metal AM";
  defaultInfillDensity: number;
  defaultWallCount: number;
  defaultLayerOrientation: "x" | "y" | "z";
  layerStrengthFactor: number;
};

type BuiltInMaterial = IsotropicLinearElasticMaterialJson & {
  density: number;
  yieldStrength: number;
  printProfile?: PrintMaterialProfile;
};

type MaterialCatalog = Map<string, BuiltInMaterial>;

const BUILT_IN_MATERIALS: Record<string, BuiltInMaterial> = {
  "mat-aluminum-6061": materialDefinition("mat-aluminum-6061", 68_900_000_000, 0.33, 2700, 276_000_000),
  "mat-aluminum-7075": materialDefinition("mat-aluminum-7075", 71_700_000_000, 0.33, 2810, 503_000_000),
  "mat-steel": materialDefinition("mat-steel", 200_000_000_000, 0.29, 7850, 250_000_000),
  "mat-stainless-304": materialDefinition("mat-stainless-304", 193_000_000_000, 0.29, 8000, 215_000_000),
  "mat-titanium-grade-5": materialDefinition("mat-titanium-grade-5", 114_000_000_000, 0.34, 4430, 880_000_000),
  "mat-copper": materialDefinition("mat-copper", 117_000_000_000, 0.34, 8960, 70_000_000),
  "mat-brass": materialDefinition("mat-brass", 100_000_000_000, 0.34, 8530, 200_000_000),
  "mat-abs": materialDefinition("mat-abs", 2_100_000_000, 0.35, 1040, 40_000_000, fdmProfile(35, 3, 0.7)),
  "mat-pla": materialDefinition("mat-pla", 3_500_000_000, 0.36, 1240, 60_000_000, fdmProfile(35, 3, 0.68)),
  "mat-pla-plus": materialDefinition("mat-pla-plus", 3_900_000_000, 0.36, 1240, 68_000_000, fdmProfile(35, 3, 0.7)),
  "mat-petg": materialDefinition("mat-petg", 2_100_000_000, 0.38, 1270, 50_000_000, fdmProfile(40, 3, 0.72)),
  "mat-asa": materialDefinition("mat-asa", 2_200_000_000, 0.35, 1070, 46_000_000, fdmProfile(35, 3, 0.7)),
  "mat-nylon": materialDefinition("mat-nylon", 2_800_000_000, 0.39, 1150, 70_000_000, fdmProfile(40, 3, 0.74)),
  "mat-nylon-cf": materialDefinition("mat-nylon-cf", 7_600_000_000, 0.34, 1180, 105_000_000, fdmProfile(40, 4, 0.78)),
  "mat-pa12-sls": materialDefinition("mat-pa12-sls", 1_700_000_000, 0.39, 1010, 48_000_000, printProfile("SLS", 100, 2, 0.9)),
  "mat-polycarbonate": materialDefinition("mat-polycarbonate", 2_400_000_000, 0.37, 1200, 65_000_000, fdmProfile(40, 3, 0.74)),
  "mat-pc-abs": materialDefinition("mat-pc-abs", 2_300_000_000, 0.36, 1150, 56_000_000, fdmProfile(40, 3, 0.72)),
  "mat-peek": materialDefinition("mat-peek", 3_700_000_000, 0.4, 1300, 97_000_000, fdmProfile(50, 4, 0.78)),
  "mat-sla-tough-resin": materialDefinition("mat-sla-tough-resin", 2_800_000_000, 0.38, 1180, 55_000_000, printProfile("SLA", 100, 1, 0.86)),
  "mat-sla-standard-resin": materialDefinition("mat-sla-standard-resin", 2_200_000_000, 0.38, 1120, 42_000_000, printProfile("SLA", 100, 1, 0.82)),
  "mat-316l-am": materialDefinition("mat-316l-am", 180_000_000_000, 0.3, 7900, 470_000_000, printProfile("Metal AM", 100, 1, 0.92))
};

export function buildCoreModelFromCloudMesh(input: BuildCoreModelInput): OpenCAEModelJson {
  validateVolumeMeshArtifact(input.volumeMesh);
  const material = resolveMaterial(input);
  const elementBlocks = [{
    name: "solid",
    type: input.volumeMesh.elements[0]?.type ?? "Tet4",
    material: material.name,
    connectivity: input.volumeMesh.elements.flatMap((element) => element.connectivity)
  }];
  const elementCount = input.volumeMesh.elements.length;
  const surfaceSets = cloneSurfaceSets(input.volumeMesh.surfaceSets);
  const nodeSets: NodeSetJson[] = [];
  const boundaryConditions: BoundaryConditionJson[] = [];
  const loads: LoadJson[] = [];

  for (const [index, constraint] of (input.study?.constraints ?? []).entries()) {
    if (constraint.type !== "fixed") continue;
    const selectionRef = constraint.selectionRef ?? "FS1";
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef,
      role: "fixed_support",
      diagnostics: input.mappingDiagnostics
    }, surfaceSets);
    const nodeSetName = `${surfaceSet.name}_nodes`;
    nodeSets.push({ name: nodeSetName, nodes: nodeSetFromSurfaceSet(surfaceSet, input.volumeMesh.surfaceFacets) });
    boundaryConditions.push({
      name: `fixedSupport${index}`,
      type: "fixed",
      nodeSet: nodeSetName,
      components: ["x", "y", "z"]
    });
  }

  for (const [index, load] of (input.study?.loads ?? []).entries()) {
    const loadType = load.type ?? "force";
    if (loadType === "gravity" && !load.selectionRef) {
      loads.push({
        name: `bodyGravity${index}`,
        type: "bodyGravity",
        acceleration: gravityAcceleration(load.parameters)
      });
      continue;
    }

    const selectionRef = load.selectionRef ?? "L1";
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef,
      role: "load_surface",
      diagnostics: input.mappingDiagnostics
    }, surfaceSets);

    if (loadType === "pressure") {
      loads.push({
        name: `pressure${index}`,
        type: "pressure",
        surfaceSet: surfaceSet.name,
        pressure: pressurePascals(load.parameters),
        direction: vector3(load.parameters?.direction) ?? [0, 0, -1]
      });
      continue;
    }

    loads.push({
      name: loadType === "gravity" ? `payloadGravity${index}` : `appliedForce${index}`,
      type: "surfaceForce",
      surfaceSet: surfaceSet.name,
      totalForce: loadType === "gravity" ? payloadGravityForce(load.parameters) : forceVector(load.parameters)
    });
  }

  if (boundaryConditions.length === 0) {
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef: "FS1",
      role: "fixed_support",
      diagnostics: input.mappingDiagnostics
    }, surfaceSets);
    const nodeSetName = `${surfaceSet.name}_nodes`;
    nodeSets.push({ name: nodeSetName, nodes: nodeSetFromSurfaceSet(surfaceSet, input.volumeMesh.surfaceFacets) });
    boundaryConditions.push({ name: "fixedSupport0", type: "fixed", nodeSet: nodeSetName, components: ["x", "y", "z"] });
  }
  if (loads.length === 0) {
    const surfaceSet = ensureMappedSurfaceSet({
      study: input.study,
      displayModel: input.displayModel,
      volumeMesh: input.volumeMesh,
      selectionRef: "L1",
      role: "load_surface",
      diagnostics: input.mappingDiagnostics
    }, surfaceSets);
    loads.push({ name: "appliedForce0", type: "surfaceForce", surfaceSet: surfaceSet.name, totalForce: [0, -500, 0] });
  }

  const model: OpenCAEModelJson = {
    schema: OPENCAE_MODEL_SCHEMA,
    schemaVersion: OPENCAE_MODEL_SCHEMA_VERSION,
    nodes: { coordinates: [...input.volumeMesh.nodes.coordinates] },
    materials: [material],
    elementBlocks,
    nodeSets,
    elementSets: [{ name: "allElements", elements: Array.from({ length: elementCount }, (_value, index) => index) }],
    surfaceFacets: input.volumeMesh.surfaceFacets.map((facet) => ({ ...facet, nodes: [...facet.nodes] })),
    surfaceSets,
    boundaryConditions,
    loads,
    steps: [stepFor(input.analysisType, input.study, input.solverSettings, boundaryConditions, loads)],
    coordinateSystem: input.volumeMesh.coordinateSystem,
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: input.volumeMesh.metadata.source === "structured_block" ? "structured_block_core" : "actual_volume_mesh"
    }
  };
  const validation = validateModelJson(model);
  if (!validation.ok) {
    throw new Error(`OpenCAE Core Cloud generated an invalid Core model: ${validation.errors[0]?.message ?? "validation failed"}`);
  }
  const preflight = preflightCoreModel(model, { requireSurfaceSelections: true });
  if (!preflight.ok) {
    throw new Error(`OpenCAE Core Cloud model preflight failed: ${preflight.errors[0]?.message ?? "preflight failed"}`);
  }
  return model;
}

export function mapSelectionToSurfaceSet(input: SelectionMappingInput): SurfaceSetJson {
  const facets = input.volumeMesh.surfaceFacets;
  const bySelection = facets.filter((facet) => facet.sourceSelectionRef === input.selectionRef);
  const bySelectionSet = bestSurfaceSetForFacets(input.volumeMesh.surfaceSets, bySelection);
  if (bySelectionSet) return recordMapping(input, "bySelection", bySelectionSet, bySelection.length);

  const sourceFaceIds = new Set([input.selectionRef, ...geometryRefEntityIds(input.study, input.selectionRef)]);
  const byFace = facets.filter((facet) => facet.sourceFaceId && sourceFaceIds.has(facet.sourceFaceId));
  const byFaceSet = bestSurfaceSetForFacets(input.volumeMesh.surfaceSets, byFace);
  if (byFaceSet) return recordMapping(input, "byFace", byFaceSet, byFace.length);

  const selectionNames = new Set([
    input.selectionRef,
    ...selectionDisplayNames(input.study, input.selectionRef),
    ...sourceFaceIds
  ].map(normalizeName));
  const physicalNames = physicalGroupCandidates(input.role);
  const byPhysical = input.volumeMesh.surfaceSets.find((set) => physicalNames.has(set.name) && selectionNames.has(normalizeName(set.name)));
  if (byPhysical?.facets.length) return recordMapping(input, "byPhysical", byPhysical, byPhysical.facets.length);

  const geometric = geometricFallback(input);
  if (geometric) return recordMapping(input, "geometric", geometric, geometric.facets.length);

  throw new Error(`OpenCAE Core Cloud could not map selection ${input.selectionRef} to a high-confidence ${input.role} surface set.`);
}

function recordMapping(
  input: SelectionMappingInput,
  mode: SelectionMappingMode,
  surfaceSet: SurfaceSetJson,
  matchedFacetCount: number
): SurfaceSetJson {
  input.diagnostics?.push({
    selectionRef: input.selectionRef,
    role: input.role,
    mode,
    surfaceSet: surfaceSet.name,
    matchedFacetCount
  });
  return surfaceSet;
}

function validateVolumeMeshArtifact(volumeMesh: CoreVolumeMeshArtifact): void {
  if (volumeMesh.elements.length === 0) throw new Error("Cloud meshing produced no volume elements.");
  if (volumeMesh.surfaceFacets.length === 0) throw new Error("Cloud meshing produced no boundary surface facets.");
  if (volumeMesh.metadata.connectedComponentCount !== 1) {
    throw new Error(`Cloud meshing produced ${volumeMesh.metadata.connectedComponentCount} connected components; one fused solid is required.`);
  }
  if (volumeMesh.metadata.meshQuality.invertedElementCount > 0) {
    throw new Error(`Cloud meshing produced ${volumeMesh.metadata.meshQuality.invertedElementCount} inverted elements.`);
  }
}

function resolveMaterial(input: BuildCoreModelInput): IsotropicLinearElasticMaterialJson {
  const providedCatalog = providedMaterialCatalog([input.material, ...(input.materials ?? [])]);
  const materialAssignments = input.study?.materialAssignments ?? [];
  const material = materialFromUnknown(input.material, providedCatalog);
  if (material) return material;

  for (const assignment of materialAssignments) {
    const assigned = materialFromUnknown(assignment, providedCatalog);
    if (assigned) return assigned;
  }

  for (const candidate of input.materials ?? []) {
    const listed = materialFromUnknown(candidate, providedCatalog);
    if (listed) return listed;
  }
  return materialFromBuiltIn("mat-aluminum-6061");
}

function materialFromUnknown(value: unknown, catalog: MaterialCatalog = new Map()): IsotropicLinearElasticMaterialJson | undefined {
  if (typeof value === "string") {
    return materialFromCatalog(value, catalog) ?? materialFromBuiltIn(value);
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const materialId = stringValue(raw.materialId);
  if (materialId) {
    return materialFromCatalog(materialId, catalog, objectValue(raw.parameters)) ?? materialFromBuiltIn(materialId, objectValue(raw.parameters));
  }

  const directMaterial = materialObjectFromUnknown(raw);
  if (directMaterial) return stripPrintProfile(effectiveMaterial(directMaterial, objectValue(raw.parameters)));

  const builtInId = stringValue(raw.id) ?? stringValue(raw.name);
  return builtInId
    ? materialFromCatalog(builtInId, catalog, objectValue(raw.parameters))
      ?? (builtInId in BUILT_IN_MATERIALS ? materialFromBuiltIn(builtInId, objectValue(raw.parameters)) : undefined)
    : undefined;
}

function providedMaterialCatalog(candidates: unknown[]): MaterialCatalog {
  const catalog: MaterialCatalog = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const material = materialObjectFromUnknown(raw);
    if (!material) continue;
    for (const alias of [raw.id, raw.materialId, raw.name, material.name]) {
      addCatalogAlias(catalog, alias, material);
    }
  }
  return catalog;
}

function addCatalogAlias(catalog: MaterialCatalog, alias: unknown, material: BuiltInMaterial): void {
  const text = stringValue(alias);
  if (!text) return;
  catalog.set(text, material);
  catalog.set(text.toLowerCase(), material);
}

function materialFromCatalog(
  id: string,
  catalog: MaterialCatalog,
  parameters?: Record<string, unknown>
): IsotropicLinearElasticMaterialJson | undefined {
  const material = catalog.get(id) ?? catalog.get(id.toLowerCase());
  if (!material) return undefined;
  return stripPrintProfile(effectiveMaterial({ ...material, name: id }, parameters));
}

function materialFromBuiltIn(id: string, parameters?: Record<string, unknown>): IsotropicLinearElasticMaterialJson {
  const material = BUILT_IN_MATERIALS[id];
  if (!material) throw new Error(`OpenCAE Core Cloud does not know material ${id}.`);
  return stripPrintProfile(effectiveMaterial(material, parameters));
}

function materialObjectFromUnknown(raw: Record<string, unknown>): BuiltInMaterial | undefined {
  const youngModulus = numberValue(raw.youngModulus ?? raw.youngsModulus);
  const poissonRatio = numberValue(raw.poissonRatio);
  const density = numberValue(raw.density);
  const yieldStrength = numberValue(raw.yieldStrength);
  if (!youngModulus || poissonRatio === undefined || !density || !yieldStrength) return undefined;
  return materialDefinition(
    stringValue(raw.name) ?? stringValue(raw.id) ?? "material",
    youngModulus,
    poissonRatio,
    density,
    yieldStrength,
    printProfileFromUnknown(raw.printProfile)
  );
}

function materialDefinition(
  name: string,
  youngModulus: number,
  poissonRatio: number,
  density: number,
  yieldStrength: number,
  printProfile?: PrintMaterialProfile
): BuiltInMaterial {
  return {
    name,
    type: "isotropicLinearElastic",
    youngModulus,
    poissonRatio,
    density,
    yieldStrength,
    ...(printProfile ? { printProfile } : {})
  };
}

function fdmProfile(defaultInfillDensity: number, defaultWallCount: number, layerStrengthFactor: number): PrintMaterialProfile {
  return printProfile("FDM", defaultInfillDensity, defaultWallCount, layerStrengthFactor);
}

function printProfile(
  process: PrintMaterialProfile["process"],
  defaultInfillDensity: number,
  defaultWallCount: number,
  layerStrengthFactor: number
): PrintMaterialProfile {
  return { process, defaultInfillDensity, defaultWallCount, defaultLayerOrientation: "z", layerStrengthFactor };
}

function printProfileFromUnknown(value: unknown): PrintMaterialProfile | undefined {
  const raw = objectValue(value);
  if (!raw) return undefined;
  const process = printProcess(raw.process);
  const defaultInfillDensity = numberValue(raw.defaultInfillDensity);
  const defaultWallCount = numberValue(raw.defaultWallCount);
  const defaultLayerOrientation = isLayerOrientation(raw.defaultLayerOrientation) ? raw.defaultLayerOrientation : undefined;
  const layerStrengthFactor = numberValue(raw.layerStrengthFactor);
  if (!process || defaultInfillDensity === undefined || defaultWallCount === undefined || !defaultLayerOrientation || layerStrengthFactor === undefined) {
    return undefined;
  }
  return {
    process,
    defaultInfillDensity,
    defaultWallCount,
    defaultLayerOrientation,
    layerStrengthFactor
  };
}

function printProcess(value: unknown): PrintMaterialProfile["process"] | undefined {
  return value === "FDM" || value === "SLS" || value === "SLA" || value === "Metal AM" ? value : undefined;
}

function effectiveMaterial(material: BuiltInMaterial, parameters: Record<string, unknown> | undefined): BuiltInMaterial {
  const printSettings = normalizePrintParameters(material, parameters);
  if (!material.printProfile || !printSettings.printed) return material;

  const infill = clamp((printSettings.infillDensity ?? 100) / 100, 0.05, 1);
  const wallCount = clamp(printSettings.wallCount ?? 3, 1, 12);
  const shellShare = clamp(0.12 + wallCount * 0.045, 0.16, 0.5);
  const sectionFill = clamp(shellShare + (1 - shellShare) * infill, 0.05, 1);
  const layerFactor = printSettings.layerOrientation === "z" ? 1 : material.printProfile.layerStrengthFactor;
  const stiffnessFactor = clamp(0.18 + 0.82 * sectionFill ** 1.35, 0.08, 1);
  const strengthFactor = clamp((0.25 + 0.75 * sectionFill ** 1.15) * layerFactor, 0.08, 1);
  const densityFactor = clamp(0.18 + 0.82 * sectionFill, 0.08, 1);

  return {
    ...material,
    youngModulus: material.youngModulus * stiffnessFactor,
    density: material.density * densityFactor,
    yieldStrength: material.yieldStrength * strengthFactor
  };
}

function normalizePrintParameters(
  material: BuiltInMaterial,
  parameters: Record<string, unknown> | undefined
): { printed: boolean; infillDensity: number; wallCount: number; layerOrientation: "x" | "y" | "z" } {
  return {
    printed: typeof parameters?.printed === "boolean" ? parameters.printed : Boolean(material.printProfile),
    infillDensity: clamp(numberValue(parameters?.infillDensity) ?? material.printProfile?.defaultInfillDensity ?? 100, 1, 100),
    wallCount: Math.round(clamp(numberValue(parameters?.wallCount) ?? material.printProfile?.defaultWallCount ?? 1, 1, 12)),
    layerOrientation: isLayerOrientation(parameters?.layerOrientation) ? parameters.layerOrientation : material.printProfile?.defaultLayerOrientation ?? "z"
  };
}

function stripPrintProfile(material: BuiltInMaterial): IsotropicLinearElasticMaterialJson {
  return {
    name: material.name,
    type: material.type,
    youngModulus: material.youngModulus,
    poissonRatio: material.poissonRatio,
    density: material.density,
    yieldStrength: material.yieldStrength
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isLayerOrientation(value: unknown): value is "x" | "y" | "z" {
  return value === "x" || value === "y" || value === "z";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ensureMappedSurfaceSet(input: SelectionMappingInput, surfaceSets: SurfaceSetJson[]): SurfaceSetJson {
  const mapped = mapSelectionToSurfaceSet(input);
  const existing = surfaceSets.find((set) => set.name === mapped.name);
  if (existing) return existing;
  surfaceSets.push(mapped);
  return mapped;
}

function cloneSurfaceSets(surfaceSets: SurfaceSetJson[]): SurfaceSetJson[] {
  return surfaceSets.map((set) => ({ name: set.name, facets: [...set.facets] }));
}

function bestSurfaceSetForFacets(surfaceSets: SurfaceSetJson[], facets: SurfaceFacetJson[]): SurfaceSetJson | undefined {
  if (facets.length === 0) return undefined;
  const facetIds = new Set(facets.map((facet) => facet.id));
  const ranked = surfaceSets
    .map((set) => ({
      set,
      matches: set.facets.filter((facet) => facetIds.has(facet)).length
    }))
    .filter((entry) => entry.matches > 0)
    .sort((left, right) => right.matches - left.matches);
  return ranked[0]?.set;
}

function geometryRefEntityIds(study: CloudStudyLike | undefined, selectionRef: string): string[] {
  const selection = study?.namedSelections?.find((candidate) => candidate.id === selectionRef);
  return selection?.geometryRefs?.map((ref) => ref.entityId).filter((value): value is string => typeof value === "string") ?? [];
}

function selectionDisplayNames(study: CloudStudyLike | undefined, selectionRef: string): string[] {
  const selection = study?.namedSelections?.find((candidate) => candidate.id === selectionRef);
  return [selection?.name].filter((value): value is string => typeof value === "string");
}

function physicalGroupCandidates(role: SelectionMappingInput["role"]): Set<string> {
  return role === "fixed_support"
    ? new Set(["fixed_support", "base_mount", "fixed", "support"])
    : new Set(["load_surface", "upright_load", "load", "force"]);
}

function normalizeName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function geometricFallback(input: SelectionMappingInput): SurfaceSetJson | undefined {
  const displayFaces = displayModelFaces(input.displayModel);
  const entityIds = new Set([input.selectionRef, ...geometryRefEntityIds(input.study, input.selectionRef)]);
  const face = displayFaces.find((candidate) => entityIds.has(candidate.id));
  if (!face) return undefined;
  const ranked = input.volumeMesh.surfaceSets
    .map((set) => ({ set, score: geometricScore(set, input.volumeMesh.surfaceFacets, face) }))
    .filter((entry) => entry.score >= 0.9)
    .sort((left, right) => right.score - left.score);
  if (ranked.length !== 1) return undefined;
  return ranked[0]!.set;
}

function displayModelFaces(displayModel: unknown): Array<{ id: string; center?: [number, number, number]; normal?: [number, number, number] }> {
  if (!displayModel || typeof displayModel !== "object") return [];
  const faces = (displayModel as { faces?: unknown }).faces;
  if (!Array.isArray(faces)) return [];
  return faces.flatMap((face) => {
    if (!face || typeof face !== "object") return [];
    const raw = face as { id?: unknown; center?: unknown; normal?: unknown };
    return typeof raw.id === "string" ? [{ id: raw.id, center: vector3(raw.center), normal: vector3(raw.normal) }] : [];
  });
}

function geometricScore(surfaceSet: SurfaceSetJson, facets: SurfaceFacetJson[], face: { center?: [number, number, number]; normal?: [number, number, number] }): number {
  const selected = facets.filter((facet) => surfaceSet.facets.includes(facet.id));
  if (selected.length === 0) return 0;
  const centroid = average(selected.map((facet) => facet.center).filter((value): value is [number, number, number] => Array.isArray(value)));
  const normal = average(selected.map((facet) => facet.normal).filter((value): value is [number, number, number] => Array.isArray(value)));
  const normalScore = face.normal && normal ? Math.max(0, dot(normalize(normal), normalize(face.normal))) : 0.5;
  const distanceScore = face.center && centroid ? Math.max(0, 1 - Math.hypot(centroid[0] - face.center[0], centroid[1] - face.center[1], centroid[2] - face.center[2]) / 0.02) : 0.5;
  return normalScore * 0.6 + distanceScore * 0.4;
}

function stepFor(
  analysisType: CloudAnalysisType,
  study: CloudStudyLike | undefined,
  solverSettings: Record<string, unknown> | undefined,
  boundaryConditions: BoundaryConditionJson[],
  loads: LoadJson[]
): StepJson {
  const names = {
    boundaryConditions: boundaryConditions.map((condition) => condition.name),
    loads: loads.map((load) => load.name)
  };
  if (analysisType === "static_stress") {
    return { name: "loadStep", type: "staticLinear", ...names };
  }
  const settings = { ...(study?.solverSettings ?? {}), ...(solverSettings ?? {}) };
  return {
    name: "dynamicStep",
    type: "dynamicLinear",
    ...names,
    startTime: numberValue(settings.startTime) ?? 0,
    endTime: numberValue(settings.endTime) ?? 0.1,
    timeStep: numberValue(settings.timeStep) ?? 0.005,
    outputInterval: numberValue(settings.outputInterval) ?? 0.005,
    loadProfile: dynamicLoadProfile(settings.loadProfile),
    dampingRatio: numberValue(settings.dampingRatio) ?? 0.02,
    ...(numberValue(settings.rayleighAlpha) !== undefined ? { rayleighAlpha: numberValue(settings.rayleighAlpha) } : {}),
    ...(numberValue(settings.rayleighBeta) !== undefined ? { rayleighBeta: numberValue(settings.rayleighBeta) } : {})
  };
}

function forceVector(parameters: Record<string, unknown> | undefined): [number, number, number] {
  const direction = normalize(vector3(parameters?.direction) ?? [0, -1, 0]);
  const value = numberValue(parameters?.value) ?? 0;
  return [direction[0] * value, direction[1] * value, direction[2] * value];
}

function pressurePascals(parameters: Record<string, unknown> | undefined): number {
  const value = numberValue(parameters?.value) ?? 0;
  const units = typeof parameters?.units === "string" ? parameters.units.toLowerCase() : "pa";
  if (units === "kpa") return value * 1000;
  if (units === "mpa") return value * 1_000_000;
  if (units === "psi") return value * 6894.757293168;
  return value;
}

function payloadGravityForce(parameters: Record<string, unknown> | undefined): [number, number, number] {
  const direction = normalize(vector3(parameters?.direction) ?? [0, -1, 0]);
  const massKg = numberValue(parameters?.value) ?? numberValue(parameters?.payloadMassKg) ?? 0;
  return [direction[0] * massKg * STANDARD_GRAVITY, direction[1] * massKg * STANDARD_GRAVITY, direction[2] * massKg * STANDARD_GRAVITY];
}

function gravityAcceleration(parameters: Record<string, unknown> | undefined): [number, number, number] {
  const direction = normalize(vector3(parameters?.direction) ?? [0, -1, 0]);
  return [direction[0] * STANDARD_GRAVITY, direction[1] * STANDARD_GRAVITY, direction[2] * STANDARD_GRAVITY];
}

function dynamicLoadProfile(value: unknown): "step" | "ramp" | "quasi_static" | "half_sine" {
  if (value === "step" || value === "ramp" || value === "quasi_static" || value === "half_sine") return value;
  if (value === "quasiStatic") return "quasi_static";
  if (value === "sinusoidal") return "half_sine";
  return "ramp";
}

function vector3(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0]!, value[1]!, value[2]!]
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, -1, 0];
}

function average(values: Array<[number, number, number]>): [number, number, number] | undefined {
  if (values.length === 0) return undefined;
  const sum = values.reduce<[number, number, number]>((acc, value) => [acc[0] + value[0], acc[1] + value[1], acc[2] + value[2]], [0, 0, 0]);
  return [sum[0] / values.length, sum[1] / values.length, sum[2] / values.length];
}

function dot(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}
