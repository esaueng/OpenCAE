import { isModalResultSummary } from "@opencae/schema";
import type { AnalysisMesh, CustomMaterial, DisplayModel, DynamicSolverSettings, MeshQuality, Project, ResultField, ResultRenderBounds, ResultSummary, RunEvent, Study, StudyRun } from "@opencae/schema";
import type { StepGeometryInspection, StepGeometryRepairReport } from "@opencae/mesh-intake";
import { assertCompatibleManufacturingProcess, resolveMaterial } from "@opencae/materials";
import type { LoadApplicationPoint, LoadDirection, LoadDirectionLabel, LoadType, PayloadLoadMetadata } from "../loadPreview";
import type { PayloadObjectSelection } from "../workspaceViewTypes";
import { embedUploadedModelFile, type EmbeddedModelFile, type LocalResultBundle, type SolverSurfaceMesh } from "../projectFile";
import { createLocalBlankProject, createLocalSampleProject, createLocalUploadResponse, openLocalProjectPayload } from "../localProjectFactory";
import type { SolveProgressEvent } from "@opencae/solve-pipeline";
import type { ResultViewCaptures } from "../report/captureResultViews";
import { isCancelledSolveError, startLocalSolve } from "../workers/solveWorkerClient";
import { loadLocalRunResults, saveLocalRunResults } from "./localResultsStore";
import { cancelWasmMeshing, canMeshStudyOnDemand, generateWasmMeshForStudy, type WasmMeshPhaseProgress } from "./wasmMeshing";
import { geometrySourceForStudy, hasActualCoreVolumeMesh, isComplexGeometry, normalizeSolverBackend, openCaeCoreEligibility, OPENCAE_CORE_MESH_REQUIRED_REASON, type NormalizedBrowserSolverBackend } from "../workers/opencaeCoreSolve";

export interface SampleProjectResponse {
  message?: string;
  project: Project;
  displayModel: DisplayModel;
  results?: LocalResultBundle;
}

export type StepGeometryMetadata = {
  status: "solid" | "repairable" | "unrepairable" | "invalid" | "unchecked" | "repaired";
  inspection?: StepGeometryInspection;
  repair?: StepGeometryRepairReport;
  message?: string;
};

export const STEP_REPAIR_UNAVAILABLE_MESSAGE =
  "Automatic repair cannot close this model. Re-export it from CAD as a solid body (stitch/heal in CAD; the gaps exceed the 0.05 mm in-app sew tolerance).";

const STEP_REPAIR_AVAILABLE_MESSAGE =
  "Automatic repair can re-close this model's faces. Use Fix open surfaces before simulation.";

export type ModelMutationOptions = {
  signal?: AbortSignal;
  /** Rechecked after expensive CAD work and immediately before persistence. */
  isCurrent?: () => boolean;
  /** Monotonic token used by the API to reject out-of-order model writes. */
  clientId?: string;
  generation?: number;
};

export type SampleModelId = "bracket" | "plate" | "cantilever";
export type SampleAnalysisType = "static_stress" | "dynamic_structural";

export interface ResultsResponse {
  summary: ResultSummary;
  fields: ResultField[];
  surfaceMesh?: SolverSurfaceMesh;
  /** Solver diagnostics entries (e.g. core-solve-diagnostics with real mesh counts). */
  diagnostics?: unknown[];
  artifacts?: {
    meshConnectivity?: { connectedComponents: number };
    meshStatistics?: { nodes: number; elements: number };
  };
  reportCaptures?: ResultViewCaptures;
}

export interface RunSimulationOptions {
  onRunStatus?: (message: string) => void;
  resultRenderBounds?: ResultRenderBounds | null;
  customMaterials?: CustomMaterial[];
  /**
   * Called when a run had to mesh its geometry first (A-M4 local-first
   * meshing): receives the study with the freshly stored mesh artifact so the
   * caller can persist it (same shape generateMesh returns).
   */
  onStudyMeshed?: (study: Study) => void;
}

const localResultsByRunId = new Map<string, ResultsResponse>();
const localRunsByRunId = new Map<string, LocalRunRecord>();
const RUN_BOOKKEEPING_LIMIT = 4;
const EVENT_SOURCE_CLOSED_READY_STATE = 2;
const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.001;
/** Prefix of retired client-dispatched cloud runs; kept only to recognize historical run ids from old autosaves. */
const HISTORICAL_CLOUD_RUN_ID_PREFIX = "run-cloud-core-";
const HISTORICAL_CLOUD_RUN_MESSAGE =
  "This run was solved on the retired OpenCAE Core Cloud. Its results are only available if they were saved with the project; re-run the simulation to solve locally in your browser.";

function setCappedRunEntry<T>(cache: Map<string, T>, runId: string, value: T, limit = RUN_BOOKKEEPING_LIMIT): void {
  cache.delete(runId);
  cache.set(runId, value);
  while (cache.size > limit) {
    const oldestRunId = cache.keys().next().value as string | undefined;
    if (oldestRunId === undefined) return;
    cache.delete(oldestRunId);
  }
}

// ---------------------------------------------------------------------------
// Local run controller: real, solver-driven run events for in-browser solves.
// Replaces the former pre-timed synthetic event scripts (honest results: every
// progress event now reflects actual solver phase reports, elapsed time is
// wall-clock, and estimatedRemainingMs is only present where it is derivable).
// ---------------------------------------------------------------------------

type LocalRunStatus = "running" | "complete" | "failed" | "cancelled";

type LocalRunRecord = {
  runId: string;
  status: LocalRunStatus;
  /** Replay buffer for late subscribers (bounded). */
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  startedAtMs: number;
  lastProgress: number;
  cancelSolve?: () => void;
};

const LOCAL_RUN_EVENT_BUFFER_LIMIT = 200;

function createLocalRunRecord(runId: string, status: LocalRunStatus = "running"): LocalRunRecord {
  const record: LocalRunRecord = {
    runId,
    status,
    events: [],
    listeners: new Set(),
    startedAtMs: Date.now(),
    lastProgress: 0
  };
  setCappedRunEntry(localRunsByRunId, runId, record);
  return record;
}

function activeLocalRun(): LocalRunRecord | undefined {
  for (const record of localRunsByRunId.values()) {
    if (record.status === "running") return record;
  }
  return undefined;
}

function emitLocalRunEvent(
  record: LocalRunRecord,
  event: { type: RunEvent["type"]; progress?: number; message: string; estimatedRemainingMs?: number }
): void {
  const progress = typeof event.progress === "number"
    ? Math.max(record.lastProgress, Math.min(100, Math.max(0, Math.round(event.progress))))
    : record.lastProgress;
  record.lastProgress = progress;
  const runEvent: RunEvent = {
    runId: record.runId,
    type: event.type,
    progress,
    message: event.message,
    elapsedMs: Math.max(0, Date.now() - record.startedAtMs),
    ...(event.estimatedRemainingMs !== undefined ? { estimatedRemainingMs: Math.max(0, Math.round(event.estimatedRemainingMs)) } : {}),
    timestamp: new Date().toISOString()
  };
  record.events.push(runEvent);
  // Bound the replay buffer: keep the initial state event, drop the oldest
  // interim progress entries.
  if (record.events.length > LOCAL_RUN_EVENT_BUFFER_LIMIT) record.events.splice(1, 1);
  for (const listener of [...record.listeners]) listener(runEvent);
}

