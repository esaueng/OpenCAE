import {
  connectedComponents,
  deriveFixedSupportNodeSetFromSurface,
  validateModelJson,
  volumeMeshToModelJson,
  type LoadJson,
  type OpenCAEModelJson,
  type StepJson,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";
import {
  solveDynamicMdofTet4Cpu,
  solveStaticLinearTet4Cpu,
  type DynamicLoadProfile,
  type DynamicTet4CpuFrame,
  type StaticLinearTet4CpuResult
} from "@opencae/solver-cpu";
import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import {
  assessResultFailure,
  type DisplayModel,
  type DynamicSolverSettings,
  type ResultField,
  type ResultProvenance,
  type ResultSample,
  type ResultSummary,
  type Study
} from "@opencae/schema";
import { inferCriticalPrintAxis } from "@opencae/study-core";

type Vec3 = [number, number, number];

type CoreStudyModel = {
  model: OpenCAEModelJson;
  renderNodePoints: Vec3[];
  meshSource: ResultProvenance["meshSource"];
  meshConnectivity?: {
    connectedComponents: number;
  };
};

type CoreTetMesh = {
  solverCoordinates: number[];
  renderNodePoints: Vec3[];
  connectivity: number[];
};

type ActualCoreVolumeMeshArtifact = {
  model: OpenCAEModelJson;
  renderNodePoints?: Vec3[];
  meshConnectivity?: {
    connectedComponents?: number;
  };
};

export type CoreCloudGeometrySource = {
  kind: "sample_procedural" | "uploaded_cad" | "uploaded_mesh" | "structured_block";
  sampleId?: "cantilever" | "beam" | "bracket";
  format?: "step" | "stl" | "obj" | "msh" | "json";
  filename?: string;
  contentBase64?: string;
  units?: "mm" | "m";
  descriptor?: Record<string, unknown>;
  geometryDescriptor?: Record<string, unknown>;
};

export type LocalSolveResult = {
  summary: ResultSummary;
  fields: ResultField[];
  artifacts?: {
    meshConnectivity?: {
      connectedComponents: number;
    };
    meshStatistics?: {
      nodes: number;
      elements: number;
    };
  };
};

export type NormalizedBrowserSolverBackend = "opencae_core_cloud" | "opencae_core_local";

export type OpenCaeCoreEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export type OpenCaeCoreSolveOutcome =
  | { ok: true; result: LocalSolveResult; solverBackend: "opencae-core-preview-tet4" | "opencae-core-preview-sdof" | "opencae-core-sparse-tet" | "opencae-core-mdof-tet" }
  | { ok: false; reason: string };

const STANDARD_GRAVITY = 9.80665;
const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;

const COMPLEX_CORE_PREVIEW_REJECTION_REASON = "OpenCAE Core Local requires simple block/beam geometry or an actual Core volume mesh. Use OpenCAE Core Cloud for complex production geometry.";
export const OPENCAE_CORE_CLOUD_GEOMETRY_REQUIRED_REASON = "OpenCAE Core Cloud requires a procedural or uploaded geometry source so the cloud container can generate a Core volume mesh.";

const OPENCAE_CORE_ACTUAL_STATIC_PROVENANCE: ResultProvenance = {
  kind: "opencae_core_fea",
  solver: "opencae-core-sparse-tet",
  solverVersion: "0.1.0",
  meshSource: "actual_volume_mesh",
  resultSource: "computed",
  units: "m-N-s-Pa"
};

const OPENCAE_CORE_ACTUAL_DYNAMIC_PROVENANCE: ResultProvenance = {
  ...OPENCAE_CORE_ACTUAL_STATIC_PROVENANCE,
  solver: "opencae-core-mdof-tet",
  integrationMethod: "newmark_average_acceleration"
};

const OPENCAE_CORE_PREVIEW_STATIC_PROVENANCE: ResultProvenance = {
  kind: "local_estimate",
  solver: "opencae-core-preview-tet4",
  solverVersion: "0.1.0",
  meshSource: "structured_block_proxy",
  resultSource: "computed_preview",
  units: "m-N-s-Pa"
};

const OPENCAE_CORE_PREVIEW_DYNAMIC_PROVENANCE: ResultProvenance = {
  ...OPENCAE_CORE_PREVIEW_STATIC_PROVENANCE,
  solver: "opencae-core-preview-sdof",
  integrationMethod: "newmark_average_acceleration"
};

export function normalizeSolverBackend(value: { solverSettings?: { backend?: unknown } } | Study | undefined): NormalizedBrowserSolverBackend {
  const backend = value?.solverSettings?.backend;
  return backend === "opencae_core_local" ? "opencae_core_local" : "opencae_core_cloud";
}

export function isSimpleBlockLikeDisplayModel(displayModel: DisplayModel | undefined): boolean {
  if (!displayModel?.dimensions || !positiveDimensions(displayModel.dimensions)) return false;
  if (displayModel.bodyCount !== 1) return false;
  if (displayModel.nativeCad || displayModel.visualMesh) return false;
  const text = displayModelText(displayModel);
  if (/\b(bracket|hole|holes|rib|gusset|upright|fillet|web[- ]front|mounting)\b/i.test(text)) return false;
  if (/\b(cantilever|beam|block|rectangular|plate)\b/i.test(text)) return true;
  return displayModel.faces.length > 0 && displayModel.faces.length <= 6;
}

export function hasActualCoreVolumeMesh(study: Study, displayModel?: DisplayModel): boolean {
  void displayModel;
  const artifact = actualCoreVolumeMeshArtifact(study);
  if (!artifact?.model) return false;
  if (meshSourceForActualArtifact(artifact) !== "actual_volume_mesh") return false;
  return connectedComponentCountForActualArtifact(artifact) === 1;
}

export function hasCloudMeshableGeometry(study: Study, displayModel?: DisplayModel): boolean {
  return Boolean(cloudGeometrySourceForStudy(study, displayModel));
}

export function cloudGeometrySourceForStudy(study: Study, displayModel?: DisplayModel): CoreCloudGeometrySource | null {
  const explicit = coreCloudGeometryFromUnknown((displayModel as { coreCloudGeometry?: unknown } | undefined)?.coreCloudGeometry)
    ?? coreCloudGeometryFromUnknown((study.meshSettings.summary as { artifacts?: { coreCloudGeometry?: unknown; geometry?: unknown } } | undefined)?.artifacts?.coreCloudGeometry)
    ?? coreCloudGeometryFromUnknown((study.meshSettings.summary as { artifacts?: { coreCloudGeometry?: unknown; geometry?: unknown } } | undefined)?.artifacts?.geometry);
  if (explicit) return withMeshPresetSize(explicit, study.meshSettings.preset);

  if (displayModel?.nativeCad) {
    return {
      kind: "uploaded_cad",
      format: displayModel.nativeCad.format,
      filename: displayModel.nativeCad.filename,
      contentBase64: displayModel.nativeCad.contentBase64,
      units: displayModel.dimensions?.units === "m" ? "m" : "mm"
    };
  }

  if (displayModel?.visualMesh) {
    return {
      kind: "uploaded_cad",
      format: displayModel.visualMesh.format,
      filename: displayModel.visualMesh.filename,
      contentBase64: displayModel.visualMesh.contentBase64,
      units: displayModel.dimensions?.units === "m" ? "m" : "mm"
    };
  }

  if (displayModel && isBracketDemoGeometry(study, displayModel)) {
    return {
      kind: "sample_procedural",
      sampleId: "bracket",
      units: "mm",
      descriptor: bracketProceduralGeometryDescriptor(study.meshSettings.preset)
    };
  }

  if (displayModel && isSimpleBlockLikeDisplayModel(displayModel)) {
    const dimensions = displayModel.dimensions;
    if (!dimensions) return null;
    return {
      kind: "structured_block",
      units: dimensions.units === "m" ? "m" : "mm",
      descriptor: {
        length: dimensions.x,
        width: dimensions.z,
        height: dimensions.y,
        surfaces: {
          fixedSupport: selectionSurfaceDescriptor(study, "fixed", "FS1"),
          loadSurface: selectionSurfaceDescriptor(study, "load", "L1")
        }
      }
    };
  }

  return null;
}

/**
 * Built-in sample geometry is authored in display-model space (Y axis = height) and the
 * viewer stands it upright with the legacy +90 deg X base rotation, while every OpenCAE
 * Core solver mesh for that geometry (cloud structured block, procedural bracket, and
 * the structured block Core model built below) lives in the upright solver frame that
 * rotation produces (Z axis = height). Uploaded CAD/mesh geometry is meshed in its own
 * file coordinates, which the viewer renders without the base rotation, so its
 * directions pass through unchanged.
 */
export function displayDirectionToSolverFrame(direction: Vec3, displayModel: DisplayModel | undefined): Vec3 {
  if (!displayModel || !displayModelUsesUprightSolverFrame(displayModel)) {
    return [direction[0], direction[1], direction[2]];
  }
  return [direction[0], negated(direction[2]), direction[1]];
}

function negated(value: number): number {
  return value === 0 ? 0 : -value;
}

/**
 * Study load directions are recorded in display-model space, but OpenCAE Core Cloud
 * applies them verbatim in the solver frame when it meshes dispatched geometry. Rotate
 * them into the solver frame so the solved deformation matches the load arrows shown in
 * the viewer.
 */
export function studyForCoreCloudGeometryDispatch(study: Study, displayModel: DisplayModel | undefined): Study {
  if (!displayModel || !displayModelUsesUprightSolverFrame(displayModel)) return study;
  return {
    ...study,
    loads: study.loads.map((load) => {
      const direction = vector3(load.parameters.direction);
      if (!direction) return load;
      return {
        ...load,
        parameters: {
          ...load.parameters,
          direction: displayDirectionToSolverFrame(direction, displayModel)
        }
      };
    })
  };
}

function displayModelUsesUprightSolverFrame(displayModel: DisplayModel): boolean {
  // Mirrors the viewer rule for the legacy sample base rotation (modelOrientation.ts):
  // uploaded geometry and empty models render without it.
  return displayModel.bodyCount !== 0 &&
    !displayModel.nativeCad &&
    !displayModel.visualMesh &&
    !displayModel.id.includes("uploaded");
}

export function isComplexGeometry(displayModel: DisplayModel | undefined, study?: Study): boolean {
  if (!displayModel) return false;
  if (hasActualCoreVolumeMeshForDisplay(displayModel)) return true;
  if (isSimpleBlockLikeDisplayModel(displayModel)) return false;
  const text = `${displayModelText(displayModel)} ${study?.geometryScope.map((scope) => scope.label).join(" ") ?? ""}`;
  if (/\b(bracket|hole|holes|rib|gusset|upright|uploaded|step|stl|obj|mounting)\b/i.test(text)) return true;
  if (displayModel.nativeCad || displayModel.visualMesh) return true;
  return displayModel.faces.length > 6;
}

export function openCaeCoreEligibility(study: Study, displayModel?: DisplayModel): OpenCaeCoreEligibility {
  if (study.type !== "static_stress" && study.type !== "dynamic_structural") {
    return { ok: false, reason: "OpenCAE Core browser solve currently supports static and dynamic structural studies only." };
  }
  if (study.meshSettings.status !== "complete") return { ok: false, reason: "OpenCAE Core requires a completed mesh step." };
  if (!displayModel?.dimensions || !positiveDimensions(displayModel.dimensions)) {
    return { ok: false, reason: "OpenCAE Core requires usable block-like display dimensions." };
  }
  if (isComplexGeometry(displayModel, study) && !hasActualCoreVolumeMesh(study, displayModel)) {
    return { ok: false, reason: COMPLEX_CORE_PREVIEW_REJECTION_REASON };
  }
  if (!study.materialAssignments.length) return { ok: false, reason: "OpenCAE Core requires an assigned material." };
  if (!study.constraints.some((constraint) => constraint.type === "fixed")) {
    return { ok: false, reason: "OpenCAE Core requires at least one fixed support." };
  }
  const unsupportedLoad = study.loads.find((load) => load.type !== "force");
  if (unsupportedLoad) return { ok: false, reason: `OpenCAE Core Local supports force loads only; ${unsupportedLoad.type} loads require OpenCAE Core Cloud.` };
  if (!study.loads.length) return { ok: false, reason: "OpenCAE Core requires at least one force load." };
  const material = materialForStudy(study).material;
  const force = totalForceVector(study, displayModel, material.density);
  if (Math.hypot(...force) <= 1e-12) {
    return { ok: false, reason: "OpenCAE Core requires a force load with a finite positive value and direction." };
  }
  return { ok: true };
}

export function trySolveOpenCaeCoreStudy({ study, runId, displayModel }: {
  study: Study;
  runId: string;
  displayModel?: DisplayModel;
}): OpenCaeCoreSolveOutcome {
  const eligibility = openCaeCoreEligibility(study, displayModel);
  if (!eligibility.ok) return eligibility;

  try {
    const coreModel = openCaeCoreModelForStudy(study, displayModel);
    const isActualMesh = coreModel.meshSource === "actual_volume_mesh";
    if (study.type === "dynamic_structural") {
      const material = materialForStudy(study).material;
      const settings = dynamicSettingsForStudy(study);
      const provenance = isActualMesh ? OPENCAE_CORE_ACTUAL_DYNAMIC_PROVENANCE : OPENCAE_CORE_PREVIEW_DYNAMIC_PROVENANCE;
      const solved = solveDynamicMdofTet4Cpu(coreModel.model, {
        maxDofs: maxDofsForMeshPreset(study.meshSettings.preset),
        startTime: settings.startTime,
        endTime: settings.endTime,
        timeStep: settings.timeStep,
        outputInterval: settings.outputInterval,
        dampingRatio: settings.dampingRatio,
        loadProfile: dynamicLoadProfileForCore(settings.loadProfile),
        massDensity: material.density
      });
      if (!solved.ok) return { ok: false, reason: `OpenCAE Core solve failed: ${solved.error.message}` };
      return {
        ok: true,
        solverBackend: isActualMesh ? "opencae-core-mdof-tet" : "opencae-core-preview-sdof",
        result: dynamicResultBundleForOpenCaeCore(runId, coreModel, solved.result.frames, study, displayModel, settings, provenance)
      };
    }

    const solved = solveStaticLinearTet4Cpu(coreModel.model, { maxDofs: maxDofsForMeshPreset(study.meshSettings.preset) });
    if (!solved.ok) return { ok: false, reason: `OpenCAE Core solve failed: ${solved.error.message}` };
    const provenance = isActualMesh ? OPENCAE_CORE_ACTUAL_STATIC_PROVENANCE : OPENCAE_CORE_PREVIEW_STATIC_PROVENANCE;
    return {
      ok: true,
      solverBackend: isActualMesh ? "opencae-core-sparse-tet" : "opencae-core-preview-tet4",
      result: resultBundleForOpenCaeCore(runId, coreModel, solved.result, study, provenance)
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "OpenCAE Core solve failed." };
  }
}

export function buildOpenCaeCoreCloudModelForStudy(study: Study, displayModel: DisplayModel | undefined): CoreStudyModel {
  if (!displayModel?.dimensions) throw new Error("OpenCAE Core Cloud requires display dimensions before generating a Core model.");
  const actualMesh = actualCoreVolumeMeshArtifact(study);
  const material = materialForStudy(study);
  const effective = effectiveMaterialProperties(material.material, material.parameters, {
    criticalLayerAxis: inferCriticalPrintAxis(study, displayModel.faces)
  });
  const coreMaterial = {
    name: effective.id,
    type: "isotropicLinearElastic" as const,
    youngModulus: effective.youngsModulus,
    poissonRatio: effective.poissonRatio,
    yieldStrength: effective.yieldStrength ?? material.material.yieldStrength,
    density: effective.density ?? material.material.density
  };

  let model: OpenCAEModelJson;
  let renderNodePoints: Vec3[];
  let meshSource: ResultProvenance["meshSource"];
  let meshConnectivity: CoreStudyModel["meshConnectivity"];

  if (actualMesh?.model) {
    if (!hasActualCoreVolumeMesh(study, displayModel)) {
      throw new Error("OpenCAE Core Cloud requires an actual Core volume mesh with actual_volume_mesh provenance and one connected component.");
    }
    model = cloneModelForCloud(actualMesh.model);
    renderNodePoints = actualMesh.renderNodePoints?.length ? actualMesh.renderNodePoints : renderNodePointsForModel(model);
    meshSource = "actual_volume_mesh";
    meshConnectivity = connectedComponentCountForActualArtifact(actualMesh)
      ? { connectedComponents: connectedComponentCountForActualArtifact(actualMesh)! }
      : undefined;
  } else {
    if (isComplexGeometry(displayModel, study)) {
      if (hasCloudMeshableGeometry(study, displayModel)) {
        throw new Error("OpenCAE Core Cloud should dispatch this complex geometry source to the cloud container for meshing.");
      }
      throw new Error(OPENCAE_CORE_CLOUD_GEOMETRY_REQUIRED_REASON);
    }
    const mesh = tetMeshForDisplayModel(displayModel, study.meshSettings.preset);
    model = volumeMeshToModelJson({
      nodes: { coordinates: solverFrameCoordinates(mesh.solverCoordinates, displayModel) },
      materials: [coreMaterial],
      elementBlocks: [{
        name: "structured-block-tet4",
        type: "Tet4",
        material: coreMaterial.name,
        connectivity: mesh.connectivity
      }],
      coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
      meshProvenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-cloud",
        resultSource: "computed",
        meshSource: "structured_block_core"
      }
    });
    renderNodePoints = mesh.renderNodePoints;
    meshSource = "structured_block_core";
  }

  model = {
    ...model,
    schemaVersion: "0.2.0",
    materials: [coreMaterial],
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource
    },
    coordinateSystem: model.coordinateSystem ?? { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" }
  };

  const surfaceSets = [...(model.surfaceSets ?? [])];
  const nodeSets = [...model.nodeSets.filter((set) => !/^fixedNodes\d+$/.test(set.name))];
  const boundaryConditions: OpenCAEModelJson["boundaryConditions"] = [];
  const loads: LoadJson[] = [];

  for (const [index, constraint] of study.constraints.entries()) {
    if (constraint.type !== "fixed") continue;
    const surfaceSet = ensureSurfaceSetForSelection({
      model,
      renderNodePoints,
      displayModel,
      study,
      selectionRef: constraint.selectionRef,
      surfaceSets
    });
    const nodeSet = deriveFixedSupportNodeSetFromSurface(`fixedNodes${index}`, surfaceSet.name, { ...model, surfaceSets });
    if (!nodeSet.nodes.length) throw new Error(`OpenCAE Core Cloud could not map fixed support ${constraint.selectionRef} to mesh nodes.`);
    nodeSets.push(nodeSet);
    boundaryConditions.push({ name: `fixedSupport${index}`, type: "fixed", nodeSet: nodeSet.name, components: ["x", "y", "z"] });
  }

  const density = coreMaterial.density ?? material.material.density;
  for (const [index, load] of study.loads.entries()) {
    const surfaceSet = ensureSurfaceSetForSelection({
      model,
      renderNodePoints,
      displayModel,
      study,
      selectionRef: load.selectionRef,
      surfaceSets
    });
    if (load.type === "pressure") {
      const pressure = pressurePascals(load);
      if (pressure <= 0) continue;
      const pressureDirection = normalize(vector3(load.parameters.direction) ?? [0, 0, -1]);
      loads.push({
        name: `pressure${index}`,
        type: "pressure",
        surfaceSet: surfaceSet.name,
        pressure,
        ...(pressureDirection ? { direction: displayDirectionToSolverFrame(pressureDirection, displayModel) } : {})
      });
      continue;
    }

    const force = displayDirectionToSolverFrame(forceVectorForLoad(load, displayModel, density), displayModel);
    if (Math.hypot(...force) <= 1e-12) continue;
    loads.push({
      name: load.type === "gravity" ? `payloadGravity${index}` : `appliedForce${index}`,
      type: "surfaceForce",
      surfaceSet: surfaceSet.name,
      totalForce: roundVector(force, 9)
    });
  }

  if (!boundaryConditions.length) throw new Error("OpenCAE Core Cloud requires at least one mapped fixed support.");
  if (!loads.length) throw new Error("OpenCAE Core Cloud requires at least one mapped load.");

  model = {
    ...model,
    surfaceSets,
    nodeSets,
    boundaryConditions,
    loads,
    steps: [coreCloudStepForStudy(study, boundaryConditions.map((condition) => condition.name), loads.map((load) => load.name))]
  };
  const validation = validateModelJson(model);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`OpenCAE Core Cloud generated an invalid Core model: ${first?.message ?? "validation failed"}`);
  }

  return {
    model,
    renderNodePoints,
    meshSource,
    ...(meshConnectivity ? { meshConnectivity } : {})
  };
}

