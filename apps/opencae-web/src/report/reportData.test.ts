import { describe, expect, test } from "vitest";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/samples";
import type { Project, ResultField, ResultSummary, Study } from "@opencae/schema";
import { buildReportData, suggestedReportFilename } from "./reportData";

const productionSummary: ResultSummary = {
  maxStress: 142,
  maxStressUnits: "MPa",
  maxDisplacement: 0.184,
  maxDisplacementUnits: "mm",
  safetyFactor: 1.8,
  reactionForce: 500,
  reactionForceUnits: "N",
  provenance: {
    kind: "opencae_core_fea",
    solver: "opencae-core-sparse-tet",
    coreVersion: "0.2.0",
    solverCpuVersion: "0.2.0",
    runnerVersion: "browser-0.2.0",
    meshSource: "actual_volume_mesh",
    resultSource: "computed",
    units: "mm-N-s-MPa"
  },
  diagnostics: [{ id: "solver-note", severity: "warning", source: "solver", message: "Fixture diagnostic, reproduced verbatim.", suggestedActions: [] }]
};

const fields: ResultField[] = [
  { id: "stress", runId: "run", type: "stress", location: "node", values: [0, 142], min: 0, max: 142, units: "MPa" },
  { id: "displacement", runId: "run", type: "displacement", location: "node", values: [0, 0.184], min: 0, max: 0.184, units: "mm" }
];

function report(overrides: Partial<Parameters<typeof buildReportData>[0]> = {}) {
  const project: Project = { ...bracketDemoProject, studies: bracketDemoProject.studies.map((study) => ({ ...study })) };
  const study = project.studies[0]!;
  return buildReportData({
    project,
    study,
    displayModel: bracketDisplayModel,
    resultSummary: productionSummary,
    resultFields: fields,
    solverMeshSummary: null,
    runTiming: { elapsedMs: 1234 },
    unitSystem: "SI",
    captures: {
      stress: { png: "data:image/png;base64,stress", fieldId: "stress", selection: "static" }
    },
    generatedAt: new Date("2026-07-10T12:34:56.000Z"),
    exaggeration: 1.8,
    showDeformed: true,
    ...overrides
  });
}

