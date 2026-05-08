#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionDomains = ["cae.esau.app"];
const productionWorkerName = "opencae";
const productionDeletionMigration = { tag: "v2-delete-cloud-fea-container", deleted_classes: ["OpenCaeFeaContainer"] };

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
    containerConfig: readWranglerConfig(resolve(baseDir, "wrangler.containers.jsonc"))
  };
}

export function validateCloudflareConfigs({ defaultConfig, staticConfig, localFirstConfig, containerConfig }) {
  const failures = [];

  if (defaultConfig) validateProductionConfig("default", defaultConfig, failures);
  if (containerConfig) validateCoreCloudContainerConfig("container", containerConfig, failures);

  validateNonProductionConfig("static", staticConfig, defaultConfig, failures);
  if (localFirstConfig) validateNonProductionConfig("local-first", localFirstConfig, defaultConfig, failures);

  if (failures.length > 0) {
    throw new Error(`Cloudflare config verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function validateCoreCloudContainerConfig(label, config, failures) {
  if (config.name !== productionWorkerName) {
    failures.push(`${label} config name must be "${productionWorkerName}", got "${String(config.name)}"`);
  }
  if (JSON.stringify(config).toLowerCase().includes("calculix")) {
    failures.push(`${label} config must not reference CalculiX`);
  }
  if (JSON.stringify(config).includes("OpenCaeFeaContainer") || JSON.stringify(config).includes("FEA_CONTAINER")) {
    failures.push(`${label} config must use CORE_CLOUD_CONTAINER and OpenCaeCoreCloudContainer`);
  }
  const container = Array.isArray(config.containers) ? config.containers[0] : undefined;
  if (
    !container ||
    container.name !== "opencae-core-cloud" ||
    container.class_name !== "OpenCaeCoreCloudContainer" ||
    container.image !== "./services/opencae-core-cloud/Dockerfile"
  ) {
    failures.push(`${label} config must define the opencae-core-cloud container image and class`);
  }
  const binding = config.durable_objects?.bindings?.[0];
  if (!binding || binding.name !== "CORE_CLOUD_CONTAINER" || binding.class_name !== "OpenCaeCoreCloudContainer") {
    failures.push(`${label} config must bind CORE_CLOUD_CONTAINER to OpenCaeCoreCloudContainer`);
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
  if (config.name !== productionWorkerName) {
    failures.push(`${label} config name must be "${productionWorkerName}", got "${String(config.name)}"`);
  }

  if (config.durable_objects || config.containers) {
    failures.push(`${label} config must not bind container solvers; browser OpenCAE Core is the runtime`);
  }

  if (!isAllowedProductionMigration(config.migrations)) {
    failures.push(`${label} config may only include the legacy container deletion migration`);
  }

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

function isAllowedProductionMigration(migrations) {
  if (migrations === undefined) return true;
  if (!Array.isArray(migrations) || migrations.length !== 1) return false;

  const migration = migrations[0];
  const keys = Object.keys(migration ?? {}).sort();
  return (
    keys.length === 2 &&
    keys[0] === "deleted_classes" &&
    keys[1] === "tag" &&
    migration.tag === productionDeletionMigration.tag &&
    Array.isArray(migration.deleted_classes) &&
    migration.deleted_classes.length === 1 &&
    migration.deleted_classes[0] === productionDeletionMigration.deleted_classes[0]
  );
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
