import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { readRunnerVersionSources, validateRunnerVersionSources } from "./verify-runner-version.mjs";

const rootDir = resolve(import.meta.dirname, "..");

describe("Cloud FEA runner version guard", () => {
  test("skips when the default Worker does not bind the legacy container runner", () => {
    const sources = readRunnerVersionSources(rootDir);
    const result = validateRunnerVersionSources(sources);

    expect(result).toMatchObject({
      runnerVersion: sources.runnerVersion,
      workerExpectedRunnerVersion: null,
      skipped: true
    });
  });

  test("fails when Worker expected version and RUNNER_VERSION file differ", () => {
    const sources = readRunnerVersionSources(rootDir);
    const mismatchedWorkerSource = `${sources.workerSource}\nconst EXPECTED_FEA_RUNNER_VERSION = "2026-05-02-previous-runner";`;

    expect(() => validateRunnerVersionSources({
      runnerVersion: sources.runnerVersion,
      workerSource: mismatchedWorkerSource
    })).toThrow(/must match services\/opencae-fea-container\/RUNNER_VERSION/);
  });

  test("passes as skipped when Worker expected version cannot be parsed", () => {
    const runnerVersion = readFileSync(resolve(rootDir, "services/opencae-fea-container/RUNNER_VERSION"), "utf8").trim();

    expect(validateRunnerVersionSources({
      runnerVersion,
      workerSource: "const OTHER_VERSION = \"2026-05-03-solver-timeout-v1\";"
    })).toMatchObject({ skipped: true, workerExpectedRunnerVersion: null });
  });
});
