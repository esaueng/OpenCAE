import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseJsonc } from "../../../scripts/verify-cloudflare-config.mjs";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => ({
    fetch: async () => Response.json({ ok: true, proxied: true })
  })
}));

const { default: worker } = await import("./index");

function readJsonc(path: string) {
  return parseJsonc(readFileSync(resolve(__dirname, path), "utf8"), path);
}

describe("Cloudflare local-first worker", () => {
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

  test("api routes explain browser-local simulation handling", async () => {
    const response = await worker.fetch(new Request("https://cae.esau.app/api/cloud-fea/runs"), {
      ASSETS: { fetch: async () => new Response("asset") }
    } as Env);

    await expect(response.json()).resolves.toMatchObject({
      solver: "opencae-core-cloud",
      label: "OpenCAE Core Cloud"
    });
    expect(response.status).toBe(503);
  });

  test("cloud core routes and legacy cloud fea aliases identify OpenCAE Core Cloud", async () => {
    const env = { ASSETS: { fetch: async () => new Response("asset") } } as Env;
    const health = await worker.fetch(new Request("https://cae.esau.app/api/cloud-core/health"), env);
    const runs = await worker.fetch(new Request("https://cae.esau.app/api/cloud-core/runs"), env);
    const legacy = await worker.fetch(new Request("https://cae.esau.app/api/cloud-fea/runs/run-1/results"), env);

    await expect(health.json()).resolves.toMatchObject({ ok: false, solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
    await expect(runs.json()).resolves.toMatchObject({ solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
    await expect(legacy.json()).resolves.toMatchObject({ solver: "opencae-core-cloud", label: "OpenCAE Core Cloud" });
  });

  test("includes an inert queue handler for stale legacy Workers Builds consumers", async () => {
    const queueHandler = (worker as ExportedHandler<Env>).queue;

    expect(typeof queueHandler).toBe("function");
    await expect(queueHandler?.({ messages: [] } as unknown as MessageBatch<unknown>, {} as Env, {} as ExecutionContext)).resolves.toBeUndefined();
  });
});