/** Terminal transition; guarantees exactly one terminal event per run. */
function finishLocalRun(
  record: LocalRunRecord,
  status: Exclude<LocalRunStatus, "running">,
  event: { type: RunEvent["type"]; progress?: number; message: string; estimatedRemainingMs?: number }
): void {
  if (record.status !== "running") return;
  record.status = status;
  record.cancelSolve = undefined;
  emitLocalRunEvent(record, event);
}

/**
 * Maps real solver progress hooks onto the run progress contract:
 * assemble 0-30%, solve/frames 30-90% (stress recovery 85-90%), postprocess
 * 90-100%. estimatedRemainingMs is only emitted for dynamic frame integration,
 * where a per-frame pace is measurable; CG iteration counts admit no honest ETA.
 *
 * Runs that meshed first (A-M4) reserve 0-20% for real meshing phases, so
 * their solve progress is compressed into offset..100 (progressOffset = 20).
 */
function handleLocalSolveProgress(record: LocalRunRecord, progress: SolveProgressEvent, progressOffset = 0): void {
  if (record.status !== "running") return;
  const fraction = progress.total > 0 ? Math.min(progress.completed / progress.total, 1) : 0;
  let percent: number;
  let message: string;
  let estimatedRemainingMs: number | undefined;
  if (progress.phase === "assemble") {
    percent = 30 * fraction;
    message = `Assembling OpenCAE Core stiffness matrix (${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} elements).`;
  } else if (progress.phase === "frames") {
    percent = 30 + 60 * fraction;
    message = `Writing dynamic result frames ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}.`;
    const elapsedMs = Date.now() - record.startedAtMs;
    if (progress.completed > 0 && progress.total > progress.completed) {
      estimatedRemainingMs = (elapsedMs / progress.completed) * (progress.total - progress.completed);
    } else if (progress.total <= progress.completed) {
      estimatedRemainingMs = 0;
    }
  } else if (progress.phase === "recover") {
    percent = 85 + 5 * fraction;
    message = "Recovering OpenCAE Core element stresses.";
  } else {
    percent = 30 + 55 * fraction;
    message = progress.iteration !== undefined
      ? `Solving OpenCAE Core sparse system (CG iteration ${progress.iteration.toLocaleString()}${
          progress.relativeResidual !== undefined && Number.isFinite(progress.relativeResidual)
            ? `, residual ${progress.relativeResidual.toExponential(1)}`
            : ""
        }).`
      : "Solving OpenCAE Core sparse system.";
  }
  emitLocalRunEvent(record, {
    type: "progress",
    progress: progressOffset + percent * (100 - progressOffset) / 100,
    message,
    ...(estimatedRemainingMs !== undefined ? { estimatedRemainingMs } : {})
  });
}

/**
 * Persist a completed local result bundle for reload restore. Failures are
 * never silent: they surface as a visible warning diagnostic on the result
 * summary (and a console warning).
 */
async function persistLocalRunResults(runId: string, results: ResultsResponse): Promise<ResultsResponse> {
  try {
    await saveLocalRunResults(runId, results);
    return results;
  } catch (error) {
    const message = messageFromUnknownError(error) || "Browser storage is unavailable; these results will not survive a reload.";
    console.warn(`[OpenCAE] ${message}`);
    return {
      ...results,
      summary: {
        ...results.summary,
        diagnostics: [
          ...(results.summary.diagnostics ?? []),
          {
            id: "local-results-persistence",
            severity: "warning" as const,
            source: "local_job" as const,
            message: `Results computed successfully but could not be saved for reload: ${message}`,
            suggestedActions: []
          }
        ]
      }
    };
  }
}

export async function loadSampleProject(sample: SampleModelId = "bracket", analysisType: SampleAnalysisType = "static_stress"): Promise<SampleProjectResponse> {
  return fetchJsonWithFallback(
    "/api/sample-project/load",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample, analysisType })
    },
    () => createLocalSampleProject(sample, analysisType)
  );
}

export async function createProject(): Promise<SampleProjectResponse> {
  return fetchJsonWithFallback(
    "/api/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "blank" })
    },
    () => createLocalBlankProject()
  );
}

export async function importLocalProject(file: File): Promise<SampleProjectResponse> {
  const text = await file.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("The selected file is not a valid OpenCAE project file.");
  }
  return fetchJsonWithFallback(
    "/api/projects/import",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    },
    () => openLocalProjectPayload(payload)
  );
}

export async function uploadModel(
  projectId: string,
  file: File,
  currentProject?: Project,
  mutationOptions: ModelMutationOptions = {}
): Promise<SampleProjectResponse> {
  return uploadModelWithGeometry(projectId, file, currentProject, undefined, mutationOptions);
}

