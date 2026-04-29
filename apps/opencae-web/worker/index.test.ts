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
      body: JSON.stringify({
        projectId: "project-1",
        studyId: "study-1",
        fidelity: "ultra",
        study: { id: "study-1", type: "dynamic_structural" },
        displayModel: { id: "display-1", faces: [] },
        geometry: { format: "stl", filename: "cantilever.stl", contentBase64: "c29saWQKZW5kc29saWQK" },
        dynamicSettings: { startTime: 0, endTime: 0.5, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02 }
      })
    }), env);
    const body = await response.json() as { run: { id: string; status: string; solverBackend: string }; streamUrl: string };
    const stored = JSON.parse(await (await bucket.get(`runs/${body.run.id}/request.json`))!.text()) as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(body.run.status).toBe("queued");
    expect(body.run.solverBackend).toBe("cloudflare-fea-calculix");
    expect(body.streamUrl).toBe(`/api/cloud-fea/runs/${body.run.id}/events`);
    expect(stored).toMatchObject({
      projectId: "project-1",
      studyId: "study-1",
      fidelity: "ultra",
      solver: "calculix",
      analysisType: "dynamic_structural",
      study: { id: "study-1", type: "dynamic_structural" },
      displayModel: { id: "display-1" },
      geometry: { format: "stl", filename: "cantilever.stl" },
      dynamicSettings: { endTime: 0.5, timeStep: 0.005 }
    });
    expect(send).toHaveBeenCalledWith({ runId: body.run.id });
  });

  test("runs cloud FEA inline when queue binding is not provisioned", async () => {
    const bucket = new MemoryR2Bucket();
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(cloudContainerSolveResponse("run-inline-1", false)))
      }
    };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({ projectId: "project-1", studyId: "study-1", fidelity: "detailed" })
    }), env);
    const body = await response.json() as { run: { id: string }; streamUrl: string };
    const events = JSON.parse(await (await bucket.get(`runs/${body.run.id}/events.json`))!.text()) as Array<{ type: string }>;
    const results = JSON.parse(await (await bucket.get(`runs/${body.run.id}/results.json`))!.text()) as { summary: { maxStress: number } };

    expect(response.status).toBe(202);
    expect(body.streamUrl).toBe(`/api/cloud-fea/runs/${body.run.id}/events`);
    expect(events.at(-1)?.type).toBe("complete");
    expect(results.summary.maxStress).toBe(431400000);
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

  test("queue handler calls the container and writes CalculiX artifacts", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-1/request.json", JSON.stringify({
      runId: "run-cloud-1",
      projectId: "project-1",
      studyId: "study-1",
      fidelity: "ultra",
      study: { id: "study-1", type: "dynamic_structural" },
      dynamicSettings: { startTime: 0, endTime: 0.5, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02 }
    }));
    const message = { body: { runId: "run-cloud-1" }, ack: vi.fn(), retry: vi.fn() };
    const containerFetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/solve");
      const payload = await request.json() as Record<string, unknown>;
      expect(payload).toMatchObject({ runId: "run-cloud-1", studyId: "study-1" });
      return Response.json(cloudContainerSolveResponse("run-cloud-1", true));
    });
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send: vi.fn() },
      FEA_CONTAINER: { fetch: containerFetch }
    };

    await worker.queue({ messages: [message] }, env);
    const resultsResponse = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs/run-cloud-1/results"), env);
    const results = await resultsResponse.json() as { summary: { maxStress: number; transient?: { frameCount: number } }; fields: Array<{ frameIndex?: number; samples?: Array<{ source?: string; vonMisesStressPa?: number }> }> };

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(containerFetch).toHaveBeenCalled();
    expect(JSON.parse(await (await bucket.get("runs/run-cloud-1/events.json"))!.text()).at(-1).type).toBe("complete");
    expect(await (await bucket.get("runs/run-cloud-1/input.inp"))!.text()).toContain("*DYNAMIC");
    expect(await (await bucket.get("runs/run-cloud-1/solver.log"))!.text()).toContain("CalculiX");
    expect(await bucket.get("runs/run-cloud-1/mesh.json")).not.toBeNull();
    expect(resultsResponse.status).toBe(200);
    expect(results.summary.maxStress).toBe(431400000);
    expect(results.summary.transient?.frameCount).toBe(2);
    expect(results.fields.some((field) => field.frameIndex === 1)).toBe(true);
    expect(results.fields[0]?.samples?.[0]?.source).toBe("calculix");
    expect(results.fields[0]?.samples?.[0]?.vonMisesStressPa).toBeGreaterThan(0);
  });

  test("queue handler records failed container diagnostics without fake results", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-fail/request.json", JSON.stringify({
      runId: "run-cloud-fail",
      studyId: "study-1",
      geometry: { format: "stl", filename: "open-shell.stl", contentBase64: "c29saWQKZW5kc29saWQK" }
    }));
    const message = { body: { runId: "run-cloud-fail" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json({ error: "Meshing failed: STL is not watertight." }, { status: 422 }))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-fail/events.json"))!.text()) as Array<{ type: string; message: string }>;
    const resultsResponse = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs/run-cloud-fail/results"), env);

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Meshing failed: STL is not watertight." });
    expect(await bucket.get("runs/run-cloud-fail/results.json")).toBeNull();
    expect(resultsResponse.status).toBe(404);
  });
});

function cloudContainerSolveResponse(runId: string, dynamic: boolean) {
  return {
    summary: {
      maxStress: 431400000,
      maxStressUnits: "Pa",
      maxDisplacement: 0.000761,
      maxDisplacementUnits: "m",
      safetyFactor: 0.64,
      reactionForce: 500,
      reactionForceUnits: "N",
      ...(dynamic ? { transient: { startTime: 0, endTime: 0.005, timeStep: 0.005, outputInterval: 0.005, frameCount: 2 } } : {})
    },
    fields: [
      {
        id: `field-${runId}-stress-0`,
        runId,
        type: "stress",
        location: "node",
        values: [120000, 240000],
        min: 120000,
        max: 431400000,
        units: "Pa",
        ...(dynamic ? { frameIndex: 0, time: 0 } : {}),
        samples: [{ point: [0, 0, 0], value: 120000, nodeId: "N1", elementId: "E1", source: "calculix", vonMisesStressPa: 120000 }]
      },
      {
        id: `field-${runId}-stress-1`,
        runId,
        type: "stress",
        location: "node",
        values: [431400000],
        min: 120000,
        max: 431400000,
        units: "Pa",
        ...(dynamic ? { frameIndex: 1, time: 0.005 } : {}),
        samples: [{ point: [1, 0, 0], value: 431400000, nodeId: "N2", elementId: "E1", source: "calculix", vonMisesStressPa: 431400000 }]
      }
    ],
    artifacts: {
      inputDeck: "*DYNAMIC\n*NODE FILE\nU\n*EL FILE\nS\n",
      solverLog: "CalculiX completed transient run.",
      meshSummary: { nodes: 2, elements: 1 }
    }
  };
}