function openCaeCoreModelForStudy(study: Study, displayModel: DisplayModel | undefined): CoreStudyModel {
  if (!displayModel?.dimensions) throw new Error("OpenCAE Core requires display dimensions.");
  const actualMesh = actualCoreVolumeMeshArtifact(study);
  if (actualMesh?.model) {
    if (!hasActualCoreVolumeMesh(study, displayModel)) {
      throw new Error("OpenCAE Core actual mesh artifacts must use actual_volume_mesh provenance and one connected component.");
    }
    return coreStudyModelForActualMeshArtifact(actualMesh);
  }
  if (isComplexGeometry(displayModel, study)) {
    throw new Error(COMPLEX_CORE_PREVIEW_REJECTION_REASON);
  }
  const material = materialForStudy(study);
  const effective = effectiveMaterialProperties(material.material, material.parameters, {
    criticalLayerAxis: inferCriticalPrintAxis(study, displayModel.faces)
  });
  const mesh = tetMeshForDisplayModel(displayModel, study.meshSettings.preset);
  const boundaryConditions: OpenCAEModelJson["boundaryConditions"] = [];
  const loads: OpenCAEModelJson["loads"] = [];
  const nodeSets: OpenCAEModelJson["nodeSets"] = [];

  for (const [index, constraint] of study.constraints.entries()) {
    if (constraint.type !== "fixed") continue;
    const centers = selectionCenters(study, displayModel, constraint.selectionRef);
    const nodes = nearestMeshNodes(mesh.renderNodePoints, centers, nodeSelectionCount(study.meshSettings.preset));
    if (!nodes.length) throw new Error("OpenCAE Core could not map fixed support selection to mesh nodes.");
    const name = `fixedNodes${index}`;
    nodeSets.push({ name, nodes });
    boundaryConditions.push({ name: `fixedSupport${index}`, type: "fixed", nodeSet: name, components: ["x", "y", "z"] });
  }

  const density = effective.density ?? material.material.density;
  for (const [index, load] of study.loads.entries()) {
    if (load.type !== "force") continue;
    const centers = selectionCenters(study, displayModel, load.selectionRef);
    const nodes = nearestMeshNodes(mesh.renderNodePoints, centers, nodeSelectionCount(study.meshSettings.preset));
    if (!nodes.length) continue;
    const force = forceVectorForLoad(load, displayModel, density);
    if (Math.hypot(...force) <= 1e-12) continue;
    const distributedForce = scaleVector(force, 1 / nodes.length);
    const name = `loadNodes${index}`;
    nodeSets.push({ name, nodes });
    loads.push({ name: `appliedForce${index}`, type: "nodalForce", nodeSet: name, vector: distributedForce });
  }

  if (!boundaryConditions.length) throw new Error("OpenCAE Core requires at least one mapped fixed support.");
  if (!loads.length) throw new Error("OpenCAE Core requires at least one mapped force load.");

  const model: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.1.0",
    nodes: { coordinates: mesh.solverCoordinates },
    materials: [{
      name: effective.id,
      type: "isotropicLinearElastic",
      youngModulus: effective.youngsModulus,
      poissonRatio: effective.poissonRatio,
      density: effective.density ?? material.material.density,
      yieldStrength: effective.yieldStrength ?? material.material.yieldStrength
    }],
    elementBlocks: [{
      name: "block-tet4",
      type: "Tet4",
      material: effective.id,
      connectivity: mesh.connectivity
    }],
    nodeSets,
    elementSets: [{ name: "allElements", elements: Array.from({ length: mesh.connectivity.length / 4 }, (_value, index) => index) }],
    boundaryConditions,
    loads,
    steps: [{
      name: "loadStep",
      type: "staticLinear",
      boundaryConditions: boundaryConditions.map((condition) => condition.name),
      loads: loads.map((load) => load.name)
    }]
  };
  return { model, renderNodePoints: mesh.renderNodePoints, meshSource: "structured_block_proxy" };
}

