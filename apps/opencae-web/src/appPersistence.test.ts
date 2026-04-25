import { describe, expect, test } from "vitest";
import type { DisplayModel, Project, ResultField, ResultSummary } from "@opencae/schema";
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

describe("app persistence", () => {
  test("builds a reloadable snapshot with project, model, results, and UI state", () => {
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      results: { activeRunId: "run-1", completedRunId: "run-1", summary, fields },
      ui: {
        activeStep: "results",
        selectedFaceId: "face-1",
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
    expect(snapshot.ui.showDeformed).toBe(true);
  });

  test("parses valid autosave JSON and rejects invalid autosave JSON", () => {
    const snapshot = buildAutosavedWorkspace({
      project,
      displayModel,
      savedAt: "2026-04-24T13:00:00.000Z",
      ui: {
        activeStep: "loads",
        selectedFaceId: null,
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
    expect(parseAutosavedWorkspacePayload("{bad json")).toBeNull();
    expect(parseAutosavedWorkspacePayload(JSON.stringify({ ...snapshot, version: 99 }))).toBeNull();
  });
});
