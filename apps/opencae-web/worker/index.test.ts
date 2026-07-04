import { existsSync, readFileSync } from "node:fs";
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

function dispatchWorker(request: Request, env: Env, ctx: ExecutionContext = createExecutionContext()): Promise<Response> {
  return worker.fetch(request, env, ctx);
}
const expectedRunnerVersion = "0.1.6";
const expectedContainerInstanceName = `opencae-core-cloud-${expectedRunnerVersion}`;
const expectedContainerApplicationName = "opencae-core-cloud-0.1.1";

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

  test("default Cloudflare deploy uses the Core Cloud production config", () => {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: Record<string, string> };
    const defaultConfig = readJsonc("../../../wrangler.jsonc") as {
      name?: string;
      routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
      containers?: Array<{ name?: string; class_name?: string; image?: string }>;
      durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
      migrations?: unknown;
    };

    expect(packageJson.scripts["deploy:cloudflare"]).toContain("--config wrangler.containers.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("--containers-rollout=immediate");
    expect(packageJson.scripts["deploy:core-cloud"]).toContain("--config wrangler.containers.jsonc");
    expect(packageJson.scripts["containers:build:core-cloud"]).toContain("services/opencae-core-cloud");
    expect(packageJson.scripts["test:core-cloud-container"]).toBe("pnpm --filter @opencae/core-cloud test");
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeDefined();
    expect(defaultConfig.name).toBe("opencae");
    expect(defaultConfig.routes).toEqual([{ pattern: "cae.esau.app", custom_domain: true }]);
    expect(defaultConfig.containers).toEqual([
      expect.objectContaining({
        name: expectedContainerApplicationName,
        class_name: "OpenCaeCoreCloudContainer",
        image: "./services/opencae-core-cloud/Dockerfile"
      })
    ]);
    expect(defaultConfig.durable_objects?.bindings).toEqual([
      { name: "CORE_CLOUD_CONTAINER", class_name: "OpenCaeCoreCloudContainer" }
    ]);
    expect(defaultConfig.migrations).toEqual([
      { tag: "v3-opencae-core-cloud-container", new_sqlite_classes: ["OpenCaeCoreCloudContainer"] }
    ]);
  });

  test("container config wires OpenCAE Core Cloud instead of legacy FEA", () => {
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
        name: expectedContainerApplicationName,
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

  test("Core Cloud runner version is file backed and used in container instance names", () => {
    const versionPath = resolve(__dirname, "../../../services/opencae-core-cloud/RUNNER_VERSION");
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(existsSync(versionPath)).toBe(true);
    expect(readFileSync(versionPath, "utf8").trim()).toBe(expectedRunnerVersion);
    expect(workerSource).toContain(`EXPECTED_CORE_CLOUD_RUNNER_VERSION = "${expectedRunnerVersion}"`);
    expect(workerSource).toContain("coreCloudContainerInstanceName");
  });

  test("health advertises browser OpenCAE Core runtime", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/health"), {
      ASSETS: { fetch: async () => new Response("asset") }
    } as unknown as Env);

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      solverRuntime: "browser-opencae-core"
    });
  });

  test("asset responses include browser security headers", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/"), {
      ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) }
    } as unknown as Env);

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  test("static asset _headers ships the same security headers the worker applies", async () => {
    const headersFile = readFileSync(resolve(__dirname, "../public/_headers"), "utf8");
    const response = await dispatchWorker(new Request("https://cae.esau.app/"), {
      ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) }
    } as unknown as Env);

    const workerCsp = response.headers.get("content-security-policy");
    expect(workerCsp).toBeTruthy();
    expect(headersFile).toContain(`Content-Security-Policy: ${workerCsp}`);
    expect(headersFile).toContain("X-Content-Type-Options: nosniff");
    expect(headersFile).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(headersFile).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()");
  });

  test("health reports Core Cloud availability and no legacy/local fallback flags", async () => {
    containerMock.fetch.mockResolvedValueOnce(Response.json({
      ok: true,
      service: "opencae-core-cloud",
      runnerVersion: expectedRunnerVersion,
      coreVersion: "0.1.5",
      solverCpuVersion: "0.1.5",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolverMethods: ["sparse_static", "mdof_dynamic"]
    }));

    const response = await dispatchWorker(new Request("https://cae.esau.app/api/cloud-core/health"), createEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "cloudflare-worker",
      service: "opencae-web",
      coreCloudAvailable: true,
      containerBound: true,
      containerRunnerVersion: expectedRunnerVersion,
      coreVersion: "0.1.5",
      solverCpuVersion: "0.1.5",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolverMethods: ["sparse_static", "mdof_dynamic"],
      solver: "opencae-core-cloud",
      noCalculix: true,
      noLocalEstimateFallback: true
    });
  });

  test("api routes explain OpenCAE Core Cloud handling when container resources are unbound", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/api/cloud-fea/runs"), {
      ASSETS: { fetch: async () => new Response("asset") }
    } as unknown as Env);

    await expect(response.json()).resolves.toMatchObject({
      solver: "opencae-core-cloud",
      label: "OpenCAE Core Cloud"
    });
    expect(response.status).toBe(503);
  });

  test("cloud core health and legacy cloud fea aliases identify OpenCAE Core Cloud when unbound", async () => {
    const env = { ASSETS: { fetch: async () => new Response("asset") } } as unknown as Env;
    const health = await dispatchWorker(new Request("https://cae.esau.app/api/cloud-core/health"), env);
    const runs = await dispatchWorker(new Request("https://cae.esau.app/api/cloud-core/runs"), env);
    const legacy = await dispatchWorker(new Request("https://cae.esau.app/api/cloud-fea/runs/run-1/results"), env);

    await expect(health.json()).resolves.toMatchObject({ ok: false, solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
    await expect(runs.json()).resolves.toMatchObject({ solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
    await expect(legacy.json()).resolves.toMatchObject({ solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
  });

  test("run creation stores artifacts and calls only the Core Cloud container", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const result = coreResult();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion, supportedAnalysisTypes: ["static_stress"] }))
      .mockResolvedValueOnce(Response.json(result));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-core-1" }), env, ctx);
    const body = await response.json() as { run: { id: string }; streamUrl: string; startUrl: string };
    await ctx.flush();

    expect(response.status).toBe(202);
    expect(body.run.id).toMatch(/^run-cloud-core-/);
    expect(body.run.id).not.toBe("run-core-1");
    expect(body.streamUrl).toMatch(new RegExp(`/api/cloud-core/runs/${body.run.id}/events\\?token=.+`));
    expect(body.startUrl).toMatch(new RegExp(`/api/cloud-core/runs/${body.run.id}/start\\?token=.+`));
    expect(containerMock.fetch).not.toHaveBeenCalled();
    const unauthenticatedStart = await startCoreRun(env, body.run.id);
    expect(unauthenticatedStart.status).toBe(403);
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(startResponse.status).toBe(200);
    expect(containerMock.requestedNames).toEqual([expectedContainerInstanceName, expectedContainerInstanceName]);
    expect(containerMock.fetch).toHaveBeenCalledTimes(2);
    expect(String(containerMock.fetch.mock.calls[1]?.[0].url)).toBe("https://container.local/solve");
    expect(await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/request.json`)).toMatchObject({ runId: body.run.id });
    expect(await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/results.json`)).toMatchObject({
      provenance: { solver: "opencae-core-cloud", kind: "opencae_core_fea" }
    });
    expect(await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/events.json`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "complete", message: "OpenCAE Core Cloud solve complete." })])
    );
  });

  test("cloud run artifacts require the per-run token", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    const response = await dispatchWorker(coreRunRequest({ runId: "run-token-test" }), env, ctx);
    const body = await response.json() as { run: { id: string }; streamUrl: string };
    await ctx.flush();

    const eventsWithoutToken = await dispatchWorker(new Request(`https://cae.esau.app/api/cloud-core/runs/${body.run.id}/events`), env);
    const resultsWithoutToken = await dispatchWorker(new Request(`https://cae.esau.app/api/cloud-core/runs/${body.run.id}/results`), env);
    const eventsWithToken = await dispatchWorker(new Request(`https://cae.esau.app${body.streamUrl}`), env);

    expect(eventsWithoutToken.status).toBe(403);
    expect(resultsWithoutToken.status).toBe(403);
    expect(eventsWithToken.status).toBe(200);
  });

  test("duplicate start requests do not dispatch a second container solve", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const result = coreResult();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion }))
      .mockResolvedValueOnce(Response.json(result));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-dup-start" }), env, ctx);
    const body = await response.json() as { run: { id: string }; startUrl: string };
    await ctx.flush();

    const firstStart = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(firstStart.status).toBe(200);
    expect(containerMock.fetch).toHaveBeenCalledTimes(2);

    containerMock.fetch.mockClear();
    await env.CORE_CLOUD_ARTIFACTS.put(`cloud-core/runs/${body.run.id}/events.json`, JSON.stringify([
      { runId: body.run.id, type: "state", message: "queued", timestamp: "t" }
    ]));
    const secondStart = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(secondStart.status).toBe(409);
    expect(containerMock.fetch).not.toHaveBeenCalled();
  });

  test("cancel marks a queued run cancelled and blocks a later start", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();

    const response = await dispatchWorker(coreRunRequest({ runId: "run-cancel" }), env, ctx);
    const body = await response.json() as { run: { id: string }; startUrl: string; runToken: string };
    await ctx.flush();

    const unauthorizedCancel = await dispatchWorker(new Request(`https://cae.esau.app/api/cloud-core/runs/${body.run.id}/cancel`, { method: "POST" }), env);
    expect(unauthorizedCancel.status).toBe(403);

    const cancel = await dispatchWorker(new Request(`https://cae.esau.app/api/cloud-core/runs/${body.run.id}/cancel?token=${body.runToken}`, { method: "POST" }), env);
    expect(cancel.status).toBe(200);
    expect(await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/events.json`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "cancelled" })])
    );

    const startAfterCancel = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(startAfterCancel.status).toBe(409);
    expect(containerMock.fetch).not.toHaveBeenCalled();
  });

  test("core cloud health returns 503 when the container runner version is stale", async () => {
    containerMock.fetch.mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.0.1" }));
    const response = await dispatchWorker(new Request("https://cae.esau.app/api/cloud-core/health"), createEnv());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, containerBound: true });
  });

  test("rejects oversized Core Cloud request bodies before JSON parsing", async () => {
    const env = createEnv();
    const response = await dispatchWorker(new Request("https://cae.esau.app/api/cloud-core/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5000001" },
      body: "{}"
    }), env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "OpenCAE Core Cloud request body is too large." });
  });

  test("unwraps older Core Cloud result envelopes before validation", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion, supportedAnalysisTypes: ["static_stress"] }))
      .mockResolvedValueOnce(Response.json({ ok: true, runId: "run-envelope", result: coreResult(), diagnostics: [] }));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-envelope" }), env, ctx);
    const body = await response.json() as CoreRunResponse;
    await ctx.flush();

    expect(response.status).toBe(202);
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(startResponse.status).toBe(200);
    await expect(env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/results.json`)).resolves.toMatchObject({
      provenance: { solver: "opencae-core-cloud", kind: "opencae_core_fea" },
      fields: expect.any(Array)
    });
    const events = await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/events.json`);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "complete", message: "OpenCAE Core Cloud solve complete." })
    ]));
  });

  test("cloud core run routes expose progress events and stored production results", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion, supportedAnalysisTypes: ["static_stress"] }))
      .mockResolvedValueOnce(Response.json(coreResult()));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-e2e" }), env, ctx);
    const body = await response.json() as CoreRunResponse;
    await ctx.flush();
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(startResponse.status).toBe(200);
    const eventsResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.streamUrl}`), env);
    const resultsResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.resultsUrl}`), env);
    const events = await eventsResponse.json() as Array<{ type: string; message: string; progress?: number }>;
    const results = await resultsResponse.json() as { provenance?: Record<string, unknown>; fields?: unknown[] };
    const serialized = JSON.stringify({ events, results }).toLowerCase();

    expect(response.status).toBe(202);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "state", message: "OpenCAE Core Cloud solve queued.", progress: 0 }),
      expect.objectContaining({ type: "progress", message: "OpenCAE Core Cloud solve running.", progress: 25 }),
      expect.objectContaining({ type: "complete", message: "OpenCAE Core Cloud solve complete.", progress: 100 })
    ]));
    expect(results.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "actual_volume_mesh"
    });
    expect(results.fields?.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("local_estimate");
    expect(serialized).not.toContain("computed_preview");
    expect(serialized).not.toContain("calculix");
  });

  test("cloud core run routes store and forward geometry-only requests", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion, supportedAnalysisTypes: ["static_stress"] }))
      .mockImplementationOnce(async (request: Request) => {
        const body = await request.json() as Record<string, unknown>;
        expect(body).toMatchObject({
          geometry: { kind: "sample_procedural", sampleId: "bracket" }
        });
        expect(body.runId).toMatch(/^run-cloud-core-/);
        expect(body.coreModel).toBeUndefined();
        return Response.json(coreResult());
      });

    const response = await dispatchWorker(coreRunRequest({ runId: "run-geometry", geometryOnly: true }), env, ctx);
    const body = await response.json() as CoreRunResponse;
    await ctx.flush();
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    const requestArtifact = await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/request.json`);
    const events = await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/events.json`);

    expect(response.status).toBe(202);
    expect(startResponse.status).toBe(200);
    expect(requestArtifact).toMatchObject({
      geometry: { kind: "sample_procedural", sampleId: "bracket" },
      solverSettings: { backend: "opencae_core_cloud" }
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "progress", message: "Dispatching geometry to OpenCAE Core Cloud for meshing." }),
      expect.objectContaining({ type: "complete", message: "OpenCAE Core Cloud solve complete." })
    ]));
  });

  test("legacy cloud-fea run alias is only a Core Cloud alias", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion, supportedAnalysisTypes: ["static_stress"] }))
      .mockResolvedValueOnce(Response.json(coreResult()));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-alias", path: "/api/cloud-fea/runs" }), env, ctx);
    const body = await response.json() as CoreRunResponse;
    await ctx.flush();
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl.replace("/api/cloud-core/runs", "/api/cloud-fea/runs")}`, { method: "POST" }), env);
    expect(startResponse.status).toBe(200);

    expect(body).toMatchObject({
      run: { solverBackend: "opencae-core-cloud" },
      message: "OpenCAE Core Cloud simulation queued."
    });
    expect(String(containerMock.fetch.mock.calls[1]?.[0].url)).toBe("https://container.local/solve");
  });

  test("stale Core Cloud runner is rejected without a local fallback", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch.mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: "0.0.1" }));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-stale" }), env, ctx);
    const body = await response.json() as CoreRunResponse;
    await ctx.flush();

    expect(response.status).toBe(202);
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(startResponse.status).toBe(500);
    const events = await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/events.json`);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", message: expect.stringContaining("runner version") })
    ]));
    expect(await env.CORE_CLOUD_ARTIFACTS.get(`cloud-core/runs/${body.run.id}/results.json`)).toBeNull();
    expect(containerMock.fetch).toHaveBeenCalledTimes(1);
  });

  test("dynamic Core Cloud result with frame metadata is accepted", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion }))
      .mockResolvedValueOnce(Response.json(coreResult({
        summary: { transient: { analysisType: "dynamic_structural", frameCount: 2, startTime: 0, endTime: 0.01, timeStep: 0.01, outputInterval: 0.01, peakDisplacement: 0.001, peakDisplacementTimeSeconds: 0.01 } },
        fields: [
          { id: "disp-0", type: "displacement", location: "node", values: [0], min: 0, max: 0, units: "m", frameIndex: 0, timeSeconds: 0 },
          { id: "disp-1", type: "displacement", location: "node", values: [0.001], min: 0, max: 0.001, units: "m", frameIndex: 1, timeSeconds: 0.01 }
        ]
      })));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-dynamic", analysisType: "dynamic_structural" }), env, ctx);
    const body = await response.json() as CoreRunResponse;
    await ctx.flush();
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(startResponse.status).toBe(200);

    await expect(env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/results.json`)).resolves.toMatchObject({
      summary: { transient: { frameCount: 2 } }
    });
  });

  test("rejects incomplete Core Cloud result contracts before storing results", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion }))
      .mockResolvedValueOnce(Response.json(coreResult({
        summary: {
          provenance: undefined,
          maxStressUnits: undefined,
          maxDisplacementUnits: undefined,
          reactionForceUnits: undefined
        },
        fields: [
          { id: "stress", type: "stress", location: "element", values: [123], min: 123, max: 123, units: undefined }
        ]
      })));

    const response = await dispatchWorker(coreRunRequest({ runId: "run-incomplete" }), env, ctx);
    const body = await response.json() as CoreRunResponse;
    await ctx.flush();
    const startResponse = await dispatchWorker(new Request(`https://cae.esau.app${body.startUrl}`, { method: "POST" }), env);
    expect(startResponse.status).toBe(500);

    const events = await env.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${body.run.id}/events.json`);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "error",
        message: "OpenCAE Core Cloud returned an incomplete result contract."
      })
    ]));
    expect(await env.CORE_CLOUD_ARTIFACTS.get(`cloud-core/runs/${body.run.id}/results.json`)).toBeNull();
  });

  test("legacy and preview provenance are rejected", async () => {
    const calculixEnv = createEnv();
    const calculixCtx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion }))
      .mockResolvedValueOnce(Response.json(coreResult({ provenance: { solver: "calculix", kind: "opencae_core_fea", resultSource: "computed" } })));

    const calculixResponse = await dispatchWorker(coreRunRequest({ runId: "run-calculix" }), calculixEnv, calculixCtx);
    const calculixBody = await calculixResponse.json() as CoreRunResponse;
    await calculixCtx.flush();
    const calculixStart = await dispatchWorker(new Request(`https://cae.esau.app${calculixBody.startUrl}`, { method: "POST" }), calculixEnv);
    expect(calculixStart.status).toBe(500);

    const calculixEvents = await calculixEnv.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${calculixBody.run.id}/events.json`);
    expect(calculixEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", message: expect.stringContaining("legacy solver") })
    ]));

    containerMock.fetch.mockReset();
    const previewEnv = createEnv();
    const previewCtx = createExecutionContext();
    containerMock.fetch
      .mockResolvedValueOnce(Response.json({ ok: true, runnerVersion: expectedRunnerVersion }))
      .mockResolvedValueOnce(Response.json(coreResult({ provenance: { solver: "opencae-core-cloud", kind: "local_estimate", resultSource: "computed_preview" } })));

    const previewResponse = await dispatchWorker(coreRunRequest({ runId: "run-preview" }), previewEnv, previewCtx);
    const previewBody = await previewResponse.json() as CoreRunResponse;
    await previewCtx.flush();
    const previewStart = await dispatchWorker(new Request(`https://cae.esau.app${previewBody.startUrl}`, { method: "POST" }), previewEnv);
    expect(previewStart.status).toBe(500);

    const previewEvents = await previewEnv.CORE_CLOUD_ARTIFACTS.readJson(`cloud-core/runs/${previewBody.run.id}/events.json`);
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