function coreStudyModelForActualMeshArtifact(artifact: ActualCoreVolumeMeshArtifact): CoreStudyModel {
  const model = artifact.model;
  const renderNodePoints = artifact.renderNodePoints?.length
    ? artifact.renderNodePoints
    : renderNodePointsForModel(model);
  const connectedComponents = connectedComponentCountForActualArtifact(artifact);
  return {
    model,
    renderNodePoints,
    meshSource: "actual_volume_mesh",
    meshConnectivity: connectedComponents ? { connectedComponents } : undefined
  };
}

function cloneModelForCloud(model: OpenCAEModelJson): OpenCAEModelJson {
  return {
    ...model,
    nodes: { coordinates: [...model.nodes.coordinates] },
    materials: model.materials.map((material) => ({ ...material })),
    elementBlocks: model.elementBlocks.map((block) => ({ ...block, connectivity: [...block.connectivity] })),
    nodeSets: model.nodeSets.map((set) => ({ name: set.name, nodes: [...set.nodes] })),
    elementSets: model.elementSets.map((set) => ({ name: set.name, elements: [...set.elements] })),
    surfaceFacets: model.surfaceFacets?.map((facet) => ({ ...facet, nodes: [...facet.nodes] })) ?? [],
    surfaceSets: model.surfaceSets?.map((set) => ({ name: set.name, facets: [...set.facets] })) ?? [],
    boundaryConditions: [],
    loads: [],
    steps: []
  };
}

