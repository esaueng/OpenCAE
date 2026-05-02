import { describe, expect, test } from "vitest";
import { attachUploadedModelToProject, createLocalBlankProject, createLocalSampleProject, createLocalStaticStressStudy, uploadedDisplayModelFor } from "./localProjectFactory";

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
});
