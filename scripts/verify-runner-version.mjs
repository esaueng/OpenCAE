#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerSource = readFileSync(resolve(rootDir, "apps/opencae-web/worker/index.ts"), "utf8");
const serviceSource = readFileSync(resolve(rootDir, "services/opencae-core-cloud/src/index.ts"), "utf8");
const versionFile = readFileSync(resolve(rootDir, "services/opencae-core-cloud/RUNNER_VERSION"), "utf8").trim();

const workerVersion = constantValue(workerSource, "EXPECTED_CORE_CLOUD_RUNNER_VERSION");

if (!workerVersion || !versionFile || workerVersion !== versionFile) {
  console.error(`OpenCAE Core Cloud runner version mismatch: worker=${workerVersion ?? "missing"} file=${versionFile || "missing"}`);
  process.exit(1);
}

if (!serviceSource.includes("RUNNER_VERSION") || !serviceSource.includes("RUNNER_VERSION\", import.meta.url")) {
  console.error("OpenCAE Core Cloud service must read runner version from services/opencae-core-cloud/RUNNER_VERSION");
  process.exit(1);
}

if (!workerSource.includes("coreCloudContainerInstanceName") || !workerSource.includes("EXPECTED_CORE_CLOUD_RUNNER_VERSION")) {
  console.error("OpenCAE Core Cloud Worker must use the expected runner version in the container instance name.");
  process.exit(1);
}

console.log(`OpenCAE Core Cloud runner version verified: ${versionFile}`);

function constantValue(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*"([^"]+)"`));
  return match?.[1];
}
