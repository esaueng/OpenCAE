import { describe, expect, test } from "vitest";
import {
  canNavigateToStep,
  isEditableShortcutTarget,
  printLayerOrientationForViewer,
  workflowStepForShortcut,
  shouldAutoAdvanceAfterMaterialAssignment,
  shouldAutoAdvanceAfterMeshGeneration,
  shouldShowStartScreen
} from "./appShellState";

describe("app shell state", () => {
  test("shows the start screen when home is requested from an open project", () => {
    expect(shouldShowStartScreen({ homeRequested: true, hasProject: true, hasDisplayModel: true, hasStudy: true })).toBe(true);
  });

  test("keeps the workspace open when a project exists before simulation creation", () => {
    expect(shouldShowStartScreen({ homeRequested: false, hasProject: true, hasDisplayModel: true, hasStudy: false })).toBe(false);
  });

  test("does not auto-advance after mesh generation", () => {
    expect(shouldAutoAdvanceAfterMeshGeneration()).toBe(false);
  });

  test("does not auto-advance after material assignment", () => {
    expect(shouldAutoAdvanceAfterMaterialAssignment()).toBe(false);
  });

  test("blocks run navigation until the mesh is complete", () => {
    expect(canNavigateToStep("run", { meshStatus: "not_started" })).toBe(false);
    expect(canNavigateToStep("run", { meshStatus: "ready" })).toBe(false);
    expect(canNavigateToStep("run", { meshStatus: "complete" })).toBe(true);
    expect(canNavigateToStep("mesh", { meshStatus: "not_started" })).toBe(true);
  });

  test("maps workflow keyboard shortcuts to adjacent allowed steps", () => {
    expect(workflowStepForShortcut("n", "model", { meshStatus: "not_started" })).toBe("material");
    expect(workflowStepForShortcut("b", "material", { meshStatus: "not_started" })).toBe("model");
    expect(workflowStepForShortcut("n", "mesh", { meshStatus: "complete" })).toBe("run");
    expect(workflowStepForShortcut("n", "mesh", { meshStatus: "ready" })).toBeNull();
    expect(workflowStepForShortcut("b", "model", { meshStatus: "complete" })).toBeNull();
    expect(workflowStepForShortcut("n", "results", { meshStatus: "complete" })).toBeNull();
  });

  test("ignores single-key shortcuts while editing form fields", () => {
    expect(isEditableShortcutTarget({ tagName: "INPUT", isContentEditable: false })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "SELECT", isContentEditable: false })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(isEditableShortcutTarget(null)).toBe(false);
  });

  test("uses draft print direction for viewer preview before material is applied", () => {
    expect(printLayerOrientationForViewer("z", "x")).toBe("x");
    expect(printLayerOrientationForViewer("z", null)).toBeNull();
    expect(printLayerOrientationForViewer("z", undefined)).toBe("z");
  });
});
