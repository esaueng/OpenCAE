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

  test("keeps sample model and analysis changes on the model step", () => {
    expect(appSource).toContain('await openProjectResponse(loadSampleProject(nextSample, nextAnalysisType), { nextStep: "model" });');
    expect(appSource).toContain("applyStep(options.nextStep);");
  });

  test("drives dynamic result playback with animation frames instead of queued intervals", () => {
    expect(appSource).toContain("window.requestAnimationFrame(advancePlaybackFrame)");
    expect(appSource).toContain("resultPlaybackFramePositionRef.current");
    expect(appSource).toContain("resultFramePosition={resultVisualFramePosition}");
    expect(appSource).not.toContain("window.setInterval");
  });

  test("invalidates completed results after dynamic solver settings change", () => {
    expect(appSource).toContain("invalidateCompletedRunState();");
    expect(appSource).toContain("setRunProgress(0);");
    expect(appSource).toContain("setResultFields([]);");
  });

  test("keeps dynamic output cadence separate from smaller integration time steps", () => {
    expect(appSource).toContain("const mergedSettings = { ...study.solverSettings, ...settings };");
    expect(appSource).toContain("settings.outputInterval ?? study.solverSettings.outputInterval");
    expect(appSource).not.toContain("outputInterval: settings.timeStep ?? settings.outputInterval");
  });

  test("normalizes legacy dense dynamic output cadence when settings change", () => {
    expect(appSource).toContain("MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS");
    expect(appSource).toContain("mergedSettings.timeStep,");
    expect(appSource).toContain("MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS");
  });
});
