#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = resolve(import.meta.dirname, "..");
const productionDomain = "cae.esau.app";
const productionWorkerName = "opencae-alpha";

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
    containersConfig: readWranglerConfig(resolve(baseDir, "wrangler.containers.jsonc")),
    staticConfig: readWranglerConfig(resolve(baseDir, "wrangler.static.jsonc")),
    localFirstConfig: readWranglerConfig(resolve(baseDir, "wrangler.local-first.jsonc"))
  };
}

export function validateCloudflareConfigs({ defaultConfig, containersConfig, staticConfig, localFirstConfig }) {
  const failures = [];

  if (defaultConfig) validateProductionConfig("default", defaultConfig, failures);

  validateNonProductionConfig("static", staticConfig, defaultConfig, failures);
  if (localFirstConfig) validateNonProductionConfig("local-first", localFirstConfig, defaultConfig, failures);
  if (containersConfig) validateReferenceContainerConfig("legacy containers", containersConfig, failures);

  if (failures.length > 0) {
    throw new Error(`Cloudflare config verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function validateProductionConfig(label, config, failures) {
  if (config.name !== productionWorkerName) {
    failures.push(`${label} config name must be "${productionWorkerName}", got "${String(config.name)}"`);
  }

  if (config.durable_objects || config.containers || config.migrations) {
    failures.push(`${label} config must not bind Cloud FEA containers; browser OpenCAE Core is the default runtime`);
  }

  if (!hasCustomDomainRoute(config, productionDomain)) {
    failures.push(`${label} config must route ${productionDomain} as a custom domain`);
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

  if (hasRoutePattern(config, productionDomain)) {
    failures.push(`${label} config must not route ${productionDomain}`);
  }
}

function validateReferenceContainerConfig(_label, _config, _failures) {
  if (_config.name !== productionWorkerName) {
    _failures.push(`${_label} config name must match "${productionWorkerName}" when deployed from the alpha Workers project`);
  }

  const containerName = _config.containers?.[0]?.name;
  if (containerName !== `${productionWorkerName}-opencaefeacontainer`) {
    _failures.push(`${_label} container application name must be "${productionWorkerName}-opencaefeacontainer", got "${String(containerName)}"`);
  }

  // Legacy container config is kept as a reference/manual experiment artifact.
  // The default production deploy is intentionally validated by wrangler.jsonc.
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