async function uploadModelWithGeometry(
  projectId: string,
  file: File,
  currentProject?: Project,
  knownStepGeometry?: StepGeometryMetadata,
  mutationOptions: ModelMutationOptions = {}
): Promise<SampleProjectResponse> {
  assertCurrentModelMutation(mutationOptions);
  const contentBase64 = await fileToBase64(file);
  assertCurrentModelMutation(mutationOptions);
  const embeddedModel: EmbeddedModelFile = {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    contentBase64
  };
  const stepDisplayFaces = await stepDisplayFacesForUpload(file.name, contentBase64);
  assertCurrentModelMutation(mutationOptions);
  const stepGeometry = knownStepGeometry ?? await inspectStepGeometryForUpload(file.name, contentBase64);
  assertCurrentModelMutation(mutationOptions);
  const modelMutation = modelMutationForRequest(currentProject, mutationOptions);
  const data = await fetchJsonWithFallback(
    `/api/projects/${projectId}/uploads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...embeddedModel, ...(modelMutation ? { modelMutation } : {}) }),
      ...(mutationOptions.signal ? { signal: mutationOptions.signal } : {})
    },
    () => {
      if (!currentProject) throw new Error("Could not upload model without an open project.");
      return createLocalUploadResponse(currentProject, embeddedModel, undefined, { stepDisplayFaces });
    }
  );
  let nextProject = embedUploadedModelFile(data.project, embeddedModel);
  if (stepGeometry) nextProject = attachStepGeometryMetadata(nextProject, embeddedModel.filename, stepGeometry);
  const notice = stepGeometryUploadNotice(stepGeometry);
  return {
    ...data,
    project: nextProject,
    message: [data.message, notice].filter(Boolean).join(" ")
  };
}

/**
 * Export a healed STEP through Gmsh, then feed those bytes back through the
 * normal replacement path. Re-importing intentionally resets face-bound
 * setup because healing/capping can renumber B-rep faces.
 */
export async function repairUploadedStepModel(
  projectId: string,
  currentProject: Project,
  mutationOptions: ModelMutationOptions = {}
): Promise<SampleProjectResponse> {
  assertCurrentModelMutation(mutationOptions);
  const embeddedModel = embeddedStepModel(currentProject);
  if (!embeddedModel) throw new Error("The uploaded STEP bytes are unavailable. Re-upload the model before repairing it.");
  if (import.meta.env.VITE_WASM_MESHING === "0" || typeof Worker === "undefined") {
    throw new Error("STEP repair is unavailable in this browser build.");
  }
  const client = await import("../workers/meshWorkerClient");
  const repaired = await client.repairStepFileInWorker({
    stepContent: base64ToArrayBuffer(embeddedModel.contentBase64)
  });
  // Do not let an old repair persist over a model/project selected while the
  // worker was healing the B-rep. The caller's generation guard changes at
  // action initiation, before the newer upload has to finish.
  assertCurrentModelMutation(mutationOptions);
  const repairedBuffer = repaired.stepContent.slice().buffer as ArrayBuffer;
  const repairedFile = new File([repairedBuffer], embeddedModel.filename, { type: embeddedModel.contentType || "model/step" });
  const response = await uploadModelWithGeometry(projectId, repairedFile, currentProject, {
    status: "repaired",
    inspection: repaired.inspection,
    repair: repaired.repair,
    message: "Open surfaces were healed into a closed solid. Review the repaired shape before simulation."
  }, mutationOptions);
  return {
    ...response,
    message: `Open surfaces fixed (${repaired.repair.method === "heal_and_cap" ? `${repaired.repair.cappedSurfaceCount} boundary patch${repaired.repair.cappedSurfaceCount === 1 ? "" : "es"} added` : "faces sewn"}). Material, supports, loads, mesh, and prior runs were reset because repaired face IDs can change.`
  };
}

async function inspectStepGeometryForUpload(filename: string, contentBase64: string): Promise<StepGeometryMetadata | undefined> {
  const extension = filename.trim().split(".").pop()?.toLowerCase();
  if (extension !== "step" && extension !== "stp") return undefined;
  if (import.meta.env.VITE_WASM_MESHING === "0" || typeof Worker === "undefined") {
    return { status: "unchecked", message: "STEP topology could not be checked in this browser build." };
  }
  try {
    const client = await import("../workers/meshWorkerClient");
    const { inspection, repairProbe } = await client.inspectStepFileInWorker({ stepContent: base64ToArrayBuffer(contentBase64) });
    return stepGeometryMetadataFromInspection(inspection, repairProbe);
  } catch (error) {
    return {
      status: "unchecked",
      message: `STEP topology check was unavailable: ${messageFromUnknownError(error) || "unknown error"}`
    };
  }
}

export function stepGeometryMetadataFromInspection(
  inspection: StepGeometryInspection,
  repairProbe?: "succeeded" | "failed"
): StepGeometryMetadata {
  const status: StepGeometryMetadata["status"] = repairProbe === "succeeded" || inspection.repairable
    ? "repairable"
    : repairProbe === "failed"
      ? "unrepairable"
      : inspection.status === "solid"
        ? "solid"
        : inspection.status === "invalid"
          ? "invalid"
          : "unrepairable";
  return { status, inspection, ...(inspection.message ? { message: inspection.message } : {}) };
}

/**
 * A nominal solid can still fail during 3D meshing. Trial-run the exact repair
 * behind Fix open surfaces and persist only its repairability result onto the
 * current uploaded model; the original STEP bytes remain untouched.
 */
export async function probeUploadedStepRepairAfterMeshFailure(
  currentProject: Project,
  mutationOptions: ModelMutationOptions = {}
): Promise<{ project: Project; stepGeometry: StepGeometryMetadata } | null> {
  assertCurrentModelMutation(mutationOptions);
  const embeddedModel = embeddedStepModel(currentProject);
  if (!embeddedModel) return null;
  const currentStatus = uploadedStepGeometryStatus(currentProject) ?? "unchecked";
  if (currentStatus !== "solid" && currentStatus !== "unchecked") return null;
  if (import.meta.env.VITE_WASM_MESHING === "0" || typeof Worker === "undefined") {
    throw new Error("STEP repairability checking is unavailable in this browser build.");
  }
  const client = await import("../workers/meshWorkerClient");
  assertCurrentModelMutation(mutationOptions);
  const { inspection, repairProbe } = await client.inspectStepFileInWorker({
    stepContent: base64ToArrayBuffer(embeddedModel.contentBase64),
    probeRepairEvenIfSolid: true
  });
  assertCurrentModelMutation(mutationOptions);
  const mapped = stepGeometryMetadataFromInspection(inspection, repairProbe);
  const stepGeometry: StepGeometryMetadata = mapped.status === "repairable"
    ? { ...mapped, message: STEP_REPAIR_AVAILABLE_MESSAGE }
    : { ...mapped, status: "unrepairable", message: STEP_REPAIR_UNAVAILABLE_MESSAGE };
  return {
    project: attachStepGeometryMetadata(currentProject, embeddedModel.filename, stepGeometry),
    stepGeometry
  };
}

export function isStepGeometryMeshFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "StepGeometryError" ||
    error.name === "StepGeometryRepairLostVolume"
  );
}

export const STEP_REPAIR_PROBE_MODEL_CHANGED_MESSAGE =
  "Skipped the Fix open surfaces check because the model changed during meshing.";

/** Project metadata may change during a long mesh; only STEP byte identity matters for a follow-up probe. */
export function uploadedStepRepairProbeDecision<CurrentProject extends Pick<Project, "id" | "geometryFiles">>(
  sourceProject: Pick<Project, "id" | "geometryFiles"> | null | undefined,
  currentProject: CurrentProject | null | undefined
): { shouldProbe: true; project: CurrentProject } | { shouldProbe: false; reason: string } {
  if (!sourceProject || !currentProject || sourceProject.id !== currentProject.id) {
    return { shouldProbe: false, reason: STEP_REPAIR_PROBE_MODEL_CHANGED_MESSAGE };
  }
  const sourceModel = embeddedStepModel(sourceProject);
  const currentModel = embeddedStepModel(currentProject);
  const sameModel = Boolean(
    sourceModel &&
    currentModel &&
    sourceModel.size === currentModel.size &&
    sourceModel.contentBase64 === currentModel.contentBase64
  );
  return sameModel
    ? { shouldProbe: true, project: currentProject }
    : { shouldProbe: false, reason: STEP_REPAIR_PROBE_MODEL_CHANGED_MESSAGE };
}

function attachStepGeometryMetadata(project: Project, filename: string, stepGeometry: StepGeometryMetadata): Project {
  const exactIndex = project.geometryFiles.findIndex((geometry) => geometry.filename === filename && geometry.metadata.source === "local-upload");
  const fallbackIndex = project.geometryFiles.findIndex((geometry) => geometry.metadata.source === "local-upload");
  const targetIndex = exactIndex >= 0 ? exactIndex : fallbackIndex;
  if (targetIndex < 0) return project;
  return {
    ...project,
    geometryFiles: project.geometryFiles.map((geometry, index) =>
      index === targetIndex
        ? { ...geometry, metadata: { ...geometry.metadata, stepGeometry } }
        : geometry
    )
  };
}

function uploadedStepGeometryStatus(project: Project): StepGeometryMetadata["status"] | undefined {
  const geometry = project.geometryFiles.find((candidate) => candidate.metadata.source === "local-upload");
  const value = geometry?.metadata.stepGeometry;
  if (!value || typeof value !== "object") return undefined;
  const status = (value as Partial<StepGeometryMetadata>).status;
  return status;
}

function stepGeometryUploadNotice(stepGeometry: StepGeometryMetadata | undefined): string {
  if (stepGeometry?.status === "repairable") return "Open STEP surfaces were detected. Use Fix model before simulation.";
  if (stepGeometry?.status === "unrepairable") return "Open STEP surfaces were detected, but automatic repair could not create a safe solid.";
  if (stepGeometry?.status === "invalid") return stepGeometry.message ?? "The STEP topology is invalid.";
  return "";
}

function embeddedStepModel(project: Pick<Project, "geometryFiles">): EmbeddedModelFile | null {
  const geometry = project.geometryFiles.find((candidate) => candidate.metadata.source === "local-upload");
  const value = geometry?.metadata.embeddedModel;
  if (!value || typeof value !== "object") return null;
  const embedded = value as Partial<EmbeddedModelFile>;
  const extension = embedded.filename?.trim().split(".").pop()?.toLowerCase();
  if (
    (extension !== "step" && extension !== "stp") ||
    typeof embedded.filename !== "string" ||
    typeof embedded.contentType !== "string" ||
    typeof embedded.size !== "number" ||
    typeof embedded.contentBase64 !== "string" ||
    !embedded.contentBase64
  ) return null;
  return embedded as EmbeddedModelFile;
}

/**
 * Real B-rep faces for STEP uploads (plan A-M3), so supports/loads target
 * actual geometry instead of generic box-face placeholders. On by default
 * (A-M4) with the flag check outside the dynamic import so VITE_WASM_MESHING=0
 * opt-out builds tree-shake the whole path; any registry failure falls back
 * to the legacy generic faces.
 */
async function stepDisplayFacesForUpload(filename: string, contentBase64: string): Promise<DisplayModel["faces"] | undefined> {
  if (import.meta.env.VITE_WASM_MESHING !== "0") {
    const extension = filename.trim().split(".").pop()?.toLowerCase();
    if (extension !== "step" && extension !== "stp") return undefined;
    try {
      const stepFaces = await import("../stepFaces");
      const registry = await stepFaces.stepFaceRegistryFromBase64(contentBase64);
      return registry.displayFaces.length ? registry.displayFaces : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function renameProject(projectId: string, name: string, currentProject?: Project): Promise<{ project: Project; message: string }> {
  return fetchJsonWithFallback(
    `/api/projects/${projectId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    },
    () => {
      if (!currentProject) throw new Error("Could not rename project without an open project.");
      return {
        project: {
          ...currentProject,
          name,
          updatedAt: new Date().toISOString()
        },
        message: "Project renamed locally."
      };
    }
  );
}

