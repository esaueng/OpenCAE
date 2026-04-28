import { describe, expect, test } from "vitest";
import {
  canNavigateToStep,
  printLayerOrientationForViewer,
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

  test("uses draft print direction for viewer preview before material is applied", () => {
    expect(printLayerOrientationForViewer("z", "x")).toBe("x");
    expect(printLayerOrientationForViewer("z", null)).toBeNull();
    expect(printLayerOrientationForViewer("z", undefined)).toBe("z");
  });
});
