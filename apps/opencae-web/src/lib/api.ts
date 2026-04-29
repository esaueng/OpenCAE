import { solveDynamicStudy, solveStudy } from "@opencae/solver-service";
import type { AnalysisMesh, DisplayModel, DynamicSolverSettings, MeshQuality, Project, ResultField, ResultSummary, RunEvent, Study, StudyRun } from "@opencae/schema";
import type { LoadApplicationPoint, LoadDirection, LoadType, PayloadLoadMetadata, PayloadObjectSelection } from "../loadPreview";
import { embedUploadedModelFile, type EmbeddedModelFile, type LocalResultBundle } from "../projectFile";
import { createLocalBlankProject, createLocalSampleProject, createLocalUploadResponse, openLocalProjectPayload } from "../localProjectFactory";

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
}

const localResultsByRunId = new Map<string, ResultsResponse | Promise<ResultsResponse>>();
const localResultSolversByRunId = new Map<string, () => ResultsResponse>();
const localEventsByRunId = new Map<string, RunEvent[]>();
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;

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
  const payload = JSON.parse(text) as unknown;
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

export async function runSimulation(studyId: string, currentStudy?: Study, displayModel?: DisplayModel): Promise<{ run: { id: string }; streamUrl: string; message: string }> {
  try {
    if (currentStudy?.type === "dynamic_structural" && simulationBackend(currentStudy) === "cloudflare_fea") {
      return {
        ...runSimulationLocally(currentStudy, displayModel),
        message: "Dynamic Cloud FEA is not available yet. Running local transient animation."
      };
    }
    if (currentStudy && simulationBackend(currentStudy) === "cloudflare_fea") {
      const response = await fetch("/api/cloud-fea/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: currentStudy.projectId,
          studyId,
          fidelity: simulationFidelity(currentStudy)
        })
      });
      return await readJson(response);
    }
    const response = await fetch(`/api/studies/${studyId}/runs`, { method: "POST" });
    return await readJson(response);
  } catch (error) {
    if (!currentStudy) throw error;
    return runSimulationLocally(currentStudy, displayModel);
  }
}

export async function getResults(runId: string): Promise<ResultsResponse> {
  const localResults = localResultsByRunId.get(runId);
  if (localResults) return localResults;
  const localComputedResults = computeLocalResults(runId);
  if (localComputedResults) return localComputedResults;
  if (runId.startsWith("run-cloud-")) {
    const response = await fetch(`/api/cloud-fea/runs/${runId}/results`);
    return readJson(response);
  }
  const response = await fetch(`/api/runs/${runId}/results`);
  return readJson(response);
}

export async function cancelRun(runId: string): Promise<{ run: StudyRun; message: string }> {
  if (localEventsByRunId.has(runId)) {
    localEventsByRunId.delete(runId);
    localResultsByRunId.delete(runId);
    localResultSolversByRunId.delete(runId);
    return {
      run: {
        id: runId,
        studyId: "local",
        status: "cancelled",
        jobId: `job-${runId}`,
        solverBackend: "local",
        solverVersion: "0.1.0",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        diagnostics: []
      },
      message: "Simulation cancelled."
    };
  }
  const response = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
  const payload = await readJson<{ run: StudyRun }>(response);
  return { ...payload, message: "Simulation cancelled." };
}

export function subscribeToRun(runId: string, onEvent: (event: RunEvent) => void): EventSource {
  const localEvents = localEventsByRunId.get(runId);
  if (localEvents) return subscribeToLocalRun(localEvents, onEvent);
  if (runId.startsWith("run-cloud-")) return subscribeToCloudFeaRun(runId, onEvent);
  const source = new EventSource(`/api/runs/${runId}/stream`);
  const eventTypes: RunEvent["type"][] = ["state", "progress", "message", "log", "diagnostic", "complete", "cancelled", "error"];
  for (const type of eventTypes) {
    source.addEventListener(type, (message) => onEvent(JSON.parse((message as MessageEvent).data) as RunEvent));
  }
  return source;
}

function runSimulationLocally(study: Study, displayModel?: DisplayModel): { run: StudyRun; streamUrl: string; message: string } {
  const runId = `run-local-${crypto.randomUUID()}`;
  localResultSolversByRunId.set(runId, () => {
    const analysisMesh = displayModel ? analysisMeshForDisplayModel(displayModel, study.meshSettings.preset) : undefined;
    const solved = study.type === "dynamic_structural"
      ? solveDynamicStudy(study, runId, analysisMesh)
      : solveStudy(study, runId, analysisMesh);
    return { summary: solved.summary, fields: solved.fields };
  });
  const now = new Date().toISOString();
  const events: RunEvent[] = study.type === "dynamic_structural" ? localDynamicRunEvents(runId, study, now) : addRunTiming([
    { runId, type: "state", progress: 0, message: "Simulation queued locally.", timestamp: now },
    { runId, type: "progress", progress: 10, message: "Local static solver started.", timestamp: now },
    { runId, type: "progress", progress: 46, message: "Assembling local stiffness response.", timestamp: now },
    { runId, type: "progress", progress: 88, message: "Writing local result fields.", timestamp: now },
    { runId, type: "complete", progress: 100, message: "Simulation complete.", timestamp: now }
  ], localRunDurationEstimateMs(study));
  localEventsByRunId.set(runId, events);
  return {
    run: {
      id: runId,
      studyId: study.id,
      status: "queued",
      jobId: `job-${runId}`,
      meshRef: study.meshSettings.meshRef,
      solverBackend: study.type === "dynamic_structural" ? "local-dynamic-newmark" : simulationBackend(study) === "local_detailed" ? "local-detailed-superposition" : "local-static-superposition",
      solverVersion: "0.1.0",
      startedAt: now,
      diagnostics: []
    },
    streamUrl: `local:${runId}`,
    message: "Simulation running locally."
  };
}

