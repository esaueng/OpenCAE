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
//  3. Built-in materials resolve through @opencae/materials so manufacturing-process
//     compatibility and effective-property calculations cannot drift from the app.
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
import { effectiveMaterialProperties, starterMaterials, type PrintStrengthContext } from "@opencae/materials";
import type { CloudAnalysisType, CloudStudyLike, CoreVolumeMeshArtifact } from "./types";

type BuildCoreModelInput = {
  study?: CloudStudyLike;
  displayModel?: unknown;
  volumeMesh: CoreVolumeMeshArtifact;
  material?: IsotropicLinearElasticMaterialJson | Record<string, unknown>;
  materials?: Array<IsotropicLinearElasticMaterialJson | Record<string, unknown>>;
  analysisType: CloudAnalysisType;
  solverSettings?: Record<string, unknown>;
  /** Governing material axis, already mapped into the solver/global frame. */
  criticalLayerAxis?: "x" | "y" | "z";
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
  process: "FDM" | "SLS" | "SLA" | "MJF" | "Metal AM";
  defaultInfillDensity?: number;
  defaultWallCount?: number;
  defaultLayerOrientation?: "x" | "y" | "z";
  layerStrengthFactor?: number;
  inPlaneModulusFactor?: number;
  interlayerModulusFactor?: number;
  inPlaneStrengthFactor?: number;
  interlayerStrengthFactor?: number;
};

type BuiltInMaterial = IsotropicLinearElasticMaterialJson & {
  density: number;
  yieldStrength: number;
  printProfile?: PrintMaterialProfile;
};

type MaterialCatalog = Map<string, BuiltInMaterial>;

const BUILT_IN_MATERIAL_IDS = new Set(starterMaterials.map((material) => material.id));

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
  const context: PrintStrengthContext = { criticalLayerAxis: input.criticalLayerAxis };
  const material = materialFromUnknown(input.material, providedCatalog, context);
  if (material) return material;

  for (const assignment of materialAssignments) {
    const assigned = materialFromUnknown(assignment, providedCatalog, context);
    if (assigned) return assigned;
  }

  for (const candidate of input.materials ?? []) {
    const listed = materialFromUnknown(candidate, providedCatalog, context);
    if (listed) return listed;
  }
  return materialFromBuiltIn("mat-aluminum-6061", undefined, context);
}

