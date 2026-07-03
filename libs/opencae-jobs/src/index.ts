import type { RunEvent } from "@opencae/schema";

export type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

export interface JobQueueProvider {
  enqueue(jobId: string, worker: () => Promise<void>): Promise<void>;
  cancel(jobId: string): Promise<void>;
  getStatus(jobId: string): JobStatus | undefined;
}

export interface RunStateProvider {
  publish(runId: string, event: RunEvent): void;
  getEvents(runId: string): RunEvent[];
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void;
}

const MAX_TRACKED_RUNS = 200;

export class LocalRunStateProvider implements RunStateProvider {
  private readonly events = new Map<string, RunEvent[]>();
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  publish(runId: string, event: RunEvent): void {
    const list = this.events.get(runId) ?? [];
    list.push(event);
    this.events.delete(runId);
    this.events.set(runId, list);
    this.evictOldestRuns();
    for (const listener of this.listeners.get(runId) ?? []) {
      listener(event);
    }
  }

  private evictOldestRuns(): void {
    while (this.events.size > MAX_TRACKED_RUNS) {
      const oldestRunId = this.events.keys().next().value;
      if (oldestRunId === undefined) return;
      const hasListeners = (this.listeners.get(oldestRunId)?.size ?? 0) > 0;
      if (hasListeners) return;
      this.events.delete(oldestRunId);
      this.listeners.delete(oldestRunId);
    }
  }

  getEvents(runId: string): RunEvent[] {
    return this.events.get(runId) ?? [];
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set<(event: RunEvent) => void>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
    };
  }
}

export class InMemoryJobQueueProvider implements JobQueueProvider {
  private readonly statuses = new Map<string, JobStatus>();
  private readonly onError: ((jobId: string, error: unknown) => void) | undefined;

  constructor(options?: { onError?: (jobId: string, error: unknown) => void }) {
    this.onError = options?.onError;
  }

  async enqueue(jobId: string, worker: () => Promise<void>): Promise<void> {
    if (this.statuses.get(jobId) === "cancelled") return;
    this.statuses.set(jobId, "queued");
    void this.run(jobId, worker);
  }

  async cancel(jobId: string): Promise<void> {
    this.statuses.set(jobId, "cancelled");
  }

  getStatus(jobId: string): JobStatus | undefined {
    return this.statuses.get(jobId);
  }

  private async run(jobId: string, worker: () => Promise<void>): Promise<void> {
    if (this.statuses.get(jobId) === "cancelled") return;
    this.statuses.set(jobId, "running");
    try {
      await worker();
      if (this.statuses.get(jobId) !== "cancelled") {
        this.statuses.set(jobId, "complete");
      }
    } catch (error) {
      this.statuses.set(jobId, "failed");
      if (this.onError) {
        this.onError(jobId, error);
      } else {
        console.error(`Job ${jobId} failed:`, error);
      }
    }
  }
}
