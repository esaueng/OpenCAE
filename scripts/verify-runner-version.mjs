#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(import.meta.dirname, "..");
const runnerVersionRelativePath = "services/opencae-fea-container/RUNNER_VERSION";
const workerRelativePath = "apps/opencae-web/worker/index.ts";

export function readRunnerVersionSources(baseDir = rootDir) {
  return {
    runnerVersion: readFileSync(resolve(baseDir, runnerVersionRelativePath), "utf8").trim(),
    workerSource: readFileSync(resolve(baseDir, workerRelativePath), "utf8")
  };
}

export function expectedRunnerVersionFromWorkerSource(workerSource) {
  const match = /const\s+EXPECTED_FEA_RUNNER_VERSION\s*=\s*"([^"]+)"/.exec(workerSource);
  if (!match?.[1]) {
    throw new Error(`Could not find EXPECTED_FEA_RUNNER_VERSION in ${workerRelativePath}.`);
  }
  return match[1];
}

export function validateRunnerVersionSources({ runnerVersion, workerSource }) {
  const normalizedRunnerVersion = String(runnerVersion || "").trim();
  if (!normalizedRunnerVersion) {
    throw new Error(`${runnerVersionRelativePath} must contain a non-empty runner version.`);
  }
  const workerExpectedRunnerVersion = expectedRunnerVersionFromWorkerSource(workerSource);
  if (workerExpectedRunnerVersion !== normalizedRunnerVersion) {
    throw new Error(
      `Worker EXPECTED_FEA_RUNNER_VERSION "${workerExpectedRunnerVersion}" must match ${runnerVersionRelativePath} "${normalizedRunnerVersion}".`
    );
  }
  return { runnerVersion: normalizedRunnerVersion, workerExpectedRunnerVersion };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = validateRunnerVersionSources(readRunnerVersionSources(rootDir));
    console.log(`Cloud FEA runner version verified: ${result.runnerVersion}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
