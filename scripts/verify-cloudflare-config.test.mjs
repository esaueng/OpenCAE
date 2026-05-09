import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc, validateCloudflareConfigs } from "./verify-cloudflare-config.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const expectedRunnerVersion = "0.1.0";
const expectedContainerInstanceName = `opencae-core-cloud-${expectedRunnerVersion}`;

function readConfig(path) {
  return parseJsonc(readFileSync(resolve(rootDir, path), "utf8"), path);
}

function clone(value) {
  return structuredClone(value);
}

describe("Cloudflare deployment config guard", () => {
  test("passes with Core Cloud production and non-production static configs", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const localFirstConfig = readConfig("wrangler.local-first.jsonc");
    const containerConfig = readConfig("wrangler.containers.jsonc");

    expect(defaultConfig.name).toBe("opencae");
    expect(staticConfig.name).toBe("opencae-static");
    expect(localFirstConfig.name).toBe("opencae-local-first");
    expect(defaultConfig.containers[0].name).toBe(expectedContainerInstanceName);
    expect(defaultConfig.durable_objects.bindings[0]).toEqual({ name: "CORE_CLOUD_CONTAINER", class_name: "OpenCaeCoreCloudContainer" });
    expect(defaultConfig.migrations).toEqual([{ tag: "v3-opencae-core-cloud-container", new_sqlite_classes: ["OpenCaeCoreCloudContainer"] }]);
    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, localFirstConfig, containerConfig })).not.toThrow();
  });

  test("default Workers deploy targets Core Cloud while local-first stays explicit", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    const buildScript = packageJson.scripts.build;

    expect(buildScript).toContain("pnpm --filter @opencae/api build");
    expect(buildScript).toContain("pnpm --filter @opencae/web build");
    expect(buildScript).not.toContain("@cloudflare/containers");
    expect(buildScript).not.toContain("containers:build");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("wrangler deploy --config wrangler.containers.jsonc");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("verify:runner-version");
    expect(packageJson.scripts["deploy:cloudflare"]).toContain("--containers-rollout=immediate");
    expect(packageJson.scripts["deploy:cloudflare:dry-run"]).toContain("wrangler deploy --config wrangler.containers.jsonc --dry-run");
    expect(packageJson.scripts["deploy:cloudflare:local-first"]).toContain("wrangler.local-first.jsonc");
    expect(packageJson.scripts["deploy:core-cloud"]).toContain("wrangler deploy --config wrangler.containers.jsonc");
    expect(packageJson.scripts["deploy:core-cloud"]).toContain("verify:runner-version");
    expect(packageJson.scripts["containers:build:core-cloud"]).toContain("services/opencae-core-cloud");
    expect(packageJson.scripts["containers:build:core-cloud"]).toContain(`opencae/opencae-core-cloud:${expectedRunnerVersion}`);
    expect(packageJson.scripts["test:core-cloud-container"]).toBe("pnpm --filter @opencae/core-cloud test");
    expect(packageJson.dependencies?.["@cloudflare/containers"]).toBeDefined();
  });

  test("Core Cloud runner version file controls deploy checks", () => {
    const versionPath = resolve(rootDir, "services/opencae-core-cloud/RUNNER_VERSION");
    const workerSource = readFileSync(resolve(rootDir, "apps/opencae-web/worker/index.ts"), "utf8");
    const verifyRunnerSource = readFileSync(resolve(rootDir, "scripts/verify-runner-version.mjs"), "utf8");

    expect(readFileSync(versionPath, "utf8").trim()).toBe(expectedRunnerVersion);
    expect(workerSource).toContain(`EXPECTED_CORE_CLOUD_RUNNER_VERSION = "${expectedRunnerVersion}"`);
    expect(verifyRunnerSource).toContain("RUNNER_VERSION");
    expect(verifyRunnerSource).toContain("services/opencae-core-cloud/RUNNER_VERSION");
  });

  test("Core Cloud Docker build installs git before cloning Core", () => {
    const dockerfile = readFileSync(resolve(rootDir, "services/opencae-core-cloud/Dockerfile"), "utf8");
    const installGitIndex = dockerfile.indexOf("apt-get install -y --no-install-recommends git");
    const ensureCoreIndex = dockerfile.indexOf("RUN pnpm ensure:core");
    const coreInstallIndex = dockerfile.indexOf("RUN pnpm --dir /opencae-core install --frozen-lockfile --prod=false");
    const nodeTypesIndex = dockerfile.indexOf("RUN pnpm --dir /opencae-core add -Dw @types/node@22.19.17");
    const linkBuildToolsIndex = dockerfile.indexOf("ln -s /opencae-core/node_modules/.bin/tsc services/opencae-core-cloud/node_modules/.bin/tsc");
    const linkTypescriptIndex = dockerfile.indexOf("ln -s /opencae-core/node_modules/typescript services/opencae-core-cloud/node_modules/typescript");
    const linkCoreIndex = dockerfile.indexOf("ln -s /opencae-core/packages/core services/opencae-core-cloud/node_modules/@opencae/core");
    const linkSolverIndex = dockerfile.indexOf("ln -s /opencae-core/packages/solver-cpu services/opencae-core-cloud/node_modules/@opencae/solver-cpu");
    const coreBuildIndex = dockerfile.indexOf("RUN pnpm --dir /opencae-core --filter @opencae/core build");
    const serviceInstallIndex = dockerfile.indexOf("RUN pnpm install --frozen-lockfile --prod=false");
    const serviceBuildIndex = dockerfile.indexOf("RUN pnpm --filter @opencae/core-cloud build");
    const runtimeNodeModulesIndex = dockerfile.indexOf("ln -s /opencae-core/packages/core node_modules/@opencae/core");

    expect(installGitIndex).toBeGreaterThanOrEqual(0);
    expect(ensureCoreIndex).toBeGreaterThan(installGitIndex);
    expect(coreInstallIndex).toBeGreaterThan(ensureCoreIndex);
    expect(nodeTypesIndex).toBeGreaterThan(coreInstallIndex);
    expect(linkBuildToolsIndex).toBeGreaterThan(nodeTypesIndex);
    expect(linkTypescriptIndex).toBeGreaterThan(nodeTypesIndex);
    expect(linkCoreIndex).toBeGreaterThan(nodeTypesIndex);
    expect(linkSolverIndex).toBeGreaterThan(nodeTypesIndex);
    expect(coreBuildIndex).toBeGreaterThan(coreInstallIndex);
    expect(serviceInstallIndex).toBeGreaterThan(coreInstallIndex);
    expect(serviceBuildIndex).toBeGreaterThan(linkBuildToolsIndex);
    expect(runtimeNodeModulesIndex).toBeGreaterThan(serviceBuildIndex);
  });

  test("Core Cloud service declares its bundled Node runtime build", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "services/opencae-core-cloud/package.json"), "utf8"));
    const tsconfig = JSON.parse(readFileSync(resolve(rootDir, "services/opencae-core-cloud/tsconfig.json"), "utf8"));
    const dockerfile = readFileSync(resolve(rootDir, "services/opencae-core-cloud/Dockerfile"), "utf8");

    expect(packageJson.scripts.build).toContain("tsc -p tsconfig.json");
    expect(packageJson.scripts.build).toContain("esbuild src/server.ts --bundle --platform=node --format=esm");
    expect(packageJson.scripts.start).toBe("node dist/server.bundle.js");
    expect(packageJson.devDependencies?.typescript).toBeDefined();
    expect(packageJson.devDependencies?.esbuild).toBeDefined();
    expect(tsconfig.include).toEqual(["src/index.ts", "src/server.ts"]);
    expect(dockerfile).toContain("node\", \"services/opencae-core-cloud/dist/server.bundle.js");
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

  test("fails when container instance name is not versioned", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const containerConfig = clone(readConfig("wrangler.containers.jsonc"));
    containerConfig.containers[0].name = "opencae-core-cloud";

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, containerConfig })).toThrow(
      new RegExp(expectedContainerInstanceName)
    );
  });

  test("fails when Core Cloud deploy scripts lose the expected versioned image", () => {
    const defaultConfig = readConfig("wrangler.jsonc");
    const staticConfig = readConfig("wrangler.static.jsonc");
    const containerConfig = readConfig("wrangler.containers.jsonc");
    const packageJson = clone(JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")));
    packageJson.scripts["containers:build:core-cloud"] = packageJson.scripts["containers:build:core-cloud"].replace(
      `opencae/opencae-core-cloud:${expectedRunnerVersion}`,
      "opencae/opencae-core-cloud:stale"
    );

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, containerConfig, packageJson })).toThrow(
      new RegExp(`opencae/opencae-core-cloud:${expectedRunnerVersion}`)
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

  test("fails when the default production config loses the Core Cloud container binding", () => {
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    delete defaultConfig.durable_objects;

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig })).toThrow(
      /CORE_CLOUD_CONTAINER/
    );
  });

  test("fails when the default production config loses the Core Cloud durable object migration", () => {
    const defaultConfig = clone(readConfig("wrangler.jsonc"));
    const staticConfig = readConfig("wrangler.static.jsonc");
    defaultConfig.migrations = [{ tag: "v3", new_sqlite_classes: ["OtherClass"] }];

    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig })).toThrow(
      /OpenCaeCoreCloudContainer Durable Object migration/
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
