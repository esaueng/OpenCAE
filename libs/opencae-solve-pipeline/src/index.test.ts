import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { OpenCAEModelJson } from "@opencae/core";
import {
  BROWSER_SOLVE_LIMITS,
  CLOUD_SOLVER_LIMITS,
  DEFAULT_DYNAMIC_MS_PER_STEP,
  dynamicIntegrationSteps,
  estimateDynamicRuntime,
  solveStudyModelWithCorePipeline,
  type SolveProgressEvent
} from "./index";

const FIXTURE_DIR = resolve(__dirname, "../../../apps/opencae-web/src/testdata/core-cloud-golden");

function fixtureModel(name: string): OpenCAEModelJson {
  const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as {
    response: { artifacts: { generatedCoreModel: OpenCAEModelJson } };
  };
  return structuredClone(fixture.response.artifacts.generatedCoreModel);
}

describe("browser solve limits", () => {
  test("browser limits deviate from cloud limits only where documented", () => {
    expect(BROWSER_SOLVE_LIMITS).toEqual({
      ...CLOUD_SOLVER_LIMITS,
      maxDofs: 60000,
      transientFieldBytes: 256e6,
      maxTimeSteps: 20000
    });
  });

  test("running under browser limits surfaces the deviation in diagnostics", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress",
      limits: BROWSER_SOLVE_LIMITS
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const deviation = outcome.result.diagnostics.find(
      (entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === "browser-solve-limits"
    ) as { deviations?: Record<string, { applied: number; cloud: number }> } | undefined;
    expect(deviation).toBeDefined();
    expect(deviation?.deviations).toEqual({
      maxDofs: { applied: 60000, cloud: 100000 },
      transientFieldBytes: { applied: 256e6, cloud: 1.5e9 },
      maxTimeSteps: { applied: 20000, cloud: 100000 }
    });
  });

  test("running at cloud limits emits no deviation diagnostic (parity mode)", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress",
      limits: CLOUD_SOLVER_LIMITS
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.diagnostics.some(
      (entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === "browser-solve-limits"
    )).toBe(false);
  });
});

describe("dynamic runtime guards", () => {
  test("estimateDynamicRuntime multiplies steps by the calibrated pace", () => {
    expect(estimateDynamicRuntime({ steps: 100, calibratedMsPerStep: 12 })).toEqual({
      steps: 100,
      calibratedMsPerStep: 12,
      estimatedMs: 1200
    });
    expect(estimateDynamicRuntime({ steps: 10 }).estimatedMs).toBe(10 * DEFAULT_DYNAMIC_MS_PER_STEP);
    expect(estimateDynamicRuntime({ steps: -5 }).estimatedMs).toBe(0);
  });

  test("dynamicIntegrationSteps derives step counts from bounded settings", () => {
    expect(dynamicIntegrationSteps({ startTime: 0, endTime: 0.05, timeStep: 0.005 })).toBe(10);
    expect(dynamicIntegrationSteps({ startTime: 0, endTime: 0, timeStep: 0.005 })).toBe(0);
  });

  test("rejects dynamic solves above the browser step budget with an honest error", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-dynamic"),
      analysisType: "dynamic_structural",
      // 10 s at the minimum 0.1 ms time step = 100k steps, above the 20k cap.
      solverSettings: { startTime: 0, endTime: 10, timeStep: 0.0001, outputInterval: 0.005 },
      limits: BROWSER_SOLVE_LIMITS
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("dynamic-step-budget-exceeded");
    expect(outcome.error.message).toContain("integration steps");
    expect(outcome.error.message).toContain("OpenCAE Core Cloud");
  });

  test("rejects dynamic solves whose model exceeds the browser DOF budget", () => {
    const model = fixtureModel("beam-dynamic");
    const outcome = solveStudyModelWithCorePipeline({
      model,
      analysisType: "dynamic_structural",
      limits: { ...BROWSER_SOLVE_LIMITS, maxDofs: 10 }
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("max-dofs-exceeded");
  });
});

describe("hooks", () => {
  test("forwards solver progress events and honors cooperative cancel", () => {
    const phases = new Set<string>();
    let cancelAfterAssemble = false;
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress",
      limits: BROWSER_SOLVE_LIMITS,
      hooks: {
        onProgress: (event: SolveProgressEvent) => {
          phases.add(event.phase);
          if (event.phase === "solve") cancelAfterAssemble = true;
        },
        shouldCancel: () => cancelAfterAssemble
      }
    });
    expect(phases.has("assemble")).toBe(true);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("cancelled");
  });

  test("stamps browser runner provenance on successful solves", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress"
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.solver).toBe("opencae-core-cloud");
    expect(outcome.result.provenance.runnerVersion).toBe("browser-0.1.0");
    expect(outcome.result.summary.provenance).toEqual(outcome.result.provenance);
  });
});
