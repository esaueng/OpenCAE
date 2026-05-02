import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
const apiSource = readFileSync(resolve(__dirname, "lib/api.ts"), "utf8");

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

  test("keeps the workspace top bar focused on project controls", () => {
    expect(appSource).not.toContain('href="https://ko-fi.com/petergustafson"');
    expect(appSource).not.toContain("Buy me a coffee");
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

  test("keeps playback cache worker failures user-facing", () => {
    expect(appSource).toContain('setResultPlaybackCacheState({ status: "error", cacheKey: resultPlaybackCacheKey, message: "Using live playback for this browser" });');
    expect(appSource).not.toContain('error.message ? error.message : "Using live playback for this browser"');
  });

  test("keeps animation speed changes from rebuilding the smooth playback cache", () => {
    const cacheKeyStart = appSource.indexOf("const resultPlaybackCacheKey = useMemo(");
    const cacheKeyEnd = appSource.indexOf("  const visibleResultFieldsForUi = useMemo(", cacheKeyStart);
    const cacheKeyBlock = appSource.slice(cacheKeyStart, cacheKeyEnd);
    const prepareEffectStart = appSource.indexOf("void preparePlaybackFramesInWorker({");
    const prepareEffectEnd = appSource.indexOf("  useEffect(() => {\n    if (!resultPlaybackPlaying", prepareEffectStart);
    const prepareEffectBlock = appSource.slice(prepareEffectStart, prepareEffectEnd);

    expect(appSource).toContain("const PLAYBACK_CACHE_PREP_FPS = 30;");
    expect(cacheKeyBlock).not.toContain("resultPlaybackFps");
    expect(prepareEffectBlock).toContain("playbackFps: PLAYBACK_CACHE_PREP_FPS");
    expect(prepareEffectBlock).not.toContain("resultPlaybackFps");
  });

  test("rejects dynamic cloud results that do not contain animation frames before showing Results", () => {
    expect(appSource).toContain("hasDynamicPlaybackFrames(results.summary, results.fields)");
    expect(appSource).toContain("Cloud FEA dynamic results did not include animation frames.");
    expect(appSource).toContain('if (study.type === "dynamic_structural" && !hasDynamicPlaybackFrames(results.summary, results.fields))');
  });

  test("surfaces Cloud FEA run creation failures instead of leaving the run button inert", () => {
    expect(appSource).toContain('pushMessage("Starting simulation run.");');
    expect(appSource).toContain("runDiagnosticsMessage(study)");
    expect(appSource).not.toContain('pushMessage("Cloud FEA request started: POST /api/cloud-fea/runs.");');
    expect(apiSource).toContain("Cloud FEA request started: POST");
    expect(apiSource).toContain("Cloud FEA local bridge selected:");
    expect(appSource).toContain("try {\n      response = await runSimulation(study.id, study, displayModel ?? undefined, { onCloudFeaHealth: pushMessage });");
    expect(appSource).toContain("setRunProgress(0);");
    expect(appSource).toContain('pushMessage(`Cloud FEA run creation failed: ${errorMessage(error, "Could not start simulation.")}`);');
    expect(appSource).toContain("Cloud FEA run created: runId=");
    expect(appSource).toContain("Cloud FEA event polling started: GET");
    expect(appSource).toContain("Cloud FEA results fetch started: GET");
    expect(appSource).toContain('pushMessage(`Cloud FEA results fetch failed: ${errorMessage(error, "Could not load simulation results.")}`);');
  });

  test("enables deformed result shape when dynamic playback starts", () => {
    expect(appSource).toContain("function handleResultPlaybackToggle()");
    expect(appSource).toContain("if (!playing) setShowDeformed(true);");
  });

  test("wires single-key workspace shortcuts for home and step navigation", () => {
    expect(appSource).toContain('if (key === "h")');
    expect(appSource).toContain("handleFitDefaultView();");
    expect(appSource).toContain("workflowStepForShortcut(key, activeStep");
    expect(appSource).toContain("navigateToStep(shortcutStep);");
    expect(appSource).toContain("isEditableShortcutTarget(event.target as HTMLElement | null)");
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
