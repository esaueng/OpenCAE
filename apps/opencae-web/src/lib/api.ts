import type { AnalysisMesh, DisplayModel, DynamicSolverSettings, MeshQuality, Project, ResultField, ResultRenderBounds, ResultSummary, RunEvent, Study, StudyRun } from "@opencae/schema";
import type { LoadApplicationPoint, LoadDirection, LoadType, PayloadLoadMetadata, PayloadObjectSelection } from "../loadPreview";
import { embedUploadedModelFile, type EmbeddedModelFile, type LocalResultBundle, type SolverSurfaceMesh } from "../projectFile";
import { createLocalBlankProject, createLocalSampleProject, createLocalUploadResponse, openLocalProjectPayload } from "../localProjectFactory";
import type { SolveProgressEvent } from "@opencae/solve-pipeline";
import { isCancelledSolveError, startLocalSolve } from "../workers/solveWorkerClient";
import { loadLocalRunResults, saveLocalRunResults } from "./localResultsStore";
import { buildOpenCaeCoreCloudModelForStudy, cloudGeometrySourceForStudy, hasActualCoreVolumeMesh, isComplexGeometry, normalizeSolverBackend, openCaeCoreEligibility, studyForCoreCloudGeometryDispatch, OPENCAE_CORE_CLOUD_GEOMETRY_REQUIRED_REASON, type NormalizedBrowserSolverBackend } from "../workers/opencaeCoreSolve";

export interface SampleProjectResponse {
  message?: string;
  project: Project;
  displayModel: DisplayModel;
  results?: LocalResultBundle;
}

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
}

export interface RunSimulationOptions {
  onRunStatus?: (message: string) => void;
  resultRenderBounds?: ResultRenderBounds | null;
}

const localResultsByRunId = new Map<string, ResultsResponse>();
const localRunsByRunId = new Map<string, LocalRunRecord>();
const cloudResultsUrlByRunId = new Map<string, string>();
const cloudEventsUrlByRunId = new Map<string, string>();
const failedCloudRunStartsByRunId = new Map<string, string>();
const cloudRunStartFailureListenersByRunId = new Map<string, (message: string) => void>();
const RUN_BOOKKEEPING_LIMIT = 4;
const EVENT_SOURCE_CLOSED_READY_STATE = 2;
const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.001;
const OPENCAE_CORE_CLOUD_FAILURE_MESSAGE = "OpenCAE Core Cloud solve failed. No local estimate fallback was used.";

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
 */
function handleLocalSolveProgress(record: LocalRunRecord, progress: SolveProgressEvent): void {
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
    progress: percent,
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

export async function uploadModel(projectId: string, file: File, currentProject?: Project): Promise<SampleProjectResponse> {
  const contentBase64 = await fileToBase64(file);
  const embeddedModel: EmbeddedModelFile = {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    contentBase64
  };
  const data = await fetchJsonWithFallback(
    `/api/projects/${projectId}/uploads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...embeddedModel })
    },
    () => {
      if (!currentProject) throw new Error("Could not upload model without an open project.");
      return createLocalUploadResponse(currentProject, embeddedModel);
    }
  );
  return {
    ...data,
    project: embedUploadedModelFile(data.project, embeddedModel)
  };
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

export async function generateMesh(studyId: string, preset: MeshQuality, currentStudy?: Study, displayModel?: DisplayModel): Promise<{ study: Study; message: string }> {
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

export async function assignMaterial(studyId: string, materialId: string, parameters: Record<string, unknown> = {}, currentStudy?: Study): Promise<{ study: Study; message: string }> {
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

export async function addLoad(studyId: string, type: LoadType, value: number, selectionRef: string, direction: LoadDirection, applicationPoint?: LoadApplicationPoint | null, payloadObject?: PayloadObjectSelection | null, currentStudy?: Study, payloadMetadata: PayloadLoadMetadata = {}): Promise<{ study: Study; message: string }> {
  return fetchJsonWithFallback(
    `/api/studies/${studyId}/loads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, value, selectionRef, direction, applicationPoint, payloadObject, ...payloadMetadata })
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
              parameters: { value, units: type === "pressure" ? "kPa" : type === "gravity" ? "kg" : "N", direction, ...(applicationPoint ? { applicationPoint } : {}), ...(payloadObject ? { payloadObject } : {}), ...(type === "gravity" ? payloadMetadata : {}) },
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
  if (currentStudy && simulationBackend(currentStudy) === "opencae_core_cloud") {
    return runOpenCaeCoreCloudSimulation(currentStudy, displayModel, options);
  }
  try {
    void options;
    const response = await fetch(`/api/studies/${studyId}/runs`, { method: "POST" });
    return await readJson(response, `POST /api/studies/${studyId}/runs`);
  } catch (error) {
    if (!currentStudy) throw error;
    return runSimulationLocally(currentStudy, displayModel);
  }
}

