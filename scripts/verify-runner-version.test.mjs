import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { readRunnerVersionSources, validateRunnerVersionSources } from "./verify-runner-version.mjs";

const rootDir = resolve(import.meta.dirname, "..");

describe("Cloud FEA runner version guard", () => {
  test("passes when Worker expected version matches the container RUNNER_VERSION file", () => {
    const sources = readRunnerVersionSources(rootDir);

    expect(() => validateRunnerVersionSources(sources)).not.toThrow();
  });

  test("fails when Worker expected version and RUNNER_VERSION file differ", () => {
    const sources = readRunnerVersionSources(rootDir);
    const mismatchedWorkerSource = sources.workerSource.replace(
      /EXPECTED_FEA_RUNNER_VERSION = "[^"]+"/,
      'EXPECTED_FEA_RUNNER_VERSION = "2026-05-02-previous-runner"'
    );

    expect(() => validateRunnerVersionSources({
      runnerVersion: sources.runnerVersion,
      workerSource: mismatchedWorkerSource
    })).toThrow(/must match services\/opencae-fea-container\/RUNNER_VERSION/);
  });

  test("fails when Worker expected version cannot be parsed", () => {
    const runnerVersion = readFileSync(resolve(rootDir, "services/opencae-fea-container/RUNNER_VERSION"), "utf8").trim();

    expect(() => validateRunnerVersionSources({
      runnerVersion,
      workerSource: "const OTHER_VERSION = \"2026-05-03-solver-timeout-v1\";"
    })).toThrow(/Could not find EXPECTED_FEA_RUNNER_VERSION/);
  });
});