export async function generateMesh(studyId: string, preset: MeshQuality, currentStudy?: Study, displayModel?: DisplayModel, onProgress?: (message: string) => void, onPhaseProgress?: (progress: WasmMeshPhaseProgress) => void): Promise<{ study: Study; message: string }> {
  // In-browser gmsh-wasm meshing (production default since A-M4). Returns
  // null in opt-out builds or when the geometry has no wasm-meshable source,
  // and falls through to the existing preset-estimate path on transient
  // failure for preview/sample geometry. Uploaded STEP failures and typed
  // quality/topology rejections are permanent: surface them instead of
  // marking a fake estimate complete and failing again at Run.
  if (currentStudy) {
    try {
      const presetStudy: Study = { ...currentStudy, meshSettings: { ...currentStudy.meshSettings, preset } };
      const geometry = geometrySourceForStudy(presetStudy, displayModel);
      const wasmMeshed = await generateWasmMeshForStudy({
        preset,
        study: presetStudy,
        displayModel,
        geometry: geometry ? geometryWithMeshPreset(geometry, presetStudy) : null,
        meshSizeMm: PROCEDURAL_MESH_SIZE_MM[preset] ?? PROCEDURAL_MESH_SIZE_MM.medium,
        onProgress,
        onPhaseProgress
      });
      if (wasmMeshed) return wasmMeshed;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (
        displayModel?.nativeCad?.format === "step" ||
        (error instanceof Error && (error.name === "MeshQualityError" || error.name === "StepGeometryError"))
      ) throw error;
      onProgress?.(`In-browser meshing failed (${messageFromUnknownError(error) || "unknown error"}). Falling back to preset estimates.`);
    }
  }
  return fetchJsonWithFallback(
    `/api/studies/${studyId}/mesh`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset })
    },
    () => {
      if (!currentStudy) throw new Error("Could not generate mesh without an open study.");
      const analysisMesh = displayModel ? analysisMeshForDisplayModel(displayModel, preset) : undefined;
      const summary = meshSummaryForPreset(preset, analysisMesh);
      return {
        study: {
          ...currentStudy,
          meshSettings: {
            preset,
            status: "complete" as const,
            meshRef: `${currentStudy.projectId}/mesh/mesh-summary.json`,
            summary
          }
        },
        message: "Mesh generated locally."
      };
    }
  );
}

export async function assignMaterial(
  studyId: string,
  materialId: string,
  parameters: Record<string, unknown> = {},
  currentStudy?: Study,
  customMaterials: readonly CustomMaterial[] = []
): Promise<{ study: Study; message: string }> {
  resolveMaterial(materialId, customMaterials);
  if (parameters.manufacturingProcessId !== undefined) {
    assertCompatibleManufacturingProcess(materialId, parameters.manufacturingProcessId, customMaterials);
  }
  return fetchJsonWithFallback(
    `/api/studies/${studyId}/materials`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ materialId, parameters })
    },
    () => {
      if (!currentStudy) throw new Error("Could not assign material without an open study.");
      const bodySelection = currentStudy.namedSelections.find((selection) => selection.entityType === "body");
      const selectionRef = bodySelection?.id ?? currentStudy.geometryScope[0]?.entityId ?? "selection-body-local";
      return {
        study: {
          ...currentStudy,
          materialAssignments: [{
            id: "assign-material-current",
            materialId,
            selectionRef,
            parameters,
            status: "complete" as const
          }]
        },
        message: `Material assigned to ${bodySelection?.name ?? "model"}.`
      };
    }
  );
}

export async function addSupport(studyId: string, selectionRef?: string, currentStudy?: Study): Promise<{ study: Study; message: string }> {
  return fetchJsonWithFallback(
    `/api/studies/${studyId}/supports`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectionRef })
    },
    () => {
      if (!currentStudy) throw new Error("Could not add support without an open study.");
      return {
        study: {
          ...currentStudy,
          constraints: [
            ...currentStudy.constraints,
            {
              id: `constraint-${crypto.randomUUID()}`,
              type: "fixed" as const,
              selectionRef: selectionRef ?? currentStudy.namedSelections.find((selection) => selection.entityType === "face")?.id ?? "selection-fixed-face",
              parameters: {},
              status: "complete" as const
            }
          ]
        },
        message: "Fixed support added."
      };
    }
  );
}

