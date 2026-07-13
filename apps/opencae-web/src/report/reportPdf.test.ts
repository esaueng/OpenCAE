import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReportData } from "./reportData";
import { renderReportPdf } from "./reportPdf";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmOQz7/wHwAEbQJe8AlDgQAAAABJRU5ErkJggg==";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderReportPdf", () => {
  test("renders a multi-page PDF and tolerates font/logo fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const blob = await renderReportPdf(fixtureReport());
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);

    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    expect([...text.matchAll(/\/Type \/Page\b/g)].length).toBeGreaterThanOrEqual(2);
    expect(blob.type).toBe("application/pdf");

    const qaOutput = process.env.REPORT_PDF_QA_OUTPUT;
    if (qaOutput) {
      mkdirSync(dirname(qaOutput), { recursive: true });
      writeFileSync(qaOutput, bytes);
    }
  });

  test("renders an empty-data report with explicit unavailable values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const empty = fixtureReport();
    empty.geometry = [];
    empty.geometryFiles.rows = [];
    empty.materials.rows = [];
    empty.manufacturing.rows = [];
    empty.supports.rows = [];
    empty.loads.rows = [];
    empty.mesh = [];
    empty.solver = [];
    empty.results = [];
    empty.loadCapacity = [];
    empty.diagnostics = [];
    empty.figures.stress.png = undefined;
    empty.figures.displacement.png = undefined;

    await expect(renderReportPdf(empty)).resolves.toBeInstanceOf(Blob);
  });
});

function fixtureReport(): ReportData {
  const rows = [
    { label: "Result source", value: "OpenCAE Core Local (in-browser)" },
    { label: "Max stress", value: "142 MPa" },
    { label: "Max displacement", value: "0.184 mm" }
  ];
  return {
    pageFormat: "a4",
    filename: "OpenCAE-Report_fixture_2026-07-10.pdf",
    generatedAtIso: "2026-07-10T12:00:00.000Z",
    reportDate: "2026-07-10",
    title: "Dynamic Structural Simulation Report",
    projectName: "Cantilever Fixture",
    studyName: "Dynamic Structural",
    unitSystemLabel: "SI (m, Pa)",
    provenanceTier: "production_fea",
    provenanceLabel: "OpenCAE Core Local (in-browser)",
    coverMeta: [
      { label: "Solver", value: "OpenCAE Core Local (in-browser)" },
      { label: "Version", value: "0.2.0" },
      { label: "Method", value: "mdof_dynamic" },
      { label: "Mesh", value: "Tet10 · 26,944 elements" }
    ],
    keyResults: [
      { label: "Max von Mises stress", value: "142 MPa" },
      { label: "Max displacement", value: "0.184 mm" },
      { label: "Safety factor", value: "1.8" },
      { label: "Reaction force", value: "500 N" }
    ],
    failureAssessment: { status: "pass", title: "Within allowable limit", message: "The reported factor of safety is above 1.0." },
    geometry: [{ label: "Source", value: "Sample model: Cantilever (procedural)" }],
    geometryFiles: { headers: ["File", "Format", "Size"], rows: [["cantilever.step", "STEP", "12.0 KB"]] },
    materials: { headers: ["Material / target", "Young's modulus", "Poisson ratio", "Density", "Yield strength"], rows: [["Aluminum 6061 / Body", "68,900 MPa", "0.33", "2,700 kg/m^3", "276 MPa"]] },
    manufacturing: { headers: ["Material / target", "Process", "Process settings"], rows: [["Aluminum 6061 / Body", "CNC machining", "Solid stock · Isotropic"]] },
    supports: { headers: ["Support", "Target"], rows: [["Fixed support", "Fixed end"]] },
    loads: { headers: ["Load", "Magnitude", "Direction", "Target"], rows: [["Force", "500 N", "[0, 0, -1]", "Free end"]] },
    mesh: [{ label: "Nodes", value: "42,381" }, { label: "Elements", value: "26,944" }, { label: "Element type", value: "Tet10" }],
    solver: rows,
    figures: {
      stress: { title: "Von Mises stress", png: ONE_PIXEL_PNG, unavailableLabel: "Not available (--)", legendMin: "0 MPa", legendMax: "142 MPa", caption: "Von Mises stress (MPa). Automatically selected peak von Mises stress frame (frame 17 of 21, 0.0800 s). Deformed shape, ×1.8 exaggeration (display only)." },
      displacement: { title: "Displacement magnitude", png: ONE_PIXEL_PNG, unavailableLabel: "Not available (--)", legendMin: "0 mm", legendMax: "0.184 mm", caption: "Displacement magnitude (mm). Automatically selected peak displacement magnitude frame (frame 21 of 21, 0.1000 s). Deformed shape, ×1.8 exaggeration (display only)." }
    },
    results: rows,
    loadCapacity: [
      { label: "Current applied load", value: "500 N" },
      { label: "Max theoretical load (at FoS 1.0)", value: "900 N" },
      { label: "Target factor of safety", value: "1.5" },
      { label: "Max load at target FoS", value: "600 N (1.2x current)" }
    ],
    transientResults: [],
    diagnostics: ["Fixture diagnostic."],
    includeSmoothingDisclaimer: true,
    footerDisclaimer: "Development-grade analysis. Not a substitute for professional engineering review."
  };
}
