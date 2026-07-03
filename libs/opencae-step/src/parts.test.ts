import { describe, expect, it } from "vitest";
import {
  PARAMETRIC_PARTS,
  buildParametricPartStep,
  defaultPartParameters,
  parametricPartFor,
  partStepFilename,
  validatePartParameters
} from "./parts";

describe("parametric part catalog", () => {
  it("exposes the coat hook, cylinder, ring, and plate", () => {
    expect(PARAMETRIC_PARTS.map((part) => part.id)).toEqual(["coat-hook", "cylinder", "ring", "plate"]);
  });

  it("provides defaults inside each parameter's range", () => {
    for (const part of PARAMETRIC_PARTS) {
      const defaults = defaultPartParameters(part.id);
      expect(validatePartParameters(part.id, defaults)).toEqual([]);
      for (const parameter of part.parameters) {
        expect(defaults[parameter.key]).toBeGreaterThanOrEqual(parameter.minMm);
        expect(defaults[parameter.key]).toBeLessThanOrEqual(parameter.maxMm);
      }
    }
  });

  it("rejects unknown part ids", () => {
    expect(() => parametricPartFor("gear" as never)).toThrow(/Unknown parametric part/);
  });
});

describe("validatePartParameters", () => {
  it("flags missing and out-of-range dimensions", () => {
    const problems = validatePartParameters("cylinder", { diameter: Number.NaN, height: 10_000 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/Enter a value for diameter/);
    expect(problems[1]).toMatch(/Height must be between/);
  });

  it("requires a ring tube thin enough to keep a centre hole", () => {
    const problems = validatePartParameters("ring", { ringOuterDiameter: 30, ringTubeDiameter: 15 });
    expect(problems).toEqual(["Ring tube diameter must be less than half the outer diameter so the ring keeps a centre hole."]);
  });
});

describe("buildParametricPartStep", () => {
  it("emits analytic surfaces and no tessellated geometry", () => {
    const { stepText } = buildParametricPartStep("coat-hook");
    expect(stepText).toContain("TOROIDAL_SURFACE");
    expect(stepText).toContain("CYLINDRICAL_SURFACE");
    expect(stepText).toContain("PLANE(");
    expect((stepText.match(/MANIFOLD_SOLID_BREP/g) ?? []).length).toBe(2);
    // Faceted exports show up as one of these; analytic parts must have none.
    expect(stepText).not.toContain("B_SPLINE");
    expect(stepText).not.toContain("FACETED_BREP");
    expect(stepText).not.toContain("POLY_LOOP");
    expect(stepText).not.toContain("TRIANGULATED");
  });

  it("names the exported bodies after the part definition", () => {
    expect(buildParametricPartStep("coat-hook").stepText).toContain("MANIFOLD_SOLID_BREP('Ring'");
    expect(buildParametricPartStep("coat-hook").stepText).toContain("MANIFOLD_SOLID_BREP('Boss'");
    expect(buildParametricPartStep("plate").stepText).toContain("MANIFOLD_SOLID_BREP('Plate'");
  });

  it("derives the filename from the dimensions", () => {
    expect(buildParametricPartStep("coat-hook").filename).toBe("support-free-coat-hook-64x36mm.step");
    expect(partStepFilename("cylinder", { diameter: 12.5, height: 40 })).toBe("cylinder-12.5x40mm.step");
    expect(partStepFilename("plate", { width: 120, depth: 80, thickness: 8 })).toBe("plate-120x80x8mm.step");
  });

  it("reports the body count for multi-body parts", () => {
    expect(buildParametricPartStep("coat-hook").bodyCount).toBe(2);
    expect(buildParametricPartStep("ring").bodyCount).toBe(1);
  });

  it("throws on invalid dimensions", () => {
    expect(() => buildParametricPartStep("cylinder", { diameter: -3, height: 10 })).toThrow(/Diameter must be between/);
  });

  it("uses the requested dimensions in the geometry", () => {
    const { stepText } = buildParametricPartStep("cylinder", { diameter: 25, height: 40 });
    expect(stepText).toContain("CYLINDRICAL_SURFACE('',#");
    expect(stepText).toContain(",12.5)");
    expect(stepText).toContain("(12.5,0.,40.)");
  });

  it("only references entity ids that are defined", () => {
    for (const part of PARAMETRIC_PARTS) {
      const { stepText } = buildParametricPartStep(part.id);
      const defined = new Set([...stepText.matchAll(/^#(\d+)=/gm)].map((match) => match[1]));
      for (const match of stepText.matchAll(/#(\d+)/g)) {
        expect(defined.has(match[1]), `entity #${match[1]} is referenced but never defined in ${part.id}`).toBe(true);
      }
    }
  });
});
