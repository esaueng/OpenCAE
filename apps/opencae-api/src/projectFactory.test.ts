import { describe, expect, test } from "vitest";
import { attachUploadedModelToProject, blankDisplayModel, createBlankProject, createStaticStressStudy, uploadedDisplayModelFor, createSampleProject, sampleDisplayModelFor } from "./projectFactory";

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
  test("creates a blank project without preconfigured geometry or active study", () => {
    const project = createBlankProject({
      projectId: "project-blank",
      studyId: "study-blank",
      now: "2026-04-24T12:00:00.000Z"
    });

    expect(project.name).toBe("Untitled Project");
    expect(project.geometryFiles).toEqual([]);
    expect(project.studies).toEqual([]);
    expect(blankDisplayModel().bodyCount).toBe(0);
  });

  test("creates static stress study setup after geometry is available", () => {
    const blank = createBlankProject({
      projectId: "project-study",
      studyId: "study-unused",
      now: "2026-04-24T12:00:00.000Z"
    });
    const displayModel = uploadedDisplayModelFor("mounting-plate.stl", sizedAsciiStlBase64);
    const project = attachUploadedModelToProject(blank, {
      geometryId: "geom-upload",
      filename: "mounting-plate.stl",
      artifactKey: "project-study/geometry/uploaded-display.json",
      now: "2026-04-24T12:05:00.000Z",
      displayModel
    });

    const study = createStaticStressStudy(project, displayModel, {
      studyId: "study-static",
      now: "2026-04-24T12:06:00.000Z"
    });

    expect(study.name).toBe("Static Stress");
    expect(study.geometryScope).toEqual([
      { bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "mounting-plate body" }
    ]);
    expect(study.namedSelections.filter((selection) => selection.entityType === "face")).toHaveLength(displayModel.faces.length);
    expect(study.materialAssignments).toEqual([]);
    expect(study.constraints).toEqual([]);
    expect(study.loads).toEqual([]);
    expect(study.meshSettings.status).toBe("not_started");
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
      const expectedSampleName = sampleId === "plate" ? "beam" : sampleId;
      expect(project.geometryFiles[0]?.filename).toContain(expectedSampleName);
      expect(sampleDisplayModelFor(sampleId).name.toLowerCase()).toContain(expectedSampleName);
      expect(sampleDisplayModelFor(sampleId).dimensions?.units).toBe("mm");
      expect(sampleDisplayModelFor(sampleId).dimensions?.x).toBeGreaterThan(0);
      expect(project.studies[0]?.geometryScope[0]?.label.toLowerCase()).toContain(expectedSampleName);
      expect(project.studies[0]?.namedSelections.filter((selection) => selection.entityType === "face")).toHaveLength(sampleDisplayModelFor(sampleId).faces.length);
      expect(project.studies[0]?.loads[0]?.parameters.direction).toEqual(sampleId === "bracket" ? [0, 0, -1] : [0, -1, 0]);
    }
  });

  test("creates seeded dynamic structural projects from each selectable sample", () => {
    for (const sampleId of ["bracket", "plate", "cantilever"] as const) {
      const project = createSampleProject(sampleId, {
        projectId: `project-${sampleId}`,
        studyId: `study-${sampleId}`,
        name: `Test ${sampleId}`,
        now: "2026-04-24T12:00:00.000Z",
        includeSeedRun: true,
        analysisType: "dynamic_structural"
      });
      const study = project.studies[0];

      expect(study?.name).toBe("Dynamic Structural");
      expect(study?.type).toBe("dynamic_structural");
      expect(study?.solverSettings).toMatchObject({
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration"
      });
      expect(study?.materialAssignments).toHaveLength(1);
      expect(study?.constraints).toHaveLength(1);
      expect(study?.loads).toHaveLength(1);
      expect(study?.meshSettings.status).toBe("complete");
      expect(study?.runs[0]).toMatchObject({
        id: `run-${sampleId}-dynamic-seeded`,
        studyId: `study-${sampleId}`,
        status: "complete",
        resultRef: `project-${sampleId}/results/run-${sampleId}-dynamic-seeded/results.json`,
        reportRef: `project-${sampleId}/reports/run-${sampleId}-dynamic-seeded/report.html`
      });
      expect(project.geometryFiles[0]?.metadata).toMatchObject({
        sampleModel: sampleId,
        sampleAnalysisType: "dynamic_structural"
      });
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
    expect(plate.faces.find((face) => face.id === "face-load-top")?.label).toBe("End payload mass");
    expect(cantilever.faces.find((face) => face.id === "face-base-left")?.normal).toEqual([-1, 0, 0]);
  });

  test("configures the beam sample with a payload mass sitting on the free end", () => {
    const project = createSampleProject("plate", {
      projectId: "project-plate",
      studyId: "study-plate",
      now: "2026-04-24T12:00:00.000Z",
      includeSeedRun: false
    });
    const load = project.studies[0]?.loads[0];

    expect(project.name).toBe("Beam Demo");
    expect(project.geometryFiles[0]?.filename).toBe("end-loaded-beam.step");
    expect(sampleDisplayModelFor("plate").name).toBe("end loaded beam assembly");
    expect(sampleDisplayModelFor("plate").faces.map((face) => face.label)).toEqual([
      "Fixed end face",
      "End payload mass",
      "Beam top face",
      "Beam body"
    ]);
    expect(load).toMatchObject({
      type: "gravity",
      selectionRef: "selection-load-face",
      parameters: {
        value: 0.497664,
        units: "kg",
        direction: [0, -1, 0],
        applicationPoint: [1.48, 0.56, 0],
        payloadMaterialId: "payload-aluminum-6061",
        payloadVolumeM3: 0.00018432,
        payloadMassMode: "material",
        payloadObject: {
          id: "payload-display-plate",
          label: "end payload mass",
          center: [1.48, 0.56, 0],
          volumeM3: 0.00018432,
          volumeSource: "bounds-fallback",
          volumeStatus: "estimated"
        }
      }
    });
  });

  test("configures the cantilever sample with an explicit Z force on the free end", () => {
    const project = createSampleProject("cantilever", {
      projectId: "project-cantilever",
      studyId: "study-cantilever",
      now: "2026-04-24T12:00:00.000Z",
      includeSeedRun: false
    });
    const load = project.studies[0]?.loads[0];

    expect(load).toMatchObject({
      type: "force",
      selectionRef: "selection-load-face",
      parameters: {
        value: 500,
        units: "N",
        direction: [0, -1, 0],
        applicationPoint: [1.75, 0.18, 0]
      }
    });
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
    expect(project.studies).toEqual([]);
  });

  test("imports STEP as a selectable native CAD display model", () => {
    const displayModel = uploadedDisplayModelFor("hat-clip.step", "SVNPMTAzMDM=");

    expect(displayModel.bodyCount).toBe(1);
    expect(displayModel.faces).toHaveLength(6);
    expect(displayModel.dimensions).toBeUndefined();
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
    expect(project.studies).toEqual([]);
  });
});