export async function updateStudy(studyId: string, patch: Partial<Study>, message = "Study updated.", currentStudy?: Study): Promise<{ study: Study; message: string }> {
  return fetchJsonWithFallback(
    `/api/studies/${studyId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    },
    () => {
      if (!currentStudy) throw new Error("Could not update study without an open study.");
      return { study: { ...currentStudy, ...patch } as Study, message };
    }
  ).then((data) => ({ ...data, message }));
}

export async function addLoad(studyId: string, type: LoadType, value: number, selectionRef: string, direction: LoadDirection, applicationPoint?: LoadApplicationPoint | null, payloadObject?: PayloadObjectSelection | null, currentStudy?: Study, payloadMetadata: PayloadLoadMetadata = {}, directionMode?: LoadDirectionLabel): Promise<{ study: Study; message: string }> {
  return fetchJsonWithFallback(
    `/api/studies/${studyId}/loads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, value, selectionRef, direction, directionMode, applicationPoint, payloadObject, ...payloadMetadata })
    },
    () => {
      if (!currentStudy) throw new Error("Could not add load without an open study.");
      return {
        study: {
          ...currentStudy,
          loads: [
            ...currentStudy.loads,
            {
              id: `load-${crypto.randomUUID()}`,
              type,
              selectionRef,
              parameters: { value, units: type === "pressure" ? "kPa" : type === "gravity" ? "kg" : "N", direction, ...(directionMode ? { directionMode } : {}), ...(applicationPoint ? { applicationPoint } : {}), ...(payloadObject ? { payloadObject } : {}), ...(type === "gravity" ? payloadMetadata : {}) },
              status: "complete" as const
            }
          ]
        },
        message: "Load added."
      };
    }
  );
}

export async function runSimulation(studyId: string, currentStudy?: Study, displayModel?: DisplayModel, options: RunSimulationOptions = {}): Promise<{ run: { id: string }; streamUrl: string; message: string }> {
  // B4a: every run executes locally in the browser (complex geometry without
  // a stored mesh artifact is wasm-meshed first when this build/browser can).
  // The legacy POST /api/studies/{id}/runs dispatch branch is gone: since B3
  // no reachable caller runs without the open study.
  void studyId;
  if (!currentStudy) throw new Error("runSimulation requires the open study; server-dispatched runs were removed.");
  // Local runs never leave the browser. Stamp the resolved backend onto the
  // run's study copy so the solve worker's explicit-local guard sees the
  // routing decision; the persisted study keeps the user's "auto" choice.
  return runSimulationLocally(studyWithLocalBackend(currentStudy), displayModel, options);
}

function studyWithLocalBackend(study: Study): Study {
  if (study.solverSettings.backend === "opencae_core_local") return study;
  // The identical-looking branches keep the static/dynamic study union narrowed
  // so each spread pairs solverSettings with its own study variant.
  if (study.type === "dynamic_structural") return { ...study, solverSettings: { ...study.solverSettings, backend: "opencae_core_local" } };
  if (study.type === "modal_analysis") return { ...study, solverSettings: { ...study.solverSettings, backend: "opencae_core_local" } };
  return { ...study, solverSettings: { ...study.solverSettings, backend: "opencae_core_local" } };
}

export async function getResults(runId: string): Promise<ResultsResponse> {
  const localResults = localResultsByRunId.get(runId);
  if (localResults) return localResults;
  // Local run ids never exist server-side; restore from the browser store
  // (post-reload) or fail with a clear reason instead of a confusing 404.
  if (runId.startsWith("run-local-")) return restoreLocalRunResults(runId);
  // Historical cloud runs (pre-B4a autosaves): the client cloud path is gone,
  // so never fetch the dead endpoints — fail with an honest explanation.
  if (runId.startsWith(HISTORICAL_CLOUD_RUN_ID_PREFIX)) throw new Error(HISTORICAL_CLOUD_RUN_MESSAGE);
  const response = await fetch(`/api/runs/${runId}/results`);
  return withFieldRunIds(runId, await readJson(response, `GET /api/runs/${runId}/results`));
}

async function restoreLocalRunResults(runId: string): Promise<ResultsResponse> {
  let stored: ResultsResponse | null;
  try {
    stored = await loadLocalRunResults<ResultsResponse>(runId);
  } catch (error) {
    throw new Error(`Local results for this run could not be restored: ${messageFromUnknownError(error) || "browser storage unavailable."}`);
  }
  if (!stored) throw new Error("Results for this local run are no longer available in this browser (storage cleared or run pruned). Re-run the simulation.");
  const results = withFieldRunIds(runId, stored);
  setCappedRunEntry(localResultsByRunId, runId, results);
  return results;
}

export function withReportCaptures(results: ResultsResponse, reportCaptures: ResultViewCaptures): ResultsResponse {
  return { ...results, reportCaptures };
}

export async function saveRunReportCaptures(runId: string, reportCaptures: ResultViewCaptures): Promise<void> {
  let results = localResultsByRunId.get(runId);
  if (!results) results = await loadLocalRunResults<ResultsResponse>(runId) ?? undefined;
  if (!results) throw new Error("Simulation results are no longer available; report images could not be saved.");
  const next = withReportCaptures(results, reportCaptures);
  await saveLocalRunResults(runId, next);
  setCappedRunEntry(localResultsByRunId, runId, next);
}

// Deployed Core Cloud runners omit runId on result fields; the schema (and
// autosave restore) requires it, so stamp the owning run before use.
export function withFieldRunIds(runId: string, results: ResultsResponse): ResultsResponse {
  const stamped = !Array.isArray(results.fields) || results.fields.every((field) => typeof field.runId === "string" && field.runId)
    ? results
    : {
        ...results,
        fields: results.fields.map((field) => (typeof field.runId === "string" && field.runId ? field : { ...field, runId }))
      };
  return withDerivedSafetyFactorSurfaceField(stamped);
}

const DERIVED_SAFETY_FACTOR_CAP = 1000;

// Cloud results carry safety factor only as an element field with no surface
// alignment, so Safety Factor mode used to fall back to demo geometry. Derive a
// per-node field from the surface stress field and the summary yield margin.
export function withDerivedSafetyFactorSurfaceField(results: ResultsResponse): ResultsResponse {
  if (isModalResultSummary(results.summary)) return results;
  const surfaceMesh = results.surfaceMesh;
  if (!surfaceMesh) return results;
  const aligned = (field: ResultField) => field.location === "node" && field.surfaceMeshRef === surfaceMesh.id && field.values.length === surfaceMesh.nodes.length;
  if (results.fields.some((field) => field.type === "safety_factor" && aligned(field))) return results;
  const stressField = results.fields.find((field) => field.type === "stress" && aligned(field));
  const safetyFactor = Number(results.summary?.safetyFactor);
  const maxStress = Number(results.summary?.maxStress);
  if (!stressField || !Number.isFinite(safetyFactor) || !Number.isFinite(maxStress) || safetyFactor <= 0 || maxStress <= 0) return results;
  const yieldStrength = safetyFactor * maxStress;
  const values = stressField.values.map((stress) =>
    Math.min(DERIVED_SAFETY_FACTOR_CAP, yieldStrength / Math.max(Math.abs(stress), yieldStrength / DERIVED_SAFETY_FACTOR_CAP))
  );
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return results;
  return {
    ...results,
    fields: [
      ...results.fields,
      {
        ...stressField,
        id: `${stressField.id}-derived-safety-factor`,
        type: "safety_factor",
        values,
        min: Math.min(...finiteValues),
        max: Math.max(...finiteValues),
        units: "ratio",
        vectors: undefined,
        samples: undefined
      }
    ]
  };
}