function ensureSurfaceSetForSelection({
  model,
  renderNodePoints,
  displayModel,
  study,
  selectionRef,
  surfaceSets
}: {
  model: OpenCAEModelJson;
  renderNodePoints: Vec3[];
  displayModel: DisplayModel;
  study: Study;
  selectionRef: string;
  surfaceSets: SurfaceSetJson[];
}): SurfaceSetJson {
  const existing = surfaceSets.find((set) => set.name === selectionRef);
  if (existing?.facets.length) return existing;

  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  const selectionNames = new Set([
    selectionRef,
    ...(selection?.geometryRefs.map((ref) => ref.entityId) ?? [])
  ]);
  const sourceMatches = (model.surfaceFacets ?? [])
    .filter((facet) => selectionNames.has(facet.sourceSelectionRef ?? "") || selectionNames.has(facet.sourceFaceId ?? ""))
    .map((facet) => facet.id);
  const facets = sourceMatches.length
    ? sourceMatches
    : facetsForDisplaySelection(model.surfaceFacets ?? [], renderNodePoints, displayModel, study, selectionRef);
  if (!facets.length) throw new Error(`OpenCAE Core Cloud could not map selection ${selectionRef} to Core surface facets.`);
  const next = { name: selectionRef, facets: [...new Set(facets)].sort((left, right) => left - right) };
  surfaceSets.push(next);
  return next;
}

function facetsForDisplaySelection(
  surfaceFacets: SurfaceFacetJson[],
  renderNodePoints: Vec3[],
  displayModel: DisplayModel,
  study: Study,
  selectionRef: string
): number[] {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  const faceIds = new Set([
    selectionRef,
    ...(selection?.geometryRefs.filter((ref) => ref.entityType === "face").map((ref) => ref.entityId) ?? [])
  ]);
  const faces = displayModel.faces.filter((face) => faceIds.has(face.id));
  if (!faces.length) return [];

  const bounds = renderBoundsForPoints(renderNodePoints);
  const result = new Set<number>();
  for (const face of faces) {
    const normal = normalize(face.normal);
    if (!normal) continue;
    const axis = dominantAxis(normal);
    const target = normal[axis] >= 0 ? bounds.max[axis] : bounds.min[axis];
    const span = Math.max(bounds.max[axis] - bounds.min[axis], 1);
    const tolerance = Math.max(span * 1e-5, 1e-8);
    const matching = surfaceFacets
      .filter((facet) => Math.abs(facetCenterFromRenderNodes(facet, renderNodePoints)[axis] - target) <= tolerance)
      .map((facet) => facet.id);
    for (const facetId of matching.length ? matching : nearestSurfaceFacets(surfaceFacets, renderNodePoints, [face.center], 8)) {
      result.add(facetId);
    }
  }
  return [...result];
}

function coreCloudStepForStudy(study: Study, boundaryConditions: string[], loads: string[]): StepJson {
  if (study.type !== "dynamic_structural") {
    return { name: "loadStep", type: "staticLinear", boundaryConditions, loads };
  }
  const settings = dynamicSettingsForStudy(study);
  return {
    name: "dynamicStep",
    type: "dynamicLinear",
    boundaryConditions,
    loads,
    startTime: settings.startTime,
    endTime: settings.endTime,
    timeStep: settings.timeStep,
    outputInterval: settings.outputInterval,
    loadProfile: settings.loadProfile,
    dampingRatio: settings.dampingRatio,
    ...("rayleighAlpha" in settings && typeof settings.rayleighAlpha === "number" ? { rayleighAlpha: settings.rayleighAlpha } : {}),
    ...("rayleighBeta" in settings && typeof settings.rayleighBeta === "number" ? { rayleighBeta: settings.rayleighBeta } : {})
  };
}