export async function getResults(runId: string): Promise<ResultsResponse> {
  const localResults = localResultsByRunId.get(runId);
  if (localResults) return localResults;
  const cloudResultsUrl = cloudResultsUrlByRunId.get(runId);
  if (cloudResultsUrl) {
    const request = headerTokenRequest(cloudResultsUrl);
    const response = await fetch(request.url, { headers: request.headers });
    return withFieldRunIds(runId, await readJson(response, `GET ${request.url}`));
  }
  // Local run ids never exist server-side; restore from the browser store
  // (post-reload) or fail with a clear reason instead of a confusing 404.
  if (runId.startsWith("run-local-")) return restoreLocalRunResults(runId);
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
  const cloudEventsUrl = cloudEventsUrlByRunId.get(runId);
  if (cloudEventsUrl) {
    const cancelRequest = headerTokenRequest(cloudCancelUrlFromEventsUrl(cloudEventsUrl));
    const cancelUrl = cancelRequest.url;
    try {
      const response = await fetch(cancelUrl, { method: "POST", headers: cancelRequest.headers });
      const payload = await readJson<{ run?: StudyRun; message?: string }>(response, `POST ${cancelUrl}`);
      return { run: payload.run ?? cancelledStudyRun(runId, "opencae-core-cloud"), message: payload.message ?? "Simulation cancelled." };
    } catch {
      return {
        run: cancelledStudyRun(runId, "opencae-core-cloud"),
        message: "Stopped watching the cloud run; the solve may still finish server-side."
      };
    }
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

function cloudCancelUrlFromEventsUrl(eventsUrl: string): string {
  const queryIndex = eventsUrl.indexOf("?");
  const path = queryIndex >= 0 ? eventsUrl.slice(0, queryIndex) : eventsUrl;
  const query = queryIndex >= 0 ? eventsUrl.slice(queryIndex) : "";
  return `${path.replace(/\/events$/, "/cancel")}${query}`;
}

// Run tokens travel in the x-opencae-run-token header for fetch calls so they
// stay out of access logs and browser history. EventSource cannot set headers,
// so the events stream URL keeps its token query parameter.
function headerTokenRequest(url: string): { url: string; headers: Record<string, string> } {
  const queryIndex = url.indexOf("?");
  if (queryIndex < 0) return { url, headers: {} };
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  const token = params.get("token");
  if (!token) return { url, headers: {} };
  params.delete("token");
  const rest = params.toString();
  return { url: `${url.slice(0, queryIndex)}${rest ? `?${rest}` : ""}`, headers: { "x-opencae-run-token": token } };
}

export function subscribeToRun(runId: string, onEvent: (event: RunEvent) => void): EventSource {
  const localRecord = localRunsByRunId.get(runId);
  if (localRecord) return subscribeToLocalRunRecord(localRecord, onEvent);
  const deliverFailure = (message: string) => onEvent(syntheticRunErrorEvent(runId, message));
  const failedStartMessage = failedCloudRunStartsByRunId.get(runId);
  if (failedStartMessage) {
    globalThis.setTimeout(() => deliverFailure(failedStartMessage), 0);
  } else if (cloudEventsUrlByRunId.has(runId)) {
    setCappedRunEntry(cloudRunStartFailureListenersByRunId, runId, deliverFailure);
  }
  const source = new EventSource(cloudEventsUrlByRunId.get(runId) ?? `/api/runs/${runId}/stream`);
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

async function runOpenCaeCoreCloudSimulation(study: Study, displayModel: DisplayModel | undefined, options: RunSimulationOptions): Promise<{ run: { id: string }; streamUrl: string; message: string }> {
  const runId = `run-cloud-core-${crypto.randomUUID()}`;
  try {
    const response = await fetch("/api/cloud-core/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(openCaeCoreCloudSolveRequest(runId, study, displayModel))
    });
    const payload = await readJson<{ run: { id: string }; streamUrl?: string; startUrl?: string; resultsUrl?: string; message?: string }>(response, "POST /api/cloud-core/runs");
    const responseRunId = payload.run.id;
    setCappedRunEntry(cloudResultsUrlByRunId, responseRunId, payload.resultsUrl ?? `/api/cloud-core/runs/${responseRunId}/results`);
    setCappedRunEntry(cloudEventsUrlByRunId, responseRunId, payload.streamUrl ?? `/api/cloud-core/runs/${responseRunId}/events`);
    void startOpenCaeCoreCloudRun(responseRunId, payload.startUrl ?? `/api/cloud-core/runs/${responseRunId}/start`);
    return {
      run: payload.run,
      streamUrl: payload.streamUrl ?? `/api/cloud-core/runs/${responseRunId}/events`,
      message: payload.message ?? "OpenCAE Core Cloud simulation running."
    };
  } catch (error) {
    // A deployment without Core Cloud (local dev API, static/local-first Worker)
    // cannot serve this route at all. Run the real in-browser OpenCAE Core solver
    // instead; its provenance stays honestly labeled as a browser solve. This is
    // not a result fallback: cloud solve failures from a provisioned deployment
    // still surface as errors below.
    if (isCloudCoreUnavailableInDeployment(error)) {
      options.onRunStatus?.("OpenCAE Core Cloud is not available in this deployment. Running the OpenCAE Core Local browser solver instead.");
      const localStudy: Study = study.type === "dynamic_structural"
        ? { ...study, solverSettings: { ...study.solverSettings, backend: "opencae_core_local" } }
        : { ...study, solverSettings: { ...study.solverSettings, backend: "opencae_core_local" } };
      return runSimulationLocally(localStudy, displayModel);
    }
    throw new Error(coreCloudFailureMessage(error), { cause: error });
  }
}

function isCloudCoreUnavailableInDeployment(error: unknown): boolean {
  const message = messageFromUnknownError(error);
  if (!message.startsWith("POST /api/cloud-core/runs failed with HTTP")) return false;
  return message.includes("HTTP 404") || message.includes("not provisioned in this Worker build");
}

async function startOpenCaeCoreCloudRun(runId: string, startUrl: string): Promise<void> {
  const request = headerTokenRequest(startUrl);
  try {
    const response = await fetch(request.url, { method: "POST", headers: request.headers });
    if (!response.ok) {
      const text = await response.text();
      console.warn(text);
      recordCloudRunStartFailure(runId, coreCloudFailureMessage(formatHttpError(`POST ${request.url}`, response.status, response.statusText, text)));
    }
  } catch (error) {
    const message = coreCloudFailureMessage(error);
    console.warn(message);
    recordCloudRunStartFailure(runId, message);
  }
}

function recordCloudRunStartFailure(runId: string, message: string): void {
  setCappedRunEntry(failedCloudRunStartsByRunId, runId, message);
  const listener = cloudRunStartFailureListenersByRunId.get(runId);
  if (!listener) return;
  cloudRunStartFailureListenersByRunId.delete(runId);
  listener(message);
}

function coreCloudFailureMessage(error: unknown): string {
  const message = messageFromUnknownError(error);
  if (!message) return OPENCAE_CORE_CLOUD_FAILURE_MESSAGE;
  if (message.includes("No local estimate fallback was used.")) return message;
  return `${message.replace(/\.+$/, "")}. No local estimate fallback was used.`;
}

function messageFromUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

// Gmsh characteristic length (mm) for cloud-meshed procedural sample geometry.
// The container caps solves at 30k DOFs; 6mm on the bracket stays well below it.
const CLOUD_PROCEDURAL_MESH_SIZE_MM: Record<MeshQuality, number> = {
  coarse: 18,
  medium: 12,
  fine: 8,
  ultra: 6
};

export function geometryWithMeshPreset(geometry: NonNullable<ReturnType<typeof cloudGeometrySourceForStudy>>, study: Study) {
  if (geometry.kind !== "sample_procedural" || !geometry.descriptor) return geometry;
  const meshSize = CLOUD_PROCEDURAL_MESH_SIZE_MM[study.meshSettings.preset] ?? CLOUD_PROCEDURAL_MESH_SIZE_MM.medium;
  return { ...geometry, descriptor: { ...geometry.descriptor, meshSize } };
}

export function studyForCoreCloudGeometrySolve(study: Study, displayModel: DisplayModel | undefined): Study {
  return studyForCoreCloudGeometryDispatch(study, displayModel);
}

// Exported so scripts/record-core-cloud-golden.mts records fixtures with the exact
// production request builder (see apps/opencae-web/src/testdata/core-cloud-golden/).
export function openCaeCoreCloudSolveRequest(runId: string, study: Study, displayModel: DisplayModel | undefined) {
  const actualMesh = hasActualCoreVolumeMesh(study, displayModel);
  const geometry = actualMesh ? null : cloudGeometrySourceForStudy(study, displayModel);
  if (!actualMesh && !geometry && isComplexGeometry(displayModel, study)) {
    throw new Error(OPENCAE_CORE_CLOUD_GEOMETRY_REQUIRED_REASON);
  }
  if (geometry) {
    const useLinearGmshElements = geometry.kind === "sample_procedural" && geometry.sampleId === "bracket";
    const cloudSolverSettings = {
      ...study.solverSettings,
      backend: "opencae_core_cloud",
      // Native curved Gmsh Tet10 elements can invert around the bracket's drilled holes.
      ...(useLinearGmshElements ? { elementOrder: 1 } : {})
    };
    return {
      runId,
      analysisType: study.type,
      // The cloud container meshes dispatched geometry in the upright solver frame and
      // applies study load directions verbatim, so hand it a solver-frame study.
      study: studyForCoreCloudGeometryDispatch(study, displayModel),
      displayModel,
      geometry: geometryWithMeshPreset(geometry, study),
      coreVolumeMesh: null,
      solverSettings: cloudSolverSettings,
      resultSettings: {
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-cloud",
          resultSource: "computed",
          meshSource: "actual_volume_mesh"
        },
        renderBounds: displayModel?.dimensions ?? null
      }
    };
  }

  const coreBuild = buildOpenCaeCoreCloudModelForStudy(study, displayModel);
  return {
    runId,
    analysisType: study.type,
    study,
    coreModel: coreBuild.model,
    coreVolumeMesh: null,
    solverSettings: {
      ...study.solverSettings,
      backend: "opencae_core_cloud"
    },
    resultSettings: {
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-cloud",
        resultSource: "computed",
        meshSource: coreBuild.meshSource
      },
      renderBounds: displayModel?.dimensions ?? null
    }
  };
}

function runSimulationLocally(study: Study, displayModel?: DisplayModel): { run: StudyRun; streamUrl: string; message: string } {
  const runId = `run-local-${crypto.randomUUID()}`;
  const backend = simulationBackend(study);
  const coreEligibility = openCaeCoreEligibility(study, displayModel);
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
    message: dynamic ? "OpenCAE Core dynamic solve queued in browser." : "OpenCAE Core solve queued in browser."
  });

  const handle = startLocalSolve(
    { runId, study, displayModel, debugResults: debugResultsEnabled() },
    (progress) => handleLocalSolveProgress(record, progress)
  );
  record.cancelSolve = handle.cancel;
  void handle.completion
    .then(async ({ result }) => {
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
    })
    .catch((error) => {
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

export function dynamicOutputFrameEstimate(study: Study, options: { backend?: "opencae_core_cloud" | "opencae_core_local" | "cloudflare_fea" | "opencae_core" | "local_detailed" } = {}): number {
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
    throw new Error(formatHttpError(endpoint, response.status, response.statusText, message));
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
  } catch {
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
