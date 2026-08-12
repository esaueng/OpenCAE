import { describe, expect, test } from "vitest";
import { defaultSolverMethodForStudy, displayModelForUnits, formatDensity, formatDisplayNumber, formatForce, formatLength, formatMass, formatMaterialStress, formatResultMetric, formatResultNumber, formatResultProvenanceLabel, formatStress, formatUnitSystemLabel, formatVolume, loadValueForUnits, resultFieldForUnits, resultSummaryForUnits, resultValueForUnits, resultValueFromDisplayUnits } from "./unitDisplay";

describe("unit display formatting", () => {
  test("uses one canonical solver method for each study type", () => {
    expect(defaultSolverMethodForStudy({ type: "static_stress" })).toBe("sparse_static");
    expect(defaultSolverMethodForStudy({ type: "dynamic_structural" })).toBe("mdof_dynamic");
    expect(defaultSolverMethodForStudy({ type: "modal_analysis" })).toBe("block_shift_invert_modal");
    expect(defaultSolverMethodForStudy({ type: "steady_state_thermal" })).toBe("sparse_steady_thermal");
  });

  test("formats solver metrics with adaptive precision", () => {
    // Every readout — panel, report, unitless scalar — goes through one
    // formatter whose precision follows magnitude, so nothing rounds twice.
    expect(formatResultMetric(24.830578943767595, "°C")).toBe("24.83 °C");
    expect(formatResultMetric(19207.968569501394, "W/m²")).toBe("19,208 W/m²");
    expect(formatResultMetric(5.955570096632689e-9, "%")).toBe("5.956e-9 %");
    expect(formatResultNumber(151.10482851265246)).toBe("151.1");
    expect(formatResultNumber(1.8)).toBe("1.8");
    expect(formatResultMetric(1, undefined)).toBe("Unit missing");
  });

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

  test("adapts display precision so a nonzero quantity never prints as zero", () => {
    // The reported defect: a 0.001 mm deflection is 0.00003937 in, and a fixed
    // three-decimal rendering printed the imperial summary as "0 in".
    expect(formatLength(0.001, "mm", "US")).toBe("0.00003937 in");
    expect(formatLength(0.001, "mm", "SI")).toBe("0.001 mm");
    // Below the significant-figure floor, exponent notation beats a run of
    // leading zeros — but the value is still not zero.
    expect(formatDisplayNumber(5.955570096632689e-9)).toBe("5.956e-9");
    expect(formatDisplayNumber(0)).toBe("0");
    expect(formatDisplayNumber(Number.NaN)).toBe("NaN");
  });

  test("keeps fixed-decimal rendering unchanged above the small-magnitude floor", () => {
    // Everything at ordinary engineering magnitudes must format exactly as it
    // did before precision became adaptive.
    expect(formatDisplayNumber(9993.100129611415)).toBe("9,993.1");
    expect(formatDisplayNumber(151.10482851265246)).toBe("151.1");
    expect(formatDisplayNumber(20.59535875768971)).toBe("20.6");
    expect(formatDisplayNumber(2.519060156230549)).toBe("2.519");
    expect(formatDisplayNumber(0.0012345)).toBe("0.001");
  });

  test("converts result summaries without rounding the converted magnitudes", () => {
    // Rounding belongs at the string boundary. A summary that rounds here
    // destroys small imperial displacements before anything can format them.
    const summary = resultSummaryForUnits({
      maxStress: 142,
      maxStressUnits: "MPa",
      maxDisplacement: 0.001,
      maxDisplacementUnits: "mm",
      safetyFactor: 1.8,
      reactionForce: 500,
      reactionForceUnits: "N"
    }, "US");

    expect(summary.maxDisplacement).toBeCloseTo(0.001 / 25.4, 12);
    expect(summary.maxDisplacement).not.toBe(0);
    expect(formatResultMetric(summary.maxDisplacement, summary.maxDisplacementUnits)).toBe("0.00003937 in");
  });

  test("keeps a converged thermal energy balance error visible in the report", () => {
    // reportData prints `energyBalanceRelativeError * 100`; pre-rounding turned
    // a converged 1e-6 balance into "0 %".
    expect(formatResultMetric(1e-6 * 100, "%")).toBe("0.0001 %");
    expect(formatResultMetric(5.955570096632689e-9 * 100, "%")).toBe("5.956e-7 %");
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

    const celsiusField = { type: "temperature" as const, units: "°C" };
    expect(resultValueForUnits(celsiusField, 20, "US")).toEqual({ value: 68, units: "°F" });
    expect(resultValueFromDisplayUnits(celsiusField, 68, "US")).toBeCloseTo(20, 12);

    const fahrenheitField = { type: "temperature" as const, units: "°F" };
    expect(resultValueForUnits(fahrenheitField, 68, "SI")).toEqual({ value: 20, units: "°C" });
    expect(resultValueFromDisplayUnits(fahrenheitField, 20, "SI")).toBeCloseTo(68, 12);
  });

  test("converts raw stress tensors with the scalar field without rounding", () => {
    const field = resultFieldForUnits({
      id: "stress",
      runId: "run",
      type: "stress",
      component: "von_mises",
      location: "node",
      values: [100],
      tensorValues: [100, -25, 0, 12.5, 0, 0],
      min: 100,
      max: 100,
      units: "MPa"
    }, "US");
    expect(field.units).toBe("ksi");
    expect(field.tensorValues?.[0]).toBeCloseTo(14.5037738, 6);
    expect(field.tensorValues?.[1]).toBeCloseTo(-3.62594345, 6);
  });

  test("formats result provenance labels with Core FEA and preview separated", () => {
    expect(formatResultProvenanceLabel({ kind: "opencae_core_fea", solver: "opencae-core-cloud", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units: "mm-N-s-MPa" })).toBe("OpenCAE Core Cloud");
    expect(formatResultProvenanceLabel({ kind: "opencae_core_fea", solver: "opencae-core-sparse-tet", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units: "mm-N-s-MPa" })).toBe("OpenCAE Core Local");
    expect(formatResultProvenanceLabel({ kind: "opencae_core_fea", solver: "opencae-core-sparse-tet", solverVersion: "0.1.0", meshSource: "structured_block_core", resultSource: "computed", units: "mm-N-s-MPa" })).toBe("OpenCAE Core Preview (coarse block proxy)");
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