function localDynamicRunEvents(runId: string, study: Study, timestamp: string): RunEvent[] {
  const frameCount = dynamicOutputFrameEstimate(study);
  const estimatedDurationMs = localRunDurationEstimateMs(study, frameCount);
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
    { runId, type: "state", progress: 0, message: "Simulation queued locally.", timestamp },
    { runId, type: "progress", progress: 10, message: "Local dynamic solver started.", timestamp },
    { runId, type: "progress", progress: 34, message: "Estimating lumped mass, stiffness, and damping.", timestamp },
    { runId, type: "progress", progress: 62, message: "Integrating dynamic response with Newmark average acceleration.", timestamp },
    ...writeEvents,
    { runId, type: "complete", progress: 100, message: "Simulation complete.", timestamp }
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

function dynamicOutputFrameEstimate(study: Study): number {
  const raw = study.solverSettings as Partial<DynamicSolverSettings>;
  const startTime = finiteOr(raw.startTime, 0);
  const endTime = finiteOr(raw.endTime, 0.1);
  const timeStep = finiteOr(raw.timeStep, 0.005);
  const outputInterval = Math.max(finiteOr(raw.outputInterval, 0.005), timeStep, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
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
    localResultsByRunId.set(runId, results);
    localResultSolversByRunId.delete(runId);
    return results;
  });
  localResultsByRunId.set(runId, task);
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
      await computeLocalResults(event.runId);
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

function subscribeToCloudFeaRun(runId: string, onEvent: (event: RunEvent) => void): EventSource {
  let closed = false;
  let seenCount = 0;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  const poll = async () => {
    if (closed) return;
    try {
      const response = await fetch(`/api/cloud-fea/runs/${runId}/events`);
      const payload = await readJson<{ events: RunEvent[] }>(response);
      const nextEvents = payload.events.slice(seenCount);
      seenCount = payload.events.length;
      for (const event of nextEvents) {
        if (closed) return;
        onEvent(event);
        if (event.type === "complete" || event.type === "cancelled" || event.type === "error") {
          closed = true;
          if (timer) globalThis.clearInterval(timer);
          return;
        }
      }
    } catch (error) {
      if (!closed) {
        onEvent({
          runId,
          type: "error",
          progress: 100,
          message: error instanceof Error ? error.message : "Cloud FEA event stream failed.",
          timestamp: new Date().toISOString()
        });
      }
      closed = true;
      if (timer) globalThis.clearInterval(timer);
    }
  };
  void poll();
  timer = globalThis.setInterval(() => void poll(), 750);
  return {
    close() {
      closed = true;
      if (timer) globalThis.clearInterval(timer);
    }
  } as EventSource;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      message = parsed.error ?? text;
    } catch {
      // Use the raw response body when the server did not return JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function fetchJsonWithFallback<T>(input: RequestInfo | URL, init: RequestInit, fallback: () => T | Promise<T>): Promise<T> {
  try {
    const response = await fetch(input, init);
    return await readJson<T>(response);
  } catch {
    return fallback();
  }
}

function meshSummaryForPreset(preset: MeshQuality, analysisMesh?: AnalysisMesh) {
  const sampleCount = analysisMesh?.samples.length;
  const summaryByPreset: Record<MeshQuality, NonNullable<Study["meshSettings"]["summary"]>> = {
    coarse: { nodes: 12840, elements: 7320, warnings: [], analysisSampleCount: sampleCount ?? 1200, quality: "coarse" as const },
    medium: { nodes: 42381, elements: 26944, warnings: ["Small feature curvature represented by surface analysis samples."], analysisSampleCount: sampleCount ?? 4800, quality: "medium" as const },
    fine: { nodes: 88420, elements: 57102, warnings: ["Fine surface analysis sampling enabled for higher-quality local results."], analysisSampleCount: sampleCount ?? 19200, quality: "fine" as const },
    ultra: { nodes: 182400, elements: 119808, warnings: ["Ultra surface analysis sampling enabled for detailed local gradients."], analysisSampleCount: sampleCount ?? 45000, quality: "ultra" as const }
  };
  return summaryByPreset[preset];
}

function simulationBackend(study: Study): "local_detailed" | "cloudflare_fea" | undefined {
  const backend = (study.solverSettings as { backend?: unknown }).backend;
  return backend === "cloudflare_fea" || backend === "local_detailed" ? backend : undefined;
}

function simulationFidelity(study: Study): "standard" | "detailed" | "ultra" {
  const fidelity = (study.solverSettings as { fidelity?: unknown }).fidelity;
  return fidelity === "detailed" || fidelity === "ultra" ? fidelity : "standard";
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
