import type { DisplayModel, Project, ResultField, ResultSummary, RunEvent, Study } from "@opencae/schema";
import type { LoadDirection, LoadType } from "../loadPreview";

export interface SampleProjectResponse {
  message?: string;
  project: Project;
  displayModel: DisplayModel;
}

export type SampleModelId = "bracket" | "plate" | "cantilever";

export interface ResultsResponse {
  summary: ResultSummary;
  fields: ResultField[];
}

export async function loadSampleProject(sample: SampleModelId = "bracket"): Promise<SampleProjectResponse> {
  const response = await fetch("/api/sample-project/load", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sample })
  });
  return readJson(response);
}

export async function createProject(): Promise<SampleProjectResponse> {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "blank" })
  });
  return readJson(response);
}

export async function importLocalProject(file: File): Promise<SampleProjectResponse> {
  const text = await file.text();
  const payload = JSON.parse(text) as unknown;
  const response = await fetch("/api/projects/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
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

export async function assignMaterial(studyId: string, materialId: string): Promise<{ study: Study; message: string }> {
  const response = await fetch(`/api/studies/${studyId}/materials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ materialId })
  });
  return readJson(response);
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

export async function addLoad(studyId: string, type: LoadType, value: number, selectionRef: string, direction: LoadDirection): Promise<{ study: Study; message: string }> {
  const response = await fetch(`/api/studies/${studyId}/loads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, value, selectionRef, direction })
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
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}
