import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc, readCloudflareConfigs, validateCloudflareConfigs } from "./verify-cloudflare-config.mjs";

const rootDir = resolve(import.meta.dirname, "..");

function readConfig(path) {
  return parseJsonc(readFileSync(resolve(rootDir, path), "utf8"), path);
}

function clone(value) {
  return structuredClone(value);
}

describe("Cloudflare deployment config guard (post cloud retirement)", () => {
  test("passes with static assets and the isolated encrypted backup binding", () => {
    const { defaultConfig, retiredDoCleanupConfig, staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const readme = readFileSync(resolve(rootDir, "README.md"), "utf8");

    expect(defaultConfig.name).toBe("opencae");
    expect(staticConfig.name).toBe("opencae-static");
    expect(defaultConfig.containers).toBeUndefined();
    expect(defaultConfig.durable_objects).toBeUndefined();
    expect(defaultConfig.r2_buckets).toEqual([{ binding: "PROJECT_BACKUPS", bucket_name: "opencae-project-backups" }]);
    expect(readme).toContain("Deploy command: npx wrangler deploy");
    expect(readme).toContain("Do not use `npx wrangler versions upload` for the production Worker");
    expect(retiredDoCleanupConfig.migrations).toEqual([
      { tag: "v3-opencae-core-cloud-container", new_sqlite_classes: ["OpenCaeCoreCloudContainer"] },
      { tag: "v4-retire-opencae-core-cloud-container", deleted_classes: ["OpenCaeCoreCloudContainer"] }
    ]);
    expect(() => validateCloudflareConfigs({ defaultConfig, retiredDoCleanupConfig, staticConfig, packageJson })).not.toThrow();
  });

  test("retired container and local-first wrangler variants stay deleted", () => {
    expect(existsSync(resolve(rootDir, "wrangler.containers.jsonc"))).toBe(false);
    expect(existsSync(resolve(rootDir, "wrangler.local-first.jsonc"))).toBe(false);
    expect(existsSync(resolve(rootDir, "services/opencae-core-cloud"))).toBe(false);
    expect(existsSync(resolve(rootDir, "scripts/verify-runner-version.mjs"))).toBe(false);
  });

  test("OpenCAE Core packages are in-repo and sibling bootstrap files stay deleted", () => {
    for (const packageDir of ["core", "examples", "solver-cpu", "solver-wasm", "solver-webgpu", "viewer"]) {
      expect(existsSync(resolve(rootDir, "packages", packageDir, "package.json")), packageDir).toBe(true);
    }
    for (const retiredPath of [
      "OPENCAE_CORE_REF",
      "scripts/ensure-opencae-core.mjs",
      "scripts/verify-core-ref-reachable.mjs"
    ]) {
      expect(existsSync(resolve(rootDir, retiredPath)), retiredPath).toBe(false);
    }
    const workspace = readFileSync(resolve(rootDir, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toContain("../opencae-core");
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    expect(packageJson.scripts).not.toHaveProperty("ensure:core");
    expect(packageJson.scripts).not.toHaveProperty("verify:core-ref");
    expect(packageJson.scripts["build:core"]).not.toContain("install");
  });

  test("rejects checked-in migrations (PR preview version uploads cannot carry them)", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.migrations = [
      { tag: "v4-retire-opencae-core-cloud-container", deleted_classes: ["OpenCaeCoreCloudContainer"] }
    ];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must not declare migrations/
    );
  });

  test("requires the retired Durable Object cleanup config to target production narrowly", () => {
    const { defaultConfig, staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const retiredDoCleanupConfig = clone(readConfig("wrangler.retired-do-cleanup.jsonc"));
    retiredDoCleanupConfig.migrations = [
      { tag: "v4-retire-opencae-core-cloud-container", deleted_classes: ["OpenCaeCoreCloudContainer"] },
      { tag: "v5-unexpected", deleted_classes: ["SomeOtherClass"] }
    ];

    expect(() => validateCloudflareConfigs({ defaultConfig, retiredDoCleanupConfig, staticConfig, packageJson })).toThrow(
      /recorded creation tag and the v4 delete-class migration/
    );
  });

  test("fails if a container binding sneaks back into the production config", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.containers = [{ name: "opencae-core-cloud-0.1.1", class_name: "OpenCaeCoreCloudContainer" }];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must not define containers/
    );
  });

  test("fails if a Durable Object binding sneaks back into the production config", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.durable_objects = { bindings: [{ name: "CORE_CLOUD_CONTAINER", class_name: "OpenCaeCoreCloudContainer" }] };

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must not bind Durable Objects/
    );
  });

  test("fails if an R2 artifact binding sneaks back into the production config", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.r2_buckets = [{ binding: "CORE_CLOUD_ARTIFACTS", bucket_name: "opencae-core-cloud-artifacts" }];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /must bind only PROJECT_BACKUPS/
    );
  });

  test("fails if retired container scripts return to package.json", () => {
    const { defaultConfig, staticConfig } = readCloudflareConfigs(rootDir);
    const packageJson = clone(JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")));
    packageJson.scripts["containers:build:core-cloud"] = "wrangler containers build services/opencae-core-cloud";

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /containers:build:core-cloud was retired/
    );
  });

  test("fails if the @cloudflare/containers dependency returns", () => {
    const { defaultConfig, staticConfig } = readCloudflareConfigs(rootDir);
    const packageJson = clone(JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")));
    packageJson.dependencies = { ...(packageJson.dependencies ?? {}), "@cloudflare/containers": "^0.3.3" };

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /@cloudflare\/containers must stay removed/
    );
  });

  test("fails when static and production configs share a Worker name", () => {
    const { defaultConfig, packageJson } = readCloudflareConfigs(rootDir);
    const staticConfig = clone(readConfig("wrangler.static.jsonc"));
    staticConfig.name = defaultConfig.name;

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /static config must not share the production Worker name/
    );
  });

  test.each(["cae.esau.app"])("fails when the production config loses %s", (productionDomain) => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.routes = defaultConfig.routes.filter((route) => route.pattern !== productionDomain);

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      new RegExp(`default config must route ${productionDomain.replaceAll(".", "\\.")} as a custom domain`)
    );
  });

  test("fails when the production config drops the SPA asset wiring", () => {
    const { staticConfig, packageJson } = readCloudflareConfigs(rootDir);
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    defaultConfig.assets.run_worker_first = ["/health"];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson })).toThrow(
      /run_worker_first must include/
    );
  });
});