function materialFromUnknown(
  value: unknown,
  catalog: MaterialCatalog = new Map(),
  context: PrintStrengthContext = {}
): IsotropicLinearElasticMaterialJson | undefined {
  if (typeof value === "string") {
    return materialFromCatalog(value, catalog, undefined, context) ?? materialFromBuiltIn(value, undefined, context);
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const materialId = stringValue(raw.materialId);
  if (materialId) {
    return materialFromCatalog(materialId, catalog, objectValue(raw.parameters), context)
      ?? materialFromBuiltIn(materialId, objectValue(raw.parameters), context);
  }

  const directMaterial = materialObjectFromUnknown(raw);
  if (directMaterial) return stripPrintProfile(effectiveMaterial(directMaterial, objectValue(raw.parameters), context));

  const builtInId = stringValue(raw.id) ?? stringValue(raw.name);
  return builtInId
    ? materialFromCatalog(builtInId, catalog, objectValue(raw.parameters), context)
      ?? (BUILT_IN_MATERIAL_IDS.has(builtInId) ? materialFromBuiltIn(builtInId, objectValue(raw.parameters), context) : undefined)
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
  parameters?: Record<string, unknown>,
  context: PrintStrengthContext = {}
): IsotropicLinearElasticMaterialJson | undefined {
  const material = catalog.get(id) ?? catalog.get(id.toLowerCase());
  if (!material) return undefined;
  return stripPrintProfile(effectiveMaterial({ ...material, name: id }, parameters, context));
}

function materialFromBuiltIn(
  id: string,
  parameters?: Record<string, unknown>,
  context: PrintStrengthContext = {}
): IsotropicLinearElasticMaterialJson {
  const material = starterMaterials.find((candidate) => candidate.id === id);
  if (!material) throw new Error(`OpenCAE Core Cloud does not know material ${id}.`);
  const effective = effectiveMaterialProperties(material, parameters ?? {}, context);
  return {
    name: effective.id,
    type: "isotropicLinearElastic",
    youngModulus: effective.youngsModulus,
    poissonRatio: effective.poissonRatio,
    density: effective.density,
    yieldStrength: effective.yieldStrength
  };
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

function printProfileFromUnknown(value: unknown): PrintMaterialProfile | undefined {
  const raw = objectValue(value);
  if (!raw) return undefined;
  const process = printProcess(raw.process);
  const defaultInfillDensity = boundedNumberValue(raw.defaultInfillDensity, 1, 100);
  const defaultWallCount = boundedNumberValue(raw.defaultWallCount, 1, 12);
  const defaultLayerOrientation = isLayerOrientation(raw.defaultLayerOrientation) ? raw.defaultLayerOrientation : undefined;
  const layerStrengthFactor = boundedNumberValue(raw.layerStrengthFactor, 0.1, 1);
  if (!process) return undefined;
  return {
    process,
    ...(defaultInfillDensity === undefined ? {} : { defaultInfillDensity }),
    ...(defaultWallCount === undefined ? {} : { defaultWallCount }),
    ...(defaultLayerOrientation === undefined ? {} : { defaultLayerOrientation }),
    ...(layerStrengthFactor === undefined ? {} : { layerStrengthFactor }),
    inPlaneModulusFactor: boundedNumberValue(raw.inPlaneModulusFactor, 0.1, 1),
    interlayerModulusFactor: boundedNumberValue(raw.interlayerModulusFactor, 0.1, 1),
    inPlaneStrengthFactor: boundedNumberValue(raw.inPlaneStrengthFactor, 0.1, 1),
    interlayerStrengthFactor: boundedNumberValue(raw.interlayerStrengthFactor, 0.1, 1)
  };
}

function printProcess(value: unknown): PrintMaterialProfile["process"] | undefined {
  return value === "FDM" || value === "SLS" || value === "SLA" || value === "MJF" || value === "Metal AM" ? value : undefined;
}

function effectiveMaterial(
  material: BuiltInMaterial,
  parameters: Record<string, unknown> | undefined,
  context: PrintStrengthContext = {}
): BuiltInMaterial {
  const effective = effectiveMaterialProperties({
    id: material.name,
    name: material.name,
    youngsModulus: material.youngModulus,
    poissonRatio: material.poissonRatio,
    density: material.density,
    yieldStrength: material.yieldStrength,
    printProfile: material.printProfile
  }, parameters ?? {}, context);
  return {
    ...material,
    youngModulus: effective.youngsModulus,
    density: effective.density,
    yieldStrength: effective.yieldStrength
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
  // Deviation from the opencae-core@5fff277 mirror: leading/trailing
  // underscores are trimmed with a linear scan instead of /^_+|_+$/g —
  // CodeQL flags the anchored quantifier as polynomial on untrusted input.
  const collapsed = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 0x5f) start += 1;
  while (end > start && collapsed.charCodeAt(end - 1) === 0x5f) end -= 1;
  return collapsed.slice(start, end);
}

function geometricFallback(input: SelectionMappingInput): SurfaceSetJson | undefined {
  const displayFaces = displayModelFaces(input.displayModel);
  const entityIds = new Set([input.selectionRef, ...geometryRefEntityIds(input.study, input.selectionRef)]);
  const face = displayFaces.find((candidate) => entityIds.has(candidate.id));
  if (!face) return undefined;
  // STEP picking can briefly fall back to an ad-hoc point/normal face while
  // the B-rep registry is still warming. Those points live in the normalized
  // 2.4-unit preview frame, while volume-mesh facets live in solver meters.
  // Reproject the picked point into the mesh frame and resolve the actual
  // triangle under it before trying the older centroid heuristic.
  if (face.id.startsWith("face-upload-picked-")) {
    const pickedSurfaceSet = surfaceSetAtPickedUploadPoint(input.volumeMesh, face);
    if (pickedSurfaceSet) return pickedSurfaceSet;
  }
  const ranked = input.volumeMesh.surfaceSets
    .map((set) => ({ set, score: geometricScore(set, input.volumeMesh.surfaceFacets, face) }))
    .filter((entry) => entry.score >= 0.9)
    .sort((left, right) => right.score - left.score);
  if (ranked.length !== 1) return undefined;
  return ranked[0]!.set;
}

const STEP_PREVIEW_LONGEST_SPAN = 2.4;
const PICKED_POINT_MIN_NORMAL_ALIGNMENT = 0.8;
const PICKED_POINT_MAX_DISTANCE_FRACTION = 0.03;
const PICKED_POINT_AMBIGUITY_DISTANCE_FRACTION = 0.005;
const PICKED_POINT_AMBIGUITY_NORMAL_MARGIN = 0.1;

function surfaceSetAtPickedUploadPoint(
  volumeMesh: CoreVolumeMeshArtifact,
  face: { center?: [number, number, number]; normal?: [number, number, number] }
): SurfaceSetJson | undefined {
  if (!face.center || !face.normal) return undefined;
  const bounds = meshNodeBounds(volumeMesh.nodes.coordinates);
  if (!bounds) return undefined;
  const size: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ];
  const longest = Math.max(...size);
  if (!(longest > 0)) return undefined;
  const meshCenter: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
  const previewToMeshScale = longest / STEP_PREVIEW_LONGEST_SPAN;
  const pickedPoint: [number, number, number] = [
    meshCenter[0] + face.center[0] * previewToMeshScale,
    meshCenter[1] + face.center[1] * previewToMeshScale,
    meshCenter[2] + face.center[2] * previewToMeshScale
  ];
  const pickedNormal = normalize(face.normal);
  const facetsById = new Map(volumeMesh.surfaceFacets.map((facet) => [facet.id, facet]));
  const ranked = volumeMesh.surfaceSets
    .flatMap((set) => {
      let distance = Infinity;
      let normalAlignment = -1;
      for (const facetId of set.facets) {
        const facet = facetsById.get(facetId);
        if (!facet) continue;
        const facetDistance = pointToSurfaceFacetDistance(pickedPoint, facet, volumeMesh.nodes.coordinates);
        if (facetDistance < distance) distance = facetDistance;
        if (facet.normal) normalAlignment = Math.max(normalAlignment, dot(pickedNormal, normalize(facet.normal)));
      }
      return Number.isFinite(distance) && normalAlignment >= PICKED_POINT_MIN_NORMAL_ALIGNMENT
        ? [{ set, distance, normalAlignment }]
        : [];
    })
    .sort((left, right) => left.distance - right.distance || right.normalAlignment - left.normalAlignment);

  const best = ranked[0];
  if (!best || best.distance > longest * PICKED_POINT_MAX_DISTANCE_FRACTION) return undefined;
  const runnerUp = ranked[1];
  if (
    runnerUp &&
    runnerUp.distance - best.distance < longest * PICKED_POINT_AMBIGUITY_DISTANCE_FRACTION &&
    best.normalAlignment - runnerUp.normalAlignment < PICKED_POINT_AMBIGUITY_NORMAL_MARGIN
  ) return undefined;
  return best.set;
}

function meshNodeBounds(coordinates: number[]): { min: [number, number, number]; max: [number, number, number] } | undefined {
  if (coordinates.length < 3) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < coordinates.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = coordinates[index + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : undefined;
}

function pointToSurfaceFacetDistance(
  point: [number, number, number],
  facet: SurfaceFacetJson,
  coordinates: number[]
): number {
  const corners = facet.nodes.slice(0, 3).map((node) => nodeCoordinate(coordinates, node));
  if (corners.length !== 3 || corners.some((corner) => !corner)) {
    return facet.center ? Math.hypot(point[0] - facet.center[0], point[1] - facet.center[1], point[2] - facet.center[2]) : Infinity;
  }
  return pointTriangleDistance(point, corners[0]!, corners[1]!, corners[2]!);
}

function nodeCoordinate(coordinates: number[], node: number): [number, number, number] | undefined {
  const offset = node * 3;
  return offset + 2 < coordinates.length
    ? [coordinates[offset]!, coordinates[offset + 1]!, coordinates[offset + 2]!]
    : undefined;
}

/** Exact point-to-triangle distance (Ericson, Real-Time Collision Detection). */
function pointTriangleDistance(
  point: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): number {
  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const ap = subtract(point, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);

  const bp = subtract(point, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(ap[0] - v * ab[0], ap[1] - v * ab[1], ap[2] - v * ab[2]);
  }

  const cp = subtract(point, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(ap[0] - w * ac[0], ap[1] - w * ac[1], ap[2] - w * ac[2]);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = subtract(c, b);
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(bp[0] - w * edge[0], bp[1] - w * edge[1], bp[2] - w * edge[2]);
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return Math.hypot(
    ap[0] - (v * ab[0] + w * ac[0]),
    ap[1] - (v * ab[1] + w * ac[1]),
    ap[2] - (v * ab[2] + w * ac[2])
  );
}

function subtract(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
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

function boundedNumberValue(value: unknown, min: number, max: number): number | undefined {
  const number = numberValue(value);
  return number !== undefined && number >= min && number <= max ? number : undefined;
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
