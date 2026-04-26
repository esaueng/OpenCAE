import { describe, expect, test } from "vitest";
import { canNavigateToStep, shouldAutoAdvanceAfterMeshGeneration, shouldShowStartScreen } from "./appShellState";

describe("app shell state", () => {
  test("shows the start screen when home is requested from an open project", () => {
    expect(shouldShowStartScreen({ homeRequested: true, hasProject: true, hasDisplayModel: true, hasStudy: true })).toBe(true);
  });

  test("does not auto-advance after mesh generation", () => {
    expect(shouldAutoAdvanceAfterMeshGeneration()).toBe(false);
  });

  test("blocks run navigation until the mesh is complete", () => {
    expect(canNavigateToStep("run", { meshStatus: "not_started" })).toBe(false);
    expect(canNavigateToStep("run", { meshStatus: "ready" })).toBe(false);
    expect(canNavigateToStep("run", { meshStatus: "complete" })).toBe(true);
    expect(canNavigateToStep("mesh", { meshStatus: "not_started" })).toBe(true);
  });
});
