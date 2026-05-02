import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseJsonc } from "../../../scripts/verify-cloudflare-config.mjs";

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

function readJsonc(path: string) {
  return parseJsonc(readFileSync(resolve(__dirname, path), "utf8"), path);
}

describe("Cloudflare FEA worker orchestration", () => {
  test("container Durable Object is declared as a Cloudflare container proxy", () => {
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(workerSource).toContain('import { Container } from "@cloudflare/containers";');
    expect(workerSource).toContain("export class OpenCaeFeaContainer extends Container");
    expect(workerSource).toContain("defaultPort = 8080");
    expect(workerSource).not.toContain("The CalculiX adapter endpoint is served by the container image.");
  });

  test("default Cloudflare deploy uses the container binding config", () => {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as { scripts: Record<string, string> };
    const containerConfig = readJsonc("../../../wrangler.containers.jsonc") as {
      name?: string;
      account_id?: string;
      workers_dev?: boolean;
      routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
      containers?: Array<{ class_name?: string; image?: string; image_build_context?: string }>;
      durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
      migrations?: Array<{ new_sqlite_classes?: string[] }>;
    };
    const defaultConfig = readJsonc("../../../wrangler.jsonc") as typeof containerConfig;
    const localFirstConfig = readJsonc("../../../wrangler.local-first.jsonc") as typeof containerConfig;

    expect(packageJson.scripts["deploy:cloudflare"]).toContain("--config wrangler.containers.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("pnpm verify:cloudflare-config");
    expect(packageJson.scripts["deploy:cloudflare:dry-run"]).toContain("--config wrangler.containers.jsonc");
    expect(packageJson.scripts["deploy:cloudflare:static"]).toContain("--config wrangler.jsonc");
    expect(packageJson.scripts["deploy:cloudflare:static:dry-run"]).toContain("--config wrangler.jsonc");
    expect(packageJson.scripts["containers:build"]).toContain("--config wrangler.containers.jsonc");
    expect(packageJson.scripts["containers:push"]).toContain("--config wrangler.containers.jsonc");
    expect(containerConfig.name).toBe("opencae");
    expect(containerConfig.account_id).toBe("747b74cbd7d019dd7aeecb2c24a4bf10");
    expect(containerConfig.workers_dev).toBe(false);
    expect(containerConfig.routes).toContainEqual({ pattern: "cae.esau.app", custom_domain: true });
    expect(defaultConfig.name).toBe("opencae-static");
    expect(defaultConfig.name).not.toBe(containerConfig.name);
    expect(localFirstConfig.name).toBe("opencae-local-first");
    expect(localFirstConfig.name).not.toBe(containerConfig.name);
    expect(defaultConfig.routes ?? []).not.toContainEqual({ pattern: "cae.esau.app", custom_domain: true });
    expect(localFirstConfig.routes ?? []).not.toContainEqual({ pattern: "cae.esau.app", custom_domain: true });
    expect(containerConfig.containers?.[0]).toMatchObject({
      class_name: "OpenCaeFeaContainer",
      image: "./services/opencae-fea-container/Dockerfile",
      image_build_context: "./services/opencae-fea-container"
    });
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

  test("reports Cloud FEA health when the container binding is absent", async () => {
    const bucket = new MemoryR2Bucket();
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send: vi.fn(async () => undefined) }
    };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/health"), env);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      mode: "cloudflare-worker",
      artifactsBound: true,
      queueBound: true,
      containerBound: false,
      containersEnabled: false,
      cloudFeaAvailable: false,
      requiredDeployConfig: "wrangler.containers.jsonc",
      deploymentHint: "The current Worker version has no FEA_CONTAINER binding. This usually means the app was deployed with wrangler.jsonc instead of wrangler.containers.jsonc, or Cloudflare Builds is still running plain wrangler deploy.",
      requestOrigin: "https://cae.example",
      cloudFeaEndpoint: "https://cae.example/api/cloud-fea/runs"
    });
  });

  test("reports Cloud FEA health when the container binding is present", async () => {
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: new MemoryR2Bucket(),
      FEA_RUN_QUEUE: { send: vi.fn(async () => undefined) },
      FEA_CONTAINER: { get: vi.fn() }
    };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/health"), env);
    const body = await response.json() as Record<string, unknown>;

    expect(body).toMatchObject({
      mode: "cloudflare-worker",
      artifactsBound: true,
      queueBound: true,
      containerBound: true,
      containersEnabled: true,
      cloudFeaAvailable: true,
      requestOrigin: "https://cae.example",
      cloudFeaEndpoint: "https://cae.example/api/cloud-fea/runs"
    });
    expect(body.deploymentHint).toBeUndefined();
  });

  test("dispatches cloud FEA runs with waitUntil even when queue binding exists", async () => {
    const bucket = new MemoryR2Bucket();
    const originalGet = bucket.get.bind(bucket);
    let blockBackgroundRequestRead = true;
    bucket.get = vi.fn(async (key: string) => {
      if (blockBackgroundRequestRead && key.endsWith("/request.json")) {
        blockBackgroundRequestRead = false;
        return await new Promise<null>(() => undefined);
      }
      return originalGet(key);
    });
    const send = vi.fn(async () => undefined);
    const pending: Array<Promise<unknown>> = [];
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send },
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(cloudContainerSolveResponse("run-waituntil-queued-binding", true)))
      }
    };
    const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)) };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({
        projectId: "project-1",
        studyId: "study-1",
        fidelity: "ultra",
        study: cloudStudyWithMaterial("mat-aluminum-6061", {}, "dynamic_structural"),
        displayModel: { id: "display-1", faces: [] },
        geometry: { format: "stl", filename: "cantilever.stl", contentBase64: "c29saWQKZW5kc29saWQK" },
        dynamicSettings: { startTime: 0, endTime: 0.5, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02 }
      })
    }), env, ctx);
    const body = await response.json() as { run: { id: string; status: string; solverBackend: string }; streamUrl: string };
    const stored = JSON.parse(await (await bucket.get(`runs/${body.run.id}/request.json`))!.text()) as Record<string, unknown>;
    const events = JSON.parse(await (await bucket.get(`runs/${body.run.id}/events.json`))!.text()) as Array<{ message: string }>;

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
      solverMaterial: {
        id: "mat-aluminum-6061",
        name: "Aluminum 6061",
        category: "metal",
        youngsModulusMpa: 68900,
        poissonRatio: 0.33,
        densityTonnePerMm3: 2.7e-9,
        yieldMpa: 276,
        original: {
          youngsModulus: 68900000000,
          densityKgM3: 2700,
          yieldStrength: 276000000
        }
      },
      displayModel: { id: "display-1" },
      geometry: { format: "stl", filename: "cantilever.stl" },
      dynamicSettings: { endTime: 0.5, timeStep: 0.005 }
    });
    expect(events[0]?.message).toContain("analysis=dynamic_structural");
    expect(events[0]?.message).toContain("fidelity=ultra");
    expect(events[0]?.message).toContain("material=Aluminum 6061 (mat-aluminum-6061)");
    expect(events[0]?.message).toContain("geometry=uploaded:stl:cantilever.stl");
    expect(events[0]?.message).toContain("dispatch=waitUntil");
    expect(events[0]?.message).not.toContain("queue=enabled");
    expect(events[0]?.message).toContain("container=bound");
    expect(send).not.toHaveBeenCalled();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(1);
  });

  test("stores PETG solver material in CalculiX units without print reductions when not printed", async () => {
    const bucket = new MemoryR2Bucket();
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send: vi.fn(async () => undefined) },
      FEA_CONTAINER: { get: vi.fn() }
    };

    const response = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({
        projectId: "project-1",
        studyId: "study-1",
        study: cloudStudyWithMaterial("mat-petg", { printed: false })
      })
    }), env);
    const body = await response.json() as { run: { id: string } };
    const stored = JSON.parse(await (await bucket.get(`runs/${body.run.id}/request.json`))!.text()) as { solverMaterial: Record<string, unknown> };

    expect(response.status).toBe(202);
    expect(stored.solverMaterial).toMatchObject({
      id: "mat-petg",
      name: "PETG",
      category: "plastic",
      youngsModulusMpa: 2100,
      poissonRatio: 0.38,
      densityTonnePerMm3: 1.27e-9,
      yieldMpa: 50
    });
  });

  test("stores printed PETG effective solver material from infill wall and layer settings", async () => {
    const bucket = new MemoryR2Bucket();
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_RUN_QUEUE: { send: vi.fn(async () => undefined) },
      FEA_CONTAINER: { get: vi.fn() }
    };

    const strong = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({
        projectId: "project-1",
        studyId: "study-strong",
        study: cloudStudyWithMaterial("mat-petg", { printed: true, infillDensity: 100, wallCount: 8, layerOrientation: "z" })
      })
    }), env);
    const weak = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs", {
      method: "POST",
      body: JSON.stringify({
        projectId: "project-1",
        studyId: "study-weak",
        study: cloudStudyWithMaterial("mat-petg", { printed: true, infillDensity: 20, wallCount: 1, layerOrientation: "x" })
      })
    }), env);
    const strongBody = await strong.json() as { run: { id: string } };
    const weakBody = await weak.json() as { run: { id: string } };
    const strongMaterial = (JSON.parse(await (await bucket.get(`runs/${strongBody.run.id}/request.json`))!.text()) as { solverMaterial: Record<string, number> }).solverMaterial;
    const weakMaterial = (JSON.parse(await (await bucket.get(`runs/${weakBody.run.id}/request.json`))!.text()) as { solverMaterial: Record<string, number> }).solverMaterial;

    expect(weak.status).toBe(202);
    expect(weakMaterial.youngsModulusMpa).toBeLessThan(strongMaterial.youngsModulusMpa);
    expect(weakMaterial.yieldMpa).toBeLessThan(strongMaterial.yieldMpa);
    expect(weakMaterial.densityTonnePerMm3).toBeLessThan(strongMaterial.densityTonnePerMm3);
  });

  test("rejects Cloud FEA requests without an assigned material", async () => {
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
      body: JSON.stringify({ projectId: "project-1", studyId: "study-1", study: { id: "study-1", type: "static_stress", materialAssignments: [] } })
    }), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(422);
    expect(body.error).toContain("Cloud FEA requires an assigned material");
    expect(send).not.toHaveBeenCalled();
    expect(bucket.objects.size).toBe(0);
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
      body: JSON.stringify({ projectId: "project-1", studyId: "study-1", fidelity: "detailed", study: cloudStudyWithMaterial("mat-aluminum-6061") })
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
      body: JSON.stringify({ projectId: "project-1", studyId: "study-1", fidelity: "ultra", study: cloudStudyWithMaterial("mat-aluminum-6061", {}, "dynamic_structural") })
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
    expect(await (await bucket.get("runs/run-cloud-1/solver-result-parser.txt"))!.text()).toBe("parsed-calculix-frd");
    expect(await bucket.get("runs/run-cloud-1/mesh.json")).not.toBeNull();
    expect(resultsResponse.status).toBe(200);
    expect(results.summary.maxStress).toBe(431400000);
    expect(results.summary.transient?.frameCount).toBe(2);
    expect(results.fields.some((field) => field.frameIndex === 1)).toBe(true);
    expect(results.fields.some((field) => field.frameIndex === 1 && field.timeSeconds === 0.005)).toBe(true);
    expect(results.fields[0]?.samples?.[0]?.source).toBe("calculix");
    expect(results.fields[0]?.samples?.[0]?.vonMisesStressPa).toBeGreaterThan(0);
  });

  test("queue handler preserves parsed structured block MPa and mm result units", async () => {
    const bucket = new MemoryR2Bucket();
    await bucket.put("runs/run-cloud-block/request.json", JSON.stringify({
      runId: "run-cloud-block",
      projectId: "project-1",
      studyId: "study-1",
      fidelity: "standard",
      study: { id: "study-1", type: "static_stress" }
    }));
    const message = { body: { runId: "run-cloud-block" }, ack: vi.fn(), retry: vi.fn() };
    const env = {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      FEA_ARTIFACTS: bucket,
      FEA_CONTAINER: {
        fetch: vi.fn(async () => Response.json(cloudParsedBlockSolveResponse("run-cloud-block")))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const results = JSON.parse(await (await bucket.get("runs/run-cloud-block/results.json"))!.text()) as {
      summary: { maxStress: number; maxStressUnits: string; maxDisplacement: number; maxDisplacementUnits: string; provenance: { resultSource: string } };
      fields: Array<{ type: string; location: string; units: string; samples?: Array<{ source?: string }> }>;
    };

    expect(results.summary).toMatchObject({
      maxStress: 0.18,
      maxStressUnits: "MPa",
      maxDisplacement: 0.0019,
      maxDisplacementUnits: "mm",
      provenance: { resultSource: "parsed_dat" }
    });
    expect(results.fields.find((field) => field.type === "stress")).toMatchObject({ location: "element", units: "MPa" });
    expect(results.fields.find((field) => field.type === "displacement")).toMatchObject({ location: "node", units: "mm" });
    expect(JSON.stringify(results)).not.toContain("generated-cantilever-fallback");
    expect(await (await bucket.get("runs/run-cloud-block/solver-result-parser.txt"))!.text()).toBe("parsed-calculix-dat");
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
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-do/events.json"))!.text()) as Array<{ message: string }>;

    expect(idFromName).toHaveBeenCalledWith("run-cloud-do");
    expect(get).toHaveBeenCalledWith("id:run-cloud-do");
    expect(startAndWaitForPorts).not.toHaveBeenCalled();
    expect(events.some((event) => event.message === "Generating CalculiX static input deck.")).toBe(true);
    expect(events.some((event) => event.message === "Generating CalculiX transient input deck.")).toBe(false);
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
        fetch: vi.fn(async () => Response.json({
          error: "Meshing failed: STL is not watertight.",
          artifacts: {
            inputDeck: "*HEADING\nfailed deck\n",
            solverLog: "solver failed before results",
            solverResultParser: "missing-results",
            meshSummary: { nodes: 2, elements: 0, source: "structured_block" }
          }
        }, { status: 422 }))
      }
    };

    await worker.queue({ messages: [message] }, env);
    const events = JSON.parse(await (await bucket.get("runs/run-cloud-fail/events.json"))!.text()) as Array<{ type: string; message: string }>;
    const resultsResponse = await worker.fetch(new Request("https://cae.example/api/cloud-fea/runs/run-cloud-fail/results"), env);

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.message).toContain("Meshing failed: STL is not watertight.");
    expect(events.at(-1)?.message).toContain("container HTTP 422");
    expect(events.at(-1)?.message).toContain("parser=missing-results");
    expect(events.at(-1)?.message).toContain("artifacts=inputDeck, solverLog, solverResultParser, meshSummary");
    expect(await (await bucket.get("runs/run-cloud-fail/input.inp"))!.text()).toContain("failed deck");
    expect(await (await bucket.get("runs/run-cloud-fail/solver.log"))!.text()).toContain("solver failed");
    expect(await (await bucket.get("runs/run-cloud-fail/mesh.json"))!.text()).toContain("structured_block");
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
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "Cloud FEA queue consumer does not have FEA_CONTAINER. Queue dispatch is disabled for Cloud FEA; rerun the simulation."
    });
    expect(JSON.parse(await (await bucket.get("runs/run-cloud-no-container/failed.json"))!.text()) as { error: string }).toMatchObject({
      error: "Cloud FEA queue consumer does not have FEA_CONTAINER. Queue dispatch is disabled for Cloud FEA; rerun the simulation."
    });
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

  test("container runner refuses incomplete uploaded-geometry payloads before meshing", () => {
    const staticResult = runContainerSolve({ runId: "run-static", solverMaterial: aluminumSolverMaterial(), geometry: { format: "stl", filename: "beam.stl", contentBase64: closedStlBase64() } });
    const dynamicResult = runContainerSolve({
      runId: "run-dynamic",
      solverMaterial: aluminumSolverMaterial(),
      analysisType: "dynamic_structural",
      dynamicSettings: { startTime: 0, endTime: 0.01, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02 },
      geometry: { format: "stl", filename: "beam.stl", contentBase64: closedStlBase64() }
    });

    expect(staticResult).toMatchObject({ status: 422 });
    expect(staticResult.error).toContain("requires a force load");
    expect(dynamicResult).toMatchObject({ status: 422 });
    expect(dynamicResult.error).toContain("static stress studies only");
  });

  test("container runner rejects uploaded geometry without gmsh instead of using block fallback", () => {
    const result = runContainerSolve(uploadedGeometryContainerPayload("run-uploaded-no-gmsh"));

    expect(result).toMatchObject({ status: 503 });
    expect(result.error).toContain("Gmsh executable unavailable");
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

function cloudParsedBlockSolveResponse(runId: string) {
  const provenance = {
    kind: "calculix_fea",
    solver: "calculix-ccx",
    solverVersion: "2.21",
    meshSource: "structured_block",
    resultSource: "parsed_dat",
    units: "mm-N-s-MPa"
  };
  return {
    summary: {
      maxStress: 0.18,
      maxStressUnits: "MPa",
      maxDisplacement: 0.0019,
      maxDisplacementUnits: "mm",
      safetyFactor: 1533.3,
      reactionForce: 1,
      reactionForceUnits: "N",
      provenance
    },
    fields: [
      {
        id: `field-${runId}-stress-0`,
        runId,
        type: "stress",
        location: "element",
        values: [0.12, 0.18],
        min: 0.12,
        max: 0.18,
        units: "MPa",
        provenance,
        samples: [{ point: [50, 15, 5], normal: [0, 0, 1], value: 0.18, elementId: "E1", source: "calculix-dat", vonMisesStressPa: 180000 }]
      },
      {
        id: `field-${runId}-displacement-0`,
        runId,
        type: "displacement",
        location: "node",
        values: [0, 0.0019],
        min: 0,
        max: 0.0019,
        units: "mm",
        provenance,
        samples: [{ point: [100, 15, 10], normal: [0, 0, 1], value: 0.0019, vector: [0, 0, -0.0019], nodeId: "N2", source: "calculix-dat" }]
      },
      {
        id: `field-${runId}-safety_factor-0`,
        runId,
        type: "safety_factor",
        location: "element",
        values: [1533.3],
        min: 1533.3,
        max: 1533.3,
        units: "",
        provenance,
        samples: [{ point: [50, 15, 5], normal: [0, 0, 1], value: 1533.3, elementId: "E1", source: "calculix-dat" }]
      }
    ],
    artifacts: {
      inputDeck: "*STATIC\n*NODE PRINT, NSET=NALL\nU\n*EL PRINT, ELSET=SOLID\nS\n",
      solverLog: "CalculiX completed structured block solve.",
      solverResultParser: "parsed-calculix-dat",
      meshSummary: { nodes: 735, elements: 480, source: "structured_block" }
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

function aluminumSolverMaterial() {
  return {
    id: "mat-aluminum-6061",
    name: "Aluminum 6061",
    category: "metal",
    youngsModulusMpa: 68900,
    poissonRatio: 0.33,
    densityTonnePerMm3: 2.7e-9,
    yieldMpa: 276
  };
}

function uploadedGeometryContainerPayload(runId: string) {
  return {
    runId,
    solverMaterial: aluminumSolverMaterial(),
    displayModel: {
      id: "display-uploaded",
      bodyCount: 1,
      dimensions: { x: 100, y: 30, z: 10, units: "mm" },
      faces: [
        { id: "face-fixed", label: "Fixed", color: "#666", center: [0, 15, 5], normal: [-1, 0, 0], stressValue: 0 },
        { id: "face-load", label: "Load", color: "#666", center: [100, 15, 5], normal: [1, 0, 0], stressValue: 0 }
      ]
    },
    study: {
      id: "study-uploaded",
      type: "static_stress",
      namedSelections: [
        { id: "fixed-selection", name: "Fixed", entityType: "face", geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-fixed", label: "Fixed" }], fingerprint: "fixed" },
        { id: "load-selection", name: "Load", entityType: "face", geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load", label: "Load" }], fingerprint: "load" }
      ],
      constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "fixed-selection", parameters: {}, status: "complete" }],
      loads: [{ id: "load-end", type: "force", selectionRef: "load-selection", parameters: { value: 1, direction: [0, 0, -1] }, status: "complete" }],
      solverSettings: {}
    },
    geometry: { format: "stl", filename: "beam.stl", contentBase64: closedStlBase64() }
  };
}

function cloudStudyWithMaterial(materialId: string, parameters: Record<string, unknown> = {}, type: "static_stress" | "dynamic_structural" = "static_stress") {
  return {
    id: "study-1",
    projectId: "project-1",
    name: "Cloud Study",
    type,
    geometryScope: [],
    materialAssignments: [{
      id: "assign-1",
      materialId,
      selectionRef: "selection-body",
      parameters,
      status: "complete"
    }],
    namedSelections: [],
    contacts: [],
    constraints: [],
    loads: [],
    meshSettings: { preset: "ultra", status: "complete" },
    solverSettings: type === "dynamic_structural"
      ? { startTime: 0, endTime: 0.5, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0.02, integrationMethod: "newmark_average_acceleration" }
      : {},
    validation: [],
    runs: []
  };
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