function pressurePascals(load: Study["loads"][number]): number {
  const value = Number(load.parameters.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const units = typeof load.parameters.units === "string" ? load.parameters.units.toLowerCase() : "pa";
  if (units === "kpa") return value * 1000;
  if (units === "mpa") return value * 1_000_000;
  if (units === "psi") return value * 6894.757293168;
  return value;
}

function resultBundleForOpenCaeCore(
  runId: string,
  coreModel: CoreStudyModel,
  result: Pick<StaticLinearTet4CpuResult, "displacement" | "reactionForce" | "vonMises">,
  study: Study,
  provenance: ResultProvenance
): LocalSolveResult {
  const stressFrame = stressFieldForOpenCaeCore(runId, coreModel, result.vonMises, study, provenance);
  const displacementFrame = vectorFieldForOpenCaeCore(runId, "displacement", coreModel, result.displacement, "mm", 1000, 6, provenance);
  const safetyFrame = safetyFieldForOpenCaeCore(runId, stressFrame, study, provenance);
  const summaryBase = {
    maxStress: stressFrame.max,
    maxStressUnits: "MPa",
    maxDisplacement: displacementFrame.max,
    maxDisplacementUnits: "mm",
    safetyFactor: safetyFrame.min,
    reactionForce: round(vectorMagnitudes(result.reactionForce).reduce((sum, value) => sum + value, 0), 6),
    reactionForceUnits: "N"
  };
  return {
    summary: {
      ...summaryBase,
      diagnostics: [],
      failureAssessment: assessResultFailure(summaryBase),
      provenance
    },
    fields: [stressFrame, displacementFrame, safetyFrame],
    artifacts: {
      ...(coreModel.meshConnectivity ? { meshConnectivity: coreModel.meshConnectivity } : {}),
      meshStatistics: meshStatisticsForCoreModel(coreModel)
    }
  };
}

function dynamicResultBundleForOpenCaeCore(
  runId: string,
  coreModel: CoreStudyModel,
  frames: DynamicTet4CpuFrame[],
  study: Study,
  displayModel: DisplayModel | undefined,
  settings: DynamicSolverSettings,
  provenance: ResultProvenance
): LocalSolveResult {
  const fields: ResultField[] = [];
  let peakDisplacement = 0;
  let peakDisplacementTimeSeconds = settings.startTime;
  let peakStress = 0;
  let minSafetyFactor = Number.POSITIVE_INFINITY;
  const material = materialForStudy(study).material;
  const appliedLoadMagnitude = displayModel
    ? round(Math.hypot(...totalForceVector(study, displayModel, material.density)), 6)
    : 0;
  const peakLoadScale = Math.max(...frames.map((frame) => Number.isFinite(frame.loadScale) ? Math.abs(frame.loadScale) : 0), 0);
  const peakAppliedLoad = round(appliedLoadMagnitude * Math.max(peakLoadScale, 1), 6);

  for (const frame of frames) {
    const stressFrame = withFrame(stressFieldForOpenCaeCore(runId, coreModel, frame.vonMises.values, study, provenance), frame.frameIndex, frame.timeSeconds);
    const displacementFrame = withFrame(vectorFieldForOpenCaeCore(runId, "displacement", coreModel, frame.displacement.values, "mm", 1000, 8, provenance), frame.frameIndex, frame.timeSeconds);
    const velocityFrame = withFrame(vectorFieldForOpenCaeCore(runId, "velocity", coreModel, frame.velocity.values, "mm/s", 1000, 8, provenance), frame.frameIndex, frame.timeSeconds);
    const accelerationFrame = withFrame(vectorFieldForOpenCaeCore(runId, "acceleration", coreModel, frame.acceleration.values, "mm/s^2", 1000, 8, provenance), frame.frameIndex, frame.timeSeconds);
    const safetyFrame = withFrame(safetyFieldForOpenCaeCore(runId, stressFrame, study, provenance), frame.frameIndex, frame.timeSeconds);
    fields.push(stressFrame, displacementFrame, velocityFrame, accelerationFrame, safetyFrame);

    const framePeakDisplacement = resultFieldAbsMax(displacementFrame);
    if (framePeakDisplacement > peakDisplacement) {
      peakDisplacement = framePeakDisplacement;
      peakDisplacementTimeSeconds = frame.timeSeconds;
    }
    peakStress = Math.max(peakStress, stressFrame.max);
    minSafetyFactor = Math.min(minSafetyFactor, safetyFrame.min);
  }

  stabilizeDynamicFieldRanges(fields);
  const summaryBase = {
    maxStress: round(peakStress, 1),
    maxStressUnits: "MPa",
    maxDisplacement: round(peakDisplacement, 8),
    maxDisplacementUnits: "mm",
    safetyFactor: round(Number.isFinite(minSafetyFactor) ? minSafetyFactor : 0, 2),
    reactionForce: peakAppliedLoad,
    reactionForceUnits: "N",
    diagnostics: [{
      id: "dynamic-reaction-force-unavailable",
      severity: "warning" as const,
      source: "solver" as const,
      message: provenance.resultSource === "computed_preview"
        ? "Reaction force unavailable from this preview solver."
        : "Reaction force unavailable from this dynamic solver.",
      suggestedActions: []
    }],
    loadSummary: {
      appliedLoadMagnitude,
      reactionForceSource: "applied_load_estimate" as const
    },
    transient: {
      analysisType: "dynamic_structural" as const,
      integrationMethod: settings.integrationMethod,
      startTime: settings.startTime,
      endTime: settings.endTime,
      timeStep: settings.timeStep,
      outputInterval: settings.outputInterval,
      dampingRatio: settings.dampingRatio,
      frameCount: frames.length,
      peakDisplacementTimeSeconds: round(peakDisplacementTimeSeconds, 6),
      peakDisplacement: round(peakDisplacement, 8)
    }
  };
  return {
    summary: {
      ...summaryBase,
      failureAssessment: assessResultFailure(summaryBase),
      provenance
    },
    fields,
    artifacts: {
      ...(coreModel.meshConnectivity ? { meshConnectivity: coreModel.meshConnectivity } : {}),
      meshStatistics: meshStatisticsForCoreModel(coreModel)
    }
  };
}

function stressFieldForOpenCaeCore(
  runId: string,
  coreModel: CoreStudyModel,
  vonMises: Float64Array,
  study: Study,
  provenance: ResultProvenance
): ResultField {
  const values = Array.from(vonMises, (value) => round(Math.abs(value) / 1_000_000, 6));
  const samples = values.map((value, element) => ({
    point: elementCentroid(coreModel, element),
    normal: [0, 0, 1] as Vec3,
    value,
    elementId: `E${element}`,
    source: "opencae_core",
    vonMisesStressPa: round(value * 1_000_000, 3)
  }));
  return fieldFor(runId, "stress", "element", values, "MPa", samples, provenance);
}

function vectorFieldForOpenCaeCore(
  runId: string,
  type: ResultField["type"],
  coreModel: CoreStudyModel,
  vectors: Float64Array,
  units: string,
  unitScale: number,
  digits: number,
  provenance: ResultProvenance
): ResultField {
  const nodePoints = coreModel.renderNodePoints;
  const samples = nodePoints.map((point, node) => {
    const vector = vectorForNode(vectors, node, unitScale, digits);
    return {
      point,
      normal: [0, 0, 1] as Vec3,
      value: round(Math.hypot(...vector), digits),
      vector,
      nodeId: `N${node}`,
      source: "opencae_core"
    };
  });
  return fieldFor(runId, type, "node", samples.map((sample) => sample.value), units, samples, provenance);
}

function safetyFieldForOpenCaeCore(runId: string, stressFrame: ResultField, study: Study, provenance: ResultProvenance): ResultField {
  const material = materialForStudy(study).material;
  const yieldMpa = Math.max(material.yieldStrength / 1_000_000, 1e-9);
  const values = stressFrame.values.map((stress) => round(Math.max(0.05, yieldMpa / Math.max(stress, 1e-9)), 4));
  const samples = stressFrame.samples?.map((sample, index) => ({
    ...sample,
    value: values[index] ?? 0,
    vonMisesStressPa: undefined
  })) ?? [];
  return fieldFor(runId, "safety_factor", "element", values, "ratio", samples, provenance);
}

function fieldFor(
  runId: string,
  type: ResultField["type"],
  location: ResultField["location"],
  values: number[],
  units: string,
  samples: NonNullable<ResultField["samples"]>,
  provenance: ResultProvenance
): ResultField {
  return {
    id: `field-${type}`,
    runId,
    type,
    location,
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    units,
    samples,
    provenance
  };
}

function withFrame(field: ResultField, frameIndex: number, timeSeconds: number): ResultField {
  return {
    ...field,
    id: `field-${field.type}-${field.runId}-frame-${frameIndex}`,
    frameIndex,
    timeSeconds
  };
}

function dynamicSettingsForStudy(study: Study): DynamicSolverSettings {
  const raw = study.solverSettings as Partial<DynamicSolverSettings>;
  const timeStep = finiteOr(raw.timeStep, DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
  return {
    backend: "opencae_core_local",
    fidelity: raw.fidelity ?? "standard",
    startTime: finiteOr(raw.startTime, 0),
    endTime: finiteOr(raw.endTime, 0.1),
    timeStep,
    outputInterval: Math.max(finiteOr(raw.outputInterval, DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS), timeStep, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS),
    dampingRatio: finiteOr(raw.dampingRatio, 0.02),
    integrationMethod: "newmark_average_acceleration",
    loadProfile: isDynamicLoadProfile(raw.loadProfile) ? raw.loadProfile : "ramp",
    ...(raw.allowFreeMotion === true ? { allowFreeMotion: true } : {})
  };
}

function dynamicLoadProfileForCore(value: DynamicSolverSettings["loadProfile"]): DynamicLoadProfile {
  return value === "quasi_static" ? "quasiStatic" : value;
}

function materialForStudy(study: Study) {
  const assignment = study.materialAssignments[0];
  const material = starterMaterials.find((candidate) => candidate.id === assignment?.materialId);
  if (!material) throw new Error("OpenCAE Core requires an assigned material.");
  return {
    material,
    parameters: assignment?.parameters ?? {}
  };
}

function totalForceVector(study: Study, displayModel: DisplayModel, densityKgM3: number): Vec3 {
  const force: Vec3 = [0, 0, 0];
  for (const load of study.loads) {
    const vector = forceVectorForLoad(load, displayModel, densityKgM3);
    force[0] += vector[0];
    force[1] += vector[1];
    force[2] += vector[2];
  }
  return force;
}

function forceVectorForLoad(load: Study["loads"][number], displayModel: DisplayModel, densityKgM3: number): Vec3 {
  const dimensions = displayModel.dimensions;
  if (!dimensions) throw new Error("OpenCAE Core requires display dimensions.");
  const direction = normalize(vector3(load.parameters.direction) ?? [0, 0, -1]);
  const value = Number(load.parameters.value);
  if (!direction || !Number.isFinite(value) || value <= 0) return [0, 0, 0];
  const magnitude = load.type === "pressure"
    ? pressurePascals(load) * projectedAreaM2(dimensions, direction)
    : load.type === "gravity"
      ? gravityMassKg(value, displayModel, densityKgM3) * STANDARD_GRAVITY
      : value;
  return [direction[0] * magnitude, direction[1] * magnitude, direction[2] * magnitude];
}

function projectedAreaM2(dimensions: NonNullable<DisplayModel["dimensions"]>, direction: Vec3): number {
  const [x, y, z] = dimensionMeters(dimensions);
  const ax = Math.abs(direction[0]);
  const ay = Math.abs(direction[1]);
  const az = Math.abs(direction[2]);
  if (ax >= ay && ax >= az) return Math.max(y * z, 1e-8);
  if (ay >= az) return Math.max(x * z, 1e-8);
  return Math.max(x * y, 1e-8);
}

function gravityMassKg(value: number, displayModel: DisplayModel, densityKgM3: number): number {
  if (value > 0) return value;
  return equivalentMassKg(densityKgM3, displayModel);
}

function equivalentMassKg(densityKgM3: number, displayModel: DisplayModel): number {
  const [x, y, z] = dimensionMeters(displayModel.dimensions!);
  return Math.max(densityKgM3 * x * y * z, 0.05);
}

function dimensionMeters(dimensions: NonNullable<DisplayModel["dimensions"]>): Vec3 {
  const scale = dimensions.units === "mm" ? 0.001 : 1;
  return [dimensions.x * scale, dimensions.y * scale, dimensions.z * scale];
}

const NODES_PER_ELEMENT: Record<string, number> = { Tet4: 4, Tet10: 10 };

function meshStatisticsForCoreModel(coreModel: CoreStudyModel): { nodes: number; elements: number } {
  const nodes = Math.floor(coreModel.model.nodes.coordinates.length / 3);
  const elements = coreModel.model.elementBlocks.reduce((sum, block) =>
    sum + Math.floor(block.connectivity.length / (NODES_PER_ELEMENT[block.type] ?? 4)), 0);
  return { nodes, elements };
}

function elementCentroid(coreModel: CoreStudyModel, elementIndex: number): Vec3 {
  const block = coreModel.model.elementBlocks[0];
  const connectivity = block?.connectivity.slice(elementIndex * 4, elementIndex * 4 + 4) ?? [];
  const sum: Vec3 = [0, 0, 0];
  for (const node of connectivity) {
    const point = coreModel.renderNodePoints[node] ?? [0, 0, 0];
    sum[0] += point[0];
    sum[1] += point[1];
    sum[2] += point[2];
  }
  return [round(sum[0] / 4, 6), round(sum[1] / 4, 6), round(sum[2] / 4, 6)];
}

function tetMeshForDisplayModel(displayModel: DisplayModel, preset: Study["meshSettings"]["preset"]): CoreTetMesh {
  const dimensions = displayModel.dimensions;
  if (!dimensions) throw new Error("OpenCAE Core requires display dimensions.");
  const bounds = renderBoundsForDisplayModel(displayModel);
  const [physicalX, physicalY, physicalZ] = dimensionMeters(dimensions);
  const [cellsX, cellsY, cellsZ] = meshCellsForPreset(preset);
  const renderNodePoints: Vec3[] = [];
  const solverCoordinates: number[] = [];
  const nodeIndex = (i: number, j: number, k: number) => i + (cellsX + 1) * (j + (cellsY + 1) * k);

  for (let k = 0; k <= cellsZ; k += 1) {
    const tz = k / cellsZ;
    for (let j = 0; j <= cellsY; j += 1) {
      const ty = j / cellsY;
      for (let i = 0; i <= cellsX; i += 1) {
        const tx = i / cellsX;
        const renderPoint: Vec3 = [
          lerp(bounds.min[0], bounds.max[0], tx),
          lerp(bounds.min[1], bounds.max[1], ty),
          lerp(bounds.min[2], bounds.max[2], tz)
        ];
        renderNodePoints.push(renderPoint);
        solverCoordinates.push(tx * physicalX, ty * physicalY, tz * physicalZ);
      }
    }
  }

  const connectivity: number[] = [];
  const addTet = (a: number, b: number, c: number, d: number) => {
    const signedVolume = signedTetVolume(solverCoordinates, a, b, c, d);
    if (Math.abs(signedVolume) <= 1e-18) return;
    if (signedVolume > 0) {
      connectivity.push(a, b, c, d);
    } else {
      connectivity.push(b, a, c, d);
    }
  };

  for (let k = 0; k < cellsZ; k += 1) {
    for (let j = 0; j < cellsY; j += 1) {
      for (let i = 0; i < cellsX; i += 1) {
        const n000 = nodeIndex(i, j, k);
        const n100 = nodeIndex(i + 1, j, k);
        const n010 = nodeIndex(i, j + 1, k);
        const n110 = nodeIndex(i + 1, j + 1, k);
        const n001 = nodeIndex(i, j, k + 1);
        const n101 = nodeIndex(i + 1, j, k + 1);
        const n011 = nodeIndex(i, j + 1, k + 1);
        const n111 = nodeIndex(i + 1, j + 1, k + 1);
        addTet(n000, n100, n110, n111);
        addTet(n000, n110, n010, n111);
        addTet(n000, n010, n011, n111);
        addTet(n000, n011, n001, n111);
        addTet(n000, n001, n101, n111);
        addTet(n000, n101, n100, n111);
      }
    }
  }

  return { solverCoordinates, renderNodePoints, connectivity };
}

/**
 * Rotates display-frame structured block coordinates (Y axis = height) into the upright
 * solver frame (Z axis = height) with the same proper rotation the viewer applies to
 * sample geometry, so solver surface meshes and their displacement vectors render true
 * without any axis flip. Render node points stay in display space for face mapping.
 */
function solverFrameCoordinates(displayFrameCoordinates: number[], displayModel: DisplayModel): number[] {
  if (!displayModelUsesUprightSolverFrame(displayModel)) return displayFrameCoordinates;
  const widthMeters = dimensionMeters(displayModel.dimensions!)[2];
  const coordinates: number[] = new Array(displayFrameCoordinates.length);
  for (let index = 0; index < displayFrameCoordinates.length; index += 3) {
    coordinates[index] = displayFrameCoordinates[index] ?? 0;
    coordinates[index + 1] = widthMeters - (displayFrameCoordinates[index + 2] ?? 0);
    coordinates[index + 2] = displayFrameCoordinates[index + 1] ?? 0;
  }
  return coordinates;
}

function renderBoundsForDisplayModel(displayModel: DisplayModel): { min: Vec3; max: Vec3 } {
  const centers = displayModel.faces.map((face) => face.center).filter((point) => point.every(Number.isFinite));
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const center of centers.length ? centers : [[0, 0, 0] as Vec3]) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, center[axis]!);
      max[axis] = Math.max(max[axis]!, center[axis]!);
    }
  }
  const dimensions = displayModel.dimensions ? dimensionMeters(displayModel.dimensions) : [1, 1, 1] as Vec3;
  const maxPhysical = Math.max(...dimensions, 1e-9);
  const currentSpan = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
  for (let axis = 0; axis < 3; axis += 1) {
    const span = max[axis]! - min[axis]!;
    const target = Math.max(currentSpan * (dimensions[axis]! / maxPhysical), currentSpan * 0.12, 0.2);
    if (span < target) {
      const center = (min[axis]! + max[axis]!) / 2;
      min[axis] = center - target / 2;
      max[axis] = center + target / 2;
    }
    const pad = Math.max((max[axis]! - min[axis]!) * 0.08, 0.02);
    min[axis] = min[axis]! - pad;
    max[axis] = max[axis]! + pad;
  }
  return { min, max };
}

