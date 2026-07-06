import type { DisplayModel, Study } from "@opencae/schema";
import type { SolveProgressEvent } from "@opencae/solve-pipeline";
import type { LocalSolveResult } from "./performanceProtocol";

/**
 * Message protocol for the dedicated solve worker (solveWorker.ts). Mirrors the
 * performanceProtocol conventions (id-correlated request/response envelopes),
 * plus interim progress messages and a cooperative cancel request.
 *
 * The solve worker is separate from the shared performance worker on purpose:
 * cancelling a solve may terminate the worker outright, which must never kill
 * unrelated STL decode or playback preparation work.
 */

export type SolveWorkerSolvePayload = {
  runId: string;
  study: Study;
  displayModel?: DisplayModel;
  debugResults?: boolean;
};

export type SolveWorkerRequest =
  | { kind: "solve"; id: string; payload: SolveWorkerSolvePayload }
  | { kind: "cancel"; id: string };

export type SolveWorkerProgressMessage = {
  kind: "progress";
  id: string;
  event: SolveProgressEvent;
};

export type SolveWorkerErrorShape = {
  name: string;
  message: string;
  /** Machine-readable failure code (e.g. "cancelled", "max-dofs-exceeded"). */
  code?: string;
};

export type SolveWorkerResultMessage =
  | { kind: "result"; id: string; ok: true; solverBackend: string; result: LocalSolveResult }
  | { kind: "result"; id: string; ok: false; error: SolveWorkerErrorShape };

export type SolveWorkerResponse = SolveWorkerProgressMessage | SolveWorkerResultMessage;

let solveRequestCounter = 0;

export function createSolveWorkerRequestId(): string {
  solveRequestCounter += 1;
  const uniquePart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${solveRequestCounter.toString(36)}`;
  return `solve-${uniquePart}`;
}

export function isSolveWorkerProgress(value: unknown): value is SolveWorkerProgressMessage {
  return isRecord(value) && value.kind === "progress" && typeof value.id === "string" && isRecord(value.event);
}

export function isSolveWorkerResult(value: unknown): value is SolveWorkerResultMessage {
  if (!isRecord(value) || value.kind !== "result" || typeof value.id !== "string") return false;
  if (value.ok === true) return isRecord(value.result);
  return value.ok === false && isRecord(value.error) && typeof (value.error as { message?: unknown }).message === "string";
}

export function normalizeSolveWorkerError(error: unknown, code?: string): SolveWorkerErrorShape {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Solve worker operation failed.",
      ...(code ? { code } : {})
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : "Solve worker operation failed.",
    ...(code ? { code } : {})
  };
}

/**
 * Big numeric buffers can move instead of copy. Cloud-contract results carry
 * plain JSON arrays today, so this usually returns []; if a future solver hands
 * back typed-array fields they transfer for free.
 */
export function transferablesForSolveResult(result: LocalSolveResult): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const field of result.fields ?? []) {
    const values = (field as { values?: unknown }).values;
    if (values instanceof Float64Array || values instanceof Float32Array) buffers.add(values.buffer as ArrayBuffer);
  }
  return [...buffers];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
