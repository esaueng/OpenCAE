import { afterEach, describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project, ResultField, ResultSummary, Study } from "@opencae/schema";
import {
  AUTOSAVE_STORAGE_KEY,
  AUTOSAVE_UI_STORAGE_KEY,
  buildAutosavedWorkspace,
  buildAutosavedWorkspaceUiSnapshot,
  installAutosavePageHideFlush,
  localRunIdForResultsRestore,
  parseAutosavedWorkspacePayload,
  readAutosavedWorkspace,
  scheduleAutosavedUiSnapshotWrite,
  scheduleAutosavedWorkspaceWrite,
  WORKSPACE_LOG_LIMIT,
  writeAutosavedWorkspace
} from "./appPersistence";
import type { AutosavedWorkspace, WorkspaceUiSnapshot } from "./appPersistence";
import { BRACKET_CORE_CLOUD_GEOMETRY, BRACKET_GEOMETRY_MIGRATION_NOTE } from "./bracketGeometryMigration";

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
  resultFrameIndex: 0,
  resultPlaybackFps: 12,
  resultPlaybackReverseLoop: false,
  isStepbarCollapsed: false,
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
    parameters: { printed: false, manufacturingProcessId: "process-cnc-machining" },
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

  test("returns no autosave when storage reads are denied", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new DOMException("Storage access denied", "SecurityError");
      }),
      setItem: vi.fn()
    };

    expect(readAutosavedWorkspace(storage)).toBeNull();
  });

  test("restores dynamic cloud results whose transient summary omits integrationMethod and dampingRatio", async () => {
    // Core Cloud runners up to 0.1.5 emit transient summaries without these two keys;
    // requiring them made parseResultBundle silently drop restored dynamic results.
    const { parseResultBundle } = await import("./appPersistence");
    const cloudTransientSummary = {
      ...summary,
      transient: {
        analysisType: "dynamic_structural",
        frameCount: 21,
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        loadProfile: "ramp",
        peakDisplacement: 0.0016,
        peakDisplacementTimeSeconds: 0.1,
        peakVelocity: 0.05,
        peakAcceleration: 2.1
      }
    };
    const bundle = parseResultBundle({
      completedRunId: "run-cloud",
      summary: cloudTransientSummary,
      fields
    });
    expect(bundle).toBeDefined();
    expect(bundle?.summary.transient?.frameCount).toBe(21);
  });

  test("restores report captures saved with completed simulation results", async () => {
    const { parseResultBundle } = await import("./appPersistence");
    const reportCaptures = {
      stress: {
        png: "data:image/png;base64,stress",
        fieldId: "field-1",
        selection: "peak" as const,
        frameIndex: 2,
        timeSeconds: 0.02
      }
    };

    const bundle = parseResultBundle({
      activeRunId: "run-1",
      completedRunId: "run-1",
      summary,
      fields,
      reportCaptures
    });

    expect(bundle?.reportCaptures).toEqual(reportCaptures);
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
        logs: [{ message: "Results ready", at: 1714000000000 }]
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
        draftLoadDirection: "Opposite normal",
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
    expect(parseAutosavedWorkspacePayload(JSON.stringify(snapshot))?.ui.draftLoadDirection).toBe("Opposite normal");
    expect(parseAutosavedWorkspacePayload("{bad json")).toBeNull();
    expect(parseAutosavedWorkspacePayload(JSON.stringify({ ...snapshot, version: 99 }))).toBeNull();
  });

  test("preserves enough logs to diagnose OpenCAE Core failures after reload", () => {
    const logs = Array.from({ length: 120 }, (_, index) => ({ message: `OpenCAE Core diagnostic ${index}`, at: 1714000000000 + index }));
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: {
        ...baseUi,
        logs
      }
    });
    const parsed = parseAutosavedWorkspacePayload(JSON.stringify(snapshot));

    expect(WORKSPACE_LOG_LIMIT).toBe(100);
    expect(parsed?.ui.logs).toHaveLength(100);
    expect(parsed?.ui.logs[0]).toEqual({ message: "OpenCAE Core diagnostic 0", at: 1714000000000 });
    expect(parsed?.ui.logs.at(-1)).toEqual({ message: "OpenCAE Core diagnostic 99", at: 1714000000099 });
  });

  test("restores legacy plain-string log payloads as timestamped entries", () => {
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: baseUi
    });
    const legacyPayload = JSON.stringify({
      ...snapshot,
      ui: { ...snapshot.ui, logs: ["Legacy log line"] }
    });

    const parsed = parseAutosavedWorkspacePayload(legacyPayload);

    expect(parsed?.ui.logs[0]?.message).toBe("Legacy log line");
    expect(typeof parsed?.ui.logs[0]?.at).toBe("number");
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
        logs: [{ message: "Running simulation", at: 1714000000000 }]
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
        logs: [{ message: "Setup ready", at: 1714000000000 }]
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

  test("strips embedded model payloads from undo history and reattaches them on restore", () => {
    const embeddedModel = { filename: "bracket.step", contentType: "model/step", size: 4, contentBase64: "U1RFUA==" };
    const projectWithUpload = {
      ...project,
      geometryFiles: [{
        id: "geom-upload-1",
        projectId: project.id,
        filename: "bracket.step",
        localPath: "uploads/bracket.step",
        artifactKey: "project-1/geometry/uploaded-display.json",
        status: "ready",
        metadata: { source: "local-upload", embeddedModel }
      }]
    } satisfies Project;
    const snapshot = buildAutosavedWorkspace({
      project: projectWithUpload,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: {
        ...baseUi,
        undoStack: [projectWithUpload],
        redoStack: [projectWithUpload]
      }
    });

    expect(snapshot.ui.undoStack[0]?.geometryFiles[0]?.metadata.embeddedModel).toBeUndefined();
    expect(snapshot.ui.redoStack[0]?.geometryFiles[0]?.metadata.embeddedModel).toBeUndefined();
    expect(snapshot.projectFile.project.geometryFiles[0]?.metadata.embeddedModel).toEqual(embeddedModel);
    expect(JSON.stringify(snapshot.ui)).not.toContain("U1RFUA==");

    const storage = {
      getItem: vi.fn((key: string) => (key === AUTOSAVE_STORAGE_KEY ? JSON.stringify(snapshot) : null)),
      setItem: vi.fn()
    };
    const restored = readAutosavedWorkspace(storage);

    expect(restored?.ui.undoStack[0]?.geometryFiles[0]?.metadata.embeddedModel).toEqual(embeddedModel);
    expect(restored?.ui.redoStack[0]?.geometryFiles[0]?.metadata.embeddedModel).toEqual(embeddedModel);
    expect(restored?.projectFile.project.geometryFiles[0]?.metadata.embeddedModel).toEqual(embeddedModel);
  });

  test("reports autosave write failures through the onWriteFailed callback", () => {
    vi.useFakeTimers();
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      })
    };
    const onWriteFailed = vi.fn();
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: baseUi
    });

    const cancel = scheduleAutosavedWorkspaceWrite(snapshot, storage, 100, onWriteFailed);
    vi.advanceTimersByTime(100);

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(onWriteFailed).toHaveBeenCalledTimes(1);
    cancel();
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

  test("flushes the latest autosave when the web page is reloaded", () => {
    const target = new EventTarget();
    const flush = vi.fn();
    const uninstall = installAutosavePageHideFlush(flush, target);

    target.dispatchEvent(new Event("pagehide"));
    expect(flush).toHaveBeenCalledTimes(1);

    uninstall();
    target.dispatchEvent(new Event("pagehide"));
    expect(flush).toHaveBeenCalledTimes(1);
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
      logs: [{ message: "Dragging deformation", at: 1714000000000 }]
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
        logs: [{ message: "Results ready", at: 1714000000000 }]
      }
    });
    const uiSnapshot = buildAutosavedWorkspaceUiSnapshot({
      ...heavySnapshot.ui,
      resultMode: "acceleration",
      stressExaggeration: 4,
      status: "Fine tuning view",
      logs: [{ message: "Fine tuning view", at: 1714000000000 }]
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

  test("identifies a completed local run whose large results were shed from the autosave", () => {
    const workspace = buildAutosavedWorkspace({
      project,
      displayModel,
      results: { activeRunId: "run-local-1", completedRunId: "run-local-1", summary, fields },
      ui: { ...baseUi, activeRunId: "run-local-1", completedRunId: "run-local-1", runProgress: 100 }
    });
    const slimWorkspace = {
      ...workspace,
      projectFile: { ...workspace.projectFile, results: undefined }
    } satisfies AutosavedWorkspace;

    expect(localRunIdForResultsRestore(slimWorkspace)).toBe("run-local-1");
    expect(localRunIdForResultsRestore(workspace)).toBeNull();
  });
});

