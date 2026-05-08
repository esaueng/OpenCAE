#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerSource = readFileSync(resolve(rootDir, "apps/opencae-web/worker/index.ts"), "utf8");
const serviceSource = readFileSync(resolve(rootDir, "services/opencae-core-cloud/src/index.ts"), "utf8");

const workerVersion = constantValue(workerSource, "EXPECTED_CORE_CLOUD_RUNNER_VERSION");
const serviceVersion = constantValue(serviceSource, "RUNNER_VERSION");

if (!workerVersion || !serviceVersion || workerVersion !== serviceVersion) {
  console.error(`OpenCAE Core Cloud runner version mismatch: worker=${workerVersion ?? "missing"} service=${serviceVersion ?? "missing"}`);
  process.exit(1);
}

console.log(`OpenCAE Core Cloud runner version verified: ${workerVersion}`);

function constantValue(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*"([^"]+)"`));
  return match?.[1];
}
