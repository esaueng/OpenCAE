import { describe, expect, test } from "vitest";
import { shouldAutoAdvanceAfterMeshGeneration, shouldShowStartScreen } from "./appShellState";

describe("app shell state", () => {
  test("shows the start screen when home is requested from an open project", () => {
    expect(shouldShowStartScreen({ homeRequested: true, hasProject: true, hasDisplayModel: true, hasStudy: true })).toBe(true);
  });

  test("does not auto-advance after mesh generation", () => {
    expect(shouldAutoAdvanceAfterMeshGeneration()).toBe(false);
  });
});