export async function cancelRun(runId: string): Promise<{ run: StudyRun; message: string }> {
  const localRecord = localRunsByRunId.get(runId);
  if (localRecord) {
    if (localRecord.status === "running") {
      const cancelSolve = localRecord.cancelSolve;
      // Terminal transition first so the solve completion/rejection handlers
      // become no-ops: exactly one terminal event per run.
      finishLocalRun(localRecord, "cancelled", { type: "cancelled", message: "Simulation cancelled." });
      cancelSolve?.();
    }
    localResultsByRunId.delete(runId);
    return {
      run: cancelledStudyRun(runId, "local"),
      message: "Simulation cancelled."
    };
  }
  const response = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
  const payload = await readJson<{ run: StudyRun }>(response, `POST /api/runs/${runId}/cancel`);
  return { ...payload, message: "Simulation cancelled." };
}

function cancelledStudyRun(runId: string, solverBackend: string): StudyRun {
  return {
    id: runId,
    studyId: "local",
    status: "cancelled",
    jobId: `job-${runId}`,
    solverBackend,
    solverVersion: "0.1.0",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    diagnostics: []
  };
}

export function subscribeToRun(runId: string, onEvent: (event: RunEvent) => void): EventSource {
  const localRecord = localRunsByRunId.get(runId);
  if (localRecord) return subscribeToLocalRunRecord(localRecord, onEvent);
  const deliverFailure = (message: string) => onEvent(syntheticRunErrorEvent(runId, message));
  // Browser-run ids with no live record are terminal history — never open an
  // event stream to endpoints that cannot know them (historical cloud runs'
  // client endpoints are gone; local runs live only in this session).
  if (runId.startsWith(HISTORICAL_CLOUD_RUN_ID_PREFIX) || runId.startsWith("run-local-")) {
    const timer = globalThis.setTimeout(() => deliverFailure(
      runId.startsWith(HISTORICAL_CLOUD_RUN_ID_PREFIX)
        ? HISTORICAL_CLOUD_RUN_MESSAGE
        : "This local run is no longer active in this browser session. Re-run the simulation."
    ), 0);
    return { close: () => globalThis.clearTimeout(timer) } as EventSource;
  }
  const source = new EventSource(`/api/runs/${runId}/stream`);
  const eventTypes: RunEvent["type"][] = ["state", "progress", "message", "log", "diagnostic", "complete", "cancelled", "error"];
  for (const type of eventTypes) {
    source.addEventListener(type, (message) => {
      let event: RunEvent;
      try {
        event = JSON.parse((message as MessageEvent).data) as RunEvent;
      } catch {
        return; // Ignore stream messages that are not valid JSON run events.
      }
      onEvent(event);
    });
  }
  source.onerror = () => {
    // EventSource reconnects on transient errors; only a CLOSED stream is terminal.
    if (source.readyState !== EVENT_SOURCE_CLOSED_READY_STATE) return;
    deliverFailure("Lost the connection to the solver event stream.");
  };
  return source;
}

function syntheticRunErrorEvent(runId: string, message: string): RunEvent {
  return { runId, type: "error", progress: 100, message, timestamp: new Date().toISOString() };
}

function messageFromUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

// Gmsh characteristic length (mm) per mesh preset for procedural sample
// geometry (bracket). Shared by the mesh step and the run flow's mesh-first
// path; STEP uploads use the same map as a characteristic-length hint.
const PROCEDURAL_MESH_SIZE_MM: Record<MeshQuality, number> = {
  coarse: 18,
  medium: 12,
  fine: 8,
  ultra: 6
};

export function geometryWithMeshPreset(geometry: NonNullable<ReturnType<typeof geometrySourceForStudy>>, study: Study) {
  if (geometry.kind !== "sample_procedural" || !geometry.descriptor) return geometry;
  const meshSize = PROCEDURAL_MESH_SIZE_MM[study.meshSettings.preset] ?? PROCEDURAL_MESH_SIZE_MM.medium;
  return { ...geometry, descriptor: { ...geometry.descriptor, meshSize } };
}

/** First 20% of a mesh-first run's progress belongs to real meshing phases. */
const MESH_FIRST_SOLVE_PROGRESS_OFFSET = 20;

function runSimulationLocally(study: Study, displayModel?: DisplayModel, options: RunSimulationOptions = {}): { run: StudyRun; streamUrl: string; message: string } {
  const runId = `run-local-${crypto.randomUUID()}`;
  const backend = simulationBackend(study);
  // A-M4 local-first meshing: complex geometry without a stored Core volume
  // mesh is meshed in-browser (real gmsh-wasm) before the solve; mesh and
  // solve are strictly sequential — both are memory-heavy.
  const needsMesh = isComplexGeometry(displayModel, study) && !hasActualCoreVolumeMesh(study, displayModel);
  const capabilities = { canMeshOnDemand: needsMesh && canMeshStudyOnDemand(study, displayModel) };
  const meshFirst = needsMesh && capabilities.canMeshOnDemand;
  const coreEligibility = openCaeCoreEligibility(study, displayModel, capabilities, options.customMaterials);
  const now = new Date().toISOString();
  if (!coreEligibility.ok) {
    const record = createLocalRunRecord(runId, "failed");
    record.events.push(
      { runId, type: "state", progress: 0, message: "OpenCAE Core Local solve blocked.", elapsedMs: 0, timestamp: now },
      { runId, type: "error", progress: 100, message: coreEligibility.reason, elapsedMs: 0, timestamp: now }
    );
    return {
      run: {
        id: runId,
        studyId: study.id,
        status: "failed",
        jobId: `job-${runId}`,
        meshRef: study.meshSettings.meshRef,
        solverBackend: "opencae_core_local",
        solverVersion: "0.1.0",
        startedAt: now,
        finishedAt: now,
        diagnostics: [{
          id: "opencae-core-ineligible",
          severity: "error",
          source: "solver",
          message: coreEligibility.reason,
          suggestedActions: []
        }]
      },
      streamUrl: `local:${runId}`,
      message: coreEligibility.reason
    };
  }

  // Single-flight: one in-browser solve at a time (same UX as the run button).
  if (activeLocalRun()) throw new Error("Simulation is already running.");

  const dynamic = study.type === "dynamic_structural";
  const record = createLocalRunRecord(runId);
  emitLocalRunEvent(record, {
    type: "state",
    progress: 0,
    message: meshFirst
      ? "OpenCAE Core run queued in browser: meshing geometry, then solving."
      : dynamic ? "OpenCAE Core dynamic solve queued in browser." : "OpenCAE Core solve queued in browser."
  });

  const solveProgressOffset = meshFirst ? MESH_FIRST_SOLVE_PROGRESS_OFFSET : 0;
  void (async () => {
    let solveStudy = study;
    if (meshFirst) {
      // Hard-cancel path during meshing: terminate the mesh worker.
      record.cancelSolve = () => cancelWasmMeshing("Simulation cancelled.");
      solveStudy = await meshStudyForLocalRun(record, study, displayModel);
      if (record.status !== "running") return; // Cancelled while meshing.
      // Hand the freshly meshed study (with its stored artifact) back to the
      // caller so the workspace persists it like a mesh-step result.
      options.onStudyMeshed?.(solveStudy);
    }
    const handle = startLocalSolve(
      { runId, study: solveStudy, displayModel, customMaterials: options.customMaterials, debugResults: debugResultsEnabled() },
      (progress) => handleLocalSolveProgress(record, progress, solveProgressOffset)
    );
    record.cancelSolve = handle.cancel;
    const { result } = await handle.completion;
    if (record.status !== "running") return;
    emitLocalRunEvent(record, { type: "progress", progress: 92, message: "Writing OpenCAE Core result fields." });
    const results = await persistLocalRunResults(runId, withFieldRunIds(runId, result as ResultsResponse));
    if (record.status !== "running") return;
    setCappedRunEntry(localResultsByRunId, runId, results);
    finishLocalRun(record, "complete", {
      type: "complete",
      progress: 100,
      estimatedRemainingMs: 0,
      message: dynamic ? "OpenCAE Core dynamic simulation complete." : "OpenCAE Core simulation complete."
    });
  })().catch((error) => {
    if (record.status !== "running") return;
    if (isCancelledSolveError(error)) {
      finishLocalRun(record, "cancelled", { type: "cancelled", message: "Simulation cancelled." });
      return;
    }
    finishLocalRun(record, "failed", {
      type: "error",
      progress: 100,
      message: messageFromUnknownError(error) || "Local solve failed."
    });
  });

  return {
    run: {
      id: runId,
      studyId: study.id,
      status: "queued",
      jobId: `job-${runId}`,
      meshRef: study.meshSettings.meshRef,
      solverBackend: localSolverBackendForRun(study, backend, coreEligibility),
      solverVersion: "0.1.0",
      startedAt: now,
      diagnostics: []
    },
    streamUrl: `local:${runId}`,
    message: "OpenCAE Core Local simulation running."
  };
}

