import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { buildParametricPartStep } from "@opencae/step";
import { ParametricPartBuilder } from "./ParametricPartBuilder";

describe("ParametricPartBuilder", () => {
  test("renders the part picker, dimension fields, and actions", () => {
    const html = renderToStaticMarkup(<ParametricPartBuilder onCreatePart={() => undefined} />);
    expect(html).toContain("Part type");
    expect(html).toContain("Support-free coat hook");
    expect(html).toContain("Ring outer diameter");
    expect(html).toContain("Boss diameter");
    expect(html).toContain("Add to project");
    expect(html).toContain("Download .step");
    expect(html).toContain("analytic STEP solid");
  });

  test("shows the default coat hook dimensions", () => {
    const html = renderToStaticMarkup(<ParametricPartBuilder onCreatePart={() => undefined} />);
    expect(html).toContain('value="64"');
    expect(html).toContain('value="36"');
  });
});

describe("coat hook STEP output", () => {
  test("builds the same default file the user saw faceted, but as analytic surfaces", () => {
    const { filename, stepText, bodyCount } = buildParametricPartStep("coat-hook");
    expect(filename).toBe("support-free-coat-hook-64x36mm.step");
    expect(bodyCount).toBe(2);
    expect(stepText).toContain("TOROIDAL_SURFACE");
    expect(stepText).toContain("CYLINDRICAL_SURFACE");
    expect(stepText).not.toContain("FACETED_BREP");
  });
});
