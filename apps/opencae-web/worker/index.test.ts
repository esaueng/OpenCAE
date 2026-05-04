import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc } from "../../../scripts/verify-cloudflare-config.mjs";
import worker from "./index";

function readJsonc(path: string) {
  return parseJsonc(readFileSync(resolve(__dirname, path), "utf8"), path);
}

describe("Cloudflare local-first worker", () => {
  test("does not import the Cloudflare container runtime", () => {
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(workerSource).not.toContain("@cloudflare/containers");
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
    };

    expect(packageJson.scripts["deploy:cloudflare"]).toContain("--config wrangler.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("--containers-rollout");
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeUndefined();
    expect(defaultConfig.name).toBe("opencae-alpha");
    expect(defaultConfig.routes).toContainEqual({ pattern: "cae.esau.app", custom_domain: true });
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects).toBeUndefined();
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
      error: expect.stringContaining("Simulations run in the browser with OpenCAE Core")
    });
    expect(response.status).toBe(503);
  });
});