/**
 * Mesh-first leg of a local run (A-M4): reuses the mesh step's
 * generateWasmMeshForStudy (single meshing code path), streaming its real
 * phase reports ("Meshing volume...", ...) into the run event stream within
 * the 0-20% progress window, and returns the study carrying the stored
 * artifact. Throws (failing the run honestly) when meshing cannot produce a
 * volume mesh — a run never falls back to estimates.
 */
async function meshStudyForLocalRun(record: LocalRunRecord, study: Study, displayModel?: DisplayModel): Promise<Study> {
  const preset = study.meshSettings.preset;
  emitLocalRunEvent(record, {
    type: "progress",
    progress: 2,
    message: "No stored volume mesh for this geometry — meshing in browser before solving."
  });
  let meshPhaseCount = 0;
  const geometry = geometrySourceForStudy(study, displayModel);
  const meshed = await generateWasmMeshForStudy({
    preset,
    study,
    displayModel,
    geometry: geometry ? geometryWithMeshPreset(geometry, study) : null,
    meshSizeMm: PROCEDURAL_MESH_SIZE_MM[preset] ?? PROCEDURAL_MESH_SIZE_MM.medium,
    onProgress: (message) => {
      if (record.status !== "running") return;
      meshPhaseCount += 1;
      emitLocalRunEvent(record, {
        type: "progress",
        progress: Math.min(2 + meshPhaseCount * 2, MESH_FIRST_SOLVE_PROGRESS_OFFSET - 2),
        message
      });
    }
  });
  if (!meshed) {
    throw new Error(`In-browser meshing could not run for this geometry, so the simulation was stopped. ${OPENCAE_CORE_MESH_REQUIRED_REASON}`);
  }
  emitLocalRunEvent(record, {
    type: "progress",
    progress: MESH_FIRST_SOLVE_PROGRESS_OFFSET,
    message: meshed.message
  });
  return meshed.study;
}

export function dynamicOutputFrameEstimate(study: Study, options: { backend?: string } = {}): number {
  const raw = study.solverSettings as Partial<DynamicSolverSettings>;
  const startTime = finiteOr(raw.startTime, 0);
  const endTime = finiteOr(raw.endTime, 0.1);
  const timeStep = finiteOr(raw.timeStep, DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
  const requestedOutputInterval = finiteOr(raw.outputInterval, DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
  void options;
  const backendMinimum = Math.max(DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
  const outputInterval = Math.max(requestedOutputInterval, timeStep, backendMinimum);
  const duration = Math.max(0, endTime - startTime);
  const wholeSteps = Math.floor(duration / outputInterval);
  const remainder = duration - wholeSteps * outputInterval;
  return Math.max(1, wholeSteps + 1 + (remainder > outputInterval * 1e-9 ? 1 : 0));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type Vec3 = [number, number, number];

function analysisMeshForDisplayModel(displayModel: DisplayModel, quality: AnalysisMesh["quality"]): AnalysisMesh {
  const bounds = boundsForDisplayModel(displayModel);
  const divisions = quality === "ultra" ? 64 : quality === "fine" ? 42 : quality === "medium" ? 24 : 12;
  const samples: AnalysisMesh["samples"] = [];
  const faces: Array<{ axis: 0 | 1 | 2; value: number; normal: Vec3; sourceId: string }> = [
    { axis: 0, value: bounds.min[0], normal: [-1, 0, 0], sourceId: "x-min" },
    { axis: 0, value: bounds.max[0], normal: [1, 0, 0], sourceId: "x-max" },
    { axis: 1, value: bounds.min[1], normal: [0, -1, 0], sourceId: "y-min" },
    { axis: 1, value: bounds.max[1], normal: [0, 1, 0], sourceId: "y-max" },
    { axis: 2, value: bounds.min[2], normal: [0, 0, -1], sourceId: "z-min" },
    { axis: 2, value: bounds.max[2], normal: [0, 0, 1], sourceId: "z-max" }
  ];
  for (const face of displayModel.faces) {
    samples.push({ point: face.center, normal: normalized(face.normal), weight: 1, sourceId: face.id });
  }
  for (const face of faces) {
    const otherAxes = ([0, 1, 2] as const).filter((axis) => axis !== face.axis);
    for (let a = 0; a <= divisions; a += 1) {
      for (let b = 0; b <= divisions; b += 1) {
        const point: Vec3 = [0, 0, 0];
        point[face.axis] = face.value;
        point[otherAxes[0]!] = lerp(bounds.min[otherAxes[0]!], bounds.max[otherAxes[0]!], a / divisions);
        point[otherAxes[1]!] = lerp(bounds.min[otherAxes[1]!], bounds.max[otherAxes[1]!], b / divisions);
        samples.push({ point, normal: face.normal, weight: 1, sourceId: face.sourceId });
      }
    }
  }
  return { quality, bounds, samples };
}

function boundsForDisplayModel(displayModel: DisplayModel): AnalysisMesh["bounds"] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const face of displayModel.faces) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, face.center[axis]!);
      max[axis] = Math.max(max[axis]!, face.center[axis]!);
    }
  }
  if (!displayModel.faces.length) {
    min[0] = -1.2; min[1] = -0.5; min[2] = -0.5;
    max[0] = 1.2; max[1] = 0.5; max[2] = 0.5;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const span = Math.max(max[axis]! - min[axis]!, 0.4);
    const pad = Math.max(span * 0.08, 0.12);
    min[axis] = min[axis]! - pad;
    max[axis] = max[axis]! + pad;
  }
  return { min, max };
}