function meshCellsForPreset(preset: Study["meshSettings"]["preset"]): [number, number, number] {
  if (preset === "ultra") return [6, 5, 4];
  if (preset === "fine") return [5, 4, 4];
  if (preset === "coarse") return [3, 3, 2];
  return [4, 3, 3];
}

function maxDofsForMeshPreset(preset: Study["meshSettings"]["preset"]): number {
  const [x, y, z] = meshCellsForPreset(preset);
  return (x + 1) * (y + 1) * (z + 1) * 3;
}

function nodeSelectionCount(preset: Study["meshSettings"]["preset"]): number {
  if (preset === "ultra") return 18;
  if (preset === "fine") return 14;
  if (preset === "coarse") return 8;
  return 10;
}

function selectionCenters(study: Study, displayModel: DisplayModel, selectionRef: string): Vec3[] {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  const faceIds = new Set(selection?.geometryRefs.filter((ref) => ref.entityType === "face").map((ref) => ref.entityId) ?? []);
  const centers = displayModel.faces
    .filter((face) => faceIds.has(face.id))
    .map((face) => face.center)
    .filter((point) => point.every(Number.isFinite));
  if (centers.length) return centers;
  const fallback = displayModel.faces[0]?.center;
  return fallback ? [fallback] : [[0, 0, 0]];
}

