#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
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

// The deployed container image is built from the sibling OpenCAE-Core checkout
// (see services/opencae-core-cloud/Dockerfile), not from this repo's mirror of
// the service. Cross-check the sibling's runner version so bumping the local
// RUNNER_VERSION without updating the pinned OpenCAE Core ref fails the deploy
// gate instead of failing closed in production.
const coreDir = resolve(process.env.OPENCAE_CORE_DIR ?? resolve(rootDir, "../opencae-core"));
const siblingVersionPath = resolve(coreDir, "services/opencae-core-cloud/RUNNER_VERSION");
if (existsSync(siblingVersionPath)) {
  const siblingVersion = readFileSync(siblingVersionPath, "utf8").trim();
  if (siblingVersion !== versionFile) {
    console.error(`OpenCAE Core Cloud runner version mismatch with the deployed sibling checkout: local=${versionFile} sibling=${siblingVersion} (${siblingVersionPath}).`);
    console.error("Update services/opencae-core-cloud/OPENCAE_CORE_REF to a commit whose runner version matches, or align RUNNER_VERSION.");
    process.exit(1);
  }
} else if (existsSync(coreDir)) {
  console.error(`OpenCAE Core checkout at ${coreDir} has no services/opencae-core-cloud/RUNNER_VERSION file; cannot verify the deployed runner version.`);
  process.exit(1);
} else {
  console.warn(`OpenCAE Core sibling checkout not found at ${coreDir}; skipping deployed runner version cross-check (run pnpm ensure:core first for deploys).`);
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
