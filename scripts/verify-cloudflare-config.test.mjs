import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc, validateCloudflareConfigs } from "./verify-cloudflare-config.mjs";

const rootDir = resolve(import.meta.dirname, "..");

function readConfig(path) {
  return parseJsonc(readFileSync(resolve(rootDir, path), "utf8"), path);
}

function clone(value) {
  return structuredClone(value);
}

describe("Cloudflare deployment config guard", () => {
  test("passes with browser-local production and static configs", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const containersConfig = readConfig("wrangler.containers.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const localFirstConfig = readConfig("wrangler.local-first.jsonc");

    expect(defaultConfig.name).toBe("opencae-alpha");
    expect(containersConfig.name).toBe("opencae-alpha");
    expect(containersConfig.containers?.[0]?.name).toBe("opencae-alpha-opencaefeacontainer");
    expect(staticConfig.name).toBe("opencae-static");
    expect(localFirstConfig.name).toBe("opencae-local-first");
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects).toBeUndefined();
    expect(() => validateCloudflareConfigs({ defaultConfig, containersConfig, staticConfig, localFirstConfig })).not.toThrow();
  });

  test("default Workers deploy no longer builds or pushes a container image", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

    expect(packageJson.scripts.build).toBe("pnpm --filter @opencae/api build && pnpm --filter @opencae/web build");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("wrangler deploy --config wrangler.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("--containers-rollout");
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeUndefined();
  });

  test("fails when static and production configs share a Worker name", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const staticConfig = clone(readConfig("wrangler.static.jsonc"));
    staticConfig.name = defaultConfig.name;

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig })).toThrow(
      /static config must not share the production Worker name/
    );
  });

  test("fails when local-first and production configs share a Worker name", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const localFirstConfig = clone(readConfig("wrangler.local-first.jsonc"));
    localFirstConfig.name = defaultConfig.name;

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, localFirstConfig })).toThrow(
      /local-first config must not share the production Worker name/
    );
  });

  test("fails when the default production config regains a container binding", () => {
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    defaultConfig.durable_objects = { bindings: [{ name: "FEA_CONTAINER", class_name: "OpenCaeFeaContainer" }] };

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig })).toThrow(
      /must not bind Cloud FEA containers/
    );
  });

  test("fails when the production config loses cae.esau.app", () => {
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    defaultConfig.routes = defaultConfig.routes.filter((route) => route.pattern !== "cae.esau.app");

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig })).toThrow(
      /default config must route cae\.esau\.app as a custom domain/
    );
  });
});
