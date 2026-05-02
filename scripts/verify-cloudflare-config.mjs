#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = resolve(import.meta.dirname, "..");
const productionDomain = "cae.esau.app";
const productionWorkerName = "opencae";
const containerClassName = "OpenCaeFeaContainer";
const containerBindingName = "FEA_CONTAINER";

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
    containersConfig: readWranglerConfig(resolve(baseDir, "wrangler.containers.jsonc")),
    staticConfig: readWranglerConfig(resolve(baseDir, "wrangler.jsonc")),
    localFirstConfig: readWranglerConfig(resolve(baseDir, "wrangler.local-first.jsonc"))
  };
}

export function validateCloudflareConfigs({ containersConfig, staticConfig, localFirstConfig }) {
  const failures = [];

  if (containersConfig.name !== productionWorkerName) {
    failures.push(`production config name must be "${productionWorkerName}", got "${String(containersConfig.name)}"`);
  }

  const durableBindings = Array.isArray(containersConfig.durable_objects?.bindings)
    ? containersConfig.durable_objects.bindings
    : [];
  if (!durableBindings.some((binding) => binding?.name === containerBindingName && binding?.class_name === containerClassName)) {
    failures.push(`production config must bind durable object ${containerBindingName} to ${containerClassName}`);
  }

  if (containersConfig.containers?.[0]?.class_name !== containerClassName) {
    failures.push(`production config containers[0].class_name must be "${containerClassName}"`);
  }

  if (!hasCustomDomainRoute(containersConfig, productionDomain)) {
    failures.push(`production config must route ${productionDomain} as a custom domain`);
  }

  const migrations = Array.isArray(containersConfig.migrations) ? containersConfig.migrations : [];
  if (!migrations.some((migration) => migration?.new_sqlite_classes?.includes(containerClassName))) {
    failures.push(`production config migrations must include ${containerClassName}`);
  }

  const runWorkerFirst = containersConfig.assets?.run_worker_first;
  if (!Array.isArray(runWorkerFirst) || !runWorkerFirst.includes("/api/*") || !runWorkerFirst.includes("/health")) {
    failures.push('production config assets.run_worker_first must include "/api/*" and "/health"');
  }

  validateNonProductionConfig("static", staticConfig, containersConfig, failures);
  if (localFirstConfig) validateNonProductionConfig("local-first", localFirstConfig, containersConfig, failures);

  if (failures.length > 0) {
    throw new Error(`Cloudflare config verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function validateNonProductionConfig(label, config, containersConfig, failures) {
  if (config.name === containersConfig.name || config.name === productionWorkerName) {
    failures.push(`${label} config must not share the production Worker name "${containersConfig.name}"`);
  }

  if (hasRoutePattern(config, productionDomain)) {
    failures.push(`${label} config must not route ${productionDomain}`);
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
