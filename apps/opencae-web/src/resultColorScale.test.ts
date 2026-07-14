import { describe, expect, it } from "vitest";
import type { ResultField } from "@opencae/schema";
import {
  automaticResultFieldRange,
  normalizedResultScaleValue,
  resolveResultColorScale,
  resultColorForValue,
  resultScaleCssGradient,
  validManualResultRange
} from "./resultColorScale";

const baseScale = { type: "stress" as const, component: "von_mises" as const, min: 0, max: 100, bands: "continuous" as const };

describe("result color scale", () => {
  it("clamps endpoint colors without changing the supplied numerical value", () => {
    expect(resultColorForValue(-20, baseScale)).toBe(resultColorForValue(0, baseScale));
    expect(resultColorForValue(120, baseScale)).toBe(resultColorForValue(100, baseScale));
    expect(normalizedResultScaleValue(40, baseScale)).toBe(0.4);
  });

  it("uses the same generated colors in the renderer and continuous legend", () => {
    const gradient = resultScaleCssGradient(baseScale);
    expect(gradient).toContain(`${resultColorForValue(0, baseScale)} 0%`);
    expect(gradient).toContain(`${resultColorForValue(100, baseScale)} 100%`);
  });

  it("quantizes values into eight shared bands and changes at boundaries", () => {
    const bands = { ...baseScale, bands: "bands8" as const };
    expect(resultColorForValue(0, bands)).toBe(resultColorForValue(12.499, bands));
    expect(resultColorForValue(12.5, bands)).not.toBe(resultColorForValue(12.499, bands));
    expect(resultScaleCssGradient(bands).match(/%/g)).toHaveLength(16);
  });

  it("keeps low safety values red and high values green", () => {
    const safety = { ...baseScale, type: "safety_factor" as const, component: undefined };
    expect(resultColorForValue(0, safety)).toBe("#ef4444");
    expect(resultColorForValue(100, safety)).toBe("#22c55e");
  });

  it("places the diverging neutral stop at physical zero without forcing symmetry", () => {
    const signed = { ...baseScale, component: "principal_max" as const, min: -20, max: 80 };
    expect(normalizedResultScaleValue(0, signed)).toBe(0.2);
    expect(resultColorForValue(0, signed)).toBe("#f5f5f4");
    expect(resultScaleCssGradient(signed)).toContain("#f5f5f4 20%");
  });

  it("requires finite manual limits separated by a scale-relative epsilon", () => {
    expect(validManualResultRange(1, 2)).toBe(true);
    expect(validManualResultRange(2, 1)).toBe(false);
    expect(validManualResultRange(1e12, 1e12 + 0.1)).toBe(false);
    expect(validManualResultRange(Number.NaN, 2)).toBe(false);
  });

  it("uses the run-wide range for fields with one semantic identity", () => {
    const fields = [
      { id: "a", runId: "run", type: "stress", location: "node", units: "MPa", values: [2], min: 2, max: 4 },
      { id: "b", runId: "run", type: "stress", location: "node", units: "MPa", values: [8], min: -3, max: 8 }
    ] as ResultField[];
    expect(automaticResultFieldRange(fields, (field) => `${field.runId}:${field.type}:${field.location}`, fields[0]!)).toEqual({ min: -3, max: 8 });
  });

  it("falls back to automatic range when a persisted manual range is invalid", () => {
    expect(resolveResultColorScale({
      type: "stress",
      automaticRange: { min: 2, max: 9 },
      setting: { rangeMode: "manual", bands: "continuous", manualMin: 4, manualMax: 4 }
    })).toMatchObject({ min: 2, max: 9 });
  });
});
