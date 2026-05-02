import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class Container {} }));

import worker, { looksLikePlaceholderResult } from "./index";

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
  test("container Durable Object is declared as a Cloudflare container proxy", () => {
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(workerSource).toContain('import { Container } from "@cloudflare/containers";');
    expect(workerSource).toContain("export class OpenCaeFeaContainer extends Container");
    expect(workerSource).toContain("defaultPort = 8080");
    expect(workerSource).not.toContain("The CalculiX adapter endpoint is served by the container image.");
  });

  test("default Cloudflare deploy avoids privileged container rollouts", () => {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as { scripts: Record<string, string> };
    const containerConfig = JSON.parse(readFileSync(resolve(__dirname, "../../../wrangler.containers.jsonc"), "utf8")) as {
      name?: string;
      containers?: Array<{ class_name?: string; image?: string }>;
      durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
      migrations?: Array<{ new_sqlite_classes?: string[] }>;
    };
    const defaultConfig = JSON.parse(readFileSync(resolve(__dirname, "../../../wrangler.jsonc"), "utf8")) as typeof containerConfig;

    expect(packageJson.scripts["deploy:cloudflare"]).toContain("--config wrangler.jsonc");
    expect(packageJson.scripts["deploy:cloudflare:dry-run"]).toContain("--config wrangler.jsonc");
    expect(containerConfig.name).toBe("opencae");
    expect(containerConfig.containers?.[0]).toMatchObject({ class_name: "OpenCaeFeaContainer", image: "opencae/opencae-fea:latest" });
    expect(containerConfig.durable_objects?.bindings).toContainEqual({ name: "FEA_CONTAINER", class_name: "OpenCaeFeaContainer" });
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects?.bindings ?? []).not.toContainEqual({ name: "FEA_CONTAINER", class_name: "OpenCaeFeaContainer" });
    expect(defaultConfig.migrations?.some((migration) => migration.new_sqlite_classes?.includes("OpenCaeFeaContainer")) ?? false).toBe(false);
  });

  test("rejects new cloud FEA runs when the container binding is absent", async () => {
    const bucket = new MemoryR2Bucket();
    const send = vi.fn(async () => undefined);
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send }
    };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({ projectId: "project-1", studyId: "study-1", fidelity: "ultra", study: { id: "study-1", type: "dynamic_structural" } })
    }), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toContain("Cloud FEA containers are not enabled");
    expect(send).not.toHaveBeenCalled();
    expect(bucket.objects.size).toBe(0);
  });

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

  test("uses waitUntil background solve when deployed without queue binding", async () => {
    const bucket = new MemoryR2Bucket();
    const pending: Array<Promise<unknown>> = [];
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(cloudContainerSolveResponse("run-background-1", true)))
      }
    };
    const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)) };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({ projectId: "project-1", studyId: "study-1", fidelity: "ultra", study: { id: "study-1", type: "dynamic_structural" } })
    }), env, ctx);
    const body = await response.json() as { run: { id: string } };

    expect(response.status).toBe(202);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(await bucket.get(`runs/${body.run.id}/results.json`)).toBeNull();

    await Promise.all(pending);
    const results = JSON.parse(await (await bucket.get(`runs/${body.run.id}/results.json`))!.text()) as { summary: { transient?: { frameCount: number } } };
    expect(results.summary.transient?.frameCount).toBe(2);
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
    const results = await resultsResponse.json() as { summary: { maxStress: number; transient?: { frameCount: number } }; fields: Array<{ frameIndex?: number; timeSeconds?: number; samples?: Array<{ source?: string; vonMisesStressPa?: number }> }> };

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
    expect(results.fields.some((field) => field.frameIndex === 1 && field.timeSeconds === 0.005)).toBe(true);
    expect(results.fields[0]?.samples?.[0]?.source).toBe("calculix");
    expect(results.fields[0]?.samples?.[0]?.vonMisesStressPa).toBeGreaterThan(0);
  });

  test("queue handler resolves standard Durable Object namespace container bindings by name", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-do/request.json", JSON.stringify({
      runId: "run-cloud-do",
      projectId: "project-1",
      studyId: "study-1",
      fidelity: "ultra",
      study: { id: "study-1", type: "static_stress" }
    }));
    const message = { body: { runId: "run-cloud-do" }, ack: vi.fn(), retry: vi.fn() };
    const idFromName = vi.fn((name: string) => `id:${name}`);
    const startAndWaitForPorts = vi.fn(async () => {
      throw new Error("RPC startAndWaitForPorts should not be invoked on Durable Object stubs.");
    });
    const get = vi.fn((id: string) => ({
      startAndWaitForPorts,
      fetch: vi.fn(async () => Response.json(cloudContainerSolveResponse("run-cloud-do", false)))
    }));
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: { idFromName, get }
    };

    await worker.queue({ messages: [message] }, env);
    const results = JSON.parse(await (await bucket.get("runs/run-cloud-do/results.json"))!.text()) as { summary: { maxStress: number } };

    expect(idFromName).toHaveBeenCalledWith("run-cloud-do");
    expect(get).toHaveBeenCalledWith("id:run-cloud-do");
    expect(startAndWaitForPorts).not.toHaveBeenCalled();
    expect(results.summary.maxStress).toBe(431400000);
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

  test("queue handler records missing container binding as a run failure without results", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-no-container/request.json", JSON.stringify({
      runId: "run-cloud-no-container",
      studyId: "study-1",
      geometry: { format: "stl", filename: "cantilever.stl", contentBase64: closedStlBase64() }
    }));
    const message = { body: { runId: "run-cloud-no-container" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-no-container/events.json"))!.text()) as Array<{ type: string; message: string }>;

    expect(message.ack).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Cloud FEA container binding is not configured." });
    expect(await bucket.get("runs/run-cloud-no-container/results.json")).toBeNull();
  });

  test("queue handler reports container-disabled Durable Object deployments without results", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-container-disabled/request.json", JSON.stringify({
      runId: "run-cloud-container-disabled",
      studyId: "study-1",
      analysisType: "dynamic_structural",
      study: { id: "study-1", type: "dynamic_structural" },
      geometry: { format: "stl", filename: "cantilever.stl", contentBase64: closedStlBase64() }
    }));
    const message = { body: { runId: "run-cloud-container-disabled" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => {
          throw new Error("Containers have not been enabled for this Durable Object class. Have you correctly setup your Wrangler config?");
        })
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-container-disabled/events.json"))!.text()) as Array<{ type: string; message: string }>;
    const failed = JSON.parse(await (await bucket.get("runs/run-cloud-container-disabled/failed.json"))!.text()) as { error: string };

    expect(message.ack).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.at(-1)?.message).toContain("Cloud FEA containers are not enabled");
    expect(events.at(-1)?.message).toContain("pnpm deploy:cloudflare:containers");
    expect(failed.error).toBe(events.at(-1)?.message);
    expect(await bucket.get("runs/run-cloud-container-disabled/results.json")).toBeNull();
  });

  test("queue handler rejects placeholder cloud FEA results instead of publishing fake capacity", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-placeholder/request.json", JSON.stringify({
      runId: "run-cloud-placeholder",
      studyId: "study-1",
      geometry: { format: "stl", filename: "cantilever.stl", contentBase64: closedStlBase64() }
    }));
    const message = { body: { runId: "run-cloud-placeholder" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(cloudPlaceholderSolveResponse("run-cloud-placeholder")))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-placeholder/events.json"))!.text()) as Array<{ type: string; message: string }>;

    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.message).toBe("Cloud FEA returned generated fallback data instead of parsed CalculiX results; refusing to publish fake solver results.");
    expect(await bucket.get("runs/run-cloud-placeholder/results.json")).toBeNull();
  });

  test("looksLikePlaceholderResult rejects generated cantilever fallback provenance", () => {
    expect(looksLikePlaceholderResult(
      { maxStress: 431400000, safetyFactor: 0.64 },
      [{ samples: [{ source: "generated-cantilever-fallback" }] }],
      {}
    )).toBe(true);
  });

  test("queue handler rejects generated fallback Cloud FEA results instead of publishing fake solver fields", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-generated-fallback/request.json", JSON.stringify({
      runId: "run-cloud-generated-fallback",
      studyId: "study-1",
      geometry: { format: "stl", filename: "cantilever.stl", contentBase64: closedStlBase64() }
    }));
    const message = { body: { runId: "run-cloud-generated-fallback" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(cloudGeneratedFallbackSolveResponse("run-cloud-generated-fallback")))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-generated-fallback/events.json"))!.text()) as Array<{ type: string; message: string }>;

    expect(message.ack).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "Cloud FEA returned generated fallback data instead of parsed CalculiX results; refusing to publish fake solver results."
    });
    expect(await bucket.get("runs/run-cloud-generated-fallback/results.json")).toBeNull();
  });

  test("queue handler rejects Cloud FEA results without calculix_fea provenance", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-local-provenance/request.json", JSON.stringify({
      runId: "run-cloud-local-provenance",
      studyId: "study-1"
    }));
    const message = { body: { runId: "run-cloud-local-provenance" }, ack: vi.fn(), retry: vi.fn() };
    const result = cloudContainerSolveResponse("run-cloud-local-provenance", false);
    result.summary.provenance = { ...result.summary.provenance, kind: "local_estimate" };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(result))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-local-provenance/events.json"))!.text()) as Array<{ type: string; message: string }>;

    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "Cloud FEA result provenance must identify parsed CalculiX FEA results."
    });
    expect(await bucket.get("runs/run-cloud-local-provenance/results.json")).toBeNull();
  });

  test("queue handler rejects Cloud FEA results with generated provenance result source", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-generated-provenance/request.json", JSON.stringify({
      runId: "run-cloud-generated-provenance",
      studyId: "study-1"
    }));
    const message = { body: { runId: "run-cloud-generated-provenance" }, ack: vi.fn(), retry: vi.fn() };
    const result = cloudContainerSolveResponse("run-cloud-generated-provenance", false);
    result.summary.provenance = { ...result.summary.provenance, resultSource: "generated" };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(result))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-generated-provenance/events.json"))!.text()) as Array<{ type: string; message: string }>;

    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "Cloud FEA returned generated fallback data instead of parsed CalculiX results; refusing to publish fake solver results."
    });
    expect(await bucket.get("runs/run-cloud-generated-provenance/results.json")).toBeNull();
  });

  test("queue handler rejects dynamic cloud FEA results without transient summary", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-dynamic-static/request.json", JSON.stringify({
      runId: "run-cloud-dynamic-static",
      studyId: "study-1",
      analysisType: "dynamic_structural",
      study: { id: "study-1", type: "dynamic_structural" },
      dynamicSettings: { startTime: 0, endTime: 0.01, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02 },
      geometry: { format: "stl", filename: "cantilever.stl", contentBase64: closedStlBase64() }
    }));
    const message = { body: { runId: "run-cloud-dynamic-static" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(cloudContainerSolveResponse("run-cloud-dynamic-static", false)))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-dynamic-static/events.json"))!.text()) as Array<{ type: string; message: string }>;

    expect(message.ack).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.at(-1)?.message).toContain("animation frames");
    expect(await bucket.get("runs/run-cloud-dynamic-static/results.json")).toBeNull();
    expect(JSON.parse(await (await bucket.get("runs/run-cloud-dynamic-static/failed.json"))!.text()) as { error: string }).toMatchObject({
      error: expect.stringContaining("animation frames")
    });
  });

  test("queue handler rejects dynamic cloud FEA results without multiple timed frame fields", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-dynamic-unframed/request.json", JSON.stringify({
      runId: "run-cloud-dynamic-unframed",
      studyId: "study-1",
      analysisType: "dynamic_structural",
      study: { id: "study-1", type: "dynamic_structural" },
      dynamicSettings: { startTime: 0, endTime: 0.01, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02 },
      geometry: { format: "stl", filename: "cantilever.stl", contentBase64: closedStlBase64() }
    }));
    const message = { body: { runId: "run-cloud-dynamic-unframed" }, ack: vi.fn(), retry: vi.fn() };
    const badDynamicResult = cloudContainerSolveResponse("run-cloud-dynamic-unframed", true);
    badDynamicResult.fields = badDynamicResult.fields.map(({ frameIndex, time, ...field }) => field);
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(badDynamicResult))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-dynamic-unframed/events.json"))!.text()) as Array<{ type: string; message: string }>;

    expect(message.ack).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.at(-1)?.message).toContain("animation frames");
    expect(await bucket.get("runs/run-cloud-dynamic-unframed/results.json")).toBeNull();
  });

  test("container runner refuses unparsed CalculiX output by default", () => {
    const staticResult = runContainerSolve({ runId: "run-static", geometry: { format: "stl", filename: "beam.stl", contentBase64: closedStlBase64() } });
    const dynamicResult = runContainerSolve({
      runId: "run-dynamic",
      analysisType: "dynamic_structural",
      dynamicSettings: { startTime: 0, endTime: 0.01, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02 },
      geometry: { format: "stl", filename: "beam.stl", contentBase64: closedStlBase64() }
    });

    expect(staticResult).toMatchObject({ status: 422 });
    expect(staticResult.error).toContain("CalculiX output was not parsed");
    expect(dynamicResult).toMatchObject({ status: 422 });
    expect(dynamicResult.error).toContain("CalculiX output was not parsed");
  });

  test("container runner rejects invalid open surface geometry", () => {
    const result = runContainerSolve({ runId: "run-invalid", geometry: { format: "stl", filename: "open.stl", contentBase64: btoa("solid\nendsolid\n") } });

    expect(result.error).toContain("not watertight");
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
      provenance: {
        kind: "calculix_fea",
        solver: "calculix-ccx",
        solverVersion: "2.21",
        meshSource: "gmsh",
        resultSource: "parsed_frd",
        units: "mm-N-s-MPa"
      },
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
        provenance: {
          kind: "calculix_fea",
          solver: "calculix-ccx",
          solverVersion: "2.21",
          meshSource: "gmsh",
          resultSource: "parsed_frd",
          units: "mm-N-s-MPa"
        },
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
        provenance: {
          kind: "calculix_fea",
          solver: "calculix-ccx",
          solverVersion: "2.21",
          meshSource: "gmsh",
          resultSource: "parsed_frd",
          units: "mm-N-s-MPa"
        },
        ...(dynamic ? { frameIndex: 1, time: 0.005 } : {}),
        samples: [{ point: [1, 0, 0], value: 431400000, nodeId: "N2", elementId: "E1", source: "calculix", vonMisesStressPa: 431400000 }]
      }
    ],
    artifacts: {
      inputDeck: "*DYNAMIC\n*NODE FILE\nU\n*EL FILE\nS\n",
      solverLog: "CalculiX completed transient run.",
      solverResultParser: "parsed-calculix-frd",
      meshSummary: { nodes: 2, elements: 1 }
    }
  };
}

