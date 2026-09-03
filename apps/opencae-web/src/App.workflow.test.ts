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
    expect(appSource).toContain('const opened = await openProjectResponse(loadSampleProject(nextSample, nextAnalysisType), { actionHandle, nextStep: "model" });');
    expect(appSource).toContain("if (opened) {");
    expect(appSource).toContain("applyStep(options.nextStep);");
  });

  test("does not wire sample selectors directly to project reloads", () => {
    expect(appSource).not.toContain("onSampleModelChange={handleLoadSample}");
    expect(appSource).not.toContain("onSampleAnalysisTypeChange={(analysisType) => void handleLoadSample");
  });

  test("shows model import progress in the viewer until the active upload settles", () => {
    expect(appSource).toContain("const [modelImport, setModelImport]");
    expect(appSource).toContain("const MODEL_IMPORT_INDICATOR_MIN_MS = 500;");
    expect(appSource).toContain("setModelImport({ id: importId, filename: file.name });");
    expect(appSource).toContain("MODEL_IMPORT_INDICATOR_MIN_MS - (Date.now() - importStartedAt)");
    expect(appSource).toContain("setModelImport((current) => current?.id === importId ? null : current);");
    expect(appSource).toContain("importingModelFilename={modelImport?.filename}");
  });

  test("keeps the workspace top bar focused on project controls", () => {
    expect(appSource).not.toContain('href="https://ko-fi.com/esau"');
    expect(appSource).not.toContain("Buy me a coffee");
  });

  test("shows the beta release tag in the workspace brand", () => {
    expect(appSource).toContain('<span className="beta-tag">Beta</span>');
    expect(appSource).not.toContain('<span className="beta-tag">Alpha</span>');
  });

  test("drives dynamic result playback with animation frames instead of queued intervals", () => {
    expect(appSource).toContain("window.requestAnimationFrame(advancePlaybackFrame)");
    expect(appSource).toContain("resultPlaybackFramePositionRef.current");
    expect(appSource).toContain("resultPlaybackOrdinalPositionRef.current");
    expect(appSource).toContain("resultPlaybackDirectionRef.current");
    expect(appSource).toContain("resultPlaybackEndpointHoldRemainingMsRef.current");
    expect(appSource).toContain("resultFramePosition={resultVisualFramePosition}");
    expect(appSource).toContain("resultFrameOrdinalPosition={resultVisualOrdinalPosition}");
    expect(appSource).toContain("advancePlaybackTimeline({");
    expect(appSource).toContain("PLAYBACK_ENDPOINT_HOLD_MS");
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
    expect(cacheKeyBlock).not.toContain("resultPlaybackReverseLoop");
    expect(prepareEffectBlock).toContain("playbackFps: PLAYBACK_CACHE_PREP_FPS");
    expect(prepareEffectBlock).not.toContain("resultPlaybackFps");
    expect(prepareEffectBlock).not.toContain("resultPlaybackReverseLoop");
  });

  test("rejects dynamic results that do not contain animation frames before showing Results", () => {
    expect(appSource).toContain("hasDynamicPlaybackFrames(results.summary, results.fields)");
    expect(appSource).toContain("Dynamic results did not include animation frames.");
    expect(appSource).toContain('if (study.type === "dynamic_structural" && (!isStructuralResultSummary(results.summary) || !hasDynamicPlaybackFrames(results.summary, results.fields)))');
  });

  test("gates result rendering by current study and run identity", () => {
    expect(appSource).toContain("const resultDisplayEligible = useMemo");
    expect(appSource).toContain("resultsEligible={resultDisplayEligible}");
    expect(appSource).toContain("resultSummary={resultDisplayEligible ? resultSummaryForUi : null}");
    expect(appSource).toContain("processingRunIdRef.current !== response.run.id || currentStudy?.type !== study.type");
  });

  test("surfaces run creation failures instead of leaving the run button inert", () => {
    expect(appSource).toContain('pushMessage("Starting simulation run.");');
    expect(appSource).toContain("runDiagnosticsMessage(study, displayModel ?? undefined)");
    expect(apiSource).not.toContain("external solver request started: POST");
    expect(apiSource).not.toContain("external solver bridge selected:");
    expect(appSource).toContain("try {\n      response = await runSimulation(study.id, study, displayModel ?? undefined, {\n        onRunStatus: pushMessage,\n        resultRenderBounds,");
    expect(appSource).toContain("setRunProgress(0);");
    expect(appSource).toContain('const message = errorMessage(error, "Could not start simulation.");');
    expect(appSource).toContain("setRunError(message);");
    expect(appSource).toContain('if (event.type === "error") setRunError(event.message || "Simulation run failed.");');
    expect(appSource).not.toContain("external solver run created: runId=");
    expect(appSource).not.toContain("external solver event polling started: GET");
    expect(appSource).not.toContain("external solver results fetch started: GET");
    expect(appSource).toContain('const message = errorMessage(error, "Could not load simulation results.");');
  });

  test("renders live solver progress inside the topbar run button", () => {
    expect(appSource).toContain("const runButtonProgress = Math.min(100, Math.max(0, Math.round(runProgress)));");
    expect(appSource).toContain('style={{ "--run-progress": `${runButtonProgress}%` } as CSSProperties}');
    expect(appSource).toContain('aria-label={solverRunning ? `Running simulation: ${runButtonProgress}%` : "Run simulation"}');
    expect(appSource).toContain('solverRunning ? `Running… ${runButtonProgress}%` : "Run simulation"');
  });

  test("passes measured viewer render bounds into browser-local runs", () => {
    expect(appSource).toContain("const [resultRenderBounds, setResultRenderBounds] = useState<ResultRenderBounds | null>(null);");
    expect(appSource).toContain("onResultRenderBoundsChange={setResultRenderBounds}");
    expect(appSource).toContain("resultRenderBounds");
    expect(apiSource).toContain("resultRenderBounds?: ResultRenderBounds | null;");
    expect(apiSource).not.toContain("resultRenderBounds: options.resultRenderBounds ?? undefined");
  });

  test("enables deformed result shape when dynamic playback starts", () => {
    expect(appSource).toContain("function handleResultPlaybackToggle()");
    expect(appSource).toContain("if (!playing) setShowDeformed(true);");
  });

  test("wires reverse loop playback controls into the results panel", () => {
    expect(appSource).toContain("const [resultPlaybackReverseLoop, setResultPlaybackReverseLoop] = useState(restoredUi?.resultPlaybackReverseLoop ?? false);");
    expect(appSource).toContain("resultPlaybackReverseLoop={resultPlaybackReverseLoop}");
    expect(appSource).toContain("onResultPlaybackReverseLoopChange={setResultPlaybackReverseLoop}");
    expect(appSource).toContain('mode: resultPlaybackReverseLoop ? "reverse" : "restart"');
  });

  test("wires single-key workspace shortcuts for home and step navigation", () => {
    expect(appSource).toContain('if (key === "h")');
    expect(appSource).toContain("handleFitDefaultView();");
    expect(appSource).toContain("workflowStepForShortcut(key, activeStep");
    expect(appSource).toContain("navigateToStep(shortcutStep);");
    expect(appSource).toContain("isEditableShortcutTarget(event.target as HTMLElement | null)");
    expect(appSource).toContain('aria-controls="workspace-shortcut-guide"');
    expect(appSource).toContain("<KeyboardShortcutGuide />");
    expect(appSource).toContain("checked={singleKeyShortcutsEnabled}");
    expect(appSource).toContain("useFocusTrap<HTMLDivElement>(shortcutGuideOpen");
    expect(appSource).toContain('role="dialog" aria-modal="true"');
    expect(appSource).toContain('className="shortcut-popover-backdrop"');
  });

  test("moves skip-link focus to the main workspace target", () => {
    expect(appSource).toContain('href="#workspace-main" onClick={handleSkipToMain}');
    expect(appSource).toContain('window.history.replaceState(window.history.state, "", "#workspace-main");');
    expect(appSource).toContain("main.focus();");
    expect(appSource).toContain('ref={workspaceMainRef} className="workspace" id="workspace-main" tabIndex={-1}');
  });

  test("invalidates completed results after dynamic solver settings change", () => {
    expect(appSource).toContain("invalidateCompletedRunState();");
    expect(appSource).toContain("setRunProgress(0);");
    expect(appSource).toContain("setResultFields([]);");
  });

  test("lets the storage card be closed and keeps the top-bar panels exclusive", () => {
    // The card sat at a z-index below --z-popover, so the shortcut popover painted over
    // it; and it had no dismissal at all, so it floated over the viewer until a
    // preference was chosen.
    expect(appSource).toContain("onDismiss={() => setStorageRecoveryNoticeOpen(false)}");
    expect(appSource).toMatch(
      /if \(!storageRecoveryNoticeOpen\) return undefined;[\s\S]{0,200}?if \(event\.key === "Escape"\) setStorageRecoveryNoticeOpen\(false\);/,
    );
    expect(appSource).toContain("onClick={() => { setStorageRecoveryNoticeOpen(false); setShortcutGuideOpen((open) => !open); }}");
    expect(appSource).toContain("onClick={() => { setShortcutGuideOpen(false); setStorageRecoveryNoticeOpen((open) => !open); }}");
  });

  test("clears progress when a completed run's results are thrown away", () => {
    // Without this the abandoned run leaves runProgress at 100, so solverStatus stays
    // "Complete" and the status pill reads "Results ready" for results it just discarded.
    expect(appSource).toMatch(
      /pushMessage\("Completed results were ignored because the active project or analysis changed during the run\.\"\);[\s\S]{0,240}?setRunProgress\(0\);[\s\S]{0,40}?return;/,
    );
  });

  test("drops result data on invalidation without discarding how the user was looking at it", () => {
    // Invalidating a run used to reset resultMode, stressComponent, selectedModeIndex and
    // showDeformed as well, so tweaking a load and re-running silently threw away the
    // user's view every time. Everything here is reconciled against the next summary.
    const body = appSource.match(/function invalidateCompletedRunState\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(body).toContain("setResultSummary(null)");
    expect(body).not.toContain('setResultMode("stress")');
    expect(body).not.toContain('setStressComponent("von_mises")');
    expect(body).not.toContain("setSelectedModeIndex(1)");
    expect(body).not.toContain("setShowDeformed(false)");

    // Probes are the exception: they resolve by index into one run's surface mesh, so
    // carrying them across would silently mis-resolve them onto different geometry.
    expect(body).toContain("setResultProbes([])");

    // The reconciliation this relies on has to stay.
    expect(appSource).toContain("setResultMode((currentMode) => compatibleResultModeForSummary(resultSummary, currentMode));");
  });

  test("keeps the completed solve time so the report can state it", () => {
    // runTiming is nulled on the "complete" event, which is the exact moment the elapsed
    // time stops being an estimate — so every report used to print "Solve wall time: --".
    expect(appSource).toContain('const completedElapsedMs = timingFromRunEvent(event)?.elapsedMs;');
    expect(appSource).toContain('if (typeof completedElapsedMs === "number") setSolveElapsedMs(completedElapsedMs);');
    expect(appSource).toContain("runTiming: runTiming ?? (solveElapsedMs === null ? null : { elapsedMs: solveElapsedMs }),");
    // ...and drops it with the results it describes, so it can never outlive them.
    expect(appSource).toMatch(/function invalidateCompletedRunState\(\) \{[\s\S]*?setSolveElapsedMs\(null\);/);
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

  test("names the inline project rename field for assistive technology", () => {
    expect(appSource).toContain('aria-label="Project name"');
    expect(appSource).toContain('id="project-name-hint"');
  });
});
