import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseJsonc } from "../../../scripts/verify-cloudflare-config.mjs";

const containerMock = vi.hoisted(() => ({
  fetch: vi.fn(),
  requestedNames: [] as string[]
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: (_binding: unknown, name?: string) => {
    containerMock.requestedNames.push(name ?? "");
    return { fetch: containerMock.fetch };
  }
}));

const { default: worker } = await import("./index");

function readJsonc(path: string) {
  return parseJsonc(readFileSync(resolve(__dirname, path), "utf8"), path);
}

describe("Cloudflare local-first worker", () => {
  beforeEach(() => {
    containerMock.fetch.mockReset();
    containerMock.requestedNames.length = 0;
  });

  test("exports the OpenCAE Core Cloud container class without the legacy FEA container", () => {
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(workerSource).toContain("@cloudflare/containers");
    expect(workerSource).toContain("OpenCaeCoreCloudContainer");
    expect(workerSource).not.toContain("OpenCaeFeaContainer");
    expect(workerSource).not.toContain("FEA_CONTAINER");
  });

  test("default Cloudflare deploy uses the local-first production config", () => {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: Record<string, string> };
    const defaultConfig = readJsonc("../../../wrangler.jsonc") as {
      name?: string;
      routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
      containers?: unknown;
      durable_objects?: unknown;
      migrations?: unknown;
    };

    expect(packageJson.scripts["deploy:cloudflare"]).toContain("--config wrangler.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("--containers-rollout");
    expect(packageJson.scripts["deploy:cloudflare:containers"]).toContain("--config wrangler.containers.jsonc");
    expect(packageJson.scripts["containers:build"]).toContain("services/opencae-core-cloud");
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeDefined();
    expect(defaultConfig.name).toBe("opencae");
    expect(defaultConfig.routes).toEqual([{ pattern: "cae.esau.app", custom_domain: true }]);
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects).toBeUndefined();
    expect(defaultConfig.migrations).toEqual([{ tag: "v2-delete-cloud-fea-container", deleted_classes: ["OpenCaeFeaContainer"] }]);
  });

  test("container config wires OpenCAE Core Cloud instead of CalculiX FEA", () => {
    const containerConfig = readJsonc("../../../wrangler.containers.jsonc") as {
      routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
      containers?: Array<{ name?: string; class_name?: string; image?: string }>;
      durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
      migrations?: unknown;
    };
    const serialized = JSON.stringify(containerConfig).toLowerCase();

    expect(serialized).not.toContain("calculix");
    expect(serialized).not.toContain("opencaefeacontainer");
    expect(serialized).not.toContain("fea_container");
    expect(containerConfig.routes).toEqual([{ pattern: "cae.esau.app", custom_domain: true }]);
    expect(containerConfig.containers).toEqual([
      expect.objectContaining({
        name: "opencae-core-cloud",
        class_name: "OpenCaeCoreCloudContainer",
        image: "./services/opencae-core-cloud/Dockerfile"
      })
    ]);
    expect(containerConfig.durable_objects?.bindings).toEqual([
      { name: "CORE_CLOUD_CONTAINER", class_name: "OpenCaeCoreCloudContainer" }
    ]);
    expect((containerConfig as { r2_buckets?: Array<{ binding?: string }> }).r2_buckets).toEqual([
      expect.objectContaining({ binding: "CORE_CLOUD_ARTIFACTS" })
    ]);
    expect(containerConfig.migrations).toEqual([
      { tag: "v3-opencae-core-cloud-container", new_sqlite_classes: ["OpenCaeCoreCloudContainer"] }
    ]);
  });

  test("health advertises browser OpenCAE Core runtime", async () => {
    const response = await worker.fetch(new Request("https://cae.esau.app/health"), {
      ASSETS: { fetch: async () => new Response("asset") }
    } as Env);

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      solverRuntime: "browser-opencae-core"
    });
  });

  test("health reports Core Cloud availability and no CalculiX/local fallback flags", async () => {
    containerMock.fetch.mockResolvedValueOnce(Response.json({
      ok: true,
      service: "opencae-core-cloud",
      runnerVersion: "0.1.0",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"]
    }));

    const response = await worker.fetch(new Request("https://cae.esau.app/api/cloud-core/health"), createEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "cloudflare-worker",
      service: "opencae-web",
      coreCloudAvailable: true,
      containerBound: true,
      containerRunnerVersion: "0.1.0",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      solver: "opencae-core-cloud",
      noCalculix: true,
      noLocalEstimateFallback: true
    });
  });

  test("api routes explain OpenCAE Core Cloud handling when container resources are unbound", async () => {
    const response = await worker.fetch(new Request("https://cae.esau.app/api/cloud-fea/runs"), {
      ASSETS: { fetch: async () => new Response("asset") }
    } as Env);

    await expect(response.json()).resolves.toMatchObject({
      solver: "opencae-core-cloud",
      label: "OpenCAE Core Cloud"
    });
    expect(response.status).toBe(503);
  });

  test("cloud core health and legacy cloud fea aliases identify OpenCAE Core Cloud when unbound", async () => {
    const env = { ASSETS: { fetch: async () => new Response("asset") } } as Env;
    const health = await worker.fetch(new Request("https://cae.esau.app/api/cloud-core/health"), env);
    const runs = await worker.fetch(new Request("https://cae.esau.app/api/cloud-core/runs"), env);
    const legacy = await worker.fetch(new Request("https://cae.esau.app/api/cloud-fea/runs/run-1/results"), env);

    await expect(health.json()).resolves.toMatchObject({ ok: false, solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
    await expect(runs.json()).resolves.toMatchObject({ solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
    await expect(legacy.json()).resolves.toMatchObject({ solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
  });

  test("run creation stores artifacts and calls only the Core Cloud container", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const result = coreResult();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.1.0", supportedAnalysisTypes: ["static_stress"] }))
      .mockResolvedValueOnce(Response.json(result));

    const response = await worker.fetch(coreRunRequest({ runId: "run-core-1" }), env, ctx);
    const body = await response.json() as { run: { id: string }; streamUrl: string };
    await ctx.flush();

    expect(response.status).toBe(202);
    expect(body.run.id).toBe("run-core-1");
    expect(body.streamUrl).toBe("/api/cloud-core/runs/run-core-1/events");
    expect(containerMock.requestedNames).toEqual(["opencae-core-cloud", "opencae-core-cloud"]);
    expect(containerMock.fetch).toHaveBeenCalledTimes(2);
    expect(String(containerMock.fetch.mock.calls[1]?.[0].url)).toBe("https://container.local/solve");
    expect(await env.CORE_CLOUD_ARTIFACTS.readJson("cloud-core/runs/run-core-1/request.json")).toMatchObject({ runId: "run-core-1" });
    expect(await env.CORE_CLOUD_ARTIFACTS.readJson("cloud-core/runs/run-core-1/results.json")).toMatchObject({
      provenance: { solver: "opencae-core-cloud", kind: "opencae_core_fea" }
    });
    expect(await env.CORE_CLOUD_ARTIFACTS.readJson("cloud-core/runs/run-core-1/events.json")).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "complete", message: "OpenCAE Core Cloud solve complete." })])
    );
  });

  test("legacy cloud-fea run alias is only a Core Cloud alias", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.1.0", supportedAnalysisTypes: ["static_stress"] }))
      .mockResolvedValueOnce(Response.json(coreResult()));

    const response = await worker.fetch(coreRunRequest({ runId: "run-alias", path: "/api/cloud-fea/runs" }), env, ctx);
    await ctx.flush();

    await expect(response.json()).resolves.toMatchObject({
      run: { id: "run-alias", solverBackend: "opencae-core-cloud" },
      message: "OpenCAE Core Cloud simulation queued."
    });
    expect(String(containerMock.fetch.mock.calls[1]?.[0].url)).toBe("https://container.local/solve");
  });

  test("stale Core Cloud runner is rejected without a local fallback", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch.mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.0.1" }));

    const response = await worker.fetch(coreRunRequest({ runId: "run-stale" }), env, ctx);
    await ctx.flush();

    expect(response.status).toBe(202);
    const events = await env.CORE_CLOUD_ARTIFACTS.readJson("cloud-core/runs/run-stale/events.json");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", message: expect.stringContaining("runner version") })
    ]));
    expect(await env.CORE_CLOUD_ARTIFACTS.get("cloud-core/runs/run-stale/results.json")).toBeNull();
    expect(containerMock.fetch).toHaveBeenCalledTimes(1);
  });

  test("dynamic Core Cloud result with frame metadata is accepted", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.1.0" }))
      .mockResolvedValueOnce(Response.json(coreResult({
        summary: { transient: { analysisType: "dynamic_structural", frameCount: 2, startTime: 0, endTime: 0.01, timeStep: 0.01, outputInterval: 0.01, peakDisplacement: 0.001, peakDisplacementTimeSeconds: 0.01 } },
        fields: [
          { id: "disp-0", type: "displacement", location: "node", values: [0], min: 0, max: 0, units: "m", frameIndex: 0, timeSeconds: 0 },
          { id: "disp-1", type: "displacement", location: "node", values: [0.001], min: 0, max: 0.001, units: "m", frameIndex: 1, timeSeconds: 0.01 }
        ]
      })));

    await worker.fetch(coreRunRequest({ runId: "run-dynamic", analysisType: "dynamic_structural" }), env, ctx);
    await ctx.flush();

    await expect(env.CORE_CLOUD_ARTIFACTS.readJson("cloud-core/runs/run-dynamic/results.json")).resolves.toMatchObject({
      summary: { transient: { frameCount: 2 } }
    });
  });

  test("CalculiX and preview provenance are rejected", async () => {
    const calculixEnv = createEnv();
    const calculixCtx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.1.0" }))
      .mockResolvedValueOnce(Response.json(coreResult({ provenance: { solver: "calculix", kind: "opencae_core_fea", resultSource: "computed" } })));

    await worker.fetch(coreRunRequest({ runId: "run-calculix" }), calculixEnv, calculixCtx);
    await calculixCtx.flush();

    const calculixEvents = await calculixEnv.CORE_CLOUD_ARTIFACTS.readJson("cloud-core/runs/run-calculix/events.json");
    expect(calculixEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", message: expect.stringContaining("CalculiX") })
    ]));

    containerMock.fetch.mockReset();
    const previewEnv = createEnv();
    const previewCtx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.1.0" }))
      .mockResolvedValueOnce(Response.json(coreResult({ provenance: { solver: "opencae-core-cloud", kind: "local_estimate", resultSource: "computed_preview" } })));

    await worker.fetch(coreRunRequest({ runId: "run-preview" }), previewEnv, previewCtx);
    await previewCtx.flush();

    const previewEvents = await previewEnv.CORE_CLOUD_ARTIFACTS.readJson("cloud-core/runs/run-preview/events.json");
    expect(previewEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", message: expect.stringContaining("preview") })
    ]));
  });

  test("includes an inert queue handler for stale legacy Workers Builds consumers", async () => {
    const queueHandler = (worker as ExportedHandler<Env>).queue;

    expect(typeof queueHandler).toBe("function");
    await expect(queueHandler?.({ messages: [] } as unknown as MessageBatch<unknown>, {} as Env, {} as ExecutionContext)).resolves.toBeUndefined();
  });
});

