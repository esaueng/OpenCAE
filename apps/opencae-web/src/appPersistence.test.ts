import { afterEach, describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project, ResultField, ResultSummary, Study } from "@opencae/schema";
import {
  AUTOSAVE_STORAGE_KEY,
  AUTOSAVE_UI_STORAGE_KEY,
  buildAutosavedWorkspace,
  buildAutosavedWorkspaceUiSnapshot,
  parseAutosavedWorkspacePayload,
  readAutosavedWorkspace,
  scheduleAutosavedUiSnapshotWrite,
  scheduleAutosavedWorkspaceWrite
} from "./appPersistence";
import type { WorkspaceUiSnapshot } from "./appPersistence";

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

const baseUi = {
  activeStep: "model",
  homeRequested: false,
  selectedFaceId: null,
  selectedLoadPoint: null,
  selectedPayloadObject: null,
  viewMode: "model",
  themeMode: "dark",
  resultMode: "stress",
  showDeformed: false,
  showDimensions: false,
  stressExaggeration: 1,
  draftLoadType: "force",
  draftLoadValue: 500,
  draftLoadDirection: "-Z",
  sampleModel: "bracket",
  sampleAnalysisType: "static_stress",
  activeRunId: "",
  completedRunId: "",
  runProgress: 0,
  undoStack: [],
  redoStack: [],
  status: "Ready",
  logs: []
} satisfies WorkspaceUiSnapshot;

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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  test("does not restore or persist in-progress simulation state after reload", () => {
    const runningSnapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: {
        activeStep: "run",
        homeRequested: false,
        selectedFaceId: null,
        selectedLoadPoint: null,
        selectedPayloadObject: null,
        viewMode: "model",
        themeMode: "dark",
        resultMode: "stress",
        showDeformed: false,
        showDimensions: false,
        stressExaggeration: 1,
        draftLoadType: "force",
        draftLoadValue: 500,
        draftLoadDirection: "-Z",
        sampleModel: "cantilever",
        sampleAnalysisType: "dynamic_structural",
        activeRunId: "run-stale",
        completedRunId: "",
        runProgress: 98,
        undoStack: [],
        redoStack: [],
        status: "Running simulation",
        logs: ["Running simulation"]
      }
    });

    expect(runningSnapshot.ui.runProgress).toBe(0);

    const legacySnapshot = {
      ...runningSnapshot,
      ui: {
        ...runningSnapshot.ui,
        activeRunId: "run-legacy-stale",
        runProgress: 98
      }
    };

    expect(parseAutosavedWorkspacePayload(JSON.stringify(legacySnapshot))?.ui.runProgress).toBe(0);
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

  test("debounces autosave localStorage writes until idle work is scheduled", () => {
    vi.useFakeTimers();
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn()
    };
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: {
        activeStep: "model",
        homeRequested: false,
        selectedFaceId: null,
        selectedLoadPoint: null,
        selectedPayloadObject: null,
        viewMode: "model",
        themeMode: "dark",
        resultMode: "stress",
        showDeformed: false,
        showDimensions: false,
        stressExaggeration: 1,
        draftLoadType: "force",
        draftLoadValue: 500,
        draftLoadDirection: "-Z",
        sampleModel: "bracket",
        sampleAnalysisType: "static_stress",
        activeRunId: "",
        completedRunId: "",
        runProgress: 0,
        undoStack: [],
        redoStack: [],
        status: "Ready",
        logs: []
      }
    });

    const cancel = scheduleAutosavedWorkspaceWrite(snapshot, storage, 650);

    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(649);
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    cancel();
  });

  test("defers heavy autosave snapshot construction until the scheduled write", () => {
    vi.useFakeTimers();
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn()
    };
    let buildCount = 0;
    const cancel = scheduleAutosavedWorkspaceWrite(() => {
      buildCount += 1;
      return buildAutosavedWorkspace({
        project,
        displayModel,
        savedAt: "2026-04-24T13:00:00.000Z",
        results: { activeRunId: "run-1", completedRunId: "run-1", summary, fields },
        ui: baseUi
      });
    }, storage, 200);

    expect(buildCount).toBe(0);
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(buildCount).toBe(0);
    vi.advanceTimersByTime(1);
    expect(buildCount).toBe(1);
    expect(storage.setItem).toHaveBeenCalledWith(AUTOSAVE_STORAGE_KEY, expect.stringContaining('"fields"'));

    cancel();
  });

  test("writes lightweight UI autosave separately from the heavy workspace snapshot", () => {
    vi.useFakeTimers();
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn()
    };
    const uiSnapshot = buildAutosavedWorkspaceUiSnapshot({
      ...baseUi,
      resultMode: "displacement",
      stressExaggeration: 3.25,
      status: "Dragging deformation",
      logs: ["Dragging deformation"]
    }, "2026-04-24T13:05:00.000Z");

    const cancel = scheduleAutosavedUiSnapshotWrite(uiSnapshot, storage, 200);

    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(AUTOSAVE_UI_STORAGE_KEY, JSON.stringify(uiSnapshot));
    expect(storage.setItem).not.toHaveBeenCalledWith(AUTOSAVE_STORAGE_KEY, expect.any(String));

    cancel();
  });

  test("overlays the latest lightweight UI autosave onto an existing full autosave payload", () => {
    const heavySnapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      results: { activeRunId: "run-1", completedRunId: "run-1", summary, fields },
      ui: {
        ...baseUi,
        activeStep: "results",
        viewMode: "results",
        resultMode: "stress",
        stressExaggeration: 1,
        status: "Results ready",
        logs: ["Results ready"]
      }
    });
    const uiSnapshot = buildAutosavedWorkspaceUiSnapshot({
      ...heavySnapshot.ui,
      resultMode: "acceleration",
      stressExaggeration: 4,
      status: "Fine tuning view",
      logs: ["Fine tuning view"]
    }, "2026-04-24T13:02:00.000Z");
    const storage = {
      getItem: vi.fn((key: string) => {
        if (key === AUTOSAVE_STORAGE_KEY) return JSON.stringify(heavySnapshot);
        if (key === AUTOSAVE_UI_STORAGE_KEY) return JSON.stringify(uiSnapshot);
        return null;
      }),
      setItem: vi.fn()
    };

    const restored = readAutosavedWorkspace(storage);

    expect(restored?.projectFile.results?.fields).toBeDefined();
    expect(restored?.projectFile.displayModel).toEqual(displayModel);
    expect(restored?.ui.resultMode).toBe("acceleration");
    expect(restored?.ui.stressExaggeration).toBe(4);
    expect(restored?.ui.status).toBe("Fine tuning view");
  });
});
