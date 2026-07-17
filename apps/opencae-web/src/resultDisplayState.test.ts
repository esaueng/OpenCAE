import { describe, expect, test } from "vitest";
import type { ResultField, ResultSummary } from "@opencae/schema";
import { isResultDisplayEligible, resultSummaryMatchesStudy } from "./resultDisplayState";

const structuralSummary: ResultSummary = {
  maxStress: 10,
  maxStressUnits: "MPa",
  maxDisplacement: 0.1,
  maxDisplacementUnits: "mm",
  safetyFactor: 2,
  reactionForce: 100,
  reactionForceUnits: "N"
};

const stressField: ResultField = {
  id: "stress",
  runId: "run-static",
  type: "stress",
  location: "node",
  values: [10],
  min: 10,
  max: 10,
  units: "MPa"
};

describe("result display eligibility", () => {
  test("matches each summary family only to its owning study type", () => {
    expect(resultSummaryMatchesStudy(structuralSummary, "static_stress")).toBe(true);
    expect(resultSummaryMatchesStudy(structuralSummary, "steady_state_thermal")).toBe(false);
    expect(resultSummaryMatchesStudy({
      ...structuralSummary,
      transient: {
        analysisType: "dynamic_structural",
        startTime: 0,
        endTime: 1,
        timeStep: 0.01,
        outputInterval: 0.1,
        frameCount: 11,
        peakDisplacementTimeSeconds: 1,
        peakDisplacement: 0.1
      }
    }, "dynamic_structural")).toBe(true);
    expect(resultSummaryMatchesStudy({
      analysisType: "modal_analysis",
      requestedModeCount: 1,
      convergedModeCount: 1,
      modes: [{ modeIndex: 1, frequencyHz: 20, eigenvalue: 4, scaledResidual: 1e-8, fieldId: "mode-1" }]
    }, "modal_analysis")).toBe(true);
    expect(resultSummaryMatchesStudy({
      analysisType: "steady_state_thermal",
      minTemperature: 20,
      maxTemperature: 50,
      temperatureUnits: "°C",
      maxHeatFlux: 100,
      heatFluxUnits: "W/m²",
      appliedHeat: 10,
      generatedHeat: 0,
      reactionHeat: -10,
      heatRateUnits: "W",
      energyBalanceRelativeError: 0
    }, "steady_state_thermal")).toBe(true);
  });

  test("requires a current-run field for the selected result mode", () => {
    const base = {
      studyType: "static_stress" as const,
      summary: structuralSummary,
      fields: [stressField],
      completedRunId: "run-static",
      resultMode: "stress" as const
    };
    expect(isResultDisplayEligible(base)).toBe(true);
    expect(isResultDisplayEligible({ ...base, summary: null })).toBe(false);
    expect(isResultDisplayEligible({ ...base, fields: [] })).toBe(false);
    expect(isResultDisplayEligible({ ...base, completedRunId: "run-other" })).toBe(false);
    expect(isResultDisplayEligible({ ...base, studyType: "steady_state_thermal" })).toBe(false);
    expect(isResultDisplayEligible({ ...base, resultMode: "displacement" })).toBe(false);
  });
});