function coreRunRequest(options: { runId: string; path?: string; analysisType?: string }) {
  return new Request(`https://cae.esau.app${options.path ?? "/api/cloud-core/runs"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: options.runId,
      analysisType: options.analysisType ?? "static_stress",
      coreModel: {
        schema: "opencae.model",
        schemaVersion: "0.2.0",
        loads: [{ name: "tipLoad", type: "nodalForce", vector: [0, 0, -100] }]
      },
      solverSettings: { backend: "opencae_core_cloud" }
    })
  });
}

function coreResult(overrides: { summary?: Record<string, unknown>; fields?: Array<Record<string, unknown>>; provenance?: Record<string, unknown>; diagnostics?: Array<Record<string, unknown>> } = {}) {
  return {
    summary: {
      maxStress: 123,
      maxDisplacement: 0.002,
      safetyFactor: 2.1,
      reactionForce: 100,
      ...overrides.summary
    },
    fields: overrides.fields ?? [
      { id: "stress", type: "stress", location: "element", values: [123], min: 123, max: 123, units: "Pa" },
      { id: "disp", type: "displacement", location: "node", values: [0.002], min: 0, max: 0.002, units: "m" }
    ],
    surfaceMesh: { id: "surface", nodes: [[0, 0, 0]], triangles: [], coordinateSpace: "solver", source: "opencae_core_volume_mesh" },
    diagnostics: overrides.diagnostics ?? [],
    provenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "actual_volume_mesh",
      units: "m-N-s-Pa",
      ...overrides.provenance
    }
  };
}

function createEnv() {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    CORE_CLOUD_CONTAINER: {
      idFromName: (name: string) => ({ name }),
      get: (id: unknown) => ({ id })
    },
    CORE_CLOUD_ARTIFACTS: createR2Bucket()
  } as unknown as Env & { CORE_CLOUD_ARTIFACTS: ReturnType<typeof createR2Bucket> };
}

function createR2Bucket() {
  const objects = new Map<string, string>();
  return {
    async put(key: string, value: string) {
      objects.set(key, value);
      return {} as R2Object;
    },
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        text: async () => value,
        json: async () => JSON.parse(value)
      } as R2ObjectBody;
    },
    async readJson(key: string) {
      const object = await this.get(key);
      if (!object) throw new Error(`Missing R2 object ${key}`);
      return object.json();
    }
  };
}

function createExecutionContext() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      promises.push(promise);
    },
    passThroughOnException: () => undefined,
    props: {},
    async flush() {
      await Promise.all(promises);
    }
  } as unknown as ExecutionContext & { flush: () => Promise<void> };
}
