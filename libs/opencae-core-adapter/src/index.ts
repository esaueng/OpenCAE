import {
  connectedComponents,
  deriveFixedSupportNodeSetFromSurface,
  elevateTet4MeshToTet10,
  validateModelJson,
  volumeMeshToModelJson,
  type LoadJson,
  type OpenCAEModelJson,
  type CoreStructuralSolveResult,
  type StepJson,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";
import type { DynamicLoadProfile } from "@opencae/solver-cpu";
import {
  BROWSER_SOLVE_LIMITS,
  solveDynamicVariantsWithCorePipeline,
  solveStaticVariantsWithCorePipeline,
  solveStudyModelWithCorePipeline,
  type SolverHooks
} from "@opencae/solve-pipeline";
import { effectiveMaterialProperties, resolveMaterial } from "@opencae/materials";
import {
  type CustomMaterial,
  type DisplayModel,
  type DynamicSolverSettings,
  type ModalSolverSettings,
  type ResultField,
  type ResultProvenance,
  type ResultSummary,
  type LoadCase,
  type LoadCombination,
  type RunVariantResult,
  type RunVariantRef,
  type Study
} from "@opencae/schema";
import { inferGlobalCriticalPrintAxis } from "@opencae/study-core";

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

export type CoreMeshStatistics = {
  nodes: number;
  elements: number;
  totalDofs: number;
  constrainedDofs: number;
  freeDofs: number;
  representativeElementSizeMm: number;
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
  variants?: RunVariantResult[];
  variantRefs?: RunVariantRef[];
  activeVariantId?: string;
  /** Solver-space render surface mesh (same contract as the cloud response). */
  surfaceMesh?: unknown;
  /** Solver diagnostics entries (core-solve-diagnostics, phase diagnostics, ...). */
  diagnostics?: unknown[];
  artifacts?: Record<string, unknown> & {
    meshConnectivity?: {
      connectedComponents: number;
    };
    meshStatistics?: CoreMeshStatistics;
  };
};

// B4a: the client cloud-solve path is retired; the browser solves locally,
// full stop. The type stays named so the B5 sweep (and any future backend)
// touches one place.
export type NormalizedBrowserSolverBackend = "opencae_core_local";

export type OpenCaeCoreEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export type OpenCaeCoreSolveOutcome =
  | { ok: true; result: LocalSolveResult; solverBackend: "opencae-core-sparse-tet" | "opencae-core-mdof-tet" | "opencae-core-modal-tet" }
  | { ok: false; reason: string; code?: string };

const STANDARD_GRAVITY = 9.80665;
const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;

const COMPLEX_CORE_MESH_REQUIRED_REASON =
  "This geometry needs a volume mesh before it can solve, and in-browser meshing is unavailable here " +
  "(opt-out build, unsupported browser, or no meshable geometry source). Generate a mesh on the Mesh step, " +
  "or rebuild with in-browser meshing enabled. Results are never estimated.";
export const OPENCAE_CORE_MESH_REQUIRED_REASON = "OpenCAE Core requires a procedural or uploaded geometry source to generate a volume mesh for this study.";

export function normalizeSolverBackend(value: { solverSettings?: { backend?: unknown } } | Study | undefined): NormalizedBrowserSolverBackend {
  void value;
  return "opencae_core_local";
}

export type ResolvedSolverBackend = {
  backend: NormalizedBrowserSolverBackend;
  /** "explicit" = the user chose this backend; "auto" = per-model routing chose it. */
  source: "explicit" | "auto";
};

/**
 * Explicit user backend choice, or null when the study carries no explicit
 * choice ("auto", unset, legacy, retired "opencae_core_cloud", or unknown
 * values all mean "never chose" — the schema aliases the retired cloud
 * choice to "auto" at parse time, and this treats any straggler the same).
 */
export function explicitSolverBackend(value: { solverSettings?: { backend?: unknown } } | Study | undefined): NormalizedBrowserSolverBackend | null {
  const backend = value?.solverSettings?.backend;
  return backend === "opencae_core_local" ? backend : null;
}

/**
 * Environment capabilities that affect run eligibility and routing. The web
 * app reports whether it can mesh the study's geometry on demand (in-browser
 * wasm meshing, production default since A-M4); the dev API server cannot.
 */
export type CoreSolveCapabilities = {
  /** True when the caller can generate a real volume mesh before solving (wasm mesh worker + meshable geometry source). */
  canMeshOnDemand?: boolean;
};

/**
 * Backend that auto routing picks for this study. With the client cloud path
 * retired (B4a) every run executes locally; ineligible studies fail the run
 * honestly with openCaeCoreEligibility's actionable reason instead of being
 * routed elsewhere or estimated.
 */
export function autoSolverBackend(study: Study, displayModel?: DisplayModel, capabilities?: CoreSolveCapabilities): NormalizedBrowserSolverBackend {
  void study;
  void displayModel;
  void capabilities;
  return "opencae_core_local";
}

/**
 * Concrete backend for a run plus whether the user chose it explicitly.
 * Local either way since B4a; the explicit/auto distinction still drives UI
 * labels and the solve worker's explicit-local guard.
 */
export function resolveSolverBackend(study: Study, displayModel?: DisplayModel, capabilities?: CoreSolveCapabilities): ResolvedSolverBackend {
  const explicit = explicitSolverBackend(study);
  if (explicit) return { backend: explicit, source: "explicit" };
  return { backend: autoSolverBackend(study, displayModel, capabilities), source: "auto" };
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

export function hasMeshableGeometrySource(study: Study, displayModel?: DisplayModel): boolean {
  return Boolean(geometrySourceForStudy(study, displayModel));
}

export function geometrySourceForStudy(study: Study, displayModel?: DisplayModel): CoreCloudGeometrySource | null {
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

export function displayPointToSolverFrame(point: Vec3, displayModel: DisplayModel | undefined): Vec3 {
  if (!displayModel?.dimensions || !displayModelUsesUprightSolverFrame(displayModel)) {
    return [point[0], point[1], point[2]];
  }
  const bounds = renderBoundsForDisplayModel(displayModel);
  const dimensions = dimensionMeters(displayModel.dimensions);
  const physical: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const span = bounds.max[axis]! - bounds.min[axis]!;
    physical[axis] = span > 1e-15
      ? ((point[axis]! - bounds.min[axis]!) / span) * dimensions[axis]!
      : dimensions[axis]! / 2;
  }
  return [physical[0], dimensions[2] - physical[2], physical[1]];
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
export function studyForCoreGeometryDispatch(study: Study, displayModel: DisplayModel | undefined): Study {
  if (!displayModel || !displayModelUsesUprightSolverFrame(displayModel)) return study;
  return {
    ...study,
    loads: study.loads.map((load) => {
      const direction = vector3(load.parameters.direction);
      const remotePoint = vector3(load.parameters.remotePoint);
      if (!direction && !remotePoint) return load;
      return {
        ...load,
        parameters: {
          ...load.parameters,
          ...(direction ? { direction: displayDirectionToSolverFrame(direction, displayModel) } : {}),
          ...(remotePoint ? { remotePoint: displayPointToSolverFrame(remotePoint, displayModel) } : {})
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

export function openCaeCoreEligibility(
  study: Study,
  displayModel?: DisplayModel,
  capabilities?: CoreSolveCapabilities,
  customMaterials: readonly CustomMaterial[] = []
): OpenCaeCoreEligibility {
  if (study.type !== "static_stress" && study.type !== "dynamic_structural" && study.type !== "modal_analysis") {
    return { ok: false, reason: "OpenCAE Core browser solve currently supports static, dynamic, and modal structural studies only." };
  }
  if (study.meshSettings.status !== "complete") return { ok: false, reason: "OpenCAE Core requires a completed mesh step." };
  if (!displayModel?.dimensions || !positiveDimensions(displayModel.dimensions)) {
    return { ok: false, reason: "OpenCAE Core requires usable block-like display dimensions." };
  }
  if (isComplexGeometry(displayModel, study) && !hasActualCoreVolumeMesh(study, displayModel) && !capabilities?.canMeshOnDemand) {
    // Complex geometry without a stored volume mesh is only runnable when the
    // caller can mesh it for real before the solve (A-M4 local-first meshing);
    // otherwise fail honestly — never estimate.
    return { ok: false, reason: COMPLEX_CORE_MESH_REQUIRED_REASON };
  }
  if (!study.materialAssignments.length) return { ok: false, reason: "OpenCAE Core requires an assigned material." };
  let material: MaterialStudyResolution;
  try {
    material = materialForStudy(study, customMaterials);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "OpenCAE Core could not resolve the assigned material." };
  }
  if (!study.constraints.some((constraint) => constraint.type === "fixed")) {
    return { ok: false, reason: "OpenCAE Core requires at least one fixed support." };
  }
  if (study.type === "dynamic_structural" && study.loads.some((load) => load.type === "bolt_preload")) {
    return { ok: false, reason: "Equivalent bolt preload is supported for static studies only." };
  }
  if (study.type === "modal_analysis") return { ok: true };
  if (!study.loads.length) return { ok: false, reason: "OpenCAE Core requires at least one load." };
  const combinations = structuralLoadCombinations(study).filter((combination) => combination.enabled);
  const requiredCaseIds = new Set([
    ...structuralLoadCases(study).filter((loadCase) => loadCase.enabled).map((loadCase) => loadCase.id),
    ...combinations.flatMap((combination) => combination.factors.map((factor) => factor.caseId))
  ]);
  const requiredLoadIds = new Set(structuralLoadCases(study).filter((loadCase) => requiredCaseIds.has(loadCase.id)).flatMap((loadCase) => loadCase.loadIds));
  if (!requiredCaseIds.size) return { ok: false, reason: "OpenCAE Core requires at least one enabled load case or combination." };
  const hasNonzeroLoad = study.loads.some((load) => requiredLoadIds.has(load.id) && Math.hypot(...forceVectorForLoad(load, displayModel, material.material.density)) > 1e-12);
  if (!hasNonzeroLoad) {
    return { ok: false, reason: "OpenCAE Core requires a load with a finite positive value and direction." };
  }
  return { ok: true };
}

/**
 * Browser-local solve at parity with the deployed Core Cloud runner: the same
 * high-fidelity model builder the cloud request path uses (surface sets,
 * surfaceForce/pressure loads, solver-frame rotation) feeds the mirrored cloud
 * pipeline in @opencae/solve-pipeline, under BROWSER_SOLVE_LIMITS.
 */
export function trySolveOpenCaeCoreStudy({ study, runId, displayModel, customMaterials = [], hooks, onVariantComplete }: {
  study: Study;
  runId: string;
  displayModel?: DisplayModel;
  customMaterials?: readonly CustomMaterial[];
  hooks?: SolverHooks;
  onVariantComplete?: (variant: RunVariantResult, surfaceMesh?: unknown) => void;
}): OpenCaeCoreSolveOutcome {
  const eligibility = openCaeCoreEligibility(study, displayModel, undefined, customMaterials);
  if (!eligibility.ok) return eligibility;

  try {
    const coreBuild = buildOpenCaeCoreModelForStudy(study, displayModel, customMaterials);
    const analysisType = study.type === "dynamic_structural"
      ? "dynamic_structural"
      : study.type === "modal_analysis"
        ? "modal_analysis"
        : "static_stress";
    if (study.type === "static_stress") {
      const loadCases = structuralLoadCases(study);
      const enabledCombinations = structuralLoadCombinations(study).filter((combination) => combination.enabled);
      const requiredCaseIds = new Set([
        ...loadCases.filter((loadCase) => loadCase.enabled).map((loadCase) => loadCase.id),
        ...enabledCombinations.flatMap((combination) => combination.factors.map((factor) => factor.caseId))
      ]);
      const solveCases = loadCases.filter((loadCase) => requiredCaseIds.has(loadCase.id));
      const solved = solveStaticVariantsWithCorePipeline({
        model: coreBuild.model,
        cases: solveCases.map((loadCase) => ({ id: loadCase.id, stepIndex: coreStepIndexForLoadCase(coreBuild.model, loadCase.id) })),
        combinations: enabledCombinations.map((combination) => ({ id: combination.id, factors: combination.factors })),
        solverSettings: pipelineSolverSettingsForStudy(study),
        limits: BROWSER_SOLVE_LIMITS,
        hooks
      });
      if (!solved.ok) {
        return {
          ok: false,
          code: solved.error.code,
          reason: solved.error.code === "cancelled" ? "OpenCAE Core solve cancelled." : `OpenCAE Core solve failed: ${solved.error.message}`
        };
      }
      const caseById = new Map(loadCases.map((loadCase) => [loadCase.id, loadCase]));
      const combinationById = new Map(enabledCombinations.map((combination) => [combination.id, combination]));
      const variants: RunVariantResult[] = [
        ...solved.cases
          .filter((entry) => caseById.get(entry.id)?.enabled)
          .map((entry) => runVariantFromCoreResult({
            id: `case:${entry.id}`,
            name: caseById.get(entry.id)?.name ?? entry.id,
            kind: "case",
            caseId: entry.id,
            result: entry.result,
            runId
          })),
        ...solved.combinations.map((entry) => runVariantFromCoreResult({
          id: `combination:${entry.id}`,
          name: combinationById.get(entry.id)?.name ?? entry.id,
          kind: "combination",
          combinationId: entry.id,
          result: entry.result,
          runId
        }))
      ];
      if (variants.length > 1) variants.push(staticEnvelopeVariant(variants, runId));
      const active = variants[0];
      if (!active) return { ok: false, code: "missing-load-cases", reason: "OpenCAE Core requires at least one enabled load case or combination." };
      const surfaceMesh = solved.cases[0]?.result.surfaceMesh;
      return {
        ok: true,
        solverBackend: "opencae-core-sparse-tet",
        result: {
          summary: active.summary,
          fields: active.fields,
          variants,
          activeVariantId: active.id,
          surfaceMesh,
          diagnostics: solved.cases.flatMap((entry) => entry.result.diagnostics),
          artifacts: {
            ...(solved.cases[0]?.result.artifacts ?? {}),
            ...(coreBuild.meshConnectivity ? { meshConnectivity: coreBuild.meshConnectivity } : {}),
            meshStatistics: meshStatisticsForCoreModel(coreBuild)
          }
        }
      };
    }
    if (study.type === "dynamic_structural") {
      const loadCases = structuralLoadCases(study).filter((loadCase) => loadCase.enabled);
      let firstCompleted: RunVariantResult | undefined;
      const solved = solveDynamicVariantsWithCorePipeline({
        model: coreBuild.model,
        cases: loadCases.map((loadCase) => ({ id: loadCase.id, stepIndex: coreStepIndexForLoadCase(coreBuild.model, loadCase.id) })),
        solverSettings: pipelineSolverSettingsForStudy(study),
        limits: BROWSER_SOLVE_LIMITS,
        hooks,
        onCaseComplete: (entry) => {
          const loadCase = loadCases.find((candidate) => candidate.id === entry.id)!;
          const variant = runVariantFromCoreResult({
            id: `case:${entry.id}`,
            name: loadCase.name,
            kind: "case",
            caseId: entry.id,
            result: entry.result,
            runId
          });
          if (!firstCompleted) firstCompleted = variant;
          onVariantComplete?.(variant, entry.result.surfaceMesh);
        }
      });
      if (!solved.ok) {
        return {
          ok: false,
          code: solved.error.code,
          reason: solved.error.code === "cancelled" ? "OpenCAE Core solve cancelled." : `OpenCAE Core solve failed: ${solved.error.message}`
        };
      }
      const active = firstCompleted;
      const firstCore = solved.cases[0]?.result;
      if (!active || !firstCore) return { ok: false, code: "missing-load-cases", reason: "OpenCAE Core requires at least one enabled dynamic load case." };
      return {
        ok: true,
        solverBackend: "opencae-core-mdof-tet",
        result: {
          summary: active.summary,
          fields: active.fields,
          variants: [active],
          variantRefs: loadCases.map((loadCase) => ({
            id: `case:${loadCase.id}`,
            name: loadCase.name,
            kind: "case",
            caseId: loadCase.id,
            persistedSeparately: true
          })),
          activeVariantId: active.id,
          surfaceMesh: firstCore.surfaceMesh,
          diagnostics: firstCore.diagnostics,
          artifacts: {
            ...(firstCore.artifacts ?? {}),
            ...(coreBuild.meshConnectivity ? { meshConnectivity: coreBuild.meshConnectivity } : {}),
            meshStatistics: meshStatisticsForCoreModel(coreBuild)
          }
        }
      };
    }
    const solved = solveStudyModelWithCorePipeline({
      model: coreBuild.model,
      analysisType,
      solverSettings: pipelineSolverSettingsForStudy(study),
      limits: BROWSER_SOLVE_LIMITS,
      hooks
    });
    if (!solved.ok) {
      return {
        ok: false,
        code: solved.error.code,
        reason: solved.error.code === "cancelled"
          ? "OpenCAE Core solve cancelled."
          : `OpenCAE Core solve failed: ${solved.error.message}`
      };
    }
    // The pipeline result is the cloud response contract (mm-N-s-MPa summary,
    // surface-aligned fields, solver-surface mesh); the ResultSummary/ResultField
    // schema types describe that same JSON shape.
    const result = solved.result as unknown as Omit<LocalSolveResult, "artifacts"> & { artifacts?: Record<string, unknown> };
    return {
      ok: true,
      solverBackend: analysisType === "dynamic_structural"
        ? "opencae-core-mdof-tet"
        : analysisType === "modal_analysis"
          ? "opencae-core-modal-tet"
          : "opencae-core-sparse-tet",
      result: {
        ...result,
        artifacts: {
          ...(result.artifacts ?? {}),
          ...(coreBuild.meshConnectivity ? { meshConnectivity: coreBuild.meshConnectivity } : {}),
          meshStatistics: meshStatisticsForCoreModel(coreBuild)
        }
      }
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "OpenCAE Core solve failed." };
  }
}

/**
 * Solver settings handed to the mirrored cloud pipeline. Static studies pass
 * their study settings through (bounded by the pipeline); dynamic studies pass
 * the same clamped transient settings that were written into the model's
 * dynamicLinear step, so the run matches both the step and the UI's frame
 * estimates.
 */
function pipelineSolverSettingsForStudy(study: Study): Record<string, unknown> {
  if (study.type === "modal_analysis") {
    return { ...study.solverSettings, modeCount: modalSettingsForStudy(study).modeCount };
  }
  if (study.type !== "dynamic_structural") return { ...study.solverSettings };
  const settings = dynamicSettingsForStudy(study);
  return {
    ...study.solverSettings,
    startTime: settings.startTime,
    endTime: settings.endTime,
    timeStep: settings.timeStep,
    outputInterval: settings.outputInterval,
    dampingRatio: settings.dampingRatio,
    loadProfile: dynamicLoadProfileForCore(settings.loadProfile)
  };
}

export function buildOpenCaeCoreModelForStudy(
  study: Study,
  displayModel: DisplayModel | undefined,
  customMaterials: readonly CustomMaterial[] = []
): CoreStudyModel {
  if (!displayModel?.dimensions) throw new Error("OpenCAE Core Cloud requires display dimensions before generating a Core model.");
  const actualMesh = actualCoreVolumeMeshArtifact(study);
  const material = materialForStudy(study, customMaterials);
  const criticalLayerAxis = inferGlobalCriticalPrintAxis(study, displayModel.faces.map((face) => ({
    entityId: face.id,
    center: face.center,
    ...(face.area ? { areaM2: face.area * 1e-6 } : {})
  })), displayModel);
  const effective = effectiveMaterialProperties(material.material, material.parameters, {
    criticalLayerAxis
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
      if (hasMeshableGeometrySource(study, displayModel)) {
        throw new Error(
          "This complex geometry must be meshed into a Core volume mesh before solving (the run flow meshes it in-browser first); no mesh artifact was stored."
        );
      }
      throw new Error(OPENCAE_CORE_MESH_REQUIRED_REASON);
    }
    const mesh = tetMeshForDisplayModel(displayModel, study.meshSettings.preset, CLOUD_STRUCTURED_BLOCK_TET10_NODE_BUDGET);
    model = volumeMeshToModelJson({
      nodes: { coordinates: solverFrameCoordinates(mesh.solverCoordinates, displayModel) },
      materials: [coreMaterial],
      elementBlocks: [{
        name: "structured-block-tet10",
        type: "Tet10",
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
    schemaVersion: "0.3.0",
    materials: [coreMaterial],
    // Stored mesh artifacts carry the material resolved at mesh time; the run
    // applies the study's current material, so every block must follow it or
    // model validation rejects the dangling mesh-time reference.
    elementBlocks: model.elementBlocks.map((block) => (
      block.material === coreMaterial.name ? block : { ...block, material: coreMaterial.name }
    )),
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource
    },
    coordinateSystem: model.coordinateSystem ?? { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" }
  };

  const surfaceSets = [...(model.surfaceSets ?? [])];
  const elementSets = [...model.elementSets];
  const nodeSets = [...model.nodeSets.filter((set) => !/^fixedNodes\d+$/.test(set.name))];
  const boundaryConditions: OpenCAEModelJson["boundaryConditions"] = [];
  const loads: LoadJson[] = [];
  const coreLoadNameByStudyLoadId = new Map<string, string>();

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
    if (load.type === "volume_force") {
      const elementSet = ensureElementSetForSelection(model, elementSets, study, displayModel, load.selectionRef);
      const direction = normalize(vector3(load.parameters.direction) ?? [0, 0, -1]);
      const magnitude = forceDensityNewtonsPerCubicMeter(load);
      if (!direction || !(magnitude > 0)) continue;
      const name = `bodyForceDensity${index}`;
      loads.push({
        name,
        type: "bodyForceDensity",
        elementSet: elementSet.name,
        forceDensity: roundVector(displayDirectionToSolverFrame(scaleVector(direction, magnitude), displayModel), 9)
      });
      coreLoadNameByStudyLoadId.set(load.id, name);
      continue;
    }

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
      const name = `pressure${index}`;
      loads.push({
        name,
        type: "pressure",
        surfaceSet: surfaceSet.name,
        pressure,
        ...(pressureDirection ? { direction: displayDirectionToSolverFrame(pressureDirection, displayModel) } : {})
      });
      coreLoadNameByStudyLoadId.set(load.id, name);
      continue;
    }

    if (load.type === "surface_traction") {
      const direction = normalize(vector3(load.parameters.direction) ?? [0, 0, -1]);
      const magnitude = pressurePascals(load);
      if (!direction || !(magnitude > 0)) continue;
      const name = `surfaceTraction${index}`;
      loads.push({
        name,
        type: "surfaceTraction",
        surfaceSet: surfaceSet.name,
        traction: roundVector(displayDirectionToSolverFrame(scaleVector(direction, magnitude), displayModel), 9)
      });
      coreLoadNameByStudyLoadId.set(load.id, name);
      continue;
    }

    if (load.type === "remote_force") {
      const force = displayDirectionToSolverFrame(forceVectorForLoad(load, displayModel, density), displayModel);
      const remotePoint = vector3(load.parameters.remotePoint);
      if (Math.hypot(...force) <= 1e-12 || !remotePoint) continue;
      const name = `remoteForce${index}`;
      loads.push({
        name,
        type: "remoteForce",
        surfaceSet: surfaceSet.name,
        totalForce: roundVector(force, 9),
        remotePoint: roundVector(renderPointToSolverPoint(remotePoint, renderNodePoints, model.nodes.coordinates, displayModel), 12)
      });
      coreLoadNameByStudyLoadId.set(load.id, name);
      continue;
    }

    if (load.type === "bolt_preload") {
      if (study.type !== "static_stress") throw new Error("Equivalent bolt preload is supported for static studies only.");
      const secondarySelectionRef = typeof load.parameters.secondarySelectionRef === "string"
        ? load.parameters.secondarySelectionRef
        : undefined;
      if (!secondarySelectionRef || secondarySelectionRef === load.selectionRef) {
        throw new Error(`Equivalent bolt preload ${load.id} requires a different opposing face selection.`);
      }
      const surfaceSetB = ensureSurfaceSetForSelection({
        model,
        renderNodePoints,
        displayModel,
        study,
        selectionRef: secondarySelectionRef,
        surfaceSets
      });
      const axis = normalize(vector3(load.parameters.direction) ?? [0, 0, 1]);
      const preloadForce = Number(load.parameters.value);
      if (!axis || !Number.isFinite(preloadForce) || preloadForce <= 0) continue;
      const name = `equivalentBoltPreload${index}`;
      loads.push({
        name,
        type: "equivalentBoltPreload",
        surfaceSetA: surfaceSet.name,
        surfaceSetB: surfaceSetB.name,
        axis: roundVector(displayDirectionToSolverFrame(axis, displayModel), 12),
        preloadForce
      });
      coreLoadNameByStudyLoadId.set(load.id, name);
      continue;
    }

    const force = displayDirectionToSolverFrame(forceVectorForLoad(load, displayModel, density), displayModel);
    if (Math.hypot(...force) <= 1e-12) continue;
    const name = load.type === "gravity" ? `payloadGravity${index}` : `appliedForce${index}`;
    loads.push({
      name,
      type: "surfaceForce",
      surfaceSet: surfaceSet.name,
      totalForce: roundVector(force, 9)
    });
    coreLoadNameByStudyLoadId.set(load.id, name);
  }

  if (!boundaryConditions.length) throw new Error("OpenCAE Core Cloud requires at least one mapped fixed support.");
  if (study.type !== "modal_analysis" && !loads.length) throw new Error("OpenCAE Core Cloud requires at least one mapped load.");

  model = {
    ...model,
    surfaceSets,
    elementSets,
    nodeSets,
    boundaryConditions,
    loads,
    steps: coreCloudStepsForStudy(study, boundaryConditions.map((condition) => condition.name), coreLoadNameByStudyLoadId)
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

export function coreMeshStatisticsForStudy(
  study: Study,
  displayModel?: DisplayModel,
  customMaterials: readonly CustomMaterial[] = []
): CoreMeshStatistics {
  return meshStatisticsForCoreModel(buildOpenCaeCoreModelForStudy(study, displayModel, customMaterials));
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

function ensureElementSetForSelection(
  model: OpenCAEModelJson,
  elementSets: OpenCAEModelJson["elementSets"],
  study: Study,
  displayModel: DisplayModel,
  selectionRef: string
): OpenCAEModelJson["elementSets"][number] {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  const candidateNames = new Set([
    selectionRef,
    selection?.name ?? "",
    ...(selection?.geometryRefs.map((ref) => ref.entityId) ?? []),
    ...(selection?.geometryRefs.map((ref) => ref.label) ?? [])
  ].filter(Boolean).map(normalizedSelectionName));
  const existing = elementSets.find((set) => candidateNames.has(normalizedSelectionName(set.name)));
  if (existing?.elements.length) return existing;
  if (displayModel.bodyCount !== 1) {
    throw new Error(`Volume force ${selectionRef} cannot map its body selection to volume elements in a multi-body mesh.`);
  }
  const allElements = elementSets.find((set) => set.name === "allElements" || set.name === "all");
  if (allElements?.elements.length) return allElements;
  const next = {
    name: "allElements",
    elements: Array.from({ length: model.elementBlocks.reduce((count, block) => count + block.connectivity.length / (block.type === "Tet10" ? 10 : 4), 0) }, (_value, index) => index)
  };
  elementSets.push(next);
  return next;
}

function normalizedSelectionName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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
    const { axis, plane: target } = facePlaneForNormal(normal, bounds);
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

function coreCloudStepsForStudy(
  study: Study,
  boundaryConditions: string[],
  coreLoadNameByStudyLoadId: ReadonlyMap<string, string>
): StepJson[] {
  if (study.type === "modal_analysis") {
    return [{ name: "modalStep", type: "modal", boundaryConditions, modeCount: modalSettingsForStudy(study).modeCount }];
  }
  if (study.type !== "dynamic_structural") {
    return structuralLoadCases(study).map((loadCase) => ({
      name: `loadCase:${loadCase.id}`,
      type: "staticLinear" as const,
      boundaryConditions,
      loads: loadCase.loadIds.flatMap((loadId) => {
        const name = coreLoadNameByStudyLoadId.get(loadId);
        return name ? [name] : [];
      })
    }));
  }
  const settings = dynamicSettingsForStudy(study);
  return structuralLoadCases(study).map((loadCase) => ({
      name: `loadCase:${loadCase.id}`,
      type: "dynamicLinear" as const,
      boundaryConditions,
      loads: loadCase.loadIds.flatMap((loadId) => {
        const name = coreLoadNameByStudyLoadId.get(loadId);
        return name ? [name] : [];
      }),
      startTime: settings.startTime,
      endTime: settings.endTime,
      timeStep: settings.timeStep,
      outputInterval: settings.outputInterval,
      loadProfile: settings.loadProfile,
      dampingRatio: settings.dampingRatio,
      ...("rayleighAlpha" in settings && typeof settings.rayleighAlpha === "number" ? { rayleighAlpha: settings.rayleighAlpha } : {}),
      ...("rayleighBeta" in settings && typeof settings.rayleighBeta === "number" ? { rayleighBeta: settings.rayleighBeta } : {})
    }));
}

function structuralLoadCases(study: Extract<Study, { type: "static_stress" | "dynamic_structural" }>): LoadCase[] {
  return study.loadCases?.length
    ? study.loadCases
    : [{ id: "case-default", name: "Default", enabled: true, loadIds: study.loads.map((load) => load.id) }];
}

function structuralLoadCombinations(study: Extract<Study, { type: "static_stress" | "dynamic_structural" }>): LoadCombination[] {
  return study.loadCombinations ?? [];
}

function coreStepIndexForLoadCase(model: OpenCAEModelJson, caseId: string): number {
  const index = model.steps.findIndex((step) => step.name === `loadCase:${caseId}`);
  if (index < 0) throw new Error(`OpenCAE Core model is missing the step for load case ${caseId}.`);
  return index;
}

function runVariantFromCoreResult({ id, name, kind, caseId, combinationId, result, runId }: {
  id: string;
  name: string;
  kind: "case" | "combination";
  caseId?: string;
  combinationId?: string;
  result: CoreStructuralSolveResult;
  runId: string;
}): RunVariantResult {
  return {
    id,
    name,
    kind,
    ...(caseId ? { caseId } : {}),
    ...(combinationId ? { combinationId } : {}),
    summary: result.summary as unknown as ResultSummary,
    fields: result.fields.map((field) => ({ ...field, runId, variantId: id })) as unknown as ResultField[]
  };
}

/** Pointwise static envelope; governing arrays index the compact variantIds table. */
export function staticEnvelopeVariant(variants: RunVariantResult[], runId: string): RunVariantResult {
  if (!variants.length) throw new Error("A static envelope requires at least one case or combination.");
  const stressFields = variants.map((variant) => variant.fields.find((field) =>
    field.type === "stress" && field.location === "node" && (field.component === undefined || field.component === "von_mises")
  ));
  const displacementFields = variants.map((variant) => variant.fields.find((field) => field.type === "displacement" && field.location === "node"));
  const stressLength = stressFields[0]?.values.length ?? 0;
  const displacementLength = displacementFields[0]?.values.length ?? 0;
  if (!stressLength || !displacementLength || stressFields.some((field) => field?.values.length !== stressLength) || displacementFields.some((field) => field?.values.length !== displacementLength)) {
    throw new Error("Static envelope fields must share aligned surface stress and displacement arrays.");
  }
  const stress = new Array<number>(stressLength).fill(Number.NEGATIVE_INFINITY);
  const stressGoverning = new Array<number>(stressLength).fill(0);
  for (let variantIndex = 0; variantIndex < stressFields.length; variantIndex += 1) {
    const values = stressFields[variantIndex]!.values;
    for (let node = 0; node < values.length; node += 1) {
      if (values[node]! > stress[node]!) {
        stress[node] = values[node]!;
        stressGoverning[node] = variantIndex;
      }
    }
  }
  const displacement = new Array<number>(displacementLength).fill(0);
  const displacementVectors = new Array<[number, number, number]>(displacementLength).fill([0, 0, 0]);
  const displacementGoverning = new Array<number>(displacementLength).fill(0);
  for (let variantIndex = 0; variantIndex < displacementFields.length; variantIndex += 1) {
    const field = displacementFields[variantIndex]!;
    for (let node = 0; node < field.values.length; node += 1) {
      const vector = field.vectors?.[node] ?? [0, 0, 0];
      const magnitude = Math.hypot(vector[0], vector[1], vector[2]);
      if (magnitude > displacement[node]!) {
        displacement[node] = magnitude;
        displacementVectors[node] = [...vector];
        displacementGoverning[node] = variantIndex;
      }
    }
  }
  const referenceStress = stressFields[0]!;
  const referenceDisplacement = displacementFields[0]!;
  const structuralSummaries = variants.map((variant) => variant.summary).filter((summary): summary is Extract<ResultSummary, { maxStress: number }> => "maxStress" in summary);
  const maxStress = Math.max(...stress, 0);
  const maxDisplacement = Math.max(...displacement, 0);
  const safetyFactor = Math.min(...structuralSummaries.map((summary) => summary.safetyFactor).filter((value) => Number.isFinite(value) && value > 0), Number.POSITIVE_INFINITY);
  return {
    id: "envelope",
    name: "Envelope",
    kind: "envelope",
    summary: {
      maxStress,
      maxStressUnits: referenceStress.units,
      maxDisplacement,
      maxDisplacementUnits: referenceDisplacement.units,
      safetyFactor: Number.isFinite(safetyFactor) ? safetyFactor : 0,
      reactionForce: Math.max(...structuralSummaries.map((summary) => summary.reactionForce), 0),
      reactionForceUnits: structuralSummaries[0]?.reactionForceUnits ?? "N",
      provenance: structuralSummaries[0]?.provenance,
      diagnostics: []
    },
    fields: [
      {
        ...referenceStress,
        id: "envelope-stress-surface",
        runId,
        variantId: "envelope",
        component: "von_mises",
        values: stress,
        min: Math.min(...stress),
        max: maxStress
      },
      {
        ...referenceDisplacement,
        id: "envelope-displacement-surface",
        runId,
        variantId: "envelope",
        values: displacement,
        vectors: displacementVectors,
        min: Math.min(...displacement),
        max: maxDisplacement
      }
    ],
    governingVariantIndices: {
      variantIds: variants.map((variant) => variant.id),
      stress: stressGoverning,
      displacement: displacementGoverning
    }
  };
}

function modalSettingsForStudy(study: Extract<Study, { type: "modal_analysis" }>): ModalSolverSettings {
  const count = Number(study.solverSettings.modeCount);
  return {
    ...study.solverSettings,
    modeCount: Number.isInteger(count) ? Math.min(10, Math.max(1, count)) : 6
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

function forceDensityNewtonsPerCubicMeter(load: Study["loads"][number]): number {
  const value = Number(load.parameters.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const units = typeof load.parameters.units === "string"
    ? load.parameters.units.toLowerCase().replace(/³/g, "^3")
    : "n/m^3";
  if (units === "kn/m^3") return value * 1_000;
  if (units === "n/mm^3") return value * 1_000_000_000;
  if (units === "lbf/in^3") return value * 271_447.14116097;
  return value;
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

type MaterialStudyResolution = {
  material: ReturnType<typeof resolveMaterial>;
  parameters: Record<string, unknown>;
};

function materialForStudy(study: Study, customMaterials: readonly CustomMaterial[] = []): MaterialStudyResolution {
  const assignment = study.materialAssignments[0];
  if (!assignment) throw new Error("OpenCAE Core requires an assigned material.");
  const material = resolveMaterial(assignment.materialId, customMaterials);
  return {
    material,
    parameters: assignment?.parameters ?? {}
  };
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

function meshStatisticsForCoreModel(coreModel: CoreStudyModel): CoreMeshStatistics {
  const model = coreModel.model;
  const nodes = Math.floor(model.nodes.coordinates.length / 3);
  const elements = model.elementBlocks.reduce((sum, block) =>
    sum + Math.floor(block.connectivity.length / (NODES_PER_ELEMENT[block.type] ?? 4)), 0);
  const totalDofs = nodes * 3;
  const structuralStep = model.steps.find((step) => step.type === "staticLinear" || step.type === "dynamicLinear" || step.type === "modal");
  const activeBoundaryConditions = new Set(structuralStep?.boundaryConditions ?? []);
  const nodeSetByName = new Map(model.nodeSets.map((nodeSet) => [nodeSet.name, nodeSet.nodes]));
  const surfaceSetByName = new Map((model.surfaceSets ?? []).map((surfaceSet) => [surfaceSet.name, surfaceSet.facets]));
  const facetById = new Map((model.surfaceFacets ?? []).map((facet) => [facet.id, facet.nodes]));
  const componentIndex = new Map([["x", 0], ["y", 1], ["z", 2]] as const);
  const constrained = new Set<number>();
  for (const boundaryCondition of model.boundaryConditions) {
    if (!activeBoundaryConditions.has(boundaryCondition.name)) continue;
    const constrainedNodes = typeof boundaryCondition.nodeSet === "string"
      ? nodeSetByName.get(boundaryCondition.nodeSet)
      : boundaryCondition.type === "fixed" && typeof boundaryCondition.surfaceSet === "string"
        ? [...new Set((surfaceSetByName.get(boundaryCondition.surfaceSet) ?? []).flatMap((facetId) => Array.from(facetById.get(facetId) ?? [])))]
        : undefined;
    if (!constrainedNodes) continue;
    const components = boundaryCondition.type === "fixed" ? boundaryCondition.components : [boundaryCondition.component];
    for (const node of constrainedNodes) {
      for (const component of components) {
        const index = componentIndex.get(component);
        if (index === undefined) continue;
        constrained.add(node * 3 + index);
      }
    }
  }
  const constrainedDofs = constrained.size;
  return {
    nodes,
    elements,
    totalDofs,
    constrainedDofs,
    freeDofs: Math.max(0, totalDofs - constrainedDofs),
    representativeElementSizeMm: representativeElementSizeMm(model)
  };
}

function representativeElementSizeMm(model: OpenCAEModelJson): number {
  const coordinates = model.nodes.coordinates;
  const lengthScale = (model.coordinateSystem?.solverUnits ?? "m-N-s-Pa").startsWith("m-") ? 1000 : 1;
  const cornerEdges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]] as const;
  let total = 0;
  let count = 0;
  for (const block of model.elementBlocks) {
    const nodesPerElement = NODES_PER_ELEMENT[block.type] ?? 4;
    for (let offset = 0; offset + nodesPerElement <= block.connectivity.length; offset += nodesPerElement) {
      for (const [leftLocal, rightLocal] of cornerEdges) {
        const left = block.connectivity[offset + leftLocal];
        const right = block.connectivity[offset + rightLocal];
        if (left === undefined || right === undefined) continue;
        const dx = (coordinates[right * 3] ?? Number.NaN) - (coordinates[left * 3] ?? Number.NaN);
        const dy = (coordinates[right * 3 + 1] ?? Number.NaN) - (coordinates[left * 3 + 1] ?? Number.NaN);
        const dz = (coordinates[right * 3 + 2] ?? Number.NaN) - (coordinates[left * 3 + 2] ?? Number.NaN);
        const length = Math.hypot(dx, dy, dz);
        if (!Number.isFinite(length) || length <= 0) continue;
        total += length;
        count += 1;
      }
    }
  }
  return count ? (total / count) * lengthScale : Number.EPSILON;
}


function tetMeshForDisplayModel(
  displayModel: DisplayModel,
  preset: Study["meshSettings"]["preset"],
  nodeBudget = CLOUD_STRUCTURED_BLOCK_TET10_NODE_BUDGET
): CoreTetMesh {
  const dimensions = displayModel.dimensions;
  if (!dimensions) throw new Error("OpenCAE Core requires display dimensions.");
  const bounds = renderBoundsForDisplayModel(displayModel);
  const [physicalX, physicalY, physicalZ] = dimensionMeters(dimensions);
  const [cellsX, cellsY, cellsZ] = meshDivisionsForDimensions([physicalX, physicalY, physicalZ], preset, nodeBudget);
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

  // Elevate to quadratic Tet10: linear tets lock in bending and under-predict
  // cantilever deflection several-fold at these grid densities.
  const tet4Elements: number[][] = [];
  for (let offset = 0; offset < connectivity.length; offset += 4) {
    tet4Elements.push(connectivity.slice(offset, offset + 4));
  }
  const elevated = elevateTet4MeshToTet10({ coordinates: solverCoordinates, elements: tet4Elements });
  // Render positions are the same per-axis affine map of solver coordinates that
  // produced the corner nodes, so midside nodes land on their edge midpoints.
  for (let node = renderNodePoints.length; node < elevated.coordinates.length / 3; node += 1) {
    const tx = physicalX > 0 ? elevated.coordinates[node * 3]! / physicalX : 0;
    const ty = physicalY > 0 ? elevated.coordinates[node * 3 + 1]! / physicalY : 0;
    const tz = physicalZ > 0 ? elevated.coordinates[node * 3 + 2]! / physicalZ : 0;
    renderNodePoints.push([
      lerp(bounds.min[0], bounds.max[0], tx),
      lerp(bounds.min[1], bounds.max[1], ty),
      lerp(bounds.min[2], bounds.max[2], tz)
    ]);
  }
  return {
    solverCoordinates: elevated.coordinates,
    renderNodePoints,
    connectivity: elevated.elements.flat()
  };
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

// The axis-aligned box face an outward face normal points at: the dominant-axis extreme of
// the render bounds. Used by cloud facet selection so both backends resolve a selection to
// the same face.
function facePlaneForNormal(normal: Vec3, bounds: { min: Vec3; max: Vec3 }): { axis: 0 | 1 | 2; plane: number } {
  const axis = dominantAxis(normal);
  return { axis, plane: normal[axis] < 0 ? bounds.min[axis] : bounds.max[axis] };
}

// Dimension-aware structured grid sizing, mirroring the cloud mesher: presets choose
// how many cells span the smallest dimension, all axes target near-cubic cells, and
// the elevated Tet10 grid stays inside the shared structured-block node budget.
// Local and cloud structured-block solves now use the same density (the local
// backend runs the full cloud pipeline on a dedicated solve worker).
const LOCAL_CELLS_ACROSS_MIN_DIMENSION: Record<string, number> = {
  coarse: 2,
  medium: 3,
  fine: 4,
  ultra: 5
};
const LOCAL_MAX_DIVISIONS_PER_AXIS = 32;
// Cloud-parity structured-block tier (simple geometry with no separate geometry source):
// sized for the retired Core Cloud runner, which had no in-browser worker-thread
// constraint — ~8000 Tet10 nodes (~24000 DOFs), well under that runner's 100000-DOF
// limit (SOLVER_LIMITS.maxDofs in the retired core-cloud server lineage;
// the frozen golden fixtures pin this behavior).
const CLOUD_STRUCTURED_BLOCK_TET10_NODE_BUDGET = 8000;

function meshDivisionsForDimensions(
  dimensions: [number, number, number],
  preset: Study["meshSettings"]["preset"],
  nodeBudget: number
): [number, number, number] {
  const positiveDims = dimensions.map((value) => (Number.isFinite(value) && value > 0 ? value : 1)) as [number, number, number];
  const cellsAcross = LOCAL_CELLS_ACROSS_MIN_DIMENSION[preset] ?? LOCAL_CELLS_ACROSS_MIN_DIMENSION.medium!;
  const targetCellSize = Math.min(...positiveDims) / cellsAcross;
  const divisions = positiveDims.map((dimension) =>
    Math.min(Math.max(Math.round(dimension / targetCellSize), 2), LOCAL_MAX_DIVISIONS_PER_AXIS)
  ) as [number, number, number];
  const elevatedNodes = ([x, y, z]: [number, number, number]) => (2 * x + 1) * (2 * y + 1) * (2 * z + 1);
  while (elevatedNodes(divisions) > nodeBudget && divisions.some((value) => value > 2)) {
    const scale = Math.cbrt(nodeBudget / elevatedNodes(divisions));
    let shrunk = false;
    for (let axis = 0; axis < 3; axis += 1) {
      const next = Math.max(Math.floor(divisions[axis]! * scale), 2);
      if (next < divisions[axis]!) shrunk = true;
      divisions[axis] = next;
    }
    if (!shrunk) break;
  }
  return divisions;
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

function renderPointToSolverPoint(
  point: Vec3,
  renderNodePoints: Vec3[],
  solverCoordinates: ArrayLike<number>,
  displayModel: DisplayModel
): Vec3 {
  if (displayModelUsesUprightSolverFrame(displayModel)) return displayPointToSolverFrame(point, displayModel);
  const renderBounds = renderBoundsForPoints(renderNodePoints);
  const solverBounds = coordinateBounds(solverCoordinates);
  const mapped: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const renderSpan = renderBounds.max[axis]! - renderBounds.min[axis]!;
    const solverSpan = solverBounds.max[axis]! - solverBounds.min[axis]!;
    mapped[axis] = renderSpan > 1e-15
      ? solverBounds.min[axis]! + ((point[axis]! - renderBounds.min[axis]!) / renderSpan) * solverSpan
      : (solverBounds.min[axis]! + solverBounds.max[axis]!) / 2;
  }
  return mapped;
}

function coordinateBounds(coordinates: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index + 2 < coordinates.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = coordinates[index + axis] ?? 0;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return { min, max };
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


function roundVector(vector: Vec3, decimals: number): Vec3 {
  return [round(vector[0], decimals), round(vector[1], decimals), round(vector[2], decimals)];
}

function scaleVector(vector: Vec3, scalar: number): Vec3 {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