describe("buildReportData", () => {
  test("preserves honest panel formatting and estimated mesh labels", () => {
    const data = report();

    expect(data.provenanceLabel).toBe("OpenCAE Core Local (in-browser)");
    expect(data.coverMeta).toContainEqual({ label: "Solver", value: "OpenCAE Core Local (in-browser)" });
    expect(data.coverMeta).toContainEqual({ label: "Version", value: "0.2.0" });
    expect(data.keyResults).toContainEqual({ label: "Max von Mises stress", value: "142 MPa" });
    expect(data.keyResults.map((row) => row.label)).not.toContain("Failure check");
    expect(data.mesh).toContainEqual({ label: "Nodes", value: "42,381 (est.)" });
    expect(data.mesh).toContainEqual({ label: "Element type", value: "Tet10" });
    expect(data.diagnostics).toContain("Fixture diagnostic, reproduced verbatim.");
    expect(data.figures.displacement.png).toBeUndefined();
    expect(data.figures.displacement.unavailableLabel).toBe("Not available (--)");
    expect(data.filename).toBe("OpenCAE-Report_bracket-demo_2026-07-10.pdf");
  });

  test("uses the same US conversion pipeline as the results panel", () => {
    const data = report({ unitSystem: "US" });

    expect(data.pageFormat).toBe("letter");
    expect(data.keyResults).toContainEqual({ label: "Max von Mises stress", value: "20.6 ksi" });
    expect(data.keyResults).toContainEqual({ label: "Max displacement", value: "0.007 in" });
    expect(data.keyResults).toContainEqual({ label: "Reaction force", value: "112.4 lbf" });
    expect(data.materials.rows[0]?.[1]).toContain("ksi");
    expect(data.materials.rows[0]?.[3]).toContain("lb/ft^3");
    expect(data.figures.stress.legendMax).toContain("ksi");
    expect(data.figures.stress.legendMin).toContain("ksi");
    expect(data.figures.displacement.legendMax).toContain("in");
  });

  test("prefers solver-actual mesh counts and marks unresolved material values missing", () => {
    const study = {
      ...bracketDemoProject.studies[0]!,
      materialAssignments: [{ ...bracketDemoProject.studies[0]!.materialAssignments[0]!, materialId: "missing-material" }]
    } satisfies Study;
    const data = report({ study, solverMeshSummary: { nodes: 1200, elements: 640, warnings: [], source: "core_solver" } });

    expect(data.mesh).toContainEqual({ label: "Nodes", value: "1,200" });
    expect(data.mesh).toContainEqual({ label: "Elements", value: "640" });
    expect(data.materials.rows[0]).toEqual(expect.arrayContaining(["--"]));
  });

  test("resolves and labels project custom materials as user-supplied and unverified", () => {
    const custom = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6,
      verification: "user_supplied_unverified" as const
    };
    const project = { ...bracketDemoProject, customMaterials: [custom] } satisfies Project;
    const study = {
      ...bracketDemoProject.studies[0]!,
      materialAssignments: [{ ...bracketDemoProject.studies[0]!.materialAssignments[0]!, materialId: custom.id }]
    } satisfies Study;
    const data = report({ project, study });

    expect(data.materials.rows[0]?.[0]).toContain("Shop aluminum (user-supplied, unverified)");
    expect(data.materials.rows[0]?.[1]).toContain("70,000 MPa");
  });

  test("keeps the demo report honest about procedural sample geometry and mesh warnings", () => {
    const project: Project = {
      ...bracketDemoProject,
      name: "Cantilever Demo",
      geometryFiles: bracketDemoProject.geometryFiles.map((geometry) => ({
        ...geometry,
        filename: "cantilever-beam.step",
        metadata: { ...geometry.metadata, source: "sample", sampleModel: "cantilever" }
      })),
      studies: bracketDemoProject.studies.map((study) => ({ ...study }))
    };
    const data = report({
      project,
      study: project.studies[0]!,
      displayModel: {
        ...bracketDisplayModel,
        coreCloudGeometry: {
          kind: "structured_block",
          sampleId: "cantilever",
          units: "mm",
          descriptor: { length: 180, width: 24, height: 24 }
        }
      }
    });

    expect(data.geometry).toContainEqual({ label: "Source", value: "Sample model: Cantilever (procedural)" });
    expect(data.geometryFiles.rows[0]).toEqual(["cantilever-beam.step", "Sample placeholder (procedural geometry)", "--"]);
    expect(data.mesh).toContainEqual({ label: "Warnings", value: "Small features simplified in the demo mesh preview." });
  });

  test("translates legacy internal mesh warnings from saved projects at the report boundary", () => {
    const study: Study = {
      ...bracketDemoProject.studies[0]!,
      meshSettings: {
        ...bracketDemoProject.studies[0]!.meshSettings,
        summary: { nodes: 42381, elements: 26944, warnings: ["Small feature simplified for the mock mesh.", "Aspect ratio above 5 on 3 elements."] }
      }
    };
    const data = report({ study });

    expect(data.mesh).toContainEqual({
      label: "Warnings",
      value: "Small features simplified in the demo mesh preview.; Aspect ratio above 5 on 3 elements."
    });
  });

  test("reports the manufacturing process, print settings, and as-analyzed properties", () => {
    const baseStudy = bracketDemoProject.studies[0]!;
    const study: Study = {
      ...baseStudy,
      materialAssignments: [{
        ...baseStudy.materialAssignments[0]!,
        materialId: "mat-petg",
        parameters: { manufacturingProcessId: "fdm", printed: true, infillDensity: 40, wallCount: 3, layerOrientation: "x" }
      }]
    };
    const data = report({ study });

    expect(data.manufacturing.headers).toEqual(["Material / target", "Process", "Process settings"]);
    expect(data.manufacturing.rows[0]?.[0]).toContain("PETG");
    expect(data.manufacturing.rows[0]?.[1]).toBe("FDM printing");
    expect(data.manufacturing.rows[0]?.[2]).toBe("3 walls · 40% infill · X build direction");

    const datasheetRow = data.materials.rows[0]!;
    const analyzedRow = data.materials.rows[1]!;
    expect(datasheetRow[0]).toContain("PETG");
    expect(analyzedRow[0]).toBe("As analyzed (FDM, homogenized)");
    expect(analyzedRow[1]).not.toBe(datasheetRow[1]);
    expect(analyzedRow[1]).toContain("MPa");
    expect(analyzedRow[4]).not.toBe(datasheetRow[4]);
  });

  test("marks a defaulted process as assumed and keeps solid materials to one properties row", () => {
    const data = report();

    expect(data.manufacturing.rows[0]).toEqual([
      "Aluminum 6061 / Bracket body",
      "CNC machining (assumed)",
      "Solid stock · Isotropic"
    ]);
    expect(data.materials.rows).toHaveLength(1);
  });

  test("reports the reverse-check load capacity using the panel's target factor", () => {
    const data = report({ targetSafetyFactor: 2 });

    expect(data.loadCapacity).toEqual([
      { label: "Current applied load", value: "500 N" },
      { label: "Max theoretical load (at FoS 1.0)", value: "900 N" },
      { label: "Target factor of safety", value: "2" },
      { label: "Max load at target FoS", value: "450 N (0.9x current)" }
    ]);
  });

  test("defaults the reverse-check target to 1.5 and omits it when the reaction force is invalid", () => {
    const data = report();
    expect(data.loadCapacity).toContainEqual({ label: "Target factor of safety", value: "1.5" });
    expect(data.loadCapacity).toContainEqual({ label: "Max load at target FoS", value: "600 N (1.2x current)" });

    const invalid = report({ resultSummary: { ...productionSummary, reactionForce: 0 } });
    expect(invalid.loadCapacity).toEqual([]);
  });

  test("adds dynamic solver and transient rows", () => {
    const dynamicStudy: Study = {
      ...bracketDemoProject.studies[0]!,
      type: "dynamic_structural",
      name: "Dynamic Structural",
      solverSettings: {
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.01,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    };
    const dynamicSummary: ResultSummary = {
      ...productionSummary,
      transient: {
        analysisType: "dynamic_structural",
        integrationMethod: "newmark_average_acceleration",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.01,
        dampingRatio: 0.02,
        frameCount: 11,
        peakDisplacementTimeSeconds: 0.08,
        peakDisplacement: 0.184
      }
    };
    const dynamicFields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "node", values: [0], min: 0, max: 142, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-4", runId: "run", type: "stress", location: "node", values: [142], min: 0, max: 142, units: "MPa", frameIndex: 4, timeSeconds: 0.04 },
      { id: "displacement-0", runId: "run", type: "displacement", location: "node", values: [0], min: 0, max: 0.184, units: "mm", frameIndex: 0, timeSeconds: 0 },
      { id: "displacement-8", runId: "run", type: "displacement", location: "node", values: [0.184], min: 0, max: 0.184, units: "mm", frameIndex: 8, timeSeconds: 0.08 }
    ];
    const data = report({
      study: dynamicStudy,
      resultSummary: dynamicSummary,
      resultFields: dynamicFields,
      captures: {
        stress: {
          png: "data:image/png;base64,stress-peak",
          fieldId: "stress-4",
          selection: "peak",
          frameIndex: 4,
          timeSeconds: 0.04
        },
        displacement: {
          png: "data:image/png;base64,displacement-peak",
          fieldId: "displacement-8",
          selection: "peak",
          frameIndex: 8,
          timeSeconds: 0.08
        }
      }
    });

    expect(data.title).toBe("Dynamic Structural Simulation Report");
    expect(data.solver).toContainEqual({ label: "Time step", value: "0.005 s" });
    expect(data.transientResults).toContainEqual({ label: "Frames", value: "11" });
    expect(data.transientResults).toContainEqual({ label: "Peak displacement", value: "0.184 mm at 0.08 s" });
    expect(data.figures.stress.legendMax).toBe("142 MPa");
    expect(data.figures.stress.caption).toContain("Automatically selected peak von Mises stress frame (frame 2 of 3, 0.0400 s)");
    expect(data.figures.displacement.caption).toContain("Automatically selected peak displacement magnitude frame (frame 3 of 3, 0.0800 s)");
  });
});

describe("suggestedReportFilename", () => {
  test("sanitizes the project name like the project-save filename", () => {
    expect(suggestedReportFilename("  Wing / Rev B!  ", new Date("2026-07-10T23:59:00Z")))
      .toBe("OpenCAE-Report_wing-rev-b_2026-07-10.pdf");
  });
});
