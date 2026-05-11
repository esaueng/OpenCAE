import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJsonc, validateCloudflareConfigs } from "./verify-cloudflare-config.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const expectedRunnerVersion = "0.1.3";
const expectedContainerApplicationName = "opencae-core-cloud-0.1.1";

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
    expect(defaultConfig.containers[0].name).toBe(expectedContainerApplicationName);
    expect(defaultConfig.durable_objects.bindings[0]).toEqual({ name: "CORE_CLOUD_CONTAINER", class_name: "OpenCaeCoreCloudContainer" });
    expect(defaultConfig.migrations).toEqual([{ tag: "v3-opencae-core-cloud-container", new_sqlite_classes: ["OpenCaeCoreCloudContainer"] }]);
    expect(() => validateCloudflareConfigs({ defaultConfig, staticConfig, localFirstConfig, containerConfig })).not.toThrow();
  });

  test("default Workers deploy targets Core Cloud while local-first stays explicit", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    const buildScript = packageJson.scripts.build;
    const buildCoreScript = packageJson.scripts["build:core"];

    expect(buildScript).toContain("pnpm --filter @opencae/api build");
    expect(buildScript).toContain("pnpm --filter @opencae/web build");
    expect(buildScript).not.toContain("@cloudflare/containers");
    expect(buildScript).not.toContain("containers:build");
    expect(buildCoreScript).toContain("pnpm install --no-frozen-lockfile");
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

  test("Core Cloud build tracks the latest external OpenCAE Core branch", () => {
    const coreRefPath = resolve(rootDir, "services/opencae-core-cloud/OPENCAE_CORE_REF");
    const coreRef = readFileSync(coreRefPath, "utf8").trim();
    const ensureCoreSource = readFileSync(resolve(rootDir, "scripts/ensure-opencae-core.mjs"), "utf8");

    expect(coreRef).toBe("main");
    expect(ensureCoreSource).toContain("OPENCAE_CORE_REF");
    expect(ensureCoreSource).toContain("services/opencae-core-cloud/OPENCAE_CORE_REF");
    expect(ensureCoreSource).toContain("updateExistingCoreWorkspace");
    expect(ensureCoreSource).toContain("git\", [\"-C\", directory, \"fetch\", \"--depth\", \"1\", \"origin\", ref]");
    expect(ensureCoreSource).toContain("merge\", \"--ff-only\", \"FETCH_HEAD");
    expect(ensureCoreSource).toContain("checkout");
    expect(ensureCoreSource).toContain("FETCH_HEAD");
  });

  test("Core Cloud Docker build installs git before cloning Core and gmsh before runtime", () => {
    const dockerfile = readFileSync(resolve(rootDir, "services/opencae-core-cloud/Dockerfile"), "utf8");
    const installGitIndex = dockerfile.indexOf("apt-get install -y --no-install-recommends git");
    const ensureCoreIndex = dockerfile.indexOf("pnpm ensure:core");
    const coreInstallIndex = dockerfile.indexOf("RUN pnpm --dir /opencae-core install --frozen-lockfile --prod=false");
    const coreBuildIndex = dockerfile.indexOf("RUN pnpm --dir /opencae-core --filter @opencae/core build");
    const solverBuildIndex = dockerfile.indexOf("RUN pnpm --dir /opencae-core --filter @opencae/solver-cpu build");
    const serviceBuildIndex = dockerfile.indexOf("RUN pnpm --dir /opencae-core --filter @opencae/core-cloud build");
    const runtimeGmshInstallIndex = dockerfile.indexOf("apt-get install -y --no-install-recommends gmsh");
    const gmshVersionIndex = dockerfile.indexOf("gmsh --version");
    const runtimeCopyIndex = dockerfile.indexOf("COPY --from=build /opencae-core/services/opencae-core-cloud/dist");

    expect(installGitIndex).toBeGreaterThanOrEqual(0);
    expect(ensureCoreIndex).toBeGreaterThan(installGitIndex);
    expect(coreInstallIndex).toBeGreaterThan(ensureCoreIndex);
    expect(coreBuildIndex).toBeGreaterThan(coreInstallIndex);
    expect(solverBuildIndex).toBeGreaterThan(coreBuildIndex);
    expect(serviceBuildIndex).toBeGreaterThan(solverBuildIndex);
    expect(runtimeGmshInstallIndex).toBeGreaterThan(serviceBuildIndex);
    expect(gmshVersionIndex).toBeGreaterThan(runtimeGmshInstallIndex);
    expect(runtimeCopyIndex).toBeGreaterThan(gmshVersionIndex);
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
      new RegExp(expectedContainerApplicationName)
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
