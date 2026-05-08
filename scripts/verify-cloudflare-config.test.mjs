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
    const staticConfig = readConfig("wrangler.static.jsonc");
    const localFirstConfig = readConfig("wrangler.local-first.jsonc");
    const containerConfig = readConfig("wrangler.containers.jsonc");

    expect(defaultConfig.name).toBe("opencae");
    expect(staticConfig.name).toBe("opencae-static");
    expect(localFirstConfig.name).toBe("opencae-local-first");
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects).toBeUndefined();
    expect(defaultConfig.migrations).toEqual([{ tag: "v2-delete-cloud-fea-container", deleted_classes: ["OpenCaeFeaContainer"] }]);
    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, localFirstConfig, containerConfig })).not.toThrow();
  });

  test("default Workers deploy stays local-first while container deploy targets Core Cloud", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    const buildScript = packageJson.scripts.build;

    expect(buildScript).toContain("pnpm --filter @opencae/api build");
    expect(buildScript).toContain("pnpm --filter @opencae/web build");
    expect(buildScript).not.toContain("@cloudflare/containers");
    expect(buildScript).not.toContain("containers:build");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("wrangler deploy --config wrangler.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare"]).not.toContain("--containers-rollout");
    expect(packageJson.scripts["deploy:cloudflare:containers"]).toContain("wrangler deploy --config wrangler.containers.jsonc");
    expect(packageJson.scripts["containers:build"]).toContain("services/opencae-core-cloud");
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeDefined();
  });

  test("fails when container config references the legacy FEA container", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const containerConfig = clone(readConfig("wrangler.containers.jsonc"));
    containerConfig.durable_objects.bindings[0].name = "FEA_CONTAINER";

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, containerConfig })).toThrow(
      /CORE_CLOUD_CONTAINER/
    );
  });

  test("fails when container config loses the Core Cloud artifacts bucket", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const containerConfig = clone(readConfig("wrangler.containers.jsonc"));
    delete containerConfig.r2_buckets;

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, containerConfig })).toThrow(
      /CORE_CLOUD_ARTIFACTS/
    );
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
      /must not bind container solvers/
    );
  });

  test("fails when the default production config adds a non-deletion durable object migration", () => {
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    defaultConfig.migrations = [{ tag: "v3", new_sqlite_classes: ["OtherClass"] }];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig })).toThrow(
      /only include the legacy container deletion migration/
    );
  });

  test.each(["cae.esau.app"])("fails when the production config loses %s", (productionDomain) => {
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    defaultConfig.routes = defaultConfig.routes.filter((route) => route.pattern !== productionDomain);

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig })).toThrow(
      new RegExp(`default config must route ${productionDomain.replaceAll(".", "\\.")} as a custom domain`)
    );
  });
});
