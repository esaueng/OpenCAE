import { describe, expect, test } from "vitest";
import type { DisplayModel, Project, ResultField, ResultSummary, Study } from "@opencae/schema";
import { buildAutosavedWorkspace, parseAutosavedWorkspacePayload } from "./appPersistence";

const project = {
  id: "project-1",
  name: "Reload Test",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-04-24T12:00:00.000Z",
  updatedAt: "2026-04-24T12:00:00.000Z"
} satisfies Project;

const displayModel = {
  id: "display-1",
  name: "Display",
  bodyCount: 1,
  faces: []
} satisfies DisplayModel;

const summary = {
  maxStress: 12,
  maxStressUnits: "MPa",
  maxDisplacement: 0.2,
  maxDisplacementUnits: "mm",
  safetyFactor: 2,
  reactionForce: 500,
  reactionForceUnits: "N"
} satisfies ResultSummary;

const fields = [{
  id: "field-1",
  runId: "run-1",
  type: "stress",
  location: "face",
  values: [12],
  min: 12,
  max: 12,
  units: "MPa"
}] satisfies ResultField[];

const studyWithSetup = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
  materialAssignments: [{
    id: "assign-1",
    materialId: "mat-aluminum-6061",
    selectionRef: "selection-body",
    parameters: { printed: false },
    status: "complete"
  }],
  namedSelections: [
    {
      id: "selection-body",
      name: "Body",
      entityType: "body",
      geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
      fingerprint: "body"
    },
    {
      id: "selection-top",
      name: "Top face",
      entityType: "face",
      geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-top", label: "Top face" }],
      fingerprint: "face-top"
    }
  ],
  contacts: [],
  constraints: [{
    id: "constraint-1",
    type: "fixed",
    selectionRef: "selection-top",
    parameters: {},
    status: "complete"
  }],
  loads: [
    {
      id: "load-force",
      type: "force",
      selectionRef: "selection-top",
      parameters: { value: 500, units: "N", direction: [0, 0, -1], applicationPoint: [1, 2, 3] },
      status: "complete"
    },
    {
      id: "load-payload",
      type: "gravity",
      selectionRef: "selection-top",
      parameters: {
        value: 0.159,
        units: "kg",
        direction: [0, 0, -1],
        payloadMaterialId: "payload-silicon",
        payloadVolumeM3: 0.0000682,
        payloadMassMode: "material",
        payloadObject: { id: "part-8", label: "Part 8", center: [0.1, 0.2, 0.3], volumeM3: 0.0000682, volumeSource: "step", volumeStatus: "available" }
      },
      status: "complete"
    }
  ],
  meshSettings: { preset: "medium", status: "complete", meshRef: "mesh-1", summary: { nodes: 10, elements: 5, warnings: [] } },
  solverSettings: {},
  validation: [],
  runs: [{ id: "run-1", studyId: "study-1", status: "complete", jobId: "job-1", solverBackend: "local", solverVersion: "test", diagnostics: [] }]
} satisfies Study;

