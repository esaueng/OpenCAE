import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(resolve(__dirname, "App.tsx"), "utf8");
const apiSource = readFileSync(resolve(__dirname, "lib/api.ts"), "utf8");
const viteConfigSource = readFileSync(resolve(__dirname, "../vite.config.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("Worker UI performance rewrite boundaries", () => {
  test("keeps the first app shell free of workspace, viewer, and solver imports", () => {
    expect(appSource).toContain("lazyWorkspaceImport");
    expect(appSource).toContain('import("./WorkspaceApp")');
    expect(appSource).not.toContain('from "./WorkspaceApp"');
    expect(appSource).not.toContain('from "./components/CadViewer"');
    expect(appSource).not.toContain('from "./lib/api"');
    expect(appSource).not.toContain("@react-three");
    expect(appSource).not.toContain("three");
    expect(appSource).not.toContain("@opencae/solver-service");
  });

  test("loads the viewer through a lazy boundary inside the workspace", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");

    expect(workspaceSource).toContain("lazyCadViewerImport");
    expect(workspaceSource).toContain('import("./components/CadViewer")');
    expect(workspaceSource).not.toContain('import { CadViewer');
  });

  test("keeps local solver code behind the browser performance worker", () => {
    expect(apiSource).not.toContain('from "@opencae/solver-service"');
    expect(apiSource).toContain("solveLocalStudyInWorker");
    expect(apiSource).toContain("fallbackSolveLocalStudy");
  });

  test("declares explicit chunks and a bundle budget command", () => {
    expect(viteConfigSource).toContain("manualChunks");
    expect(viteConfigSource).toContain("modulePreload: false");
    expect(viteConfigSource).toContain("viewer-three");
    expect(viteConfigSource).toContain("cad-import");
    expect(packageJson.scripts["check:bundle"]).toBe("node ../../scripts/check-web-bundle-budget.mjs");
  });

  test("keeps the Three viewer on demand rendering with bounded playback commits", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");

    expect(viewerSource).toContain('frameloop="demand"');
    expect(viewerSource).toContain("VIEWER_IDLE_DPR_RANGE");
    expect(viewerSource).toContain("VIEWER_ACTIVE_DPR_RANGE");
    expect(viewerSource).toContain("const viewerDpr = props.resultPlaybackPlaying || viewerInteracting ? VIEWER_ACTIVE_DPR_RANGE : VIEWER_IDLE_DPR_RANGE");
    expect(viewerSource).toContain("dpr={viewerDpr}");
    expect(viewerSource).not.toContain("dpr={[1, 2]}");
    expect(viewerSource).toContain("invalidate()");
    expect(viewerSource).toContain("onChange={invalidateViewer}");
    expect(workspaceSource).toContain("PLAYBACK_UI_COMMIT_INTERVAL_MS = 250");
    expect(workspaceSource).not.toContain("PLAYBACK_STATE_COMMIT_INTERVAL_MS = 1000 / 60");
  });

  test("uses a lighter viewer scene while playback or interaction is active", () => {
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");

    expect(viewerSource).toContain("const [viewerInteracting, setViewerInteracting] = useState(false)");
    expect(viewerSource).toContain("handleViewerInteractionChange");
    expect(viewerSource).toContain("const suppressPlaybackOverlays = props.resultPlaybackPlaying");
    expect(viewerSource).toContain("const showDimensionOverlay = shouldShowDimensionOverlay(props.showDimensions, effectiveViewMode) && !suppressPlaybackOverlays");
    expect(viewerSource).toContain("resultPlaybackPlaying={resultPlaybackPlaying}");
    expect(viewerSource).toContain("{!resultPlaybackPlaying && <Edges");
    expect(viewerSource).toContain("export function shouldShowResultMarkers(_viewMode: ViewMode, _activeStep: StepId, _resultPlaybackPlaying: boolean)");
    expect(viewerSource).toContain("return false");
  });

  test("keeps playback frame delivery out of React subscriptions and hydrated result arrays", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");
    const cacheSource = readFileSync(resolve(__dirname, "resultPlaybackCache.ts"), "utf8");
    const clientSource = readFileSync(resolve(__dirname, "workers/performanceClient.ts"), "utf8");
    const protocolSource = readFileSync(resolve(__dirname, "workers/performanceProtocol.ts"), "utf8");

    expect(workspaceSource).toContain("createResultPlaybackFrameController");
    expect(workspaceSource).toContain("setPackedFrame(cache.packed");
    expect(workspaceSource).toContain("packResultFieldsForPlayback(resultFieldsForUi)");
    expect(workspaceSource).toContain("...(packedFields ? { packedFields } : { fields: resultFieldsForUi })");
    expect(viewerSource).toContain("resultPlaybackFrameController");
    expect(viewerSource).toContain("usePackedPlaybackGeometry");
    expect(viewerSource).not.toContain("useSyncExternalStore");
    expect(cacheSource).toContain("values: Float32Array");
    expect(cacheSource).toContain("packResultFieldsForPlayback");
    expect(cacheSource).not.toContain("Array.from(field.values)");
    expect(clientSource).toContain("transferablesForPerformanceWorkerRequest(request)");
    expect(protocolSource).toContain("packedResultFieldsForPlaybackTransferables");
  });

  test("keeps packed playback animation out of per-frame React result snapshots", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");
    const callbackStart = workspaceSource.indexOf("const commitPlaybackViewerFrame = useCallback((framePosition: number) => {");
    const callbackEnd = workspaceSource.indexOf("  const solverRunning", callbackStart);
    const playbackCommitCallback = workspaceSource.slice(callbackStart, callbackEnd);
    const loopStart = workspaceSource.indexOf("const advancePlaybackFrame = (timestamp: number) => {");
    const loopEnd = workspaceSource.indexOf("animationFrameId = window.requestAnimationFrame(advancePlaybackFrame);", loopStart);
    const playbackLoop = workspaceSource.slice(loopStart, loopEnd);

    expect(callbackStart).toBeGreaterThan(-1);
    expect(loopStart).toBeGreaterThan(-1);
    expect(playbackCommitCallback).toContain("setPackedFrame(cache.packed");
    expect(viewerSource).toContain("resultPlaybackBufferCache?: PackedPreparedPlaybackCache | null");
    expect(workspaceSource).toContain("resultPlaybackBufferCache={resultPlaybackBufferCacheForViewer}");
    expect(playbackLoop).toContain("commitPlaybackViewerFrame(framePosition)");
    expect(playbackLoop).not.toContain("setResultFields");
    expect(playbackLoop).not.toContain("setSnapshot");
    expect(playbackLoop).not.toContain("fieldsForFramePosition");
    expect(playbackLoop).not.toContain("hydratePreparedPlaybackFrame");
    expect(playbackLoop).not.toContain("Array.from");
  });

  test("preserves throttled React playback labels while viewer invalidates packed buffer changes", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");

    expect(workspaceSource).toContain("PLAYBACK_UI_COMMIT_INTERVAL_MS = 250");
    expect(workspaceSource).toContain("setPackedFrame(cache.packed, framePosition)");
    expect(viewerSource).toContain("packedPreparedPlaybackFrameOrdinal(snapshot.cache, snapshot.framePosition)");
    expect(viewerSource).toContain("resultPlaybackBufferCache");
    expect(viewerSource).toContain("return resultPlaybackFrameController.subscribe(() => invalidate())");
  });

  test("keeps typed packed playback rendering off object-array result sampling", () => {
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");
    const packedPathStart = viewerSource.indexOf("function usePackedPlaybackGeometry(");
    const packedPathEnd = viewerSource.indexOf("function reusablePackedSamples", packedPathStart);
    const packedPath = viewerSource.slice(packedPathStart, packedPathEnd);
    const analysisStart = viewerSource.indexOf("function AnalysisResultModel(");
    const analysisEnd = viewerSource.indexOf("function UploadedResultSolid(", analysisStart);
    const analysisPath = viewerSource.slice(analysisStart, analysisEnd);

    expect(packedPathStart).toBeGreaterThan(-1);
    expect(analysisStart).toBeGreaterThan(-1);
    expect(packedPath).toContain("updatePackedSamples");
    expect(packedPath).not.toContain("resultSamplesForFaces");
    expect(analysisPath).toContain("usesPackedPlaybackResults");
    expect(analysisPath).toContain("useResultSamplesForFaces(displayModel.faces, resultFields, resultMode, !usesPackedPlaybackResults)");
    expect(analysisPath).toContain("initialPackedPlaybackSamplesForFaces(displayModel.faces)");
  });

  test("hides expensive result overlays during packed playback while preserving fallback rendering", () => {
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");

    expect(viewerSource).toContain("shouldShowResultMarkers(viewMode, activeStep, resultPlaybackPlaying)");
    expect(viewerSource).toContain("export function shouldShowResultMarkers(_viewMode: ViewMode, _activeStep: StepId, _resultPlaybackPlaying: boolean)");
    expect(viewerSource).toContain("return false");
    expect(viewerSource).toContain("{!resultPlaybackPlaying && <Edges");
    expect(viewerSource).toContain("function useResultSamplesForFaces");
    expect(viewerSource).toContain("resultSamplesForFaces(faces, resultFields, resultMode)");
  });

  test("idle-schedules autosave instead of writing localStorage synchronously from workspace renders", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const persistenceSource = readFileSync(resolve(__dirname, "appPersistence.ts"), "utf8");

    expect(workspaceSource).toContain("scheduleAutosavedUiSnapshotWrite(");
    expect(workspaceSource).toContain("buildAutosavedWorkspaceUiSnapshot");
    expect(workspaceSource).toContain("scheduleAutosavedWorkspaceWrite(() => buildAutosavedWorkspace");
    expect(workspaceSource).not.toContain("writeAutosavedWorkspace(buildAutosavedWorkspace");
    expect(workspaceSource).toContain("AUTOSAVE_HEAVY_WRITE_DELAY_MS");
    expect(workspaceSource).toContain("AUTOSAVE_UI_WRITE_DELAY_MS");
    expect(workspaceSource).not.toMatch(/scheduleAutosavedWorkspaceWrite\(buildAutosavedWorkspace\([\s\S]*status,[\s\S]*logs[\s\S]*\),/);
    expect(persistenceSource).toContain("requestIdleCallback");
    expect(persistenceSource).toContain("AUTOSAVE_UI_STORAGE_KEY");
  });

  test("keeps imported CAD edge overlays optional during result playback", () => {
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");
    const stepPreviewSource = readFileSync(resolve(__dirname, "stepPreview.ts"), "utf8");
    const workerSource = readFileSync(resolve(__dirname, "workers/performanceWorker.ts"), "utf8");

    expect(stepPreviewSource).toContain("includeEdges?: boolean");
    expect(stepPreviewSource).toContain("if (includeEdges)");
    expect(stepPreviewSource).toContain("shareMaterials?: boolean");
    expect(viewerSource).toContain("const lightweightResultPlayback = Boolean(resultPlaybackFrameController)");
    expect(viewerSource).toContain("stepPreviewFromBase64(contentBase64, \"#63a9e5\", { includeEdges: !lightweightResultPlayback, shareMaterials: lightweightResultPlayback })");
    expect(viewerSource).toContain("{!lightweightResultPlayback && <Edges color=\"#43556a\" threshold={18} />}");
    expect(workerSource).toContain("stepPreviewFromBase64(request.payload.contentBase64, request.payload.color, { includeEdges: false, shareMaterials: true })");
  });

  test("keeps viewer renderer stats behind explicit development opt-in flags", () => {
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");

    expect(viewerSource).toContain("ViewerRendererStatsProbe");
    expect(viewerSource).toContain("opencaePerf");
    expect(viewerSource).toContain("opencae.perf.viewerStats");
    expect(viewerSource).toContain("import.meta.env.DEV");
    expect(viewerSource).toContain("gl.info.render.calls");
    expect(viewerSource).toContain("gl.info.render.triangles");
    expect(viewerSource).toContain("gl.info.render.lines");
    expect(viewerSource).toContain("gl.info.memory.geometries");
    expect(viewerSource).toContain("gl.info.memory.textures");
    expect(viewerSource).toContain("VIEWER_STATS_LOG_INTERVAL_MS = 1000");
  });
});