type CoreRunResponse = {
  run: { id: string; solverBackend?: string };
  streamUrl: string;
  startUrl: string;
  resultsUrl: string;
};

function coreRunRequest(options: { runId: string; path?: string; analysisType?: string; geometryOnly?: boolean }) {
  return new Request(`https://cae.esau.app${options.path ?? "/api/cloud-core/runs"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options.geometryOnly ? {
      runId: options.runId,
      analysisType: options.analysisType ?? "static_stress",
      study: { id: "study-bracket", type: "static_stress", loads: [{ type: "force", parameters: { value: 100 } }] },
      geometry: {
        kind: "sample_procedural",
        sampleId: "bracket",
        units: "mm",
        descriptor: { meshSize: 24 }
      },
      solverSettings: { backend: "opencae_core_cloud" }
    } : {
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

function startCoreRun(env: Env, runId: string, path = "/api/cloud-core/runs") {
  return dispatchWorker(new Request(`https://cae.esau.app${path}/${runId}/start`, { method: "POST" }), env);
}

function coreResult(overrides: { summary?: Record<string, unknown>; fields?: Array<Record<string, unknown>>; provenance?: Record<string, unknown>; diagnostics?: Array<Record<string, unknown>> } = {}) {
  const provenance = {
    kind: "opencae_core_fea",
    solver: "opencae-core-cloud",
    resultSource: "computed",
    meshSource: "actual_volume_mesh",
    units: "mm-N-s-MPa",
    ...overrides.provenance
  };
  return {
    summary: {
      maxStress: 123,
      maxStressUnits: "MPa",
      maxDisplacement: 0.002,
      maxDisplacementUnits: "mm",
      safetyFactor: 2.1,
      reactionForce: 100,
      reactionForceUnits: "N",
      provenance,
      ...overrides.summary
    },
    fields: overrides.fields ?? [
      { id: "stress", type: "stress", location: "element", values: [123], min: 123, max: 123, units: "Pa" },
      { id: "disp", type: "displacement", location: "node", values: [0.002], min: 0, max: 0.002, units: "m" }
    ],
    surfaceMesh: { id: "surface", nodes: [[0, 0, 0]], triangles: [], coordinateSpace: "solver", source: "opencae_core_volume_mesh" },
    diagnostics: overrides.diagnostics ?? [],
    provenance
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
    async head(key: string) {
      return objects.has(key) ? ({} as R2Object) : null;
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
