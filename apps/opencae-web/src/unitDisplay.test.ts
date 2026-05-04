import { describe, expect, test } from "vitest";
import { displayModelForUnits, formatDensity, formatForce, formatLength, formatMass, formatMaterialStress, formatResultProvenanceLabel, formatStress, formatUnitSystemLabel, formatVolume, loadValueForUnits, resultFieldForUnits, resultSummaryForUnits } from "./unitDisplay";

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
      reactionForceUnits: "N"
    }, "US");

    expect(summary.maxStressUnits).toBe("ksi");
    expect(summary.maxDisplacementUnits).toBe("in");
    expect(summary.safetyFactor).toBe(1.8);
    expect(summary.reactionForceUnits).toBe("lbf");

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

  test("formats result provenance labels without calling local estimates FEA", () => {
    expect(formatResultProvenanceLabel({ kind: "local_estimate", solver: "opencae-local-heuristic-surface", solverVersion: "0.1.0", meshSource: "mock", resultSource: "generated", units: "mm-N-s-MPa" })).toBe("Local estimate");
    expect(formatResultProvenanceLabel({ kind: "analytical_benchmark", solver: "opencae-euler-bernoulli", solverVersion: "0.1.0", meshSource: "structured_block", resultSource: "generated", units: "mm-N-s-MPa" })).toBe("Analytical benchmark");
    expect(formatResultProvenanceLabel({ kind: "opencae_core_fea", solver: "opencae-core-cpu-tet4", solverVersion: "0.1.0", meshSource: "opencae_core_tet4", resultSource: "computed", units: "m-N-s-Pa" })).toBe("OpenCAE Core");
    expect(formatResultProvenanceLabel({ kind: "calculix_fea", solver: "calculix-ccx", solverVersion: "2.21", meshSource: "gmsh", resultSource: "parsed_frd", units: "mm-N-s-MPa" })).toBe("CalculiX FEA");
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
