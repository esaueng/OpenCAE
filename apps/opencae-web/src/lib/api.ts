import { solveStudy } from "@opencae/solver-service";
import type { DisplayModel, Project, ResultField, ResultSummary, RunEvent, Study, StudyRun } from "@opencae/schema";
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

export interface ResultsResponse {
  summary: ResultSummary;
  fields: ResultField[];
}

const localResultsByRunId = new Map<string, ResultsResponse>();
const localEventsByRunId = new Map<string, RunEvent[]>();

export async function loadSampleProject(sample: SampleModelId = "bracket"): Promise<SampleProjectResponse> {
  return fetchJsonWithFallback(
    "/api/sample-project/load",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample })
    },
    () => createLocalSampleProject(sample)
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

export async function renameProject(projectId: string, name: string): Promise<{ project: Project; message: string }> {
  const response = await fetch(`/api/projects/${projectId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  return readJson(response);
}

export async function generateMesh(studyId: string, preset: "coarse" | "medium" | "fine", currentStudy?: Study): Promise<{ study: Study; message: string }> {
  return fetchJsonWithFallback(
    `/api/studies/${studyId}/mesh`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset })
    },
    () => {
      if (!currentStudy) throw new Error("Could not generate mesh without an open study.");
      const summary = meshSummaryForPreset(preset);
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
      return { study: { ...currentStudy, ...patch }, message };
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

export async function runSimulation(studyId: string, currentStudy?: Study): Promise<{ run: { id: string }; streamUrl: string; message: string }> {
  try {
    const response = await fetch(`/api/studies/${studyId}/runs`, { method: "POST" });
    return await readJson(response);
  } catch (error) {
    if (!currentStudy) throw error;
    return runSimulationLocally(currentStudy);
  }
}

export async function getResults(runId: string): Promise<ResultsResponse> {
  const localResults = localResultsByRunId.get(runId);
  if (localResults) return localResults;
  const response = await fetch(`/api/runs/${runId}/results`);
  return readJson(response);
}

export async function getReportHtml(runId: string): Promise<string> {
  const response = await fetch(`/api/runs/${runId}/report`);
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
  return response.text();
}

export function subscribeToRun(runId: string, onEvent: (event: RunEvent) => void): EventSource {
  const localEvents = localEventsByRunId.get(runId);
  if (localEvents) return subscribeToLocalRun(localEvents, onEvent);
  const source = new EventSource(`/api/runs/${runId}/stream`);
  const eventTypes: RunEvent["type"][] = ["state", "progress", "message", "log", "diagnostic", "complete", "cancelled", "error"];
  for (const type of eventTypes) {
    source.addEventListener(type, (message) => onEvent(JSON.parse((message as MessageEvent).data) as RunEvent));
  }
  return source;
}

function runSimulationLocally(study: Study): { run: StudyRun; streamUrl: string; message: string } {
  const runId = `run-local-${crypto.randomUUID()}`;
  const solved = solveStudy(study, runId);
  localResultsByRunId.set(runId, { summary: solved.summary, fields: solved.fields });
  const now = new Date().toISOString();
  const events: RunEvent[] = [
    { runId, type: "state", progress: 0, message: "Simulation queued locally.", timestamp: now },
    { runId, type: "progress", progress: 10, message: "Local static solver started.", timestamp: now },
    { runId, type: "progress", progress: 46, message: "Assembling local stiffness response.", timestamp: now },
    { runId, type: "progress", progress: 88, message: "Writing local result fields.", timestamp: now },
    { runId, type: "complete", progress: 100, message: "Simulation complete.", timestamp: now }
  ];
  localEventsByRunId.set(runId, events);
  return {
    run: {
      id: runId,
      studyId: study.id,
      status: "queued",
      jobId: `job-${runId}`,
      meshRef: study.meshSettings.meshRef,
      solverBackend: "local-static-superposition",
      solverVersion: "0.1.0",
      startedAt: now,
      diagnostics: []
    },
    streamUrl: `local:${runId}`,
    message: "Simulation running locally."
  };
}

function subscribeToLocalRun(events: RunEvent[], onEvent: (event: RunEvent) => void): EventSource {
  let closed = false;
  const timers = events.map((event, index) => globalThis.setTimeout(() => {
    if (!closed) onEvent(event);
  }, index * 25));
  return {
    close() {
      closed = true;
      timers.forEach((timer) => globalThis.clearTimeout(timer));
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

function meshSummaryForPreset(preset: "coarse" | "medium" | "fine") {
  const summaryByPreset = {
    coarse: { nodes: 12840, elements: 7320, warnings: [] },
    medium: { nodes: 42381, elements: 26944, warnings: ["Small feature simplified for the mock mesh."] },
    fine: { nodes: 88420, elements: 57102, warnings: ["Fine preset is mocked; no native mesher was run."] }
  };
  return summaryByPreset[preset];
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