describe("app persistence", () => {
  test("builds a reloadable snapshot with project, model, results, and UI state", () => {
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      results: { activeRunId: "run-1", completedRunId: "run-1", summary, fields },
      ui: {
        activeStep: "results",
        homeRequested: true,
        selectedFaceId: "face-1",
        selectedLoadPoint: [0.1, 0.2, 0.3],
        selectedPayloadObject: { id: "payload-1", label: "Payload part", center: [0.1, 0.2, 0.3] },
        viewMode: "results",
        themeMode: "dark",
        resultMode: "stress",
        showDeformed: true,
        showDimensions: true,
        stressExaggeration: 2.5,
        draftLoadType: "force",
        draftLoadValue: 750,
        draftLoadDirection: "-Z",
        sampleModel: "bracket",
        sampleAnalysisType: "static_stress",
        activeRunId: "run-1",
        completedRunId: "run-1",
        runProgress: 100,
        undoStack: [project],
        redoStack: [],
        status: "Results ready",
        logs: ["Results ready"]
      }
    });

    expect(snapshot.projectFile.project.name).toBe("Reload Test");
    expect(snapshot.projectFile.displayModel).toBe(displayModel);
    expect(snapshot.projectFile.results?.fields).toBe(fields);
    expect(snapshot.ui.activeStep).toBe("results");
    expect(snapshot.ui.homeRequested).toBe(true);
    expect(snapshot.ui.showDeformed).toBe(true);
    expect(parseAutosavedWorkspacePayload(JSON.stringify(snapshot))?.ui.homeRequested).toBe(true);
  });

  test("parses valid autosave JSON and rejects invalid autosave JSON", () => {
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: {
        activeStep: "loads",
        homeRequested: false,
        selectedFaceId: null,
        selectedLoadPoint: null,
        selectedPayloadObject: null,
        viewMode: "model",
        themeMode: "light",
        resultMode: "displacement",
        showDeformed: false,
        showDimensions: false,
        stressExaggeration: 1,
        draftLoadType: "pressure",
        draftLoadValue: 12,
        draftLoadDirection: "+Z",
        sampleModel: "plate",
        sampleAnalysisType: "dynamic_structural",
        activeRunId: "",
        completedRunId: "",
        runProgress: 0,
        undoStack: [],
        redoStack: [],
        status: "Ready",
        logs: []
      }
    });

    expect(parseAutosavedWorkspacePayload(JSON.stringify(snapshot))?.ui.sampleModel).toBe("plate");
    expect(parseAutosavedWorkspacePayload(JSON.stringify(snapshot))?.ui.sampleAnalysisType).toBe("dynamic_structural");
    expect(parseAutosavedWorkspacePayload(JSON.stringify(snapshot))?.ui.selectedLoadPoint).toBeNull();
    expect(parseAutosavedWorkspacePayload(JSON.stringify(snapshot))?.ui.selectedPayloadObject).toBeNull();
    expect(parseAutosavedWorkspacePayload("{bad json")).toBeNull();
    expect(parseAutosavedWorkspacePayload(JSON.stringify({ ...snapshot, version: 99 }))).toBeNull();
  });

  test("preserves study setup, fixed supports, loads, payload masses, and mesh after reload", () => {
    const setupProject = { ...project, studies: [studyWithSetup] } satisfies Project;
    const snapshot = buildAutosavedWorkspace({
      project: setupProject,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: {
        activeStep: "loads",
        homeRequested: false,
        selectedFaceId: "face-top",
        selectedLoadPoint: [0.1, 0.2, 0.3],
        selectedPayloadObject: { id: "part-8", label: "Part 8", center: [0.1, 0.2, 0.3], volumeM3: 0.0000682, volumeSource: "step", volumeStatus: "available" },
        viewMode: "model",
        themeMode: "dark",
        resultMode: "stress",
        showDeformed: false,
        showDimensions: false,
        stressExaggeration: 1,
        draftLoadType: "gravity",
        draftLoadValue: 0.159,
        draftLoadDirection: "-Z",
        sampleModel: "bracket",
        sampleAnalysisType: "static_stress",
        activeRunId: "run-1",
        completedRunId: "run-1",
        runProgress: 100,
        undoStack: [setupProject],
        redoStack: [setupProject],
        status: "Setup ready",
        logs: ["Setup ready"]
      }
    });

    const parsed = parseAutosavedWorkspacePayload(JSON.stringify(snapshot));
    const parsedStudy = parsed?.projectFile.project.studies[0];

    expect(parsedStudy?.materialAssignments).toEqual(studyWithSetup.materialAssignments);
    expect(parsedStudy?.constraints).toEqual(studyWithSetup.constraints);
    expect(parsedStudy?.loads).toEqual(studyWithSetup.loads);
    expect(parsedStudy?.meshSettings).toEqual(studyWithSetup.meshSettings);
    expect(parsedStudy?.runs).toEqual(studyWithSetup.runs);
    expect(parsed?.ui.selectedPayloadObject).toEqual({
      id: "part-8",
      label: "Part 8",
      center: [0.1, 0.2, 0.3],
      volumeM3: 0.0000682,
      volumeSource: "step",
      volumeStatus: "available"
    });
    expect(parsed?.ui.undoStack[0]?.studies[0]?.loads).toEqual(studyWithSetup.loads);
    expect(parsed?.ui.redoStack[0]?.studies[0]?.constraints).toEqual(studyWithSetup.constraints);
  });
});
