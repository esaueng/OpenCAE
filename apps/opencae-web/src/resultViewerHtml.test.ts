import { describe, expect, test } from "vitest";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/db/sample-data";
import type { ResultField, ResultSummary } from "@opencae/schema";
import { buildResultViewerHtml, resultViewerPayloadFromHtml, suggestedResultHtmlFilename } from "./resultViewerHtml";

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
});
