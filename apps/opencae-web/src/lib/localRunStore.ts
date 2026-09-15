import type { RunEvent } from "@opencae/schema";
import type { StudyRun } from "@opencae/schema";

/**
 * In-memory local run store: run records, capped bookkeeping, and the
 * EventSource-like replay adapter for in-browser solves. Extracted from
 * lib/api.ts (which re-exports this module's public surface) so run-bus
 * changes do not touch project CRUD, mesh orchestration, or scheduling.
 */

export type LocalRunStatus = "running" | "complete" | "failed" | "cancelled";

export interface LocalRunRecord {
  runId: string;
  status: LocalRunStatus;
  /** Replay buffer for late subscribers (bounded). */
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  startedAtMs: number;
  lastProgress: number;
  cancelSolve?: () => void;
}

export const LOCAL_RUN_EVENT_BUFFER_LIMIT = 200;

function setCappedRunEntry<T>(cache: Map<string, T>, runId: string, value: T, limit: number): void {
  cache.delete(runId);
  cache.set(runId, value);
  while (cache.size > limit) {
    const oldestRunId = cache.keys().next().value as string | undefined;
    if (oldestRunId === undefined) return;
    cache.delete(oldestRunId);
  }
}

export function createLocalRunStore(limit = 4): {
  records: Map<string, LocalRunRecord>;
  createRecord: (runId: string, status?: LocalRunStatus) => LocalRunRecord;
  activeRun: () => LocalRunRecord | undefined;
} {
  const records = new Map<string, LocalRunRecord>();
  return {
    records,
    createRecord(runId: string, status: LocalRunStatus = "running"): LocalRunRecord {
      const record: LocalRunRecord = {
        runId,
        status,
        events: [],
        listeners: new Set(),
        startedAtMs: Date.now(),
        lastProgress: 0
      };
      setCappedRunEntry(records, runId, record, limit);
      return record;
    },
    activeRun(): LocalRunRecord | undefined {
      for (const record of records.values()) {
        if (record.status === "running") return record;
      }
      return undefined;
    }
  };
}

export function emitLocalRunEvent(
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
export function finishLocalRun(
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
 * EventSource-like adapter over a local run record: replays the buffered
 * events asynchronously (matching EventSource delivery semantics), then
 * streams live solver-driven events until closed.
 */
export function subscribeToLocalRunRecord(record: LocalRunRecord, onEvent: (event: RunEvent) => void): EventSource {
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

export function syntheticRunErrorEvent(runId: string, message: string): RunEvent {
  return { runId, type: "error", progress: 100, message, timestamp: new Date().toISOString() };
}

export type { StudyRun };