function nearestMeshNodes(points: Vec3[], centers: Vec3[], count: number): number[] {
  const ranked = points
    .map((point, index) => ({
      index,
      distanceSq: Math.min(...centers.map((center) => squaredDistance(point, center)))
    }))
    .sort((left, right) => left.distanceSq - right.distanceSq);
  return ranked.slice(0, Math.max(1, count)).map((entry) => entry.index);
}

function nearestSurfaceFacets(surfaceFacets: SurfaceFacetJson[], renderNodePoints: Vec3[], centers: Vec3[], count: number): number[] {
  const ranked = surfaceFacets
    .map((facet) => ({
      id: facet.id,
      distanceSq: Math.min(...centers.map((center) => squaredDistance(facetCenterFromRenderNodes(facet, renderNodePoints), center)))
    }))
    .sort((left, right) => left.distanceSq - right.distanceSq);
  return ranked.slice(0, Math.max(1, count)).map((entry) => entry.id);
}

function facetCenterFromRenderNodes(facet: SurfaceFacetJson, renderNodePoints: Vec3[]): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  for (const node of facet.nodes) {
    const point = renderNodePoints[node] ?? [0, 0, 0];
    sum[0] += point[0];
    sum[1] += point[1];
    sum[2] += point[2];
  }
  const count = Math.max(facet.nodes.length, 1);
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

