import type { DisplayModel, ResultField, ResultSummary, RunEvent, Study } from "@opencae/schema";

export interface SolveWorkerResult {
  summary: ResultSummary;
  fields: ResultField[];
  artifacts?: {
    meshConnectivity?: { connectedComponents: number };
    meshStatistics?: { nodes: number; elements: number };
  };
}

export interface SolveWorkerRequest {
  id: string;
  runId: string;
  study: Study;
  displayModel?: DisplayModel;
}

export type SolveWorkerResponse =
  | { id: string; type: "event"; event: RunEvent }
  | { id: string; type: "result"; result: SolveWorkerResult }
  | { id: string; type: "error"; message: string };

export function makeSolveRunEvent(
  runId: string,
  type: RunEvent["type"],
  progress: number,
  message: string,
  startedAt: number
): RunEvent {
  return {
    runId,
    type,
    progress,
    message,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    timestamp: new Date().toISOString()
  };
}