function normalized(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/**
 * EventSource-like adapter over a local run record: replays the buffered
 * events asynchronously (matching EventSource delivery semantics), then
 * streams live solver-driven events until closed.
 */
function subscribeToLocalRunRecord(record: LocalRunRecord, onEvent: (event: RunEvent) => void): EventSource {
  let closed = false;
  const listener = (event: RunEvent) => {
    if (!closed) onEvent(event);
  };
  const replayTimer = globalThis.setTimeout(() => {
    // Replay + attach happen in one task, so no event is missed or duplicated:
    // live emits append to record.events and cannot interleave with this loop.
    for (let index = 0; index < record.events.length; index += 1) {
      if (closed) return;
      onEvent(record.events[index]!);
    }
    if (!closed) record.listeners.add(listener);
  }, 0);
  return {
    close() {
      closed = true;
      globalThis.clearTimeout(replayTimer);
      record.listeners.delete(listener);
    }
  } as EventSource;
}

async function readJson<T>(response: Response, endpoint = response.url || "request"): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      message = parsed.error === "Not Found" && parsed.message ? parsed.message : parsed.error ?? parsed.message ?? text;
    } catch {
      // Use the raw response body when the server did not return JSON.
    }
    throw new HttpResponseError(formatHttpError(endpoint, response.status, response.statusText, message), response.status);
  }
  return response.json() as Promise<T>;
}

function formatHttpError(endpoint: string, status: number, statusText: string, message: string): string {
  const compactMessage = compactResponseMessage(message);
  const statusLabel = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
  return compactMessage ? `${endpoint} failed with ${statusLabel}: ${compactMessage}` : `${endpoint} failed with ${statusLabel}.`;
}

function compactResponseMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

async function fetchJsonWithFallback<T>(input: RequestInfo | URL, init: RequestInit, fallback: () => T | Promise<T>): Promise<T> {
  try {
    const response = await fetch(input, init);
    return await readJson<T>(response, typeof input === "string" ? `${init.method ?? "GET"} ${input}` : undefined);
  } catch (error) {
    // A superseded model mutation is deliberately cancelled. Falling back to
    // the local write path would resurrect the stale response the abort was
    // intended to discard.
    if (isAbortError(error) || (error instanceof HttpResponseError && error.status === 409)) throw error;
    return fallback();
  }
}

const MESH_PRESET_ESTIMATE_WARNING = "Node and element counts are preset planning estimates. The solver reports actual mesh statistics with the results.";

function meshSummaryForPreset(preset: MeshQuality, analysisMesh?: AnalysisMesh) {
  const sampleCount = analysisMesh?.samples.length;
  const summaryByPreset: Record<MeshQuality, NonNullable<Study["meshSettings"]["summary"]>> = {
    coarse: { nodes: 12840, elements: 7320, warnings: [MESH_PRESET_ESTIMATE_WARNING], analysisSampleCount: sampleCount ?? 1200, quality: "coarse" as const, source: "preset_estimate" },
    medium: { nodes: 42381, elements: 26944, warnings: [MESH_PRESET_ESTIMATE_WARNING, "Small feature curvature represented by surface analysis samples."], analysisSampleCount: sampleCount ?? 4800, quality: "medium" as const, source: "preset_estimate" },
    fine: { nodes: 88420, elements: 57102, warnings: [MESH_PRESET_ESTIMATE_WARNING, "Fine surface analysis sampling enabled for higher-quality local results."], analysisSampleCount: sampleCount ?? 19200, quality: "fine" as const, source: "preset_estimate" },
    ultra: { nodes: 182400, elements: 119808, warnings: [MESH_PRESET_ESTIMATE_WARNING, "Ultra surface analysis sampling enabled for detailed local gradients."], analysisSampleCount: sampleCount ?? 45000, quality: "ultra" as const, source: "preset_estimate" }
  };
  return summaryByPreset[preset];
}

function simulationBackend(study: Study): NormalizedBrowserSolverBackend {
  return normalizeSolverBackend(study);
}

function localSolverBackendForRun(study: Study, backend: NormalizedBrowserSolverBackend, coreEligibility?: ReturnType<typeof openCaeCoreEligibility>): string {
  if (backend === "opencae_core_local" && coreEligibility?.ok) {
    // Structured-block and actual-mesh studies both run the full production
    // Core pipeline in the browser now; the preview solver tier is retired.
    return study.type === "dynamic_structural" ? "opencae-core-mdof-tet" : "opencae-core-sparse-tet";
  }
  if (study.type === "dynamic_structural") return "local-dynamic-newmark";
  if (isBeamDemoStudyForLocalRun(study)) return "local-beam-demo-euler-bernoulli";
  return "local-heuristic-surface";
}

function debugResultsEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debugResults") === "1";
}

function isBeamDemoStudyForLocalRun(study: Study): boolean {
  const entityIds = new Set(study.namedSelections.flatMap((selection) => selection.geometryRefs.map((ref) => ref.entityId)));
  const hasBeamFaces = ["face-base-left", "face-load-top", "face-web-front", "face-base-bottom"].every((id) => entityIds.has(id));
  if (!hasBeamFaces) return false;
  const selectionText = study.namedSelections
    .flatMap((selection) => [selection.name, ...selection.geometryRefs.map((ref) => ref.label)])
    .join(" ")
    .toLowerCase();
  const projectText = `${study.projectId} ${study.name}`.toLowerCase();
  return selectionText.includes("payload") || selectionText.includes("beam body") || projectText.includes("beam");
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(contentBase64: string): ArrayBuffer {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function assertCurrentModelMutation(options: ModelMutationOptions): void {
  if (!options.signal?.aborted && options.isCurrent?.() !== false) return;
  const error = new Error("This model action was superseded by a newer workspace change.");
  error.name = "AbortError";
  throw error;
}

function modelMutationForRequest(project: Project | undefined, options: ModelMutationOptions) {
  if (!options.clientId || !Number.isSafeInteger(options.generation) || options.generation! < 0) return undefined;
  const geometry = project?.geometryFiles.find((candidate) => candidate.metadata.source === "local-upload")
    ?? project?.geometryFiles[0];
  return {
    clientId: options.clientId,
    generation: options.generation!,
    expectedGeometryId: geometry?.id ?? null,
    expectedUpdatedAt: project?.updatedAt ?? null
  };
}

class HttpResponseError extends Error {
  override name = "HttpResponseError";

  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