function cloudPlaceholderSolveResponse(runId: string) {
  return {
    summary: {
      maxStress: 1440000,
      maxStressUnits: "Pa",
      maxDisplacement: 0.0038,
      maxDisplacementUnits: "m",
      safetyFactor: 172,
      reactionForce: 500,
      reactionForceUnits: "N"
    },
    fields: [
      {
        id: `field-${runId}-placeholder`,
        runId,
        type: "stress",
        location: "node",
        values: [1440000],
        min: 120000,
        max: 1440000,
        units: "Pa",
        samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 1440000, source: "cloudflare_fea_placeholder", vonMisesStressPa: 1440000 }]
      }
    ],
    artifacts: {
      inputDeck: "*STATIC\n",
      solverLog: "placeholder",
      solverResultParser: "parsed-calculix-frd",
      meshSummary: { nodes: 1, elements: 1 }
    }
  };
}

function cloudGeneratedFallbackSolveResponse(runId: string) {
  return {
    resultSource: "generated_fallback",
    summary: {
      maxStress: 431400000,
      maxStressUnits: "Pa",
      maxDisplacement: 0.000761,
      maxDisplacementUnits: "m",
      safetyFactor: 0.64,
      reactionForce: 500,
      reactionForceUnits: "N",
      failureAssessment: {
        status: "fail",
        title: "CalculiX transient solve",
        message: "Cloud FEA generated fallback-for-run fields."
      }
    },
    fields: [
      {
        id: `field-${runId}-stress-0`,
        runId,
        type: "stress",
        location: "node",
        values: [431400000],
        min: 0,
        max: 431400000,
        units: "Pa",
        samples: [{ point: [0, 0, 0], value: 431400000, source: "generated-cantilever-fallback", vonMisesStressPa: 431400000 }]
      }
    ],
    diagnostics: [{ id: "cloud-fea-generated-fallback", severity: "warning" }],
    artifacts: {
      inputDeck: "*STATIC\n",
      solverLog: "cloud-fea-hard-coded-fallback",
      solverResultParser: `generated-fallback-for-${runId}`,
      meshSummary: { nodes: 1, elements: 1 }
    }
  };
}

function runContainerSolve(payload: Record<string, unknown>) {
  const source = [
    "import json, sys",
    "sys.path.insert(0, 'services/opencae-fea-container')",
    "import runner",
    "payload = json.loads(sys.stdin.read())",
    "try:",
    "    print(json.dumps(runner.solve(payload)))",
    "except runner.UserFacingSolveError as error:",
    "    print(json.dumps({'error': str(error), 'status': error.status}))"
  ].join("\n");
  const output = execFileSync("python3", ["-c", source], {
    cwd: resolve(__dirname, "../../.."),
    input: JSON.stringify(payload),
    encoding: "utf8"
  });
  return JSON.parse(output);
}

function closedStlBase64() {
  return btoa([
    "solid tetra",
    "facet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet",
    "facet normal 0 1 0 outer loop vertex 0 0 0 vertex 0 0 1 vertex 1 0 0 endloop endfacet",
    "facet normal 1 0 0 outer loop vertex 0 0 0 vertex 0 1 0 vertex 0 0 1 endloop endfacet",
    "facet normal 1 1 1 outer loop vertex 1 0 0 vertex 0 0 1 vertex 0 1 0 endloop endfacet",
    "endsolid tetra"
  ].join("\n"));
}