describe("bracket geometry migration on autosave restore", () => {
  function bracketProjectWith(geometry: unknown): Project {
    return {
      ...project,
      geometryFiles: [{
        id: "geom-bracket",
        projectId: project.id,
        filename: "bracket-demo.step",
        localPath: "samples/bracket-demo.step",
        artifactKey: "project-1/geometry/bracket-display.json",
        status: "ready",
        metadata: { source: "sample", sampleModel: "bracket", coreCloudGeometry: geometry }
      }],
      studies: [studyWithSetup]
    } as Project;
  }

  function storageWith(snapshot: AutosavedWorkspace) {
    return {
      getItem: vi.fn((key: string) => (key === AUTOSAVE_STORAGE_KEY ? JSON.stringify(snapshot) : null)),
      setItem: vi.fn()
    };
  }

  test("refreshes an outdated bracket descriptor on restore, clears the stale mesh, and reports it", () => {
    // A pre-fix autosave: the embedded descriptor still carries the full-width
    // 34 mm gusset (the wedge), and the study kept the mesh built from it.
    const staleGeometry = structuredClone(BRACKET_CORE_CLOUD_GEOMETRY);
    staleGeometry.descriptor.gusset.thickness = 34;
    const staleProject = bracketProjectWith(staleGeometry);
    const snapshot = buildAutosavedWorkspace({
      project: staleProject,
      displayModel: { ...displayModel, coreCloudGeometry: staleGeometry },
      savedAt: "2026-07-01T12:00:00.000Z",
      ui: { ...baseUi, undoStack: [staleProject], status: "Results ready", logs: [{ message: "Results ready", at: 1714000000000 }] }
    });

    const restored = readAutosavedWorkspace(storageWith(snapshot));

    expect(restored?.projectFile.project.geometryFiles[0]?.metadata.coreCloudGeometry).toEqual(BRACKET_CORE_CLOUD_GEOMETRY);
    expect(restored?.projectFile.displayModel.coreCloudGeometry).toEqual(BRACKET_CORE_CLOUD_GEOMETRY);
    // The wedge mesh is invalidated so the run flow re-meshes the corrected shape.
    expect(restored?.projectFile.project.studies[0]?.meshSettings).toEqual({ preset: "medium", status: "not_started" });
    // Undo history is refreshed too, so undo cannot resurrect the wedge.
    expect(restored?.ui.undoStack[0]?.geometryFiles[0]?.metadata.coreCloudGeometry).toEqual(BRACKET_CORE_CLOUD_GEOMETRY);
    expect(restored?.ui.undoStack[0]?.studies[0]?.meshSettings.status).toBe("not_started");
    // Honest, not silent: the migration is the restored status and newest log line.
    expect(restored?.ui.status).toBe(BRACKET_GEOMETRY_MIGRATION_NOTE);
    expect(restored?.ui.logs[0]?.message).toBe(BRACKET_GEOMETRY_MIGRATION_NOTE);
    expect(restored?.ui.logs[1]?.message).toBe("Results ready");
  });

  test("leaves an up-to-date bracket autosave untouched and note-free", () => {
    const currentProject = bracketProjectWith(structuredClone(BRACKET_CORE_CLOUD_GEOMETRY));
    const snapshot = buildAutosavedWorkspace({
      project: currentProject,
      displayModel: { ...displayModel, coreCloudGeometry: BRACKET_CORE_CLOUD_GEOMETRY },
      savedAt: "2026-07-09T12:00:00.000Z",
      ui: { ...baseUi, status: "Results ready" }
    });

    const restored = readAutosavedWorkspace(storageWith(snapshot));

    expect(restored?.ui.status).toBe("Results ready");
    expect(restored?.projectFile.project.studies[0]?.meshSettings).toEqual(studyWithSetup.meshSettings);
    expect(restored?.projectFile.displayModel.coreCloudGeometry).toEqual(BRACKET_CORE_CLOUD_GEOMETRY);
  });
});

