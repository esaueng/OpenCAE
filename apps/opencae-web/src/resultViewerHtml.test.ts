import { describe, expect, test } from "vitest";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/samples";
import type { ResultField, ResultSummary } from "@opencae/schema";
import { buildResultViewerHtml, resultViewerPayloadFromHtml, suggestedResultHtmlFilename } from "./resultViewerHtml";
import { STRESS_RAMP, stressRampFloatStops } from "./resultColorScale";

const summary: ResultSummary = {
  maxStress: 142,
  maxStressUnits: "MPa",
  maxDisplacement: 0.184,
  maxDisplacementUnits: "mm",
  safetyFactor: 1.8,
  reactionForce: 500,
  reactionForceUnits: "N"
};

const fields: ResultField[] = [
  { id: "stress", runId: "run", type: "stress", location: "node", values: [0, 71, 142], min: 0, max: 142, units: "MPa" },
  {
    id: "displacement",
    runId: "run",
    type: "displacement",
    location: "node",
    values: [0, 0.1, 0.184],
    vectors: [[0, 0, 0], [0, 0.1, 0], [0, 0.184, 0]],
    min: 0,
    max: 0.184,
    units: "mm"
  }
];

describe("self-contained result viewer", () => {
  test("embeds geometry and results without external dependencies", () => {
    const project = { ...bracketDemoProject, name: "Bracket </script><script>alert(1)</script>" };
    const html = buildResultViewerHtml({
      project,
      study: project.studies[0]!,
      displayModel: bracketDisplayModel,
      summary,
      fields,
      surfaceMesh: { id: "surface", nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]], coordinateSpace: "model-mm" },
      exportedAt: "2026-07-14T12:00:00.000Z"
    });

    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("Self-contained · offline");
    expect(html).not.toContain("https://");
    expect(html).not.toContain(project.name);
    expect(resultViewerPayloadFromHtml(html)).toMatchObject({
      format: "opencae-result-viewer",
      version: 1,
      project: { name: project.name },
      surfaceMesh: { id: "surface", triangles: [[0, 1, 2]] }
    });
  });

  test("creates a filesystem-safe filename", () => {
    expect(suggestedResultHtmlFilename("  Payload Bracket #4  ")).toBe("payload-bracket-4-results.html");
  });

  test("rejects unit markup before generating the offline viewer", () => {
    expect(() => buildResultViewerHtml({
      project: bracketDemoProject,
      study: bracketDemoProject.studies[0]!,
      displayModel: bracketDisplayModel,
      summary: { ...summary, maxStressUnits: "</strong><svg onload=alert(1)>" },
      fields,
      surfaceMesh: { id: "surface", nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]], coordinateSpace: "model-mm" }
    })).toThrow("unsafe HTML characters");
  });

  test("renders metrics through text-only DOM, with no innerHTML sink", () => {
    // The export-time unit check above fails closed, but the generated viewer
    // is a standalone file a recipient could edit. Metric values and units
    // must be written with textContent so no payload string can become markup.
    const html = buildResultViewerHtml({
      project: bracketDemoProject,
      study: bracketDemoProject.studies[0]!,
      displayModel: bracketDisplayModel,
      summary,
      fields,
      surfaceMesh: { id: "surface", nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]], coordinateSpace: "model-mm" }
    });

    expect(html).not.toContain("innerHTML");
    expect(html).toContain("metrics.replaceChildren(");
    expect(html).toContain("st.textContent=fmt(v)+' '+u");
  });

  test("emits the shared stress ramp rather than its own copy of the stops", () => {
    // The ramp used to be hand-copied into four places in three formats: hex here and in
    // the report theme, normalized float triples in this generated viewer, and CSS custom
    // properties. A change to any one of them would have split what a colour means between
    // the screen, the PDF and the exported viewer.
    const stops = stressRampFloatStops();
    expect(stops).toHaveLength(STRESS_RAMP.length);
    // #0759d6 -> 7/255, 89/255, 214/255
    expect(stops[0]).toEqual([0.027, 0.349, 0.839]);
    expect(stops[stops.length - 1]).toEqual([0.937, 0.267, 0.267]);

    const html = buildResultViewerHtml({
      project: bracketDemoProject,
      study: bracketDemoProject.studies[0]!,
      displayModel: bracketDisplayModel,
      summary,
      fields,
      surfaceMesh: { id: "surface", nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]], coordinateSpace: "model-mm" },
      exportedAt: "2026-07-14T12:00:00.000Z"
    });
    expect(html).toContain(JSON.stringify(stops));
    // The interpolation actually ran: no literal expression survives into the output.
    expect(html).not.toContain("stressRampFloatStops()");
  });
});