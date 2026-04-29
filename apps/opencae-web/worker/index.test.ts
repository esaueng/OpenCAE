import { describe, expect, test, vi } from "vitest";
import worker from "./index";

class MemoryR2Bucket {
  objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : { async text() { return value; } };
  }
}

describe("Cloudflare FEA worker orchestration", () => {
  test("queues cloud FEA runs and stores run artifacts in R2", async () => {
    const bucket = new MemoryR2Bucket();
    const send = vi.fn(async () => undefined);
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send },
      FEA_CONTAINER: { get: vi.fn() }
    };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({ projectId: "project-1", studyId: "study-1", fidelity: "ultra" })
    }), env);
    const body = await response.json() as { run: { id: string; status: string; solverBackend: string }; streamUrl: string };
    const stored = JSON.parse(await (await bucket.get(`runs/${body.run.id}/request.json`))!.text()) as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(body.run.status).toBe("queued");
    expect(body.run.solverBackend).toBe("cloudflare-fea-calculix");
    expect(body.streamUrl).toBe(`/api/cloud-fea/runs/${body.run.id}/events`);
    expect(stored).toMatchObject({ projectId: "project-1", studyId: "study-1", fidelity: "ultra" });
    expect(send).toHaveBeenCalledWith({ runId: body.run.id });
  });

  test("returns stored cloud FEA run events", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-1/events.json", JSON.stringify([{ type: "complete", message: "Simulation complete." }]));
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send: vi.fn() },
      FEA_CONTAINER: { get: vi.fn() }
    };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs/run-1/events"), env);
    const body = await response.json() as { events: Array<{ type: string; message: string }> };

    expect(response.status).toBe(200);
    expect(body.events).toEqual([{ type: "complete", message: "Simulation complete." }]);
  });

  test("queue handler writes cloud FEA events and results artifacts", async () => {
    const bucket = new MemoryR2Bucket();
    const message = { body: { runId: "run-cloud-1" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send: vi.fn() },
      FEA_CONTAINER: { get: vi.fn() }
    };

    await worker.queue({ messages: [message] }, env);
    const resultsResponse = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs/run-cloud-1/results"), env);
    const results = await resultsResponse.json() as { summary: { maxStress: number }; fields: Array<{ samples?: Array<{ source?: string }> }> };

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(JSON.parse(await (await bucket.get("runs/run-cloud-1/events.json"))!.text()).at(-1).type).toBe("complete");
    expect(resultsResponse.status).toBe(200);
    expect(results.summary.maxStress).toBe(1440000);
    expect(results.fields[0]?.samples?.[0]?.source).toBe("cloudflare_fea_placeholder");
  });
});