describe("autosave quota fallback", () => {
  function quotaLimitedStorage(maxBytes: number) {
    const store = new Map<string, string>();
    return {
      store,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > maxBytes) throw new DOMException("Quota exceeded", "QuotaExceededError");
        store.set(key, value);
      }
    };
  }

  function heavyProject(): Project {
    const artifacts = {
      actualCoreModel: { model: { nodes: { coordinates: Array.from({ length: 3000 }, (_v, i) => i * 0.001) } } },
      meshConnectivity: { connectedComponents: 1 },
      selectionMapping: [{ selection: "FS1", mode: "byFace" }]
    };
    const study = {
      ...studyWithSetup,
      meshSettings: {
        preset: "medium" as const,
        status: "complete" as const,
        meshRef: "mesh-1",
        summary: { nodes: 2150, elements: 1126, warnings: [], artifacts }
      }
    };
    return { ...project, studies: [study] } as Project;
  }

  test("sheds results and mesh artifacts when the full autosave exceeds quota", () => {
    const storage = quotaLimitedStorage(20_000);
    const snapshot = buildAutosavedWorkspace({
      project: heavyProject(),
      displayModel,
      savedAt: "2026-07-09T02:47:41.000Z",
      results: {
        activeRunId: "run-local-quota",
        completedRunId: "run-local-quota",
        summary,
        fields: [{ ...fields[0]!, values: Array.from({ length: 5000 }, () => 12) }]
      },
      ui: { ...baseUi, activeRunId: "run-local-quota", completedRunId: "run-local-quota", runProgress: 100 }
    });

    const outcome = writeAutosavedWorkspace(snapshot, storage);

    expect(outcome).toBe("slim");
    const stored = JSON.parse(storage.store.get(AUTOSAVE_STORAGE_KEY)!) as AutosavedWorkspace;
    expect(stored.projectFile.results).toBeUndefined();
    expect(localRunIdForResultsRestore(stored)).toBe("run-local-quota");
    const storedArtifacts = stored.projectFile.project.studies[0]!.meshSettings.summary?.artifacts as Record<string, unknown>;
    expect(storedArtifacts.actualCoreModel).toBeUndefined();
    // Regenerable heavyweights are gone; the setup and light artifacts survive.
    expect(storedArtifacts.meshConnectivity).toEqual({ connectedComponents: 1 });
    expect(storedArtifacts.selectionMapping).toEqual([{ selection: "FS1", mode: "byFace" }]);
    expect(stored.projectFile.project.studies[0]!.meshSettings.summary?.nodes).toBe(2150);
    expect(stored.projectFile.project.studies[0]!.constraints).toEqual(studyWithSetup.constraints);
  });

  test("reports failed when even the slim autosave cannot fit", () => {
    const storage = quotaLimitedStorage(10);
    const snapshot = buildAutosavedWorkspace({ project: heavyProject(), displayModel, ui: baseUi });

    expect(writeAutosavedWorkspace(snapshot, storage)).toBe("failed");
  });

  test("notifies degradation (not failure) through scheduleAutosavedWorkspaceWrite", () => {
    vi.useFakeTimers();
    const storage = quotaLimitedStorage(20_000);
    const onWriteFailed = vi.fn();
    const onWriteDegraded = vi.fn();
    const snapshot = buildAutosavedWorkspace({
      project: heavyProject(),
      displayModel,
      results: { activeRunId: "run-1", completedRunId: "run-1", summary, fields: [{ ...fields[0]!, values: Array.from({ length: 5000 }, () => 12) }] },
      ui: baseUi
    });

    const cancel = scheduleAutosavedWorkspaceWrite(snapshot, storage, 100, onWriteFailed, onWriteDegraded);
    vi.advanceTimersByTime(100);

    expect(onWriteDegraded).toHaveBeenCalledTimes(1);
    expect(onWriteFailed).not.toHaveBeenCalled();
    cancel();
  });

  test("undo/redo snapshots never carry heavy mesh artifacts", () => {
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      ui: { ...baseUi, undoStack: [heavyProject()], redoStack: [] }
    });

    const undoArtifacts = snapshot.ui.undoStack[0]!.studies[0]!.meshSettings.summary?.artifacts as Record<string, unknown>;
    expect(undoArtifacts.actualCoreModel).toBeUndefined();
    expect(undoArtifacts.meshConnectivity).toEqual({ connectedComponents: 1 });
  });
});
