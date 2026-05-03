import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc, validateCloudflareConfigs } from "./verify-cloudflare-config.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const expectedContainerImage = "./services/opencae-fea-container/Dockerfile";

function readConfig(path) {
  return parseJsonc(readFileSync(resolve(rootDir, path), "utf8"), path);
}

function clone(value) {
  return structuredClone(value);
}

describe("Cloudflare deployment config guard", () => {
  test("passes with the corrected production and static configs", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const containersConfig = readConfig("wrangler.containers.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const localFirstConfig = readConfig("wrangler.local-first.jsonc");

    expect(defaultConfig.name).toBe("opencae");
    expect(staticConfig.name).toBe("opencae-static");
    expect(localFirstConfig.name).toBe("opencae-local-first");
    expect(defaultConfig.containers?.[0]?.image).toBe(expectedContainerImage);
    expect(containersConfig.containers?.[0]?.image).toBe(expectedContainerImage);
    expect(() => validateCloudflareConfigs({ defaultConfig, containersConfig, staticConfig, localFirstConfig })).not.toThrow();
  });

  test("default Workers Builds deploy can build and push the container image", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

    expect(packageJson.scripts.build).toBe("pnpm --filter @opencae/api build && pnpm --filter @opencae/web build");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("wrangler deploy --config wrangler.containers.jsonc");
  });

  test("fails when static and production configs share a Worker name", () => {
    const containersConfig = readConfig("wrangler.containers.jsonc");
    const staticConfig = clone(readConfig("wrangler.static.jsonc"));
    staticConfig.name = containersConfig.name;

    expect(() => validateCloudflareConfigs({ containersConfig, staticConfig })).toThrow(
      /static config must not share the production Worker name/
    );
  });

  test("fails when local-first and production configs share a Worker name", () => {
    const containersConfig = readConfig("wrangler.containers.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const localFirstConfig = clone(readConfig("wrangler.local-first.jsonc"));
    localFirstConfig.name = containersConfig.name;

    expect(() => validateCloudflareConfigs({ containersConfig, staticConfig, localFirstConfig })).toThrow(
      /local-first config must not share the production Worker name/
    );
  });

  test("fails when the production config loses FEA_CONTAINER", () => {
    const containersConfig = clone(readConfig("wrangler.containers.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    containersConfig.durable_objects.bindings = containersConfig.durable_objects.bindings.filter(
      (binding) => binding.name !== "FEA_CONTAINER"
    );

    expect(() => validateCloudflareConfigs({ containersConfig, staticConfig })).toThrow(
      /production config must bind durable object FEA_CONTAINER/
    );
  });

  test("fails when the production config loses cae.esau.app", () => {
    const containersConfig = clone(readConfig("wrangler.containers.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    containersConfig.routes = containersConfig.routes.filter((route) => route.pattern !== "cae.esau.app");

    expect(() => validateCloudflareConfigs({ containersConfig, staticConfig })).toThrow(
      /production config must route cae\.esau\.app as a custom domain/
    );
  });

  test("fails when the production container image is not the Dockerfile path for Workers Builds", () => {
    const containersConfig = clone(readConfig("wrangler.containers.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    containersConfig.containers[0].image = "registry.cloudflare.com/747b74cbd7d019dd7aeecb2c24a4bf10/opencae/opencae-fea:0.1.2-dynamic-v1";

    expect(() => validateCloudflareConfigs({ containersConfig, staticConfig })).toThrow(
      /production config containers\[0\]\.image must be/
    );
  });
});
