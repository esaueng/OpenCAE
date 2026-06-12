import type { AnalysisMesh, DisplayModel, DynamicSolverSettings, MeshQuality, Project, ResultField, ResultRenderBounds, ResultSummary, RunEvent, Study, StudyRun } from "@opencae/schema";
import type { LoadApplicationPoint, LoadDirection, LoadType, PayloadLoadMetadata, PayloadObjectSelection } from "../loadPreview";
import { embedUploadedModelFile, type EmbeddedModelFile, type LocalResultBundle, type SolverSurfaceMesh } from "../projectFile";
import { createLocalBlankProject, createLocalSampleProject, createLocalUploadResponse, openLocalProjectPayload } from "../localProjectFactory";
import { solveLocalStudyInWorker } from "../workers/performanceClient";
import { buildOpenCaeCoreCloudModelForStudy, cloudGeometrySourceForStudy, hasActualCoreVolumeMesh, isComplexGeometry, normalizeSolverBackend, openCaeCoreEligibility, trySolveOpenCaeCoreStudy, OPENCAE_CORE_CLOUD_GEOMETRY_REQUIRED_REASON, type NormalizedBrowserSolverBackend } from "../workers/opencaeCoreSolve";
import { modelDirectionToGlobalCadFrame } from "../modelOrientation";

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

const localResultsByRunId = new Map<string, ResultsResponse | Promise<ResultsResponse>>();
const localResultSolversByRunId = new Map<string, () => Promise<ResultsResponse>>();
const localEventsByRunId = new Map<string, RunEvent[]>();
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
  const localResults = localResultsByRunId.get(runId) ?? computeLocalResults(runId);
  if (localResults) {
    const results = await localResults;
    releaseLocalRunBookkeeping(runId);
    return results;
  }
  const cloudResultsUrl = cloudResultsUrlByRunId.get(runId);
  if (cloudResultsUrl) {
    const request = headerTokenRequest(cloudResultsUrl);
    const response = await fetch(request.url, { headers: request.headers });
    return withFieldRunIds(runId, await readJson(response, `GET ${request.url}`));
  }
  const response = await fetch(`/api/runs/${runId}/results`);
  return withFieldRunIds(runId, await readJson(response, `GET /api/runs/${runId}/results`));
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

function releaseLocalRunBookkeeping(runId: string): void {
  localEventsByRunId.delete(runId);
  localResultSolversByRunId.delete(runId);
}

