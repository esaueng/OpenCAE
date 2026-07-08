import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc } from "../../../scripts/verify-cloudflare-config.mjs";

const { default: worker } = await import("./index");

function dispatchWorker(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request, env);
}

function readJsonc(path: string) {
  return parseJsonc(readFileSync(resolve(__dirname, path), "utf8"), path);
}

function createEnv(assetBody = "asset"): Env {
  return {
    ASSETS: { fetch: async () => new Response(assetBody, { headers: { "content-type": "text/html" } }) }
  } as unknown as Env;
}

describe("Cloudflare local-first worker", () => {
  test("carries no cloud solve infrastructure (retired 2026-07)", () => {
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    // B4b removed the container Durable Object, R2 artifact store, run
    // tokens, and runner-version gate. None of them may return here.
    expect(workerSource).not.toContain("@cloudflare/containers");
    expect(workerSource).not.toContain("OpenCaeCoreCloudContainer");
    expect(workerSource).not.toContain("CORE_CLOUD_CONTAINER");
    expect(workerSource).not.toContain("CORE_CLOUD_ARTIFACTS");
    expect(workerSource).not.toContain("EXPECTED_CORE_CLOUD_RUNNER_VERSION");
    expect(workerSource).not.toContain("x-opencae-run-token");
    expect(workerSource).not.toContain("R2Bucket");
    expect(workerSource).not.toContain("cloud-core/runs/");
  });

  test("wrangler config binds only static assets (no containers, DO, or R2)", () => {
    const defaultConfig = readJsonc("../../../wrangler.jsonc") as {
      name?: string;
      routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
      containers?: unknown;
      durable_objects?: unknown;
      r2_buckets?: unknown;
      migrations?: Array<{ tag?: string; deleted_classes?: string[] }>;
      assets?: { run_worker_first?: string[] };
    };

    expect(defaultConfig.name).toBe("opencae");
    expect(defaultConfig.routes).toEqual([{ pattern: "cae.esau.app", custom_domain: true }]);
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects).toBeUndefined();
    expect(defaultConfig.r2_buckets).toBeUndefined();
    expect(defaultConfig.assets?.run_worker_first).toEqual(expect.arrayContaining(["/api/*", "/health"]));
    // Checked-in migrations break Workers Builds version uploads; the retired
    // Durable Object cleanup is a one-off manual deploy step documented in
    // docs/cloud-retirement.md.
    expect(defaultConfig.migrations).toBeUndefined();
  });

  test("deploy scripts target the retired-cloud config without container gates", () => {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(packageJson.scripts["deploy:cloudflare"]).toContain("wrangler deploy");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("wrangler.containers.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("containers-rollout");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare:retired-do-cleanup"]).toContain("wrangler.retired-do-cleanup.jsonc");
    expect(packageJson.scripts["deploy:core-cloud"]).toBeUndefined();
    expect(packageJson.scripts["containers:build:core-cloud"]).toBeUndefined();
    expect(packageJson.scripts["containers:push:core-cloud"]).toBeUndefined();
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeUndefined();
  });

  test("health advertises the browser OpenCAE Core runtime", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/health"), createEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      mode: "cloudflare-worker",
      service: "opencae-web",
      solverRuntime: "browser-opencae-core"
    });
  });

  test.each([
    ["POST", "/api/cloud-core/runs"],
    ["POST", "/api/cloud-core/runs/run-1/start"],
    ["GET", "/api/cloud-core/runs/run-1/events"],
    ["GET", "/api/cloud-core/runs/run-1/results"],
    ["POST", "/api/cloud-core/runs/run-1/cancel"],
    ["GET", "/api/cloud-core/health"],
    ["POST", "/api/cloud-fea/runs"],
    ["GET", "/api/cloud-fea/runs/run-1/results"],
    ["GET", "/api/cloud-fea/health"]
  ])("retired cloud route %s %s returns an honest 410", async (method, path) => {
    const response = await dispatchWorker(new Request(`https://cae.esau.app${path}`, { method }), createEnv());
    const body = await response.json() as { error?: string; retired?: boolean; solverRuntime?: string };

    expect(response.status).toBe(410);
    expect(body.retired).toBe(true);
    expect(body.solverRuntime).toBe("browser-opencae-core");
    expect(body.error).toContain("retired");
    expect(body.error).toContain("locally in your browser");
  });

  test("other api routes explain the local-first Worker", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/api/projects"), createEnv());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Simulations run in the browser")
    });
  });

  test("serves static assets for non-api routes", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/"), createEnv("<html></html>"));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<html></html>");
  });

  test("asset responses include browser security headers", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/"), createEnv("<html></html>"));

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  test("csp permits the OCCT STEP importer embind runtime", async () => {
    const response = await dispatchWorker(new Request("https://cae.esau.app/"), createEnv("<html></html>"));

    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'");
  });

  test("static asset _headers ships the same security headers the worker applies", async () => {
    const headersFile = readFileSync(resolve(__dirname, "../public/_headers"), "utf8");
    const response = await dispatchWorker(new Request("https://cae.esau.app/"), createEnv("<html></html>"));

    const workerCsp = response.headers.get("content-security-policy");
    expect(workerCsp).toBeTruthy();
    expect(headersFile).toContain(`Content-Security-Policy: ${workerCsp}`);
    expect(headersFile).toContain("X-Content-Type-Options: nosniff");
    expect(headersFile).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(headersFile).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()");
  });

  test("includes an inert queue handler for stale legacy Workers Builds consumers", async () => {
    const queueHandler = (worker as ExportedHandler<Env>).queue;

    expect(typeof queueHandler).toBe("function");
    await expect(queueHandler?.({ messages: [] } as unknown as MessageBatch<unknown>, {} as Env, {} as ExecutionContext)).resolves.toBeUndefined();
  });
});
