import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(__dirname, path), "utf8")) as {
    compatibility_flags?: string[];
    assets?: { run_worker_first?: string[] };
  };
}

describe("Cloudflare Worker performance config", () => {
  test("runs the Worker script only for API and health routes", () => {
    for (const configPath of ["../../../wrangler.jsonc", "../../../wrangler.local-first.jsonc", "../../../wrangler.containers.jsonc"]) {
      const config = readJson(configPath);

      expect(config.assets?.run_worker_first).toEqual(["/api/*", "/health"]);
      expect(config.compatibility_flags).toContain("nodejs_compat");
    }
  });

  test("ships immutable browser cache headers for fingerprinted assets", () => {
    const headersPath = resolve(__dirname, "../public/_headers");

    expect(existsSync(headersPath)).toBe(true);
    const headers = readFileSync(headersPath, "utf8");
    expect(headers).toContain("/assets/*");
    expect(headers).toContain("Cache-Control: public, max-age=31556952, immutable");
  });

  test("uses generated Wrangler environment types instead of a hand-written Env", () => {
    const workerSource = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(workerSource).toContain("/// <reference types=\"./worker-configuration\"");
    expect(workerSource).not.toContain("type Env = {");
    expect(workerSource).toContain("satisfies ExportedHandler<Env>");
  });
});
