import type { DisplayModel, Project, ResultField, ResultSummary, RunEvent, Study } from "@opencae/schema";
import type { LoadApplicationPoint, LoadDirection, LoadType, PayloadObjectSelection } from "../loadPreview";
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

export async function generateMesh(studyId: string, preset: "coarse" | "medium" | "fine"): Promise<{ study: Study; message: string }> {
  const response = await fetch(`/api/studies/${studyId}/mesh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset })
  });
  return readJson(response);
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

export async function addSupport(studyId: string, selectionRef?: string): Promise<{ study: Study; message: string }> {
  const response = await fetch(`/api/studies/${studyId}/supports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectionRef })
  });
  return readJson(response);
}

export async function updateStudy(studyId: string, patch: Partial<Study>, message = "Study updated."): Promise<{ study: Study; message: string }> {
  const response = await fetch(`/api/studies/${studyId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  const data = await readJson<{ study: Study }>(response);
  return { ...data, message };
}

export async function addLoad(studyId: string, type: LoadType, value: number, selectionRef: string, direction: LoadDirection, applicationPoint?: LoadApplicationPoint | null, payloadObject?: PayloadObjectSelection | null): Promise<{ study: Study; message: string }> {
  const response = await fetch(`/api/studies/${studyId}/loads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, value, selectionRef, direction, applicationPoint, payloadObject })
  });
  return readJson(response);
}

export async function runSimulation(studyId: string): Promise<{ run: { id: string }; streamUrl: string; message: string }> {
  const response = await fetch(`/api/studies/${studyId}/runs`, { method: "POST" });
  return readJson(response);
}

export async function getResults(runId: string): Promise<ResultsResponse> {
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
  const source = new EventSource(`/api/runs/${runId}/stream`);
  const eventTypes: RunEvent["type"][] = ["state", "progress", "message", "log", "diagnostic", "complete", "cancelled", "error"];
  for (const type of eventTypes) {
    source.addEventListener(type, (message) => onEvent(JSON.parse((message as MessageEvent).data) as RunEvent));
  }
  return source;
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

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
