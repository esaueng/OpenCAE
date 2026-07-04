#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionDomains = ["cae.esau.app"];
const productionWorkerName = "opencae";
const legacySolverToken = ["calcu", "lix"].join("");
const expectedCoreCloudRunnerVersion = readFileSync(resolve(rootDir, "services/opencae-core-cloud/RUNNER_VERSION"), "utf8").trim();
// Three version tokens exist on purpose and only two must match:
// - RUNNER_VERSION (services/opencae-core-cloud/RUNNER_VERSION) must equal the
//   container image tag and the Durable Object instance name in the worker.
// - The Cloudflare container *application* name below was created as 0.1.1 and
//   is intentionally not renamed on runner bumps, because renaming a container
//   application replaces it in Cloudflare. Update it only as a deliberate
//   infrastructure migration.
const expectedCoreCloudContainerName = "opencae-core-cloud-0.1.1";

export function parseJsonc(source, label = "JSONC input") {
  try {
    return JSON.parse(stripJsoncComments(source));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSONC: ${message}`);
  }
}

export function readCloudflareConfigs(baseDir = rootDir) {
  return {
    defaultConfig: readWranglerConfig(resolve(baseDir, "wrangler.jsonc")),
    staticConfig: readWranglerConfig(resolve(baseDir, "wrangler.static.jsonc")),
    localFirstConfig: readWranglerConfig(resolve(baseDir, "wrangler.local-first.jsonc")),
    containerConfig: readWranglerConfig(resolve(baseDir, "wrangler.containers.jsonc")),
    packageJson: JSON.parse(readFileSync(resolve(baseDir, "package.json"), "utf8"))
  };
}

export function validateCloudflareConfigs({ defaultConfig, staticConfig, localFirstConfig, containerConfig, packageJson }) {
  const failures = [];

  if (defaultConfig) validateProductionConfig("default", defaultConfig, failures);
  if (containerConfig) validateCoreCloudContainerConfig("container", containerConfig, failures);
  if (defaultConfig && containerConfig && JSON.stringify(defaultConfig) !== JSON.stringify(containerConfig)) {
    failures.push("wrangler.jsonc must mirror wrangler.containers.jsonc exactly so a default deploy cannot publish an unbound Worker");
  }
  if (packageJson) validateCoreCloudScripts(packageJson, failures);

  validateNonProductionConfig("static", staticConfig, defaultConfig, failures);
  if (localFirstConfig) validateNonProductionConfig("local-first", localFirstConfig, defaultConfig, failures);

  if (failures.length > 0) {
    throw new Error(`Cloudflare config verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function validateCoreCloudScripts(packageJson, failures) {
  const scripts = packageJson?.scripts ?? {};
  const expectedImageTag = `opencae/opencae-core-cloud:${expectedCoreCloudRunnerVersion}`;
  if (!String(scripts["deploy:cloudflare"] ?? "").includes("verify:runner-version")) {
    failures.push("deploy:cloudflare must run verify:runner-version before production deployment");
  }
  if (!String(scripts["deploy:cloudflare"] ?? "").includes("wrangler.containers.jsonc")) {
    failures.push("deploy:cloudflare must deploy production with wrangler.containers.jsonc");
  }
  if (!String(scripts["deploy:cloudflare"] ?? "").includes("--containers-rollout=immediate")) {
    failures.push("deploy:cloudflare must roll out the Core Cloud container immediately");
  }
  if (!String(scripts["deploy:cloudflare:dry-run"] ?? "").includes("wrangler.containers.jsonc --dry-run")) {
    failures.push("deploy:cloudflare:dry-run must dry-run the Core Cloud production config");
  }
  if (!String(scripts["deploy:core-cloud"] ?? "").includes("verify:runner-version")) {
    failures.push("deploy:core-cloud must run verify:runner-version before deployment");
  }
  if (!String(scripts["deploy:core-cloud"] ?? "").includes("wrangler.containers.jsonc")) {
    failures.push("deploy:core-cloud must deploy with wrangler.containers.jsonc");
  }
  // The container Docker build fetches the OPENCAE_CORE_REF pin from the Core remote;
  // an unpushed pin would otherwise fail deep inside the image build (or worse, gate
  // production on a runner version whose container can never be built). Every path
  // that builds or deploys the container must run the fast reachability check first.
  for (const script of ["deploy:cloudflare", "deploy:cloudflare:dry-run", "deploy:core-cloud", "deploy:core-cloud:dry-run", "containers:build:core-cloud"]) {
    if (!String(scripts[script] ?? "").includes("verify:core-ref")) {
      failures.push(`${script} must run verify:core-ref so an unpushed OPENCAE_CORE_REF pin fails fast with an actionable error`);
    }
  }
  if (!String(scripts["containers:build:core-cloud"] ?? "").includes(expectedImageTag)) {
    failures.push(`containers:build:core-cloud must build ${expectedImageTag}`);
  }
  if (!String(scripts["containers:push:core-cloud"] ?? "").includes(expectedImageTag)) {
    failures.push(`containers:push:core-cloud must push ${expectedImageTag}`);
  }
  if (scripts["test:core-cloud-container"] !== "pnpm --filter @opencae/core-cloud test") {
    failures.push("test:core-cloud-container must run the OpenCAE Core Cloud service tests");
  }
}

function validateCoreCloudContainerConfig(label, config, failures) {
  if (config.name !== productionWorkerName) {
    failures.push(`${label} config name must be "${productionWorkerName}", got "${String(config.name)}"`);
  }
  if (JSON.stringify(config).toLowerCase().includes(legacySolverToken)) {
    failures.push(`${label} config must not reference legacy solver containers`);
  }
  if (JSON.stringify(config).includes("OpenCaeFeaContainer") || JSON.stringify(config).includes("FEA_CONTAINER")) {
    failures.push(`${label} config must use CORE_CLOUD_CONTAINER and OpenCaeCoreCloudContainer`);
  }
  const container = Array.isArray(config.containers) ? config.containers[0] : undefined;
  if (
    !container ||
    container.name !== expectedCoreCloudContainerName ||
    container.class_name !== "OpenCaeCoreCloudContainer" ||
    container.image !== "./services/opencae-core-cloud/Dockerfile"
  ) {
    failures.push(`${label} config must define the ${expectedCoreCloudContainerName} container image and class`);
  }
  const binding = config.durable_objects?.bindings?.[0];
  if (!binding || binding.name !== "CORE_CLOUD_CONTAINER" || binding.class_name !== "OpenCaeCoreCloudContainer") {
    failures.push(`${label} config must bind CORE_CLOUD_CONTAINER to OpenCaeCoreCloudContainer`);
  }
  const r2Binding = Array.isArray(config.r2_buckets) ? config.r2_buckets.find((bucket) => bucket?.binding === "CORE_CLOUD_ARTIFACTS") : undefined;
  if (!r2Binding) {
    failures.push(`${label} config must bind CORE_CLOUD_ARTIFACTS for run requests, events, and results`);
  }
  if (!Array.isArray(config.migrations) || !config.migrations.some((migration) => Array.isArray(migration?.new_sqlite_classes) && migration.new_sqlite_classes.includes("OpenCaeCoreCloudContainer"))) {
    failures.push(`${label} config must add an OpenCaeCoreCloudContainer Durable Object migration`);
  }
  for (const productionDomain of productionDomains) {
    if (!hasCustomDomainRoute(config, productionDomain)) {
      failures.push(`${label} config must route ${productionDomain} as a custom domain`);
    }
  }
}

function validateProductionConfig(label, config, failures) {
  validateCoreCloudContainerConfig(label, config, failures);

  for (const productionDomain of productionDomains) {
    if (!hasCustomDomainRoute(config, productionDomain)) {
      failures.push(`${label} config must route ${productionDomain} as a custom domain`);
    }
  }

  const runWorkerFirst = config.assets?.run_worker_first;
  if (!Array.isArray(runWorkerFirst) || !runWorkerFirst.includes("/api/*") || !runWorkerFirst.includes("/health")) {
    failures.push(`${label} config assets.run_worker_first must include "/api/*" and "/health"`);
  }
}

function validateNonProductionConfig(label, config, productionConfig, failures) {
  if (config.name === productionConfig?.name || config.name === productionWorkerName) {
    failures.push(`${label} config must not share the production Worker name "${productionConfig?.name ?? productionWorkerName}"`);
  }

  for (const productionDomain of productionDomains) {
    if (hasRoutePattern(config, productionDomain)) {
      failures.push(`${label} config must not route ${productionDomain}`);
    }
  }
}

function readWranglerConfig(path) {
  return parseJsonc(readFileSync(path, "utf8"), path);
}

function hasCustomDomainRoute(config, pattern) {
  return Array.isArray(config.routes) && config.routes.some((route) => route?.pattern === pattern && route?.custom_domain === true);
}

function hasRoutePattern(config, pattern) {
  return Array.isArray(config.routes) && config.routes.some((route) => route?.pattern === pattern);
}

function stripJsoncComments(source) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      output += " ";
      continue;
    }

    output += char;
  }

  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateCloudflareConfigs(readCloudflareConfigs());
    console.log("Cloudflare config verification passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
