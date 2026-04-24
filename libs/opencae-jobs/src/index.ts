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

export class LocalRunStateProvider implements RunStateProvider {
  private readonly events = new Map<string, RunEvent[]>();
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  publish(runId: string, event: RunEvent): void {
    const list = this.events.get(runId) ?? [];
    list.push(event);
    this.events.set(runId, list);
    for (const listener of this.listeners.get(runId) ?? []) {
      listener(event);
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

  async enqueue(jobId: string, worker: () => Promise<void>): Promise<void> {
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
    } catch {
      this.statuses.set(jobId, "failed");
    }
  }
}
