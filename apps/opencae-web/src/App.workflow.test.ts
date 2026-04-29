import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(resolve(__dirname, "App.tsx"), "utf8");

describe("App workflow layout", () => {
  test("uses the step-by-step StepBar as the primary simulation workflow", () => {
    expect(appSource).toContain('import { StepBar, type StepId } from "./components/StepBar";');
    expect(appSource).toContain("<StepBar");
    expect(appSource).not.toContain("<StudyTree");
  });

  test("routes project files without a study to the required simulation type screen", () => {
    expect(appSource).toContain("if (project && displayModel && displayModelForUi && !study)");
    expect(appSource).toContain("<CreateSimulationScreen");
    expect(appSource).not.toContain("<NoStudyPanel");
  });
});
