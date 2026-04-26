import { describe, expect, test } from "vitest";
import { attachUploadedModelToProject, blankDisplayModel, createBlankProject, uploadedDisplayModelFor, createSampleProject, sampleDisplayModelFor } from "./projectFactory";

const sizedAsciiStlBase64 = btoa(`
solid tray
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 268.8 0 0
vertex 0 289.9 246.05
endloop
endfacet
endsolid tray
`);

describe("projectFactory", () => {
  test("creates a blank project without preconfigured geometry or study setup", () => {
    const project = createBlankProject({
      projectId: "project-blank",
      studyId: "study-blank",
      now: "2026-04-24T12:00:00.000Z"
    });

    expect(project.name).toBe("Untitled Project");
    expect(project.geometryFiles).toEqual([]);
    expect(project.studies[0]?.namedSelections).toEqual([]);
    expect(project.studies[0]?.materialAssignments).toEqual([]);
    expect(project.studies[0]?.constraints).toEqual([]);
    expect(project.studies[0]?.loads).toEqual([]);
    expect(project.studies[0]?.meshSettings.status).toBe("not_started");
    expect(blankDisplayModel().bodyCount).toBe(0);
  });

  test("creates a usable project from each selectable sample", () => {
    for (const sampleId of ["bracket", "plate", "cantilever"] as const) {
      const project = createSampleProject(sampleId, {
        projectId: `project-${sampleId}`,
        studyId: `study-${sampleId}`,
        name: `Test ${sampleId}`,
        now: "2026-04-24T12:00:00.000Z",
        includeSeedRun: false
      });

      expect(project.name).toBe(`Test ${sampleId}`);
      expect(project.studies).toHaveLength(1);
      expect(project.studies[0]?.projectId).toBe(project.id);
      expect(project.geometryFiles[0]?.filename).toContain(sampleId);
      expect(sampleDisplayModelFor(sampleId).name.toLowerCase()).toContain(sampleId);
      expect(sampleDisplayModelFor(sampleId).dimensions?.units).toBe("mm");
      expect(sampleDisplayModelFor(sampleId).dimensions?.x).toBeGreaterThan(0);
      expect(project.studies[0]?.geometryScope[0]?.label.toLowerCase()).toContain(sampleId === "bracket" ? "bracket" : sampleId);
      expect(project.studies[0]?.namedSelections.filter((selection) => selection.entityType === "face")).toHaveLength(sampleDisplayModelFor(sampleId).faces.length);
      expect(project.studies[0]?.loads[0]?.parameters.direction).toEqual([0, 0, -1]);
    }
  });

  test("returns distinct display geometry for each sample", () => {
    const bracket = sampleDisplayModelFor("bracket");
    const plate = sampleDisplayModelFor("plate");
    const cantilever = sampleDisplayModelFor("cantilever");

    expect(plate.faces).not.toEqual(bracket.faces);
    expect(cantilever.faces).not.toEqual(bracket.faces);
    for (const faceId of ["face-base-left", "face-load-top", "face-web-front", "face-base-bottom"]) {
      expect(plate.faces.map((face) => face.id)).toContain(faceId);
      expect(cantilever.faces.map((face) => face.id)).toContain(faceId);
      expect(bracket.faces.map((face) => face.id)).toContain(faceId);
    }
    expect(plate.faces.find((face) => face.id === "face-load-top")?.label).toBe("Right load pad");
    expect(cantilever.faces.find((face) => face.id === "face-base-left")?.normal).toEqual([-1, 0, 0]);
  });

  test("adds selectable named selections for bracket display faces", () => {
    const project = createSampleProject("bracket", {
      projectId: "project-bracket",
      studyId: "study-bracket",
      now: "2026-04-24T12:00:00.000Z",
      includeSeedRun: false
    });
    const faceSelections = project.studies[0]?.namedSelections.filter((selection) => selection.entityType === "face") ?? [];

    expect(faceSelections.map((selection) => selection.geometryRefs[0]?.entityId)).toContain("face-upright-front");
    expect(faceSelections.map((selection) => selection.geometryRefs[0]?.entityId)).toContain("face-upright-hole");
    expect(faceSelections.map((selection) => selection.geometryRefs[0]?.entityId)).toContain("face-base-end");
  });

  test("attaches a previewable uploaded mesh with selectable placement faces", () => {
    const blank = createBlankProject({
      projectId: "project-upload",
      studyId: "study-upload",
      now: "2026-04-24T12:00:00.000Z"
    });
    const displayModel = uploadedDisplayModelFor("mounting-plate.stl", sizedAsciiStlBase64);
    const project = attachUploadedModelToProject(blank, {
      geometryId: "geom-upload",
      filename: "mounting-plate.stl",
      artifactKey: "project-upload/geometry/uploaded-display.json",
      now: "2026-04-24T12:05:00.000Z",
      displayModel
    });

    expect(project.name).toBe("Untitled Project");
    expect(project.geometryFiles[0]?.filename).toBe("mounting-plate.stl");
    expect(project.geometryFiles[0]?.metadata.source).toBe("local-upload");
    expect(project.geometryFiles[0]?.metadata.previewFormat).toBe("stl");
    expect(project.geometryFiles[0]?.metadata.faceCount).toBe(displayModel.faces.length);
    expect(displayModel.visualMesh?.format).toBe("stl");
    expect(displayModel.dimensions).toEqual({ x: 268.8, y: 246.1, z: 289.9, units: "mm" });
    expect(project.studies[0]?.geometryScope).toEqual([
      { bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "mounting-plate body" }
    ]);
    expect(project.studies[0]?.namedSelections.filter((selection) => selection.entityType === "face")).toHaveLength(displayModel.faces.length);
    expect(project.studies[0]?.constraints).toEqual([]);
    expect(project.studies[0]?.loads).toEqual([]);
    expect(project.studies[0]?.meshSettings.status).toBe("not_started");
  });

  test("imports STEP as a selectable native CAD display model", () => {
    const displayModel = uploadedDisplayModelFor("hat-clip.step", "SVNPMTAzMDM=");

    expect(displayModel.bodyCount).toBe(1);
    expect(displayModel.faces).toHaveLength(6);
    expect(displayModel.nativeCad?.format).toBe("step");
    expect(displayModel.nativeCad?.contentBase64).toBe("SVNPMTAzMDM=");
    expect(displayModel.visualMesh).toBeUndefined();
  });

  test("attaches STEP uploads with selectable placement faces", () => {
    const blank = createBlankProject({
      projectId: "project-step-upload",
      studyId: "study-step-upload",
      now: "2026-04-24T12:00:00.000Z"
    });
    const displayModel = uploadedDisplayModelFor("hat-clip.step", "SVNPMTAzMDM=");
    const project = attachUploadedModelToProject(blank, {
      geometryId: "geom-step",
      filename: "hat-clip.step",
      artifactKey: "project-step-upload/geometry/uploaded-display.json",
      now: "2026-04-24T12:05:00.000Z",
      displayModel
    });

    expect(project.geometryFiles[0]?.metadata.nativeCadImport).toBe(true);
    expect(project.geometryFiles[0]?.metadata.previewFormat).toBe("step");
    expect(project.studies[0]?.namedSelections.filter((selection) => selection.entityType === "face")).toHaveLength(6);
  });
});
