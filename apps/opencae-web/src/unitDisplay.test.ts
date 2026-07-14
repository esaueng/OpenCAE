import { describe, expect, test } from "vitest";
import { displayModelForUnits, formatDensity, formatForce, formatLength, formatMass, formatMaterialStress, formatResultProvenanceLabel, formatStress, formatUnitSystemLabel, formatVolume, loadValueForUnits, resultFieldForUnits, resultSummaryForUnits, resultValueForUnits, resultValueFromDisplayUnits } from "./unitDisplay";

describe("unit display formatting", () => {
  test("labels project unit systems for the workspace footer", () => {
    expect(formatUnitSystemLabel("SI")).toBe("Metric · mm");
    expect(formatUnitSystemLabel("US")).toBe("Imperial · in");
  });

  test("formats SI base values as imperial display values", () => {
    expect(formatLength(25.4, "mm", "US")).toBe("1 in");
    expect(formatStress(142, "MPa", "US")).toBe("20.6 ksi");
    expect(formatForce(500, "N", "US")).toBe("112.4 lbf");
    expect(formatVolume(41_280, "mm^3", "US")).toBe("2.519 in^3");
    expect(formatMass(111, "g", "US")).toBe("0.245 lb");
    expect(formatDensity(2700, "kg/m^3", "US")).toBe("168.6 lb/ft^3");
    expect(formatMaterialStress(68_900_000_000, "US")).toBe("9,993.1 ksi");
    expect(loadValueForUnits(6.894757293168361, "kPa", "US")).toEqual({ value: 1, units: "psi" });
    expect(loadValueForUnits(0.45359237, "kg", "US")).toEqual({ value: 1, units: "lb" });
  });

  test("formats small payload volumes without rounding to zero", () => {
    expect(formatVolume(0.0000682, "m^3", "SI")).toBe("68.2 cm^3");
    expect(formatVolume(0.0000682, "m^3", "US")).toBe("4.162 in^3");
  });

  test("converts result summaries and fields without changing safety factors", () => {
    const summary = resultSummaryForUnits({
      maxStress: 142,
      maxStressUnits: "MPa",
      maxDisplacement: 0.184,
      maxDisplacementUnits: "mm",
      safetyFactor: 1.8,
      reactionForce: 500,
      reactionForceUnits: "N",
      transient: {
        analysisType: "dynamic_structural",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.01,
        frameCount: 11,
        peakDisplacementTimeSeconds: 0.08,
        peakDisplacement: 0.184
      }
    }, "US");

    expect(summary.maxStressUnits).toBe("ksi");
    expect(summary.maxDisplacementUnits).toBe("in");
    expect(summary.safetyFactor).toBe(1.8);
    expect(summary.reactionForceUnits).toBe("lbf");
    // transient.peakDisplacement shares maxDisplacementUnits, so it must
    // convert alongside it — a mm value labeled "in" is a silent 25x error.
    expect(summary.transient?.peakDisplacement).toBe(summary.maxDisplacement);

    const field = resultFieldForUnits({
      id: "field-displacement",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [0, 0.254],
      min: 0,
      max: 0.254,
      units: "mm"
    }, "US");

    expect(field.units).toBe("in");
    expect(field.max).toBeCloseTo(0.01);
  });

  test("converts result field data without display rounding (micro-displacement fields keep full precision)", () => {
    // Field values and vectors feed the result render; a stiff part deflecting
    // ~1 µm must not quantize onto a 0.001 mm grid (that crumples the deformed
    // shape once the deformation auto-scale amplifies the steps).
    const field = resultFieldForUnits({
      id: "field-displacement",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [0.0004, 0.0014],
      min: 0.0004,
      max: 0.0014,
      units: "mm",
      vectors: [[0.0004, 0, 0], [0.001, 0, 0.001]]
    }, "SI");

    expect(field.values).toEqual([0.0004, 0.0014]);
    expect(field.min).toBe(0.0004);
    expect(field.max).toBe(0.0014);
    expect(field.vectors).toEqual([[0.0004, 0, 0], [0.001, 0, 0.001]]);
  });

  test("round-trips manual result clamps through display units without changing the physical range", () => {
    const stressField = { type: "stress" as const, units: "MPa" };
    const imperial = resultValueForUnits(stressField, 142, "US");
    expect(imperial.units).toBe("ksi");
    expect(resultValueFromDisplayUnits(stressField, imperial.value, "US")).toBeCloseTo(142, 12);

    const motionField = { type: "velocity" as const, units: "mm/s" };
    const inchesPerSecond = resultValueForUnits(motionField, 25.4, "US");
    expect(inchesPerSecond).toEqual({ value: 1, units: "in/s" });
    expect(resultValueFromDisplayUnits(motionField, 1, "US")).toBeCloseTo(25.4, 12);
  });

  test("formats result provenance labels with Core FEA and preview separated", () => {
    expect(formatResultProvenanceLabel({ kind: "opencae_core_fea", solver: "opencae-core-cloud", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units: "mm-N-s-MPa" })).toBe("OpenCAE Core Cloud");
    expect(formatResultProvenanceLabel({ kind: "opencae_core_fea", solver: "opencae-core-sparse-tet", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units: "mm-N-s-MPa" })).toBe("OpenCAE Core Local");
    expect(formatResultProvenanceLabel({ kind: "opencae_core_fea", solver: ["cloudflare-fea", "calculix"].join("-"), solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units: "mm-N-s-MPa" })).toBe("Legacy backend result");
    expect(formatResultProvenanceLabel({ kind: "local_estimate", solver: "opencae-core-preview-sdof", solverVersion: "0.1.0", meshSource: "structured_block_proxy", resultSource: "computed_preview", units: "mm-N-s-MPa" })).toBe("OpenCAE Core Preview (coarse block proxy)");
    expect(formatResultProvenanceLabel({ kind: "local_estimate", solver: "opencae-local-dynamic-newmark", solverVersion: "0.1.0", meshSource: "mock", resultSource: "generated", units: "mm-N-s-MPa" })).toBe("Estimate (not FEA)");
    expect(formatResultProvenanceLabel({ kind: "analytical_benchmark", solver: "opencae-euler-bernoulli", solverVersion: "0.1.0", meshSource: "structured_block", resultSource: "generated", units: "mm-N-s-MPa" })).toBe("Analytical benchmark");
    expect(formatResultProvenanceLabel(undefined)).toBe("Unknown result source");
  });

  test("converts display model dimensions", () => {
    const displayModel = displayModelForUnits({
      id: "model",
      name: "model",
      bodyCount: 1,
      dimensions: { x: 25.4, y: 50.8, z: 76.2, units: "mm" },
      faces: []
    }, "US");

    expect(displayModel.dimensions).toEqual({ x: 1, y: 2, z: 3, units: "in" });
  });
});
