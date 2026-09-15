import { describe, expect, test } from "vitest";
import { ProjectSchema } from "@opencae/schema";
import { attachUploadedModelToProject, blankDisplayModel, createBlankProject, createStaticStressStudy, uploadedDisplayModelFor, createSampleProject, normalizeSampleAnalysisType, sampleDisplayModelFor } from "./projectFactory";

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
    expect(study.type === "modal_analysis" ? undefined : study.loadCases).toEqual([{ id: "case-default", name: "Default", enabled: true, loadIds: [] }]);
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
      expect(project.studies[0]?.loads[0]?.parameters.direction).toEqual([0, -1, 0]);
      expect(project.studies[0]?.type === "modal_analysis" ? undefined : project.studies[0]?.loadCases?.[0]?.loadIds).toEqual(project.studies[0]?.loads.map((load) => load.id));
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
      expect(study?.type === "modal_analysis" ? undefined : study?.loadCases?.[0]?.loadIds).toEqual(study?.loads.map((load) => load.id));
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

  test("normalizes and creates the new modal and thermal sample types", () => {
    expect(normalizeSampleAnalysisType("modal_analysis")).toBe("modal_analysis");
    expect(normalizeSampleAnalysisType("steady_state_thermal")).toBe("steady_state_thermal");
    expect(normalizeSampleAnalysisType("unsupported")).toBe("static_stress");

    for (const sampleId of ["bracket", "plate", "cantilever"] as const) {
      const modal = createSampleProject(sampleId, {
        projectId: `project-${sampleId}-modal`,
        studyId: `study-${sampleId}-modal`,
        now: "2026-04-24T12:00:00.000Z",
        includeSeedRun: false,
        analysisType: "modal_analysis"
      });
      const thermal = createSampleProject(sampleId, {
        projectId: `project-${sampleId}-thermal`,
        studyId: `study-${sampleId}-thermal`,
        now: "2026-04-24T12:00:00.000Z",
        includeSeedRun: false,
        analysisType: "steady_state_thermal"
      });

      expect(modal.name).toContain("Modal Demo");
      expect(modal.studies[0]).toMatchObject({
        type: "modal_analysis",
        loads: [],
        solverSettings: { modeCount: 6 },
        runs: []
      });
      expect(thermal.name).toContain("Thermal Demo");
      expect(thermal.studies[0]).toMatchObject({
        type: "steady_state_thermal",
        constraints: [{ type: "prescribed_temperature", parameters: { value: 20, units: "°C" } }],
        loads: [{ type: "heat_flux", parameters: expect.objectContaining({ value: 10_000, units: "W/m²" }) }],
        runs: []
      });
      expect(ProjectSchema.safeParse(modal).success).toBe(true);
      expect(ProjectSchema.safeParse(thermal).success).toBe(true);
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

    expect(project.name).toBe("mounting-plate");
    expect(project.geometryFiles[0]?.filename).toBe("mounting-plate.stl");
    expect(project.geometryFiles[0]?.metadata.source).toBe("local-upload");
    expect(project.geometryFiles[0]?.metadata.previewFormat).toBe("stl");
    expect(project.geometryFiles[0]?.metadata.faceCount).toBe(displayModel.faces.length);
    expect(displayModel.visualMesh?.format).toBe("stl");
    expect(displayModel.dimensions).toEqual({ x: 268.8, y: 246.1, z: 289.9, units: "mm" });
    expect(project.studies).toEqual([]);
  });

  test("does not fabricate selectable STEP geometry before parsing", () => {
    const displayModel = uploadedDisplayModelFor("hat-clip.step", "SVNPMTAzMDM=");

    expect(displayModel.bodyCount).toBe(0);
    expect(displayModel.faces).toHaveLength(0);
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

  test("uses the uploaded file name as the default project name", () => {
    const blank = createBlankProject({
      projectId: "project-step-upload",
      studyId: "study-step-upload",
      now: "2026-04-24T12:00:00.000Z"
    });
    const displayModel = uploadedDisplayModelFor("Force Sample v1.step", "U1RFUA==");
    const project = attachUploadedModelToProject(blank, {
      geometryId: "geom-step",
      filename: "Force Sample v1.step",
      artifactKey: "project-step-upload/geometry/uploaded-display.json",
      now: "2026-04-24T12:05:00.000Z",
      displayModel
    });

    expect(project.name).toBe("Force Sample v1");
  });

  test("keeps a user-edited project name when replacing an uploaded model", () => {
    const customProject = {
      ...createBlankProject({
        projectId: "project-step-upload",
        studyId: "study-step-upload",
        now: "2026-04-24T12:00:00.000Z"
      }),
      name: "Payload Calibration"
    };
    const displayModel = uploadedDisplayModelFor("Force Sample v1.step", "U1RFUA==");
    const project = attachUploadedModelToProject(customProject, {
      geometryId: "geom-step",
      filename: "Force Sample v1.step",
      artifactKey: "project-step-upload/geometry/uploaded-display.json",
      now: "2026-04-24T12:05:00.000Z",
      displayModel
    });

    expect(project.name).toBe("Payload Calibration");
  });
});

describe("reference/backend parity (frozen reference contract)", () => {
  // Source-text parity: the dev API is a frozen reference, not the production
  // path. Importing web sources here would drag vite/jsx-typed modules into
  // the api tsc program, so this pins the mirrored literals as text. If it
  // fails, the two factories drifted: update both deliberately, not one.
  test("reference sample ids match the browser workspace factory", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const webFactory = readFileSync(resolve(rootDir, "apps/opencae-web/src/localProjectFactory.ts"), "utf8");
    // Beam ("plate") dimensions INTENTIONALLY differ: the browser factory
    // derives structural dimensions from render proportions while the
    // reference keeps nominal CAD metadata. Pin the known divergence.
    expect(webFactory).toContain("BEAM_PHYSICAL_LENGTH_MM");
    expect(webFactory).toContain('projectName: "Beam Demo"');
    const { normalizeSampleId, sampleDisplayModelFor } = await import("./projectFactory");
    const reference = sampleDisplayModelFor(normalizeSampleId("plate"));
    expect(reference.dimensions).toEqual({ x: 160, y: 32, z: 36, units: "mm" });
    for (const sample of ["bracket", "cantilever"] as const) {
      expect(sampleDisplayModelFor(normalizeSampleId(sample)).name)
        .toBe(sample === "bracket" ? "bracket demo body" : "cantilever demo body");
    }
  });

  test("reference mesh estimates match the browser quarantined estimates", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const webEstimates = readFileSync(resolve(rootDir, "apps/opencae-web/src/lib/meshEstimates.ts"), "utf8");
    const { MockMeshService } = await import("@opencae/mesh-service");
    class MemoryStorage {
      objects = new Map<string, Buffer>();
      async putObject(key: string, data: string | Buffer | Uint8Array): Promise<string> {
        this.objects.set(key, Buffer.from(data));
        return key;
      }
    }
    const service = new MockMeshService(new MemoryStorage() as never);
    const study = { projectId: "project-1", id: "study-1" } as never;
    const expected: Record<string, { nodes: number; elements: number }> = {
      coarse: { nodes: 12840, elements: 7320 },
      medium: { nodes: 42381, elements: 26944 },
      fine: { nodes: 88420, elements: 57102 },
      ultra: { nodes: 182400, elements: 119808 }
    };
    for (const [preset, counts] of Object.entries(expected)) {
      const { summary } = await service.generateMesh(study, preset as never);
      expect(summary.nodes, `nodes drift for ${preset}`).toBe(counts.nodes);
      expect(summary.elements, `elements drift for ${preset}`).toBe(counts.elements);
      // The browser twin must carry the same literals.
      expect(webEstimates).toContain(`nodes: ${counts.nodes}, elements: ${counts.elements}`);
    }
  });
});

