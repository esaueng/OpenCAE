#!/usr/bin/env node

// Deploy gate for the post-cloud-retirement Cloudflare configs (2026-07).
// The production Worker serves static assets only: simulations run in the
// browser with OpenCAE Core. This script fails the deploy if a config or
// package script quietly reintroduces the retired OpenCAE Core Cloud
// infrastructure (container, Durable Object, R2 artifact bucket) or drops
// the production domain/asset wiring. See docs/cloud-retirement.md.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionDomains = ["cae.esau.app"];
const productionWorkerName = "opencae";
const legacySolverToken = ["calcu", "lix"].join("");
const retiredCloudTokens = ["CORE_CLOUD_CONTAINER", "CORE_CLOUD_ARTIFACTS", "opencae-core-cloud-artifacts"];

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
    packageJson: JSON.parse(readFileSync(resolve(baseDir, "package.json"), "utf8"))
  };
}

export function validateCloudflareConfigs({ defaultConfig, staticConfig, packageJson }) {
  const failures = [];

  if (defaultConfig) validateProductionConfig("default", defaultConfig, failures);
  if (packageJson) validateDeployScripts(packageJson, failures);
  if (staticConfig) {
    validateRetiredCloudAbsent("static", staticConfig, failures);
    validateNonProductionConfig("static", staticConfig, defaultConfig, failures);
  }

  if (failures.length > 0) {
    throw new Error(`Cloudflare config verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function validateProductionConfig(label, config, failures) {
  if (config.name !== productionWorkerName) {
    failures.push(`${label} config name must be "${productionWorkerName}", got "${String(config.name)}"`);
  }

  validateRetiredCloudAbsent(label, config, failures);

  // The checked-in config must carry NO migrations: Workers Builds uploads PR
  // preview versions, and pending Durable Object migrations cannot ride a
  // version upload. The retired container class is deleted via the one-off
  // manual deploy documented in docs/cloud-retirement.md, not the config.
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  if (migrations.length > 0) {
    failures.push(`${label} config must not declare migrations (DO cleanup is a manual deploy step; see docs/cloud-retirement.md)`);
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
  if (config.assets?.binding !== "ASSETS") {
    failures.push(`${label} config must bind Workers Static Assets as ASSETS`);
  }
}

function validateRetiredCloudAbsent(label, config, failures) {
  if (config.containers !== undefined) {
    failures.push(`${label} config must not define containers — the Core Cloud container was retired in 2026-07 (docs/cloud-retirement.md)`);
  }
  if (config.durable_objects !== undefined) {
    failures.push(`${label} config must not bind Durable Objects — the Core Cloud container DO was retired in 2026-07`);
  }
  if (config.r2_buckets !== undefined) {
    failures.push(`${label} config must not bind R2 buckets — the Core Cloud artifact bucket binding was retired in 2026-07`);
  }
  const serialized = JSON.stringify(config);
  if (serialized.toLowerCase().includes(legacySolverToken)) {
    failures.push(`${label} config must not reference legacy solver containers`);
  }
  for (const token of retiredCloudTokens) {
    if (serialized.includes(token)) {
      failures.push(`${label} config must not reference the retired ${token} cloud binding`);
    }
  }
}

function validateDeployScripts(packageJson, failures) {
  const scripts = packageJson?.scripts ?? {};
  if (!String(scripts["deploy:cloudflare"] ?? "").includes("verify:cloudflare-config")) {
    failures.push("deploy:cloudflare must run verify:cloudflare-config before production deployment");
  }
  const serializedScripts = JSON.stringify(scripts);
  if (serializedScripts.includes("wrangler.containers.jsonc") || serializedScripts.includes("wrangler.local-first.jsonc")) {
    failures.push("package scripts must not reference the removed wrangler.containers.jsonc / wrangler.local-first.jsonc configs");
  }
  for (const retiredScript of ["deploy:core-cloud", "deploy:core-cloud:dry-run", "containers:build:core-cloud", "containers:push:core-cloud", "verify:runner-version", "test:core-cloud", "test:core-cloud-container"]) {
    if (scripts[retiredScript] !== undefined) {
      failures.push(`package script ${retiredScript} was retired with the cloud solver and must not return`);
    }
  }
  if (serializedScripts.toLowerCase().includes(legacySolverToken)) {
    failures.push("package scripts must not reference legacy solver containers");
  }
  if (packageJson?.dependencies?.["@cloudflare/containers"] !== undefined) {
    failures.push("@cloudflare/containers must stay removed — the Worker hosts no container");
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
