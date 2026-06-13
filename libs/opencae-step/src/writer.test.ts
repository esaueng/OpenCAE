import { describe, expect, it } from "vitest";
import { buildStepDocument, escapeStepString, formatStepReal, StepWriter } from "./writer";

describe("formatStepReal", () => {
  it("always carries a decimal point", () => {
    expect(formatStepReal(30)).toBe("30.");
    expect(formatStepReal(0)).toBe("0.");
    expect(formatStepReal(-0)).toBe("0.");
    expect(formatStepReal(-17)).toBe("-17.");
    expect(formatStepReal(1.5)).toBe("1.5");
    expect(formatStepReal(-0.25)).toBe("-0.25");
  });

  it("normalizes exponent notation to STEP form", () => {
    expect(formatStepReal(1e-7)).toBe("1.E-7");
    expect(formatStepReal(1.25e21)).toBe("1.25E+21");
  });

  it("rejects non-finite values", () => {
    expect(() => formatStepReal(Number.NaN)).toThrow(/finite/);
    expect(() => formatStepReal(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("escapeStepString", () => {
  it("doubles apostrophes and backslashes", () => {
    expect(escapeStepString("Peter's part")).toBe("Peter''s part");
    expect(escapeStepString("a\\b")).toBe("a\\\\b");
  });
});

describe("StepWriter", () => {
  it("assigns sequential entity ids starting at #1", () => {
    const writer = new StepWriter();
    expect(writer.cartesianPoint([1, 2, 3])).toBe(1);
    expect(writer.direction([0, 0, 1])).toBe(2);
    expect(writer.entityCount).toBe(2);
    expect(writer.dataSection()).toBe("#1=CARTESIAN_POINT('',(1.,2.,3.));\n#2=DIRECTION('',(0.,0.,1.));");
  });
});

describe("buildStepDocument", () => {
  it("wraps solids in a complete AP214 product structure", () => {
    const stepText = buildStepDocument({
      partName: "Test part",
      filename: "test-part.step",
      createdAt: new Date("2026-06-12T00:00:00Z"),
      buildSolids: (writer) => [writer.manifoldSolidBrep("Body", writer.closedShell([]))]
    });

    expect(stepText.startsWith("ISO-10303-21;\nHEADER;")).toBe(true);
    expect(stepText.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true);
    expect(stepText).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
    expect(stepText).toContain("FILE_NAME('test-part.step','2026-06-12T00:00:00'");
    expect(stepText).toContain("ADVANCED_BREP_SHAPE_REPRESENTATION('Test part'");
    expect(stepText).toContain("SHAPE_DEFINITION_REPRESENTATION(");
    expect(stepText).toContain("PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,");
    expect(stepText).toContain("SI_UNIT(.MILLI.,.METRE.)");
  });

  it("rejects documents without solids", () => {
    expect(() =>
      buildStepDocument({
        partName: "Empty",
        filename: "empty.step",
        buildSolids: () => []
      })
    ).toThrow(/at least one solid/);
  });

  it("only references entity ids that are defined", () => {
    const stepText = buildStepDocument({
      partName: "Ref check",
      filename: "ref-check.step",
      buildSolids: (writer) => [writer.manifoldSolidBrep("Body", writer.closedShell([]))]
    });
    const defined = new Set([...stepText.matchAll(/^#(\d+)=/gm)].map((match) => match[1]));
    const referenced = [...stepText.matchAll(/#(\d+)/g)].map((match) => match[1]);
    for (const id of referenced) {
      expect(defined.has(id), `entity #${id} is referenced but never defined`).toBe(true);
    }
  });
});
