import { describe, expect, test } from "vitest";
import { attachUploadedModelToProject, createLocalBlankProject, createLocalSampleProject, createLocalStaticStressStudy, openLocalProjectPayload, uploadedDisplayModelFor } from "./localProjectFactory";

const sizedAsciiStlBase64 = btoa(`
solid beam
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 100 0 0
vertex 0 25 10
endloop
endfacet
endsolid beam
`);

describe("local project factory workflow", () => {
  test("creates blank projects without an active study", () => {
    const response = createLocalBlankProject("2026-04-28T12:00:00.000Z");

    expect(response.project.studies).toEqual([]);
    expect(response.displayModel.bodyCount).toBe(0);
  });

  test("creates a static stress study after model upload while preserving geometry selections", () => {
    const blank = createLocalBlankProject("2026-04-28T12:00:00.000Z").project;
    const displayModel = uploadedDisplayModelFor("sample-bar.stl", sizedAsciiStlBase64);
    const projectWithGeometry = attachUploadedModelToProject(blank, {
      geometryId: "geom-upload",
      filename: "sample-bar.stl",
      artifactKey: "project/geometry/uploaded-display.json",
      now: "2026-04-28T12:01:00.000Z",
      displayModel
    });

    const study = createLocalStaticStressStudy(projectWithGeometry, displayModel, "study-static", "2026-04-28T12:02:00.000Z");

    expect(projectWithGeometry.studies).toEqual([]);
    expect(study.projectId).toBe(projectWithGeometry.id);
    expect(study.geometryScope[0]?.label).toBe("sample-bar body");
    expect(study.namedSelections.filter((selection) => selection.entityType === "face")).toHaveLength(displayModel.faces.length);
    expect(study.materialAssignments).toEqual([]);
    expect(study.constraints).toEqual([]);
    expect(study.loads).toEqual([]);
    expect(study.meshSettings.status).toBe("not_started");
  });

  test("uses the uploaded file name as the default project name", () => {
    const blank = createLocalBlankProject("2026-04-28T12:00:00.000Z").project;
    const displayModel = uploadedDisplayModelFor("Force Sample v1.step", "U1RFUA==");
    const projectWithGeometry = attachUploadedModelToProject(blank, {
      geometryId: "geom-upload",
      filename: "Force Sample v1.step",
      artifactKey: "project/geometry/uploaded-display.json",
      now: "2026-04-28T12:01:00.000Z",
      displayModel
    });

    expect(projectWithGeometry.name).toBe("Force Sample v1");
  });

  test("keeps a user-edited project name when replacing an uploaded model", () => {
    const customProject = { ...createLocalBlankProject("2026-04-28T12:00:00.000Z").project, name: "Payload Calibration" };
    const displayModel = uploadedDisplayModelFor("Force Sample v1.step", "U1RFUA==");
    const projectWithGeometry = attachUploadedModelToProject(customProject, {
      geometryId: "geom-upload",
      filename: "Force Sample v1.step",
      artifactKey: "project/geometry/uploaded-display.json",
      now: "2026-04-28T12:01:00.000Z",
      displayModel
    });

    expect(projectWithGeometry.name).toBe("Payload Calibration");
  });

  test("seeds cantilever loads in model space for viewer global -Z", async () => {
    const response = await createLocalSampleProject("cantilever", "static_stress", "2026-04-28T12:00:00.000Z");
    const load = response.project.studies[0]?.loads[0];

    expect(load?.parameters.direction).toEqual([0, -1, 0]);
  });

  test("rejects payloads without a valid project", () => {
    expect(() => openLocalProjectPayload("not a project")).toThrow("The selected file is not a valid OpenCAE project JSON.");
    expect(() => openLocalProjectPayload({ project: { id: "broken" } })).toThrow("The selected file is not a valid OpenCAE project JSON.");
  });

  test("notes the migration once when a loaded study carried the retired cloud backend", async () => {
    const sample = await createLocalSampleProject("cantilever", "static_stress", "2026-04-28T12:00:00.000Z");
    const cloudProject = {
      ...sample.project,
      studies: sample.project.studies.map((studyValue) => ({
        ...studyValue,
        solverSettings: { ...studyValue.solverSettings, backend: "opencae_core_cloud" }
      }))
    };

    const response = openLocalProjectPayload({ project: cloudProject });

    // Honest, not silent: the raw payload carried the retired cloud pin, the
    // parsed study is normalized to auto/local, and the run log says why.
    expect(response.message).toContain("opened from local file.");
    expect(response.message).toContain("retired OpenCAE Core Cloud backend");
    expect(response.message).toContain("run locally in your browser");
    expect(response.project.studies[0]?.solverSettings.backend).not.toBe("opencae_core_cloud");

    // Projects without the retired pin stay note-free.
    const clean = openLocalProjectPayload({ project: sample.project });
    expect(clean.message).not.toContain("retired OpenCAE Core Cloud backend");
  });

  test("ignores crafted display models with malformed faces instead of crashing face selection", () => {
    const blank = createLocalBlankProject("2026-04-28T12:00:00.000Z").project;
    const response = openLocalProjectPayload({
      project: blank,
      displayModel: {
        id: "display-crafted",
        name: "Crafted model",
        bodyCount: 1,
        faces: [{ id: "face-crafted", label: "Crafted face" }]
      }
    });

    // The malformed faces (missing center/normal vectors) are rejected and a safe fallback model is used.
    expect(response.displayModel.id).toBe("display-blank");
    expect(response.displayModel.faces).toEqual([]);
  });

  test("ignores crafted result bundles with malformed summaries", () => {
    const blank = createLocalBlankProject("2026-04-28T12:00:00.000Z").project;
    const response = openLocalProjectPayload({
      project: blank,
      results: {
        summary: { maxStress: "very high", maxStressUnits: "MPa" },
        fields: [{ id: "field-crafted" }]
      }
    });

    expect(response.results).toBeUndefined();
  });

  test("keeps well-formed display models and result bundles from project files", () => {
    const blank = createLocalBlankProject("2026-04-28T12:00:00.000Z").project;
    const response = openLocalProjectPayload({
      project: blank,
      displayModel: {
        id: "display-saved",
        name: "Saved model",
        bodyCount: 1,
        faces: [{ id: "face-1", label: "Face 1", color: "#fff", center: [0, 0, 0], normal: [0, 0, 1], stressValue: 12 }]
      },
      results: {
        summary: {
          maxStress: 12,
          maxStressUnits: "MPa",
          maxDisplacement: 0.2,
          maxDisplacementUnits: "mm",
          safetyFactor: 2,
          reactionForce: 500,
          reactionForceUnits: "N"
        },
        fields: [{ id: "field-1", runId: "run-1", type: "stress", location: "face", values: [12], min: 12, max: 12, units: "MPa" }]
      }
    });

    expect(response.displayModel.id).toBe("display-saved");
    expect(response.results?.summary.maxStress).toBe(12);
    expect(response.results?.fields).toHaveLength(1);
  });
});