export async function cancelRun(runId: string): Promise<{ run: StudyRun; message: string }> {
  if (localEventsByRunId.has(runId)) {
    localEventsByRunId.delete(runId);
    localResultsByRunId.delete(runId);
    localResultSolversByRunId.delete(runId);
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
  const localEvents = localEventsByRunId.get(runId);
  if (localEvents) return subscribeToLocalRun(localEvents, onEvent);
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

export function studyForCoreCloudGeometrySolve(study: Study, displayModel: DisplayModel | undefined): Study {
  if (!displayModel) return study;
  let changed = false;
  const loads = study.loads.map((load) => {
    const direction = load.parameters.direction;
    if (!Array.isArray(direction) || direction.length !== 3 || !direction.every((component) => Number.isFinite(Number(component)))) return load;
    const mapped = modelDirectionToGlobalCadFrame([Number(direction[0]), Number(direction[1]), Number(direction[2])], displayModel);
    if (mapped === direction) return load;
    changed = true;
    return { ...load, parameters: { ...load.parameters, direction: mapped } };
  });
  return changed ? { ...study, loads } : study;
}

export function geometryWithMeshPreset(geometry: NonNullable<ReturnType<typeof cloudGeometrySourceForStudy>>, study: Study) {
  if (geometry.kind !== "sample_procedural" || !geometry.descriptor) return geometry;
  const meshSize = CLOUD_PROCEDURAL_MESH_SIZE_MM[study.meshSettings.preset] ?? CLOUD_PROCEDURAL_MESH_SIZE_MM.medium;
  return { ...geometry, descriptor: { ...geometry.descriptor, meshSize } };
}

function openCaeCoreCloudSolveRequest(runId: string, study: Study, displayModel: DisplayModel | undefined) {
  const actualMesh = hasActualCoreVolumeMesh(study, displayModel);
  const geometry = actualMesh ? null : cloudGeometrySourceForStudy(study, displayModel);
  if (!actualMesh && !geometry && isComplexGeometry(displayModel, study)) {
    throw new Error(OPENCAE_CORE_CLOUD_GEOMETRY_REQUIRED_REASON);
  }
  if (geometry) {
    return {
      runId,
      analysisType: study.type,
      study: studyForCoreCloudGeometrySolve(study, displayModel),
      displayModel,
      geometry: geometryWithMeshPreset(geometry, study),
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
  if (!coreEligibility.ok) {
    const now = new Date().toISOString();
    setCappedRunEntry(localEventsByRunId, runId, addRunTiming([
      { runId, type: "state", progress: 0, message: "OpenCAE Core Local solve blocked.", timestamp: now },
      { runId, type: "error", progress: 100, message: coreEligibility.reason, timestamp: now }
    ], 1));
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
  setCappedRunEntry(localResultSolversByRunId, runId, () => {
    const analysisMesh = displayModel ? analysisMeshForDisplayModel(displayModel, study.meshSettings.preset) : undefined;
    const payload = { study, runId, analysisMesh, displayModel, debugResults: debugResultsEnabled() };
    return solveLocalStudyInWorker(payload).catch((error) => {
      const coreSolved = trySolveOpenCaeCoreStudy({ study, runId, displayModel });
      if (coreSolved.ok) return coreSolved.result;
      throw error;
    });
  });
  const now = new Date().toISOString();
  const events: RunEvent[] = study.type === "dynamic_structural"
    ? localDynamicRunEvents(runId, study, now, backend, coreEligibility)
    : localStaticRunEvents(runId, study, now, backend, coreEligibility);
  setCappedRunEntry(localEventsByRunId, runId, events);
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

function localStaticRunEvents(
  runId: string,
  study: Study,
  timestamp: string,
  backend: NormalizedBrowserSolverBackend,
  coreEligibility?: ReturnType<typeof openCaeCoreEligibility>
): RunEvent[] {
  if (backend === "opencae_core_local" && coreEligibility?.ok) {
    return addRunTiming([
      { runId, type: "state", progress: 0, message: "OpenCAE Core solve queued in browser.", timestamp },
      { runId, type: "progress", progress: 10, message: "OpenCAE Core CPU Tet4 solver started.", timestamp },
      { runId, type: "progress", progress: 46, message: "Building OpenCAE Core model and stiffness matrix.", timestamp },
      { runId, type: "progress", progress: 88, message: "Writing OpenCAE Core result fields.", timestamp },
      { runId, type: "complete", progress: 100, message: "OpenCAE Core simulation complete.", timestamp }
    ], localRunDurationEstimateMs(study));
  }
  return addRunTiming([
    { runId, type: "state", progress: 0, message: "Simulation queued locally.", timestamp },
    { runId, type: "progress", progress: 10, message: "Local static solver started.", timestamp },
    { runId, type: "progress", progress: 46, message: "Assembling local stiffness response.", timestamp },
    { runId, type: "progress", progress: 88, message: "Writing local result fields.", timestamp },
    { runId, type: "complete", progress: 100, message: "Simulation complete.", timestamp }
  ], localRunDurationEstimateMs(study));
}

function localDynamicRunEvents(
  runId: string,
  study: Study,
  timestamp: string,
  backend: NormalizedBrowserSolverBackend = "opencae_core_local",
  coreEligibility?: ReturnType<typeof openCaeCoreEligibility>
): RunEvent[] {
  const frameCount = dynamicOutputFrameEstimate(study);
  const estimatedDurationMs = localRunDurationEstimateMs(study, frameCount);
  const useCore = backend === "opencae_core_local" && coreEligibility?.ok;
  const milestones = [...new Set([1, Math.ceil(frameCount * 0.2), Math.ceil(frameCount * 0.4), Math.ceil(frameCount * 0.6), Math.ceil(frameCount * 0.8), frameCount])]
    .filter((frame) => frame >= 1 && frame <= frameCount);
  const writeEvents = milestones.map((frame, index) => ({
    runId,
    type: "progress" as const,
    progress: Math.min(98, 70 + Math.round(((index + 1) / milestones.length) * 28)),
    message: `Writing dynamic result frames ${frame.toLocaleString()} / ${frameCount.toLocaleString()}.`,
    timestamp
  }));
  return addRunTiming([
    { runId, type: "state", progress: 0, message: useCore ? "OpenCAE Core dynamic solve queued in browser." : "Simulation queued locally.", timestamp },
    { runId, type: "progress", progress: 10, message: useCore ? "OpenCAE Core dynamic Tet4 solver started." : "Local dynamic solver started.", timestamp },
    { runId, type: "progress", progress: 34, message: useCore ? "Building OpenCAE Core mass, damping, and stiffness response." : "Estimating lumped mass, stiffness, and damping.", timestamp },
    { runId, type: "progress", progress: 62, message: "Integrating dynamic response with Newmark average acceleration.", timestamp },
    ...writeEvents,
    {
      runId,
      type: "complete",
      progress: 100,
      message: useCore ? "OpenCAE Core dynamic simulation complete." : "Simulation complete.",
      timestamp
    }
  ], estimatedDurationMs);
}

function addRunTiming(events: RunEvent[], estimatedDurationMs: number): RunEvent[] {
  return events.map((event) => {
    const progress = typeof event.progress === "number" ? Math.max(0, Math.min(100, event.progress)) : 0;
    const elapsedMs = Math.round((estimatedDurationMs * progress) / 100);
    const estimatedRemainingMs = event.type === "complete" ? 0 : Math.max(0, estimatedDurationMs - elapsedMs);
    return {
      ...event,
      elapsedMs,
      estimatedDurationMs,
      estimatedRemainingMs
    };
  });
}

function localRunDurationEstimateMs(study: Study, frameCount = study.type === "dynamic_structural" ? dynamicOutputFrameEstimate(study) : 1): number {
  const meshMultiplier = study.meshSettings.preset === "ultra" ? 2.8 : study.meshSettings.preset === "fine" ? 1.9 : study.meshSettings.preset === "medium" ? 1.35 : 1;
  const dynamicMultiplier = study.type === "dynamic_structural" ? 1.8 : 1;
  const frameCost = study.type === "dynamic_structural" ? Math.max(frameCount, 1) * 36 : 450;
  return Math.round((1400 + frameCost) * meshMultiplier * dynamicMultiplier);
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

function computeLocalResults(runId: string): Promise<ResultsResponse> | null {
  const existing = localResultsByRunId.get(runId);
  if (existing) return Promise.resolve(existing);
  const solver = localResultSolversByRunId.get(runId);
  if (!solver) return null;
  const task = Promise.resolve().then(() => {
    const results = solver();
    setCappedRunEntry(localResultsByRunId, runId, results);
    localResultSolversByRunId.delete(runId);
    return results;
  });
  setCappedRunEntry(localResultsByRunId, runId, task);
  return task;
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

function subscribeToLocalRun(events: RunEvent[], onEvent: (event: RunEvent) => void): EventSource {
  let closed = false;
  const timers = events.map((event, index) => globalThis.setTimeout(async () => {
    if (closed) return;
    if (event.type === "complete") {
      try {
        await computeLocalResults(event.runId);
      } catch (error) {
        // Drop the rejected cached promise so a retry can solve again, then fail the run.
        localResultsByRunId.delete(event.runId);
        if (closed) return;
        onEvent(syntheticRunErrorEvent(event.runId, messageFromUnknownError(error) || "Local solve failed."));
        return;
      }
      if (closed) return;
    }
    onEvent(event);
  }, index * 160));
  return {
    close() {
      closed = true;
      timers.forEach((timer) => globalThis.clearTimeout(timer));
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
    const actualMesh = hasActualCoreVolumeMesh(study);
    if (actualMesh) return study.type === "dynamic_structural" ? "opencae-core-mdof-tet" : "opencae-core-sparse-tet";
    return study.type === "dynamic_structural" ? "opencae-core-preview-sdof" : "opencae-core-preview-tet4";
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
