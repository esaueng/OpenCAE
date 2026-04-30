import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");

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
    expect(appSource).toContain("resultPlaybackOrdinalPositionRef.current");
    expect(appSource).toContain("resultFramePosition={resultVisualFramePosition}");
    expect(appSource).toContain("resultFrameOrdinalPosition={resultVisualOrdinalPosition}");
    expect(appSource).toContain("boundedPlaybackOrdinalDelta(");
    expect(appSource).toContain("frameIndexForPlaybackOrdinal(playbackFrameIndexes, ordinalPosition)");
    expect(appSource).toContain("resultFrameCache.fieldsForFramePosition(resultVisualFramePosition)");
    expect(appSource).toContain("createPackedResultPlaybackCache(resultFieldsForUi)");
    expect(appSource).toContain("packedResultPlaybackCache?.fieldsForFramePosition(resultVisualFramePosition)");
    expect(appSource).toContain("const PLAYBACK_UI_COMMIT_INTERVAL_MS = 250;");
    expect(appSource).not.toContain("const nextFrameIndex = Math.floor(framePosition)");
    expect(appSource).not.toContain("hydratePreparedPlaybackFrame(preparedFrame).fields");
    expect(appSource).not.toContain("interpolatedFieldsForFramePosition(resultFieldsForUi");
    expect(appSource).not.toContain("window.setInterval");
  });

  test("prioritizes viewer interaction over playback visual commits", () => {
    expect(appSource).toContain("const viewerInteractingRef = useRef(false);");
    expect(appSource).toContain("const playbackViewerFrameIntervalMs = viewerInteractingRef.current");
    expect(appSource).toContain("const playbackCommitIntervalMs = viewerInteractingRef.current");
    expect(appSource).toContain("if (!viewerInteractingRef.current) {");
    expect(appSource).toContain("commitPlaybackViewerFrame(framePosition);");
    expect(appSource).toContain("onViewerInteractionChange={handleViewerInteractionChange}");
  });

  test("rejects dynamic cloud results that do not contain animation frames before showing Results", () => {
    expect(appSource).toContain("hasDynamicPlaybackFrames(results.summary, results.fields)");
    expect(appSource).toContain("Cloud FEA dynamic results did not include animation frames.");
    expect(appSource).toContain('if (study.type === "dynamic_structural" && !hasDynamicPlaybackFrames(results.summary, results.fields))');
  });

  test("enables deformed result shape when dynamic playback starts", () => {
    expect(appSource).toContain("function handleResultPlaybackToggle()");
    expect(appSource).toContain("if (!playing) setShowDeformed(true);");
  });

  test("invalidates completed results after dynamic solver settings change", () => {
    expect(appSource).toContain("invalidateCompletedRunState();");
    expect(appSource).toContain("setRunProgress(0);");
    expect(appSource).toContain("setResultFields([]);");
  });

  test("keeps dynamic output cadence separate from smaller integration time steps", () => {
    expect(appSource).toContain("normalizedDynamicSolverSettings(study.solverSettings, { ...study.solverSettings, ...settings }, settings)");
    expect(appSource).toContain("patch.outputInterval ?? currentSettings.outputInterval");
    expect(appSource).not.toContain("outputInterval: settings.timeStep ?? settings.outputInterval");
  });

  test("normalizes legacy dense dynamic output cadence when settings change", () => {
    expect(appSource).toContain("MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS");
    expect(appSource).toContain("mergedSettings.timeStep,");
    expect(appSource).toContain("MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS");
  });
});