function renderBoundsForPoints(points: Vec3[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  return {
    min: min.map((value) => Number.isFinite(value) ? value : 0) as Vec3,
    max: max.map((value) => Number.isFinite(value) ? value : 0) as Vec3
  };
}

function dominantAxis(vector: Vec3): 0 | 1 | 2 {
  const absolutes = vector.map(Math.abs) as Vec3;
  if (absolutes[0] >= absolutes[1] && absolutes[0] >= absolutes[2]) return 0;
  return absolutes[1] >= absolutes[2] ? 1 : 2;
}

function signedTetVolume(coordinates: number[], a: number, b: number, c: number, d: number): number {
  const ax = coordinates[a * 3] ?? 0;
  const ay = coordinates[a * 3 + 1] ?? 0;
  const az = coordinates[a * 3 + 2] ?? 0;
  const bax = (coordinates[b * 3] ?? 0) - ax;
  const bay = (coordinates[b * 3 + 1] ?? 0) - ay;
  const baz = (coordinates[b * 3 + 2] ?? 0) - az;
  const cax = (coordinates[c * 3] ?? 0) - ax;
  const cay = (coordinates[c * 3 + 1] ?? 0) - ay;
  const caz = (coordinates[c * 3 + 2] ?? 0) - az;
  const dax = (coordinates[d * 3] ?? 0) - ax;
  const day = (coordinates[d * 3 + 1] ?? 0) - ay;
  const daz = (coordinates[d * 3 + 2] ?? 0) - az;
  return (
    bax * (cay * daz - caz * day) -
    bay * (cax * daz - caz * dax) +
    baz * (cax * day - cay * dax)
  ) / 6;
}

function squaredDistance(left: Vec3, right: Vec3): number {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return dx * dx + dy * dy + dz * dz;
}

function scaleVector(vector: Vec3, scale: number): Vec3 {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function roundVector(vector: Vec3, decimals: number): Vec3 {
  return [round(vector[0], decimals), round(vector[1], decimals), round(vector[2], decimals)];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function vectorMagnitudes(values: Float64Array): number[] {
  const magnitudes: number[] = [];
  for (let index = 0; index < values.length; index += 3) {
    magnitudes.push(Math.hypot(values[index] ?? 0, values[index + 1] ?? 0, values[index + 2] ?? 0));
  }
  return magnitudes;
}

function vectorForNode(values: Float64Array, node: number, unitScale: number, digits: number): Vec3 {
  return [
    round((values[node * 3] ?? 0) * unitScale, digits),
    round((values[node * 3 + 1] ?? 0) * unitScale, digits),
    round((values[node * 3 + 2] ?? 0) * unitScale, digits)
  ];
}

function resultFieldAbsMax(field: ResultField): number {
  return Math.max(...[
    ...field.values,
    ...(field.samples?.map((sample) => sample.value) ?? [])
  ].map((value) => Math.abs(value)).filter(Number.isFinite), 0);
}

function stabilizeDynamicFieldRanges(fields: ResultField[]): void {
  const fieldTypes = [...new Set(fields.map((field) => field.type))];
  for (const type of fieldTypes) {
    const matchingFields = fields.filter((field) => field.type === type);
    const values = matchingFields.flatMap((field) => [
      ...field.values,
      ...(field.samples?.map((sample) => sample.value) ?? [])
    ]).filter(Number.isFinite);
    if (!values.length) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    for (const field of matchingFields) {
      field.min = round(min, dynamicRangeDigits(type));
      field.max = round(max, dynamicRangeDigits(type));
    }
  }
}

function dynamicRangeDigits(type: ResultField["type"]): number {
  if (type === "stress") return 1;
  if (type === "displacement" || type === "velocity" || type === "acceleration") return 8;
  return 3;
}

function coreCloudGeometryFromUnknown(value: unknown): CoreCloudGeometrySource | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CoreCloudGeometrySource>;
  if (!isCoreCloudGeometryKind(raw.kind)) return null;
  const descriptor = recordOrUndefined(raw.descriptor) ?? recordOrUndefined(raw.geometryDescriptor);
  return {
    kind: raw.kind,
    ...(isCoreCloudSampleId(raw.sampleId) ? { sampleId: raw.sampleId } : {}),
    ...(isCoreCloudGeometryFormat(raw.format) ? { format: raw.format } : {}),
    ...(typeof raw.filename === "string" && raw.filename ? { filename: raw.filename } : {}),
    ...(typeof raw.contentBase64 === "string" && raw.contentBase64 ? { contentBase64: raw.contentBase64 } : {}),
    ...(raw.units === "m" ? { units: "m" as const } : { units: "mm" as const }),
    ...(descriptor ? { descriptor } : {})
  };
}

function isCoreCloudGeometryKind(value: unknown): value is CoreCloudGeometrySource["kind"] {
  return value === "sample_procedural" || value === "uploaded_cad" || value === "uploaded_mesh" || value === "structured_block";
}

function isCoreCloudSampleId(value: unknown): value is NonNullable<CoreCloudGeometrySource["sampleId"]> {
  return value === "cantilever" || value === "beam" || value === "bracket";
}

function isCoreCloudGeometryFormat(value: unknown): value is NonNullable<CoreCloudGeometrySource["format"]> {
  return value === "step" || value === "stl" || value === "obj" || value === "msh" || value === "json";
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isBracketDemoGeometry(study: Study, displayModel: DisplayModel): boolean {
  const text = `${displayModelText(displayModel)} ${study.geometryScope.map((scope) => scope.label).join(" ")}`;
  return /\bbracket\b/i.test(text) && /\b(gusset|rib|upright|mounting|hole|holes)\b/i.test(text);
}

function bracketProceduralGeometryDescriptor(preset: Study["meshSettings"]["preset"] = "medium"): Record<string, unknown> {
  return {
    base: { length: 120, width: 34, height: 10 },
    upright: { height: 88, width: 18, thickness: 34 },
    gusset: { length: 72, height: 58, thickness: 34 },
    rib: { length: 72, height: 58, thickness: 34 },
    holes: [
      { id: "hole-base-1", center: [32, 17, 5], diameter: 12 },
      { id: "hole-base-2", center: [88, 17, 5], diameter: 12 },
      { id: "hole-upright-1", center: [9, 17, 56], diameter: 10 }
    ],
    surfaces: {
      fixedSupport: { selectionRef: "FS1", sourceSelectionRef: "selection-fixed-face", sourceFaceId: "face-base-left", name: "fixed_support" },
      loadSurface: { selectionRef: "L1", sourceSelectionRef: "selection-load-face", sourceFaceId: "face-load-top", name: "load_surface" }
    },
    supportFaceId: "face-base-left",
    loadFaceId: "face-load-top",
    meshSize: bracketMeshSizeMmForPreset(preset)
  };
}

// Characteristic gmsh element size (mm) for the 120 x 88 x 34 mm bracket sample.
// The mesh quality preset must change the solve mesh, not just the preset label.
export function bracketMeshSizeMmForPreset(preset: Study["meshSettings"]["preset"]): number {
  if (preset === "ultra") return 7;
  if (preset === "fine") return 9;
  if (preset === "coarse") return 18;
  return 12;
}

function withMeshPresetSize(geometry: CoreCloudGeometrySource, preset: Study["meshSettings"]["preset"]): CoreCloudGeometrySource {
  if (geometry.kind !== "sample_procedural" || geometry.sampleId !== "bracket") return geometry;
  return {
    ...geometry,
    descriptor: {
      ...(geometry.descriptor ?? {}),
      meshSize: bracketMeshSizeMmForPreset(preset)
    }
  };
}

function selectionSurfaceDescriptor(study: Study, role: "fixed" | "load", fallbackSelectionRef: string): Record<string, unknown> {
  const item = role === "fixed"
    ? study.constraints.find((constraint) => constraint.type === "fixed")
    : study.loads[0];
  const selection = item?.selectionRef
    ? study.namedSelections.find((candidate) => candidate.id === item.selectionRef)
    : undefined;
  const face = selection?.geometryRefs.find((ref) => ref.entityType === "face");
  return {
    selectionRef: item?.selectionRef ?? fallbackSelectionRef,
    sourceFaceId: face?.entityId,
    name: role === "fixed" ? "fixed_support" : "load_surface"
  };
}

function displayModelText(displayModel: DisplayModel): string {
  return [
    displayModel.id,
    displayModel.name,
    ...displayModel.faces.flatMap((face) => [face.id, face.label])
  ].join(" ").toLowerCase();
}

function hasActualCoreVolumeMeshForDisplay(displayModel: DisplayModel): boolean {
  const candidate = (displayModel as DisplayModel & { actualCoreMesh?: unknown }).actualCoreMesh;
  return Boolean(candidate);
}

function actualCoreVolumeMeshArtifact(study: Study): ActualCoreVolumeMeshArtifact | null {
  const summary = study.meshSettings.summary as (Study["meshSettings"]["summary"] & {
    source?: string;
    meshSource?: string;
    artifacts?: {
      meshConnectivity?: { connectedComponents?: number };
      actualCoreModel?: unknown;
      coreModel?: unknown;
      volumeMesh?: unknown;
    };
  }) | undefined;
  const artifacts = summary?.artifacts;
  const raw = artifacts?.actualCoreModel ?? artifacts?.coreModel ?? artifacts?.volumeMesh;
  if (!raw || typeof raw !== "object") return null;
  const model = "model" in raw ? (raw as { model?: unknown }).model : raw;
  if (!isOpenCaeModelJson(model)) return null;
  return {
    model,
    ...(isVec3Array((raw as { renderNodePoints?: unknown }).renderNodePoints) ? { renderNodePoints: (raw as { renderNodePoints: Vec3[] }).renderNodePoints } : {}),
    ...(artifacts?.meshConnectivity ? { meshConnectivity: artifacts.meshConnectivity } : {})
  };
}

function meshSourceForActualArtifact(artifact: ActualCoreVolumeMeshArtifact): string | undefined {
  return artifact.model.meshProvenance?.meshSource;
}

function connectedComponentCountForActualArtifact(artifact: ActualCoreVolumeMeshArtifact): number | undefined {
  const explicit = artifact.meshConnectivity?.connectedComponents;
  if (typeof explicit === "number" && Number.isInteger(explicit) && explicit > 0) return explicit;
  const components = connectedComponents({ elementBlocks: artifact.model.elementBlocks });
  return components.componentCount;
}

function renderNodePointsForModel(model: OpenCAEModelJson): Vec3[] {
  const points: Vec3[] = [];
  for (let index = 0; index < model.nodes.coordinates.length; index += 3) {
    points.push([
      model.nodes.coordinates[index] ?? 0,
      model.nodes.coordinates[index + 1] ?? 0,
      model.nodes.coordinates[index + 2] ?? 0
    ]);
  }
  return points;
}

function isOpenCaeModelJson(value: unknown): value is OpenCAEModelJson {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<OpenCAEModelJson>;
  return model.schema === "opencae.model" &&
    Array.isArray(model.nodes?.coordinates) &&
    Array.isArray(model.materials) &&
    Array.isArray(model.elementBlocks) &&
    Array.isArray(model.nodeSets) &&
    Array.isArray(model.boundaryConditions) &&
    Array.isArray(model.loads) &&
    Array.isArray(model.steps);
}

function isVec3Array(value: unknown): value is Vec3[] {
  return Array.isArray(value) && value.every((item) => Array.isArray(item) && item.length === 3 && item.every((component) => typeof component === "number" && Number.isFinite(component)));
}

function positiveDimensions(dimensions: DisplayModel["dimensions"]): boolean {
  return Boolean(dimensions && finitePositive(dimensions.x) && finitePositive(dimensions.y) && finitePositive(dimensions.z));
}

function finitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vector3(value: unknown): Vec3 | null {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0]!, value[1]!, value[2]!]
    : null;
}

function normalize(vector: Vec3 | null): Vec3 | null {
  if (!vector) return null;
  const length = Math.hypot(...vector);
  return length > 1e-12 ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}

function isDynamicLoadProfile(value: unknown): value is DynamicSolverSettings["loadProfile"] {
  return value === "ramp" || value === "step" || value === "quasi_static" || value === "sinusoidal";
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
