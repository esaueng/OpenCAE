import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DynamicSolverSettingsSchema, isRunResultReadyStatus } from "@opencae/schema";
import type { Constraint, DisplayFace, DisplayModel, DynamicSolverSettings, Load, MeshQuality, NamedSelection, Project, ResultField, ResultRenderBounds, ResultSummary, RunEvent, RunTimingEstimate, SimulationFidelity, Study } from "@opencae/schema";
import { RotateCcw, Save } from "lucide-react";
import { addLoad, addSupport, assignMaterial, cancelRun, createProject, generateMesh, getResults, importLocalProject, isStepGeometryMeshFailure, loadSampleProject, probeUploadedStepRepairAfterMeshFailure, renameProject, repairUploadedStepModel, runSimulation, saveRunReportCaptures, STEP_REPAIR_UNAVAILABLE_MESSAGE, subscribeToRun, updateStudy as saveStudyPatch, uploadedStepRepairProbeDecision, uploadModel, type SampleAnalysisType, type SampleModelId } from "./lib/api";
import { cancelWasmMeshing, type WasmMeshPhaseProgress } from "./lib/wasmMeshing";
import { resolveSolverBackend } from "./workers/opencaeCoreSolve";
import { manufacturingProcessForId, normalizeManufacturingParameters, starterMaterials } from "@opencae/materials";
import { BottomPanel, type WorkspaceLogEntry } from "./components/BottomPanel";
import { OpenCaeLogoMark } from "./components/OpenCaeLogoMark";
import { RightPanel } from "./components/RightPanel";
import { StartScreen } from "./components/StartScreen";
import { StepBar, type StepId } from "./components/StepBar";
import { BoundaryConditionMenu, CreateSimulationScreen } from "./components/SimulationWorkflow";
import {
  createViewerLoadMarkers,
  directionVectorForLabel,
  unitsForLoadType,
  type DraftLoadPreview,
  type LoadDirectionLabel,
  type PayloadLoadMetadata,
  type LoadType
} from "./loadPreview";
import { resetDisplayModelOrientation, type RotationAxis } from "./modelOrientation";
import { buildLocalProjectFile, suggestedProjectFilename, type LocalResultBundle, type SolverSurfaceMesh } from "./projectFile";
import { prepareBlobSaveToDisk, saveBlobToDisk } from "./lib/fileSave";
import { captureResultViews, type ResultViewCaptures } from "./report/captureResultViews";
import { buildReportData, suggestedReportFilename } from "./report/reportData";
import { buildAutosavedWorkspace, buildAutosavedWorkspaceUiSnapshot, readAutosavedWorkspace, scheduleAutosavedUiSnapshotWrite, scheduleAutosavedWorkspaceWrite, WORKSPACE_LOG_LIMIT } from "./appPersistence";
import type { AutosavedWorkspace, WorkspaceUiSnapshot } from "./appPersistence";
import {
  canNavigateToStep,
  isEditableShortcutTarget,
  printLayerOrientationForViewer,
  shouldAutoAdvanceAfterMaterialAssignment,
  shouldAutoAdvanceAfterMeshGeneration,
  shouldShowStartScreen,
  workflowStepForShortcut
} from "./appShellState";
import { displayModelForUnits, loadValueForUnits, resultFieldForUnits, resultSummaryForUnits, type UnitSystem } from "./unitDisplay";
import { supportDisplayLabel } from "./supportLabels";
import { nextSelectedPayloadObject, shouldClearPayloadSelectionOnViewerMiss } from "./payloadSelection";
import { hasLegacyStepUploadFaces, hasUnresolvedStepFaceSelections, healStepFaceSelections, legacyStepFaceHealMessage } from "./stepFaceHealing";
import { stepGeometryMetadataForProject, stepGeometryNeedsRepair } from "./stepGeometryState";
import { createLocalDynamicStructuralStudy, createLocalStaticStressStudy } from "./localProjectFactory";
import { createPackedResultPlaybackCache, createResultFrameCache, hasDynamicPlaybackFrames, solverMeshSummaryFromResults, withDerivedSurfaceSafetyFactorFields, type SolverMeshSummary } from "./resultFields";
import { packResultFieldsForPlayback, packedPreparedPlaybackFrameOrdinal, playbackFieldsForResultMode, playbackMemoryBudgetBytes, type PackedPreparedPlaybackCache, type PreparedPlaybackFrameCache } from "./resultPlaybackCache";
import {
  advancePlaybackTimeline,
  frameIndexForPlaybackOrdinal,
  playbackOrdinalForSolverFramePosition,
  PLAYBACK_ENDPOINT_HOLD_MS,
  type PlaybackDirection,
  solverFramePositionForPlaybackOrdinal
} from "./resultPlaybackTimeline";
import { preparePlaybackFramesInWorker } from "./workers/performanceClient";
import type { WorkspaceInitialAction } from "./App";
import type { PayloadObjectSelection, PrintLayerOrientation, ResultMode, ResultPlaybackFrameController, ThemeMode, ViewerLoadMarker, ViewerSupportMarker, ViewMode } from "./workspaceViewTypes";

const lazyCadViewerImport = () => import("./components/CadViewer").then((module) => ({ default: module.CadViewer }));
const CadViewer = lazy(lazyCadViewerImport);
const DEBUG_RESULT_PARAMS = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const DEBUG_RESULTS = import.meta.env.DEV && DEBUG_RESULT_PARAMS.get("debugResults") === "1";
const DEBUG_RESULT_FRAME_CACHE_ONLY = DEBUG_RESULTS && DEBUG_RESULT_PARAMS.get("bypassPacked") === "1";

// Reference numbers shown for the pre-seeded bracket demo before any solve runs.
// The provenance marks them as generated sample values so the Results panel
// never presents them as computed solver output.
const seededSummary: ResultSummary = {
  maxStress: 142,
  maxStressUnits: "MPa",
  maxDisplacement: 0.184,
  maxDisplacementUnits: "mm",
  safetyFactor: 1.8,
  reactionForce: 500,
  reactionForceUnits: "N",
  provenance: {
    kind: "local_estimate",
    solver: "sample-bracket-reference",
    solverVersion: "0.1.0",
    meshSource: "mock",
    resultSource: "generated",
    units: "mm-N-s-MPa"
  }
};
const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.001;
const PLAYBACK_UI_COMMIT_INTERVAL_MS = 250;
const PLAYBACK_CACHE_PREP_FPS = 30;
const PLAYBACK_ENDPOINT_EPSILON = 0.0001;
const AUTOSAVE_UI_WRITE_DELAY_MS = 650;
const AUTOSAVE_HEAVY_WRITE_DELAY_MS = 5000;

type ResultPlaybackCacheState =
  | { status: "idle" }
  | { status: "preparing"; cacheKey: string }
  | { status: "ready"; cacheKey: string; cache: PreparedPlaybackFrameCache }
  | { status: "fallback"; cacheKey: string; message: string }
  | { status: "error"; cacheKey: string; message: string };

type MutableResultPlaybackFrameController = ResultPlaybackFrameController & {
  setPackedFrame: (cache: PackedPreparedPlaybackCache, framePosition: number) => void;
};

type ProjectActionHandle = {
  clientId: string;
  generation: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

interface WorkspaceAppProps {
  initialAction?: WorkspaceInitialAction | null;
  restoredWorkspace?: AutosavedWorkspace | null;
}

export function WorkspaceApp({ initialAction = null, restoredWorkspace: providedRestoredWorkspace }: WorkspaceAppProps) {
  const restoredWorkspace = useMemo(() => providedRestoredWorkspace ?? readAutosavedWorkspace(), [providedRestoredWorkspace]);
  const restoredProjectFile = restoredWorkspace?.projectFile;
  const restoredUi = restoredWorkspace?.ui;
  const restoredResults = restoredProjectFile?.results;
  const [project, setProject] = useState<Project | null>(restoredProjectFile?.project ?? null);
  const [displayModel, setDisplayModel] = useState<DisplayModel | null>(restoredProjectFile?.displayModel ?? null);
  const [homeRequested, setHomeRequested] = useState(restoredUi?.homeRequested ?? !restoredProjectFile);
  const [activeStep, setActiveStep] = useState<StepId>(restoredUi?.activeStep ?? "model");
  const [undoStack, setUndoStack] = useState<Project[]>(restoredUi?.undoStack ?? []);
  const [redoStack, setRedoStack] = useState<Project[]>(restoredUi?.redoStack ?? []);
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(restoredUi?.selectedFaceId ?? null);
  const [selectedLoadPoint, setSelectedLoadPoint] = useState<[number, number, number] | null>(restoredUi?.selectedLoadPoint ?? null);
  const [selectedPayloadObject, setSelectedPayloadObject] = useState<PayloadObjectSelection | null>(restoredUi?.selectedPayloadObject ?? null);
  const [viewMode, setViewMode] = useState<ViewMode>(restoredUi?.viewMode ?? (restoredResults?.fields.length ? "results" : "model"));
  const [themeMode, setThemeMode] = useState<ThemeMode>(restoredUi?.themeMode ?? "dark");
  const [resultMode, setResultMode] = useState<ResultMode>(restoredUi?.resultMode ?? "stress");
  const [resultRenderBounds, setResultRenderBounds] = useState<ResultRenderBounds | null>(null);
  const [showDeformed, setShowDeformed] = useState(restoredUi?.showDeformed ?? false);
  const [showDimensions, setShowDimensions] = useState(restoredUi?.showDimensions ?? false);
  const [stressExaggeration, setStressExaggeration] = useState(restoredUi?.stressExaggeration ?? 1.8);
  const [fitSignal, setFitSignal] = useState(0);
  const [viewAxis, setViewAxis] = useState<RotationAxis | null>(null);
  const [viewAxisSignal, setViewAxisSignal] = useState(0);
  const [status, setStatus] = useState(restoredUi?.status ?? (restoredProjectFile ? "Workspace restored after reload." : "Ready"));
  const [logs, setLogs] = useState<WorkspaceLogEntry[]>(() => restoredUi?.logs.length
    ? restoredUi.logs
    : (restoredProjectFile ? ["Workspace restored after reload.", "Ready | Local Mode"] : ["Ready | Local Mode"]).map((message) => ({ message, at: Date.now() })));
  const [runProgress, setRunProgress] = useState(restoredUi?.runProgress ?? (restoredResults?.fields.length ? 100 : 0));
  const [meshPhaseProgress, setMeshPhaseProgress] = useState<WasmMeshPhaseProgress | null>(null);
  const [runTiming, setRunTiming] = useState<RunTimingEstimate | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState(restoredUi?.activeRunId || restoredResults?.activeRunId || restoredResults?.completedRunId || "run-bracket-demo-seeded");
  const [completedRunId, setCompletedRunId] = useState(restoredUi?.completedRunId || restoredResults?.completedRunId || "run-bracket-demo-seeded");
  const [processingRunId, setProcessingRunId] = useState<string | null>(null);
  const [resultSummary, setResultSummary] = useState<ResultSummary | null>(() =>
    restoredResults?.summary ?? (hasSeededBracketDemoRun(restoredProjectFile?.project) ? seededSummary : null));
  const [resultFields, setResultFields] = useState<ResultField[]>(() => restoredResults
    ? withDerivedSurfaceSafetyFactorFields(restoredResults)
    : []);
  const [resultSurfaceMesh, setResultSurfaceMesh] = useState<SolverSurfaceMesh | undefined>(restoredResults?.surfaceMesh);
  const [solverMeshSummary, setSolverMeshSummary] = useState<SolverMeshSummary | null>(restoredResults?.solverMeshSummary ?? null);
  const [reportCaptures, setReportCaptures] = useState<{ runId: string; captures: ResultViewCaptures } | null>(() => {
    const restoredRunId = restoredResults?.completedRunId ?? restoredResults?.activeRunId;
    return restoredRunId && restoredResults?.reportCaptures ? { runId: restoredRunId, captures: restoredResults.reportCaptures } : null;
  });
  const [viewerCaptureRevision, setViewerCaptureRevision] = useState(0);
  const [resultFrameIndex, setResultFrameIndex] = useState(0);
  const [resultPlaybackFramePosition, setResultPlaybackFramePosition] = useState(0);
  const [resultPlaybackOrdinalPosition, setResultPlaybackOrdinalPosition] = useState(0);
  const [resultPlaybackPlaying, setResultPlaybackPlaying] = useState(false);
  const [resultPlaybackFps, setResultPlaybackFps] = useState(12);
  const [resultPlaybackReverseLoop, setResultPlaybackReverseLoop] = useState(false);
  const [resultPlaybackCacheState, setResultPlaybackCacheState] = useState<ResultPlaybackCacheState>({ status: "idle" });
  const [draftLoadType, setDraftLoadType] = useState<LoadType>(restoredUi?.draftLoadType ?? "force");
  const [draftLoadValue, setDraftLoadValue] = useState(restoredUi?.draftLoadValue ?? 500);
  const [draftLoadDirection, setDraftLoadDirection] = useState<LoadDirectionLabel>(restoredUi?.draftLoadDirection ?? "-Z");
  const [draftPayloadPreview, setDraftPayloadPreview] = useState<{ value: number; metadata: PayloadLoadMetadata } | null>(null);
  const [previewLoadEdit, setPreviewLoadEdit] = useState<Load | null>(null);
  const [sampleModel, setSampleModel] = useState<SampleModelId>(restoredUi?.sampleModel ?? "bracket");
  const [sampleAnalysisType, setSampleAnalysisType] = useState<SampleAnalysisType>(restoredUi?.sampleAnalysisType ?? "static_stress");
  const [previewPrintLayerOrientation, setPreviewPrintLayerOrientation] = useState<PrintLayerOrientation | null | undefined>(undefined);
  const [isStepbarCollapsed, setIsStepbarCollapsed] = useState(false);
  const [showBoundaryConditionMenu, setShowBoundaryConditionMenu] = useState(false);
  const [isRepairingModel, setIsRepairingModel] = useState(false);
  const [singleKeyShortcutsEnabled, setSingleKeyShortcutsEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("opencae.shortcuts.singleKey") !== "off";
    } catch {
      return true;
    }
  });
  const didRequestRestoredHomeView = useRef(false);
  const activeRunSourceRef = useRef<EventSource | null>(null);
  const processingRunIdRef = useRef<string | null>(null);
  const projectRef = useRef<Project | null>(project);
  const projectActionGenerationRef = useRef(0);
  const projectActionAbortRef = useRef<AbortController | null>(null);
  const projectActionSourceRef = useRef<Project | null>(null);
  const projectActionClientIdRef = useRef<string | null>(null);
  const autosaveWriteFailureNotifiedRef = useRef(false);
  const autosaveDegradedNotifiedRef = useRef(false);
  const stepFaceHealNotifiedRef = useRef(false);
  const workspaceShortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const resultFrameIndexRef = useRef(0);
  const resultPlaybackFramePositionRef = useRef(0);
  const resultPlaybackOrdinalPositionRef = useRef(0);
  const resultPlaybackDirectionRef = useRef<PlaybackDirection>(1);
  const resultPlaybackEndpointHoldRemainingMsRef = useRef(0);
  const resultPlaybackFrameControllerRef = useRef<MutableResultPlaybackFrameController | null>(null);
  const viewerInteractingRef = useRef(false);
  const viewerCaptureRef = useRef<(() => Promise<string>) | null>(null);
  const reportCaptureInFlightRef = useRef<string | null>(null);
  const reportStateRef = useRef({ viewMode, resultMode, resultSummary, completedRunId, resultPlaybackPlaying });
  const initialActionConsumedRef = useRef(false);
  if (!resultPlaybackFrameControllerRef.current) {
    resultPlaybackFrameControllerRef.current = createResultPlaybackFrameController();
  }
  if (!projectActionClientIdRef.current) {
    projectActionClientIdRef.current = createProjectActionClientId();
  }

  const study = project?.studies[0] ?? null;
  const assignedPrintLayerOrientation = useMemo<PrintLayerOrientation | null>(() => {
    const assignment = study?.materialAssignments[0];
    if (!assignment) return null;
    const material = starterMaterials.find((candidate) => candidate.id === assignment.materialId);
    if (!material) return null;
    const parameters = normalizeManufacturingParameters(material, assignment.parameters ?? {});
    const process = parameters.manufacturingProcessId ? manufacturingProcessForId(parameters.manufacturingProcessId) : undefined;
    return process?.settingsKind === "fdm" || process?.settingsKind === "build_direction" ? parameters.layerOrientation ?? "z" : null;
  }, [study?.materialAssignments]);
  const printLayerOrientation = printLayerOrientationForViewer(assignedPrintLayerOrientation, previewPrintLayerOrientation);
  const selectedFace = useMemo(() => displayModel?.faces.find((face) => face.id === selectedFaceId) ?? null, [displayModel, selectedFaceId]);
  const displayUnitSystem = project?.unitSystem ?? "SI";
  const displayModelForUi = useMemo(() => displayModel ? displayModelForUnits(displayModel, displayUnitSystem) : null, [displayModel, displayUnitSystem]);
  const resultSummaryForUi = useMemo(() => resultSummary ? resultSummaryForUnits(resultSummary, displayUnitSystem) : null, [displayUnitSystem, resultSummary]);
  const resultFieldsForUi = useMemo(() => resultFields.map((field) => resultFieldForUnits(field, displayUnitSystem)), [displayUnitSystem, resultFields]);
  const resultFrameCache = useMemo(() => createResultFrameCache(resultFieldsForUi), [resultFieldsForUi]);
  const packedResultPlaybackCache = useMemo(() => createPackedResultPlaybackCache(resultFieldsForUi), [resultFieldsForUi]);
  const resultFieldsSignature = useMemo(() => resultFieldsSignatureForCache(resultFieldsForUi), [resultFieldsForUi]);
  const playbackFrameIndexes = useMemo(
    () => packedResultPlaybackCache ? Array.from(packedResultPlaybackCache.frameIndexes) : resultFrameCache.frameIndexes,
    [packedResultPlaybackCache, resultFrameCache]
  );
  const resultVisualOrdinalPosition = resultPlaybackPlaying
    ? resultPlaybackOrdinalPosition
    : playbackOrdinalForSolverFramePosition(playbackFrameIndexes, resultFrameIndex);
  const resultVisualFramePosition = resultPlaybackPlaying
    ? resultPlaybackFramePosition
    : resultFrameIndex;
  const resultPlaybackCacheKey = useMemo(() => [
    completedRunId,
    activeRunId,
    displayModelForUi?.id ?? "no-model",
    displayModelForUi?.nativeCad?.contentBase64?.length ?? displayModelForUi?.visualMesh?.contentBase64?.length ?? 0,
    resultMode,
    showDeformed ? "deformed" : "undeformed",
    stressExaggeration.toFixed(2),
    study?.meshSettings.preset ?? "no-mesh",
    displayUnitSystem,
    resultFieldsSignature,
    resultSurfaceMesh?.id ?? "no-surface",
    resultFrameCache.frameIndexes.join(",")
  ].join("|"), [activeRunId, completedRunId, displayModelForUi, displayUnitSystem, resultFieldsSignature, resultSurfaceMesh?.id, resultFrameCache.frameIndexes, resultMode, showDeformed, stressExaggeration, study?.meshSettings.preset]);
  const visibleResultFieldsForUi = useMemo(
    () => {
      if (DEBUG_RESULT_FRAME_CACHE_ONLY) {
        if (resultPlaybackPlaying) return resultFrameCache.fieldsForFramePosition(resultVisualFramePosition);
        return resultFrameCache.fieldsForFrame(resultFrameIndex);
      }
      if (resultPlaybackPlaying) {
        return packedResultPlaybackCache?.fieldsForFramePosition(resultVisualFramePosition) ?? resultFrameCache.fieldsForFramePosition(resultVisualFramePosition);
      }
      return packedResultPlaybackCache?.fieldsForFrame(resultFrameIndex) ?? resultFrameCache.fieldsForFrame(resultFrameIndex);
    },
    [packedResultPlaybackCache, resultFrameCache, resultFrameIndex, resultPlaybackPlaying, resultVisualFramePosition]
  );
  const resultPlaybackBufferCacheForViewer = !DEBUG_RESULT_FRAME_CACHE_ONLY && resultPlaybackCacheState.status === "ready"
    ? resultPlaybackCacheState.cache.packed ?? null
    : null;
  // In-browser wasm meshing has no cooperative cancel; terminate the mesh
  // worker if the workspace unmounts mid-mesh (no-op when idle or flag off).
  useEffect(() => () => cancelWasmMeshing("Meshing cancelled: workspace closed."), []);
  useEffect(() => {
    if (!DEBUG_RESULTS) return;
    const frameField = visibleResultFieldsForUi.find((field) => field.type === "stress")
      ?? visibleResultFieldsForUi.find((field) => field.type === "displacement");
    console.debug("[OpenCAE results] visible frame", {
      frameIndex: resultFrameIndex,
      timeSeconds: frameField?.timeSeconds,
      stress: debugResultField(visibleResultFieldsForUi.find((field) => field.type === "stress")),
      displacement: debugResultField(visibleResultFieldsForUi.find((field) => field.type === "displacement"))
    });
  }, [resultFrameIndex, visibleResultFieldsForUi]);
  useEffect(() => {
    if (resultPlaybackPlaying) return;
    const packed = resultPlaybackCacheState.status === "ready" ? resultPlaybackCacheState.cache.packed : undefined;
    if (!packed) return;
    resultPlaybackFrameControllerRef.current?.setPackedFrame(packed, resultVisualFramePosition);
  }, [resultPlaybackCacheState, resultPlaybackPlaying, resultVisualFramePosition, visibleResultFieldsForUi]);
  const resultPlaybackCacheLabel = useMemo(() => {
    if (resultPlaybackCacheState.status === "preparing") return "Preparing smooth playback";
    if (resultPlaybackCacheState.status === "ready") {
      if (resultPlaybackCacheState.cache.mode === "full") return `Smooth playback ready · ${resultPlaybackCacheState.cache.frameCount} frames`;
      if (resultPlaybackCacheState.cache.mode === "reducedFps") return `Smooth playback ready · ${resultPlaybackCacheState.cache.presentationFps} fps cache`;
      return "Playback cached at solver frames";
    }
    if (resultPlaybackCacheState.status === "fallback" || resultPlaybackCacheState.status === "error") return resultPlaybackCacheState.message;
    return "";
  }, [resultPlaybackCacheState]);
  const commitPlaybackViewerFrame = useCallback((framePosition: number) => {
    const cache = resultPlaybackCacheState.status === "ready" ? resultPlaybackCacheState.cache : null;
    if (cache?.packed) {
      resultPlaybackFrameControllerRef.current?.setPackedFrame(cache.packed, framePosition);
    }
  }, [resultPlaybackCacheState]);
  const solverRunning = Boolean(processingRunId) || (runProgress > 0 && runProgress < 100);
  reportStateRef.current = { viewMode, resultMode, resultSummary, completedRunId, resultPlaybackPlaying };
  const runReadiness = useMemo(() => readinessForStudy(study), [study]);
  const canRunSimulation = runReadiness.every((item) => item.done) && !solverRunning;
  const missingRunItems = runReadiness.filter((item) => !item.done).map((item) => item.label);
  const hasActualVolumeMesh = Boolean(study?.meshSettings.summary?.artifacts?.actualCoreModel);
  const openStepNeedsRepair = stepGeometryNeedsRepair(project) && !hasActualVolumeMesh;
  const effectiveMissingRunItems = openStepNeedsRepair ? [...missingRunItems, "Closed STEP solid"] : missingRunItems;
  const effectiveCanRunSimulation = canRunSimulation && !openStepNeedsRepair;
  const canUndoAction = undoStack.length > 0;
  const canRedoAction = redoStack.length > 0;

  useEffect(() => {
    projectRef.current = project;
    if (projectActionAbortRef.current && project !== projectActionSourceRef.current) {
      invalidateProjectAction();
    }
  }, [project]);

  useEffect(() => () => projectActionAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!initialAction || initialActionConsumedRef.current) return;
    initialActionConsumedRef.current = true;
    if (initialAction.type === "loadSample") {
      void handleLoadSample(initialAction.sample, initialAction.analysisType);
      return;
    }
    if (initialAction.type === "createProject") {
      handleCreateProject();
      return;
    }
    handleOpenProject(initialAction.file);
  }, [initialAction]);

  useEffect(() => {
    if (didRequestRestoredHomeView.current) return;
    if (!restoredProjectFile || homeRequested || !project || !displayModel) return;
    didRequestRestoredHomeView.current = true;
    requestDefaultHomeView();
  }, [displayModel, homeRequested, project, restoredProjectFile]);

  useEffect(() => {
    if (!playbackFrameIndexes.length) return;
    setResultFrameIndex((current) => playbackFrameIndexes.includes(current) ? current : playbackFrameIndexes[0] ?? 0);
    const currentFramePosition = resultPlaybackFramePositionRef.current;
    const nextFramePosition = playbackFrameIndexes.includes(Math.round(currentFramePosition)) ? currentFramePosition : playbackFrameIndexes[0] ?? 0;
    const nextOrdinalPosition = playbackOrdinalForSolverFramePosition(playbackFrameIndexes, nextFramePosition);
    resultPlaybackFramePositionRef.current = nextFramePosition;
    resultPlaybackOrdinalPositionRef.current = nextOrdinalPosition;
    resultPlaybackDirectionRef.current = playbackDirectionForLoopStart(nextOrdinalPosition, playbackFrameIndexes.length, resultPlaybackReverseLoop);
    resultPlaybackEndpointHoldRemainingMsRef.current = 0;
    setResultPlaybackFramePosition(nextFramePosition);
    setResultPlaybackOrdinalPosition(nextOrdinalPosition);
  }, [playbackFrameIndexes, resultPlaybackReverseLoop]);

  useEffect(() => {
    if (activeStep !== "results" || playbackFrameIndexes.length < 2) {
      setResultPlaybackPlaying(false);
    }
  }, [activeStep, playbackFrameIndexes.length]);

  useEffect(() => {
    if (activeStep !== "results" || playbackFrameIndexes.length < 2 || !resultFieldsForUi.length) {
      setResultPlaybackCacheState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const navigatorWithMemory = typeof navigator === "undefined" ? undefined : navigator as Navigator & { deviceMemory?: number };
    const playbackFieldsForSelectedMode = playbackFieldsForResultMode(resultFieldsForUi, resultMode);
    const packedFields = packResultFieldsForPlayback(playbackFieldsForSelectedMode);
    setResultPlaybackCacheState({ status: "preparing", cacheKey: resultPlaybackCacheKey });
    void preparePlaybackFramesInWorker({
      ...(packedFields ? { packedFields } : { fields: playbackFieldsForSelectedMode }),
      frameIndexes: playbackFrameIndexes,
      playbackFps: PLAYBACK_CACHE_PREP_FPS,
      budgetBytes: playbackMemoryBudgetBytes(navigatorWithMemory?.deviceMemory),
      cacheKey: resultPlaybackCacheKey
    })
      .then((cache) => {
        if (cancelled || cache.cacheKey !== resultPlaybackCacheKey) return;
        if (cache.mode === "fallback" || !cache.frames.length) {
          setResultPlaybackCacheState({ status: "fallback", cacheKey: resultPlaybackCacheKey, message: "Using live playback for this result size" });
          return;
        }
        setResultPlaybackCacheState({ status: "ready", cacheKey: resultPlaybackCacheKey, cache });
      })
      .catch(() => {
        if (cancelled) return;
        setResultPlaybackCacheState({ status: "error", cacheKey: resultPlaybackCacheKey, message: "Using live playback for this browser" });
      });
    return () => {
      cancelled = true;
    };
  }, [activeStep, playbackFrameIndexes, resultFieldsForUi, resultMode, resultPlaybackCacheKey]);

  useEffect(() => {
    if (!resultPlaybackPlaying || activeStep !== "results" || playbackFrameIndexes.length < 2) return;
    const frameDurationMs = 1000 / Math.max(1, Math.min(30, resultPlaybackFps));
    let animationFrameId = 0;
    let lastTimestamp: number | null = null;
    let lastViewerTimestamp = 0;
    let lastCommittedTimestamp = 0;
    let ordinalPosition = resultPlaybackOrdinalPositionRef.current;
    let direction = resultPlaybackDirectionRef.current;
    let endpointHoldRemainingMs = resultPlaybackEndpointHoldRemainingMsRef.current;
    const advancePlaybackFrame = (timestamp: number) => {
      if (lastTimestamp !== null) {
        const playbackState = advancePlaybackTimeline({
          frameCount: playbackFrameIndexes.length,
          frameDurationMs,
          elapsedMs: timestamp - lastTimestamp,
          mode: resultPlaybackReverseLoop ? "reverse" : "restart",
          state: { ordinalPosition, direction, endpointHoldRemainingMs }
        });
        ordinalPosition = playbackState.ordinalPosition;
        direction = playbackState.direction;
        endpointHoldRemainingMs = playbackState.endpointHoldRemainingMs;
        const framePosition = solverFramePositionForPlaybackOrdinal(playbackFrameIndexes, ordinalPosition);
        resultPlaybackFramePositionRef.current = framePosition;
        resultPlaybackOrdinalPositionRef.current = ordinalPosition;
        resultPlaybackDirectionRef.current = direction;
        resultPlaybackEndpointHoldRemainingMsRef.current = endpointHoldRemainingMs;
        const playbackViewerFrameIntervalMs = viewerInteractingRef.current ? Number.POSITIVE_INFINITY : frameDurationMs;
        if (timestamp - lastViewerTimestamp >= playbackViewerFrameIntervalMs) {
          lastViewerTimestamp = timestamp;
          commitPlaybackViewerFrame(framePosition);
        }
        const playbackCommitIntervalMs = viewerInteractingRef.current ? Number.POSITIVE_INFINITY : PLAYBACK_UI_COMMIT_INTERVAL_MS;
        if (timestamp - lastCommittedTimestamp >= playbackCommitIntervalMs) {
          lastCommittedTimestamp = timestamp;
          if (!viewerInteractingRef.current) {
            setResultPlaybackOrdinalPosition((current) => Math.abs(current - ordinalPosition) < 0.0001 ? current : ordinalPosition);
            setResultPlaybackFramePosition((current) => Math.abs(current - framePosition) < 0.0001 ? current : framePosition);
            const nextFrameIndex = frameIndexForPlaybackOrdinal(playbackFrameIndexes, ordinalPosition);
            if (nextFrameIndex !== resultFrameIndexRef.current) {
              resultFrameIndexRef.current = nextFrameIndex;
              startTransition(() => setResultFrameIndex(nextFrameIndex));
            }
          }
        }
      }
      lastTimestamp = timestamp;
      animationFrameId = window.requestAnimationFrame(advancePlaybackFrame);
    };
    animationFrameId = window.requestAnimationFrame(advancePlaybackFrame);
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [activeStep, commitPlaybackViewerFrame, playbackFrameIndexes, resultPlaybackFps, resultPlaybackPlaying, resultPlaybackReverseLoop]);

  useEffect(() => {
    const ordinalPosition = resultPlaybackOrdinalPositionRef.current;
    resultPlaybackDirectionRef.current = playbackDirectionForLoopStart(ordinalPosition, playbackFrameIndexes.length, resultPlaybackReverseLoop);
  }, [playbackFrameIndexes.length, resultPlaybackReverseLoop]);

  const handleViewerInteractionChange = useCallback((interacting: boolean) => {
    viewerInteractingRef.current = interacting;
    if (interacting) return;
    const framePosition = resultPlaybackFramePositionRef.current;
    const ordinalPosition = resultPlaybackOrdinalPositionRef.current;
    const nextFrameIndex = frameIndexForPlaybackOrdinal(playbackFrameIndexes, ordinalPosition);
    commitPlaybackViewerFrame(framePosition);
    setResultPlaybackOrdinalPosition(ordinalPosition);
    setResultPlaybackFramePosition(framePosition);
    if (nextFrameIndex !== resultFrameIndexRef.current) {
      resultFrameIndexRef.current = nextFrameIndex;
      startTransition(() => setResultFrameIndex(nextFrameIndex));
    }
  }, [commitPlaybackViewerFrame, playbackFrameIndexes]);

  const handleMeasureDisplayModelDimensions = useCallback((dimensions: NonNullable<DisplayModel["dimensions"]>) => {
    setDisplayModel((current) => {
      if (!current?.nativeCad) return current;
      if (
        current.dimensions?.x === dimensions.x &&
        current.dimensions?.y === dimensions.y &&
        current.dimensions?.z === dimensions.z &&
        current.dimensions?.units === dimensions.units
      ) {
        return current;
      }
      return { ...current, dimensions };
    });
  }, []);

  useEffect(() => {
    if (draftLoadType !== "gravity" && selectedPayloadObject) {
      setSelectedPayloadObject(null);
    }
  }, [draftLoadType, selectedPayloadObject]);

  useEffect(() => {
    if (activeStep !== "loads") setPreviewLoadEdit(null);
  }, [activeStep]);

  useEffect(() => {
    resultFrameIndexRef.current = resultFrameIndex;
  }, [resultFrameIndex]);

  useEffect(() => {
    resultPlaybackFramePositionRef.current = resultPlaybackFramePosition;
  }, [resultPlaybackFramePosition]);

  useEffect(() => {
    resultPlaybackOrdinalPositionRef.current = resultPlaybackOrdinalPosition;
  }, [resultPlaybackOrdinalPosition]);

  const handleResultFrameChange = useCallback((frameIndex: number) => {
    setResultFrameIndex(frameIndex);
    setResultPlaybackFramePosition(frameIndex);
    const ordinalPosition = playbackOrdinalForSolverFramePosition(playbackFrameIndexes, frameIndex);
    setResultPlaybackOrdinalPosition(ordinalPosition);
    resultFrameIndexRef.current = frameIndex;
    resultPlaybackFramePositionRef.current = frameIndex;
    resultPlaybackOrdinalPositionRef.current = ordinalPosition;
    resultPlaybackDirectionRef.current = playbackDirectionForLoopStart(ordinalPosition, playbackFrameIndexes.length, resultPlaybackReverseLoop);
    resultPlaybackEndpointHoldRemainingMsRef.current = endpointHoldForPlaybackOrdinal(ordinalPosition, playbackFrameIndexes.length);
  }, [playbackFrameIndexes, resultPlaybackReverseLoop]);

  function handleResultPlaybackToggle() {
    setResultPlaybackPlaying((playing) => {
      if (!playing) setShowDeformed(true);
      if (!playing) {
        const ordinalPosition = resultPlaybackOrdinalPositionRef.current;
        resultPlaybackDirectionRef.current = playbackDirectionForLoopStart(ordinalPosition, playbackFrameIndexes.length, resultPlaybackReverseLoop);
        resultPlaybackEndpointHoldRemainingMsRef.current = endpointHoldForPlaybackOrdinal(ordinalPosition, playbackFrameIndexes.length);
      }
      return !playing;
    });
  }

  const draftLoadPreview = useMemo<DraftLoadPreview | undefined>(() => {
    if (!study || activeStep !== "loads") return undefined;
    const isPayloadMass = draftLoadType === "gravity";
    const face = isPayloadMass && selectedPayloadObject ? faceForPayloadObject(selectedPayloadObject) : selectedFace;
    const point = isPayloadMass ? selectedPayloadObject?.center ?? null : selectedLoadPoint;
    if (!face || !point) return undefined;
    const existingSelection = study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === face.id));
    const selection = existingSelection ?? namedSelectionForFace(study, face);
    const value = isPayloadMass ? draftPayloadPreview?.value ?? draftLoadValue : draftLoadValue;
    const payloadMetadata = isPayloadMass ? draftPayloadPreview?.metadata ?? {} : {};
    return {
      selection,
      load: {
        id: "draft-load-preview",
        type: draftLoadType,
        selectionRef: selection.id,
        parameters: {
          value,
          units: unitsForLoadType(draftLoadType),
          direction: directionVectorForLabel(draftLoadDirection, face, displayModel ?? undefined),
          directionMode: draftLoadDirection,
          applicationPoint: point,
          ...(isPayloadMass && selectedPayloadObject ? { payloadObject: selectedPayloadObject } : {}),
          ...payloadMetadata
        },
        status: "complete"
      }
    };
  }, [activeStep, displayModel, draftLoadDirection, draftLoadType, draftLoadValue, draftPayloadPreview, selectedFace, selectedLoadPoint, selectedPayloadObject, study]);

  const loadMarkers = useMemo<ViewerLoadMarker[]>(() => {
    const markers = createViewerLoadMarkers({ study, loadPreviews: previewLoadEdit ? [previewLoadEdit] : [], draftLoadPreview, displayModel: displayModel ?? undefined });
    return markers.map((marker) => {
      const converted = loadValueForUnits(marker.value, marker.units, displayUnitSystem);
      return { ...marker, value: converted.value, units: converted.units };
    });
  }, [displayModel, displayUnitSystem, draftLoadPreview, previewLoadEdit, study]);
  const supportMarkers = useMemo<ViewerSupportMarker[]>(() => {
    if (!study) return [];
    const faceCounts = new Map<string, number>();
    let fixedSupportCount = 0;
    let prescribedSupportCount = 0;
    return study.constraints.flatMap((support) => {
      const selection = study.namedSelections.find((item) => item.id === support.selectionRef);
      const faceId = selection?.geometryRefs[0]?.entityId;
      if (!faceId) return [];
      const stackIndex = faceCounts.get(faceId) ?? 0;
      faceCounts.set(faceId, stackIndex + 1);
      const supportOrdinal = support.type === "fixed" ? ++fixedSupportCount : ++prescribedSupportCount;
      return [{
        id: support.id,
        faceId,
        type: support.type,
        displayLabel: supportDisplayLabel(support, supportOrdinal),
        label: selection?.geometryRefs[0]?.label ?? selection?.name ?? "selected face",
        stackIndex
      }];
    });
  }, [study]);

  function handleWorkspaceShortcut(event: KeyboardEvent) {
    if (!project || !displayModel) return;
    const key = event.key.toLowerCase();
    const editableTarget = isEditableShortcutTarget(event.target as HTMLElement | null);
    if ((event.metaKey || event.ctrlKey) && key === "s") {
      // Cmd/Ctrl+S stays global, even inside text inputs, so a save request is never silently dropped.
      event.preventDefault();
      void handleSaveProject();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "z") {
      // Editable fields keep their native undo/redo instead of mutating app history.
      if (editableTarget) return;
      event.preventDefault();
      if (event.shiftKey) {
        handleRedoAction();
      } else {
        handleUndoAction();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || editableTarget) return;
    // Single-key shortcuts: honor the user's off-switch (WCAG 2.1.4) and stay
    // inert while a modal/menu overlay is open.
    if (!singleKeyShortcutsEnabled) return;
    if (document.querySelector('[role="dialog"], .condition-menu, .result-field-menu')) return;
    if (key === "h") {
      event.preventDefault();
      handleFitDefaultView();
      return;
    }
    const shortcutStep = workflowStepForShortcut(key, activeStep, { meshStatus: study?.meshSettings.status ?? "not_started" });
    if (!shortcutStep) return;
    event.preventDefault();
    navigateToStep(shortcutStep);
  }

  // Keep the latest handler in a ref so the mount-once listener never reads stale state (e.g. Cmd+S saving outdated results).
  useEffect(() => {
    workspaceShortcutHandlerRef.current = handleWorkspaceShortcut;
  });

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => workspaceShortcutHandlerRef.current(event);
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const autosaveUiSnapshot = useMemo<WorkspaceUiSnapshot>(() => ({
    activeStep,
    homeRequested,
    selectedFaceId,
    selectedLoadPoint,
    selectedPayloadObject,
    viewMode,
    themeMode,
    resultMode,
    showDeformed,
    showDimensions,
    stressExaggeration,
    draftLoadType,
    draftLoadValue,
    draftLoadDirection,
    sampleModel,
    sampleAnalysisType,
    activeRunId,
    completedRunId,
    runProgress,
    undoStack,
    redoStack,
    status,
    logs
  }), [
    activeRunId,
    activeStep,
    completedRunId,
    draftLoadDirection,
    draftLoadType,
    draftLoadValue,
    homeRequested,
    logs,
    redoStack,
    resultMode,
    runProgress,
    sampleAnalysisType,
    sampleModel,
    selectedFaceId,
    selectedLoadPoint,
    selectedPayloadObject,
    showDeformed,
    showDimensions,
    status,
    stressExaggeration,
    themeMode,
    undoStack,
    viewMode
  ]);

  function notifyAutosaveWriteFailure() {
    if (autosaveWriteFailureNotifiedRef.current) return;
    autosaveWriteFailureNotifiedRef.current = true;
    pushMessage("Autosave failed: browser storage is full or unavailable. Save the project to disk to keep changes.");
  }

  function notifyAutosaveDegraded() {
    if (autosaveDegradedNotifiedRef.current) return;
    autosaveDegradedNotifiedRef.current = true;
    pushMessage("Autosave kept the project setup, but the mesh artifact and results exceed browser storage. Use Save project to keep them on disk.");
  }

  // Selections referencing placeholder "face-upload-*" faces can never map
  // onto the meshed geometry: legacy generic box faces (uploads made while the
  // STEP face registry was unavailable — the CSP regression) and viewport
  // picks made before the registry finished loading ("face-upload-picked-*").
  // Rebuild the real registry and remap or flag those selections as soon as
  // such a project is open or such a pick lands.
  useEffect(() => {
    if (!project || !displayModel) return undefined;
    const legacyUpload = hasLegacyStepUploadFaces(displayModel);
    if (!legacyUpload && !hasUnresolvedStepFaceSelections(project, displayModel)) return undefined;
    let cancelled = false;
    void import("./stepFaces")
      .then((stepFaces) => stepFaces.stepFaceRegistryFromBase64(displayModel.nativeCad!.contentBase64!))
      .then((registry) => {
        if (cancelled || !registry.displayFaces.length) return;
        const heal = healStepFaceSelections(project, displayModel, registry);
        // Unresolved-only heals must not write state: the selections are
        // unchanged and re-setting equivalent objects would loop this effect.
        // Legacy uploads still always swap in the registry's real faces.
        if (heal.remapped.length || heal.removed.length || legacyUpload) {
          setProject(heal.project);
          setDisplayModel(heal.displayModel);
        }
        const message = legacyStepFaceHealMessage(heal);
        // Project mutations intentionally re-run this effect while unresolved
        // selections remain. Notify once for the loaded workspace instead of
        // keying on the growing message text and spamming every mutation.
        if (message && !stepFaceHealNotifiedRef.current) {
          stepFaceHealNotifiedRef.current = true;
          pushMessage(message);
        }
      })
      .catch(() => {
        // Registry still unavailable (e.g. import failure): leave the
        // placeholder faces in place; meshing will surface its own error.
      });
    return () => {
      cancelled = true;
    };
  }, [displayModel, project]);

  useEffect(() => {
    if (!project || !displayModel) return;
    return scheduleAutosavedUiSnapshotWrite(
      () => buildAutosavedWorkspaceUiSnapshot(autosaveUiSnapshot),
      undefined,
      AUTOSAVE_UI_WRITE_DELAY_MS,
      notifyAutosaveWriteFailure
    );
  }, [autosaveUiSnapshot, displayModel, project]);

  useEffect(() => {
    if (!project || !displayModel) return;
    return scheduleAutosavedWorkspaceWrite(() => buildAutosavedWorkspace({
      project,
      displayModel,
      results: resultFields.length && resultSummary ? {
        activeRunId,
        completedRunId,
        summary: resultSummary,
        fields: resultFields,
        ...(resultSurfaceMesh ? { surfaceMesh: resultSurfaceMesh } : {}),
        ...(solverMeshSummary ? { solverMeshSummary } : {}),
        ...(reportCaptures?.runId === completedRunId ? { reportCaptures: reportCaptures.captures } : {})
      } : undefined,
      ui: autosaveUiSnapshot
    }), undefined, AUTOSAVE_HEAVY_WRITE_DELAY_MS, notifyAutosaveWriteFailure, notifyAutosaveDegraded);
  }, [
    activeRunId,
    activeStep,
    completedRunId,
    displayModel,
    draftLoadDirection,
    draftLoadType,
    draftLoadValue,
    homeRequested,
    project,
    redoStack,
    resultFields,
    resultSurfaceMesh,
    resultSummary,
    reportCaptures,
    runProgress,
    sampleAnalysisType,
    sampleModel,
    selectedFaceId,
    selectedLoadPoint,
    selectedPayloadObject,
    showDeformed,
    showDimensions,
    solverMeshSummary,
    themeMode,
    undoStack,
    viewMode
  ]);

  async function openProjectResponse(
    action: Promise<{ project: Project; displayModel: DisplayModel; message?: string; results?: LocalResultBundle }>,
    options: { actionHandle: ProjectActionHandle; nextStep?: StepId; staleMessage?: string }
  ) {
    let response: { project: Project; displayModel: DisplayModel; message?: string; results?: LocalResultBundle };
    try {
      response = await action;
    } catch (error) {
      completeProjectAction(options.actionHandle);
      throw error;
    }
    if (!options.actionHandle.isCurrent()) {
      completeProjectAction(options.actionHandle);
      if (options.staleMessage) pushMessage(options.staleMessage);
      return false;
    }
    // Clear the request token before setting project state; the project-change
    // effect treats any state change during an active action as superseding it.
    completeProjectAction(options.actionHandle);
    // Stop watching any run from the previous project so it cannot overwrite the new project's results.
    activeRunSourceRef.current?.close();
    activeRunSourceRef.current = null;
    processingRunIdRef.current = null;
    setProcessingRunId(null);
    setRunTiming(null);
    setHomeRequested(false);
    stepFaceHealNotifiedRef.current = false;
    // Keep the imperative snapshot in sync immediately. The effect below is
    // intentionally retained for ordinary state mutations, but async model
    // operations must not have a render-sized window where they can compare
    // against the previous project and overwrite a newer workspace.
    projectRef.current = response.project;
    setProject(response.project);
    setDisplayModel(response.displayModel);
    requestDefaultHomeView();
    setUndoStack([]);
    setRedoStack([]);
    setSelectedLoadPoint(null);
    setSelectedPayloadObject(null);
    if (response.results?.fields.length) {
      setResultSummary(response.results.summary);
      setResultFields(withDerivedSurfaceSafetyFactorFields(response.results));
      setResultSurfaceMesh(response.results.surfaceMesh);
      setSolverMeshSummary(response.results.solverMeshSummary ?? null);
      const restoredRunId = response.results.completedRunId ?? response.results.activeRunId ?? latestCompletedRunId(response.project.studies[0] ?? null, "") ?? "";
      setReportCaptures(response.results.reportCaptures && restoredRunId ? { runId: restoredRunId, captures: response.results.reportCaptures } : null);
      setResultFrameIndex(0);
      setActiveRunId(response.results.activeRunId ?? restoredRunId);
      setCompletedRunId(restoredRunId);
      setRunProgress(100);
      if (options.nextStep) {
        applyStep(options.nextStep);
        setViewMode("model");
      } else {
        setViewMode("results");
        setActiveStep("results");
      }
    } else {
      applyStep("model");
      setViewMode("model");
      setResultSummary(null);
      setResultFields([]);
      setResultSurfaceMesh(undefined);
      setSolverMeshSummary(null);
      setReportCaptures(null);
      setResultFrameIndex(0);
      setRunProgress(0);
      const nextCompletedRunId = latestCompletedRunId(response.project.studies[0] ?? null, "") ?? "";
      setActiveRunId(nextCompletedRunId);
      setCompletedRunId(nextCompletedRunId);
    }
    pushMessage(response.message ?? "Project opened.");
    return true;
  }

  async function handleLoadSample(nextSample = sampleModel, nextAnalysisType = sampleAnalysisType) {
    const actionHandle = beginProjectAction(projectRef.current);
    setSampleModel(nextSample);
    setSampleAnalysisType(nextAnalysisType);
    await openProjectResponse(loadSampleProject(nextSample, nextAnalysisType), { actionHandle, nextStep: "model" });
  }

  function handleCreateProject() {
    const actionHandle = beginProjectAction(projectRef.current);
    void openProjectResponse(createProject(), { actionHandle });
  }

  function handleOpenProject(file: File) {
    const actionHandle = beginProjectAction(projectRef.current);
    void openProjectResponse(importLocalProject(file), { actionHandle }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      pushMessage(error instanceof Error ? error.message : "Could not open local project.");
    });
  }

  function handleUploadModel(file: File) {
    if (!project) return;
    const sourceProject = project;
    const actionHandle = beginProjectAction(sourceProject);
    const extension = file.name.trim().split(".").pop()?.toLowerCase();
    pushMessage(extension === "step" || extension === "stp" ? "Uploading model and checking STEP topology..." : "Uploading model...");
    void openProjectResponse(uploadModel(project.id, file, project, {
      signal: actionHandle.signal,
      isCurrent: actionHandle.isCurrent,
      clientId: actionHandle.clientId,
      generation: actionHandle.generation
    }), { actionHandle }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      pushMessage(error instanceof Error ? error.message : "Could not upload model.");
    });
  }

  async function handleRepairModel() {
    if (!project || isRepairingModel) return;
    const actionHandle = beginProjectAction(project);
    setIsRepairingModel(true);
    pushMessage("Repairing open STEP surfaces...");
    try {
      await openProjectResponse(repairUploadedStepModel(project.id, project, {
        signal: actionHandle.signal,
        isCurrent: actionHandle.isCurrent,
        clientId: actionHandle.clientId,
        generation: actionHandle.generation
      }), {
        actionHandle,
        nextStep: "model",
        staleMessage: "The repaired model was not applied because the workspace changed during repair."
      });
    } catch (error) {
      if (isAbortError(error)) {
        pushMessage("Model repair stopped because the workspace changed.");
        return;
      }
      pushMessage(`Model repair failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRepairingModel(false);
    }
  }

  function beginProjectAction(sourceProject: Project | null): ProjectActionHandle {
    invalidateProjectAction();
    const controller = new AbortController();
    const generation = projectActionGenerationRef.current;
    projectActionAbortRef.current = controller;
    projectActionSourceRef.current = sourceProject;
    return {
      clientId: projectActionClientIdRef.current!,
      generation,
      signal: controller.signal,
      isCurrent: () =>
        projectActionGenerationRef.current === generation &&
        projectActionAbortRef.current === controller &&
        !controller.signal.aborted &&
        projectRef.current === sourceProject
    };
  }

  function completeProjectAction(actionHandle: ProjectActionHandle): void {
    if (projectActionGenerationRef.current !== actionHandle.generation) return;
    projectActionAbortRef.current = null;
    projectActionSourceRef.current = null;
  }

  function invalidateProjectAction(): void {
    projectActionGenerationRef.current += 1;
    projectActionAbortRef.current?.abort();
    projectActionAbortRef.current = null;
    projectActionSourceRef.current = null;
  }

  async function handleSaveProject() {
    if (!project || !displayModel) return;
    try {
      const savedAt = await saveProjectToLocalDisk(project, displayModel, resultSummary ? {
        activeRunId,
        completedRunId,
        summary: resultSummary,
        fields: resultFields,
        ...(resultSurfaceMesh ? { surfaceMesh: resultSurfaceMesh } : {}),
        ...(solverMeshSummary ? { solverMeshSummary } : {}),
        ...(reportCaptures?.runId === completedRunId ? { reportCaptures: reportCaptures.captures } : {})
      } : undefined);
      if (!savedAt) return;
      setProject((current) => current ? { ...current, updatedAt: savedAt } : current);
      pushMessage("Project saved to local disk.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      pushMessage(error instanceof Error ? error.message : "Could not save project.");
    }
  }

  const handleRegisterViewerCapture = useCallback((capture: (() => Promise<string>) | null) => {
    viewerCaptureRef.current = capture;
    if (capture) setViewerCaptureRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    const runId = completedRunId;
    if (!runId || !resultSummary || !resultFields.length || viewMode !== "results" || !viewerCaptureRef.current) return;
    if (reportCaptures?.runId === runId || reportCaptureInFlightRef.current === runId) return;
    const sourceSummary = resultSummary;
    const capture = viewerCaptureRef.current;
    let cancelled = false;
    reportCaptureInFlightRef.current = runId;
    void captureResultViews({
      getViewMode: () => reportStateRef.current.viewMode,
      getResultMode: () => reportStateRef.current.resultMode,
      setResultMode,
      getResultFrameIndex: () => resultFrameIndexRef.current,
      setResultFrameIndex: handleResultFrameChange,
      getPlaybackPlaying: () => reportStateRef.current.resultPlaybackPlaying,
      setPlaybackPlaying: setResultPlaybackPlaying,
      resultFields,
      surfaceMeshRef: resultSurfaceMesh?.id,
      capture,
      isCurrent: () => reportStateRef.current.resultSummary === sourceSummary && reportStateRef.current.completedRunId === runId
    }).then(async (captures) => {
      if (cancelled) return;
      await saveRunReportCaptures(runId, captures);
      if (cancelled || reportStateRef.current.completedRunId !== runId) return;
      setReportCaptures({ runId, captures });
      setReportError(null);
      pushMessage("Report images saved with simulation results.");
    }).catch((error) => {
      if (cancelled) return;
      const message = errorMessage(error, "Could not save report images with the simulation results.");
      setReportError(message);
      pushMessage(message);
    }).finally(() => {
      if (reportCaptureInFlightRef.current === runId) reportCaptureInFlightRef.current = null;
    });
    return () => {
      cancelled = true;
    };
  }, [completedRunId, reportCaptures, resultFields, resultSummary, resultSurfaceMesh?.id, viewMode, viewerCaptureRevision]);

  async function handleGenerateReport() {
    if (!project || !study || !resultSummary) {
      setReportError("Run a simulation before generating a report.");
      return;
    }
    if (solverRunning) {
      setReportError("Wait for the active solve to finish before generating a report.");
      return;
    }

    const sourceSummary = resultSummary;
    const sourceRunId = completedRunId;
    const captures = reportCaptures?.runId === sourceRunId ? reportCaptures.captures : null;
    if (!captures) {
      setReportError("Report images are still being saved with this simulation. Wait for image preparation to finish, then generate the report again.");
      return;
    }
    const generatedAt = new Date();
    setReportBusy(true);
    setReportError(null);
    try {
      const saveTarget = await prepareBlobSaveToDisk(suggestedReportFilename(project.name, generatedAt), {
        description: "PDF report",
        accept: { "application/pdf": [".pdf"] }
      });
      if (saveTarget === "cancelled") return;
      const reportData = buildReportData({
        project,
        study,
        displayModel,
        resultSummary: sourceSummary,
        resultFields,
        solverMeshSummary,
        runTiming,
        unitSystem: displayUnitSystem,
        captures,
        generatedAt,
        exaggeration: stressExaggeration,
        showDeformed
      });
      const { renderReportPdf } = await import("./report/reportPdf");
      const blob = await renderReportPdf(reportData);
      await saveTarget.save(blob);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : "Could not generate the simulation report.");
    } finally {
      setReportBusy(false);
    }
  }

  function pushMessage(message: string) {
    setStatus(message);
    setLogs((current) => [{ message, at: Date.now() }, ...current].slice(0, WORKSPACE_LOG_LIMIT));
  }

  function clearLogs() {
    setLogs([]);
  }

  async function updateStudy(action: Promise<{ study: Study; message: string }>, nextStep?: StepId) {
    const response = await action;
    // Snapshot the latest committed project (not the render closure) so quick consecutive mutations
    // each capture their true pre-mutation state, then merge the study into the current project.
    const projectBeforeUpdate = projectRef.current;
    if (projectBeforeUpdate) {
      recordUndoSnapshot(projectBeforeUpdate);
      setProject((current) => current
        ? { ...current, studies: current.studies.map((item) => (item.id === response.study.id ? response.study : item)) }
        : current);
    }
    // Any study change (loads, supports, materials, mesh, solver settings)
    // makes the previous run's results stale; never keep showing them.
    if (resultFields.length) {
      invalidateCompletedRunState();
      pushMessage("Previous results cleared: the study changed since the last run.");
    }
    pushMessage(response.message);
    if (nextStep) navigateToStep(nextStep);
  }

  function handleGenerateMesh(preset: MeshQuality) {
    if (!project || !study) return;
    const sourceProject = project;
    setMeshPhaseProgress({ phase: "load", phaseIndex: 0, phaseCount: 8, message: "Loading gmsh WebAssembly module..." });
    // generateMesh rethrows quality-gate and STEP topology rejections by
    // design. Surface the primary failure immediately, then trial-run the
    // exact Fix action only for geometry-class failures on the same model.
    void updateStudy(generateMesh(study.id, preset, study, displayModel ?? undefined, pushMessage, setMeshPhaseProgress), shouldAutoAdvanceAfterMeshGeneration() ? "run" : undefined)
      .catch(async (error: unknown) => {
        setMeshPhaseProgress(null);
        pushMessage(`Mesh generation failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!isStepGeometryMeshFailure(error)) return;
        const probeDecision = uploadedStepRepairProbeDecision(sourceProject, projectRef.current);
        if (!probeDecision.shouldProbe) {
          pushMessage(probeDecision.reason);
          return;
        }
        const liveProject = probeDecision.project;
        const currentStepGeometry = stepGeometryMetadataForProject(liveProject);
        if (currentStepGeometry && currentStepGeometry.status !== "solid" && currentStepGeometry.status !== "unchecked") return;

        pushMessage("Checking whether Fix open surfaces can repair this model...");
        const actionHandle = beginProjectAction(liveProject);
        try {
          const probe = await probeUploadedStepRepairAfterMeshFailure(liveProject, {
            signal: actionHandle.signal,
            isCurrent: actionHandle.isCurrent,
            clientId: actionHandle.clientId,
            generation: actionHandle.generation
          });
          if (!probe || !actionHandle.isCurrent()) return;
          completeProjectAction(actionHandle);
          projectRef.current = probe.project;
          setProject(probe.project);
          pushMessage(probe.stepGeometry.status === "repairable"
            ? "Fix open surfaces is available on the Model and Mesh steps."
            : STEP_REPAIR_UNAVAILABLE_MESSAGE);
        } catch (probeError) {
          if (isAbortError(probeError)) return;
          pushMessage(`Could not check automatic STEP repair: ${probeError instanceof Error ? probeError.message : String(probeError)}`);
        } finally {
          completeProjectAction(actionHandle);
        }
      })
      .finally(() => setMeshPhaseProgress(null));
  }

  function handleViewportFaceSelect(face: DisplayFace, point?: [number, number, number], payloadObject?: PayloadObjectSelection) {
    setSelectedFaceId(face.id);
    const isPayloadObjectLoad = activeStep === "loads" && draftLoadType === "gravity";
    const nextLoadPoint = activeStep === "loads" ? (isPayloadObjectLoad ? payloadObject?.center ?? selectedPayloadObject?.center ?? point ?? face.center : point ?? face.center) : null;
    setSelectedPayloadObject((current) => nextSelectedPayloadObject({ activeStep, draftLoadType, current, payloadObject }));
    setSelectedLoadPoint(nextLoadPoint);
    if (displayModel && !displayModel.faces.some((item) => item.id === face.id)) {
      setDisplayModel({ ...displayModel, faces: [...displayModel.faces, face] });
    }
    if (activeStep === "supports") {
      void addFixedSupportForFace(face);
      return;
    }
    pushMessage(`${face.label} selected.`);
  }

  function handleViewerMiss() {
    if (!shouldClearPayloadSelectionOnViewerMiss({ activeStep, draftLoadType })) return;
    setSelectedPayloadObject(null);
    setSelectedLoadPoint(null);
  }

  async function addFixedSupportForFace(face: DisplayFace) {
    if (!study) return;
    const existingSelection = study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === face.id));
    const selection = existingSelection ?? namedSelectionForFace(study, face);
    if (study.constraints.some((support) => support.selectionRef === selection.id)) {
      pushMessage(`Fixed support already exists on ${selection.name}.`);
      return;
    }
    const nextSelections = existingSelection ? study.namedSelections : [...study.namedSelections, selection];
    const nextSupport: Constraint = {
      id: `constraint-${crypto.randomUUID()}`,
      type: "fixed",
      selectionRef: selection.id,
      parameters: {},
      status: "complete"
    };
    await updateStudy(
      saveStudyPatch(study.id, { namedSelections: nextSelections, constraints: [...study.constraints, nextSupport] }, "Fixed support added.", study)
    );
  }

  async function addLoadForFace(type: LoadType, value: number, face: DisplayFace, direction: LoadDirectionLabel, applicationPoint?: [number, number, number] | null, payloadObject?: PayloadObjectSelection | null, payloadMetadata: PayloadLoadMetadata = {}) {
    if (!study) return;
    const existingSelection = study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === face.id));
    const selection = existingSelection ?? namedSelectionForFace(study, face);
    const nextSelections = existingSelection ? study.namedSelections : [...study.namedSelections, selection];
    const load: Load = {
      id: `load-${crypto.randomUUID()}`,
      type,
      selectionRef: selection.id,
      parameters: { value, units: unitsForLoadType(type), direction: directionVectorForLabel(direction, face, displayModel ?? undefined), directionMode: direction, ...(applicationPoint ? { applicationPoint } : {}), ...(payloadObject ? { payloadObject } : {}), ...(type === "gravity" ? payloadMetadata : {}) },
      status: "complete"
    };
    await updateStudy(
      saveStudyPatch(study.id, { namedSelections: nextSelections, loads: [...study.loads, load] }, "Load added.", study)
    );
  }

  async function handleRenameProject(name: string) {
    if (!project) return;
    const nextName = name.trim().replace(/\s+/g, " ");
    if (!nextName || nextName === project.name) return;
    try {
      const response = await renameProject(project.id, nextName, project);
      recordUndoSnapshot(project);
      setProject(response.project);
      pushMessage(response.message);
    } catch (error) {
      pushMessage(error instanceof Error ? error.message : "Could not rename project.");
    }
  }

  function recordUndoSnapshot(snapshot: Project) {
    setUndoStack((history) => [...history, cloneProjectSharingEmbeddedModels(snapshot)].slice(-30));
    setRedoStack([]);
  }

  function applyStep(step: StepId) {
    setActiveStep(step);
    if (step === "results") {
      setViewMode("results");
      return;
    }
    if (["material", "supports", "loads", "mesh", "run"].includes(step) && viewMode === "results") {
      setViewMode("model");
    }
  }

  function navigateToStep(step: StepId) {
    if (step === activeStep) return;
    if (!canNavigateToStep(step, { meshStatus: study?.meshSettings.status ?? "not_started" })) {
      pushMessage("Generate the mesh before going to Run.");
      return;
    }
    applyStep(step);
  }

  function handleStepSelect(step: StepId) {
    navigateToStep(step);
  }

  function handleCreateStaticSimulation() {
    if (!project || !displayModel) return;
    const nextStudy = createLocalStaticStressStudy(project, displayModel);
    const nextProject = { ...project, studies: [nextStudy], updatedAt: new Date().toISOString() };
    recordUndoSnapshot(project);
    setProject(nextProject);
    applyStep(displayModel.bodyCount > 0 ? "material" : "model");
    pushMessage("Static simulation created.");
  }

  function handleCreateDynamicSimulation() {
    if (!project || !displayModel) return;
    const nextStudy = createLocalDynamicStructuralStudy(project, displayModel);
    const nextProject = { ...project, studies: [nextStudy], updatedAt: new Date().toISOString() };
    recordUndoSnapshot(project);
    setProject(nextProject);
    applyStep(displayModel.bodyCount > 0 ? "material" : "model");
    pushMessage("Dynamic structural simulation created.");
  }

  function invalidateCompletedRunState() {
    setCompletedRunId("");
    setReportCaptures(null);
    setActiveRunId("");
    setRunProgress(0);
    setResultFields([]);
    setResultSurfaceMesh(undefined);
    setSolverMeshSummary(null);
    setResultFrameIndex(0);
    setResultPlaybackFramePosition(0);
    setResultPlaybackPlaying(false);
  }

  function handleUpdateSolverSettings(settings: Partial<DynamicSolverSettings> & { fidelity?: SimulationFidelity }) {
    if (!study) return;
    const nextSettings = study.type === "dynamic_structural"
      ? normalizedDynamicSolverSettings(study.solverSettings, { ...study.solverSettings, ...settings }, settings)
      : { ...study.solverSettings, ...settings };
    invalidateCompletedRunState();
    void updateStudy(
      saveStudyPatch(
        study.id,
        { solverSettings: nextSettings },
        "Solver settings updated.",
        study
      )
    );
  }

  function handleChangeStudyType(type: Study["type"]) {
    if (!study || study.type === type || solverRunning) return;
    // Backend and fidelity survive the switch; the transient settings are
    // schema defaults going to dynamic and dropped going back to static.
    const backend = study.solverSettings.backend;
    const fidelity = study.solverSettings.fidelity;
    const carried = { ...(backend ? { backend } : {}), ...(fidelity ? { fidelity } : {}) };
    const defaultNames = ["Static Stress", "Dynamic Structural"];
    const name = defaultNames.includes(study.name)
      ? (type === "dynamic_structural" ? "Dynamic Structural" : "Static Stress")
      : study.name;
    const patch: Partial<Study> = type === "dynamic_structural"
      ? { type, name, solverSettings: DynamicSolverSettingsSchema.parse(carried) }
      : { type, name, solverSettings: carried };
    void updateStudy(saveStudyPatch(
      study.id,
      patch,
      type === "dynamic_structural" ? "Study switched to dynamic structural analysis." : "Study switched to static stress analysis.",
      study
    ));
  }

  function normalizedDynamicSolverSettings(
    currentSettings: DynamicSolverSettings,
    mergedSettings: DynamicSolverSettings & { fidelity?: SimulationFidelity },
    patch: Partial<DynamicSolverSettings>
  ) {
    const minimumOutputInterval = Math.max(DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
    const requestedOutputInterval = patch.outputInterval ?? currentSettings.outputInterval ?? DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS;
    return {
      ...mergedSettings,
      loadProfile: isDynamicLoadProfile(mergedSettings.loadProfile) ? mergedSettings.loadProfile : "ramp",
      outputInterval: Math.max(
        requestedOutputInterval,
        mergedSettings.timeStep,
        minimumOutputInterval
      )
    };
  }

  function isDynamicLoadProfile(value: unknown): value is DynamicSolverSettings["loadProfile"] {
    return value === "ramp" || value === "step" || value === "quasi_static" || value === "sinusoidal";
  }

  function handleBoundaryConditionType(type: "fixed" | "prescribed_displacement" | "force" | "pressure" | "gravity") {
    setShowBoundaryConditionMenu(false);
    if (type === "fixed" || type === "prescribed_displacement") {
      applyStep("supports");
      if (type === "fixed" && selectedFace) void addFixedSupportForFace(selectedFace);
      return;
    }
    setDraftLoadType(type);
    setDraftLoadValue(defaultValueForLoadType(type));
    applyStep("loads");
  }

  function handleRotateModel(axis: RotationAxis) {
    setViewAxis(axis);
    setViewAxisSignal((value) => value + 1);
    pushMessage(`View aligned perpendicular to ${axis.toUpperCase()} axis.`);
  }

  function handleResetModelOrientation() {
    setDisplayModel((current) => (current ? resetDisplayModelOrientation(current) : current));
    requestDefaultHomeView();
    pushMessage("Model orientation reset.");
  }

  function requestDefaultHomeView() {
    setViewAxis(null);
    setFitSignal((value) => value + 1);
  }

  function handleFitDefaultView() {
    requestDefaultHomeView();
  }

  function handleUnitSystemChange(unitSystem: UnitSystem) {
    if (!project || project.unitSystem === unitSystem) return;
    recordUndoSnapshot(project);
    setProject({ ...project, unitSystem });
    pushMessage(`Project units switched to ${unitSystem === "SI" ? "metric" : "imperial"}.`);
  }

  function handleUndoAction() {
    if (!project || !canUndoAction) return;
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, cloneProjectSharingEmbeddedModels(project)]);
    setProject(cloneProjectSharingEmbeddedModels(previous));
    void persistProjectSnapshot(previous, "Undo applied.");
  }

  function handleRedoAction() {
    if (!project || !canRedoAction) return;
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, cloneProjectSharingEmbeddedModels(project)].slice(-30));
    setProject(cloneProjectSharingEmbeddedModels(next));
    void persistProjectSnapshot(next, "Redo applied.");
  }

  async function persistProjectSnapshot(snapshot: Project, message: string) {
    const snapshotStudy = snapshot.studies[0];
    if (!snapshotStudy) return;
    try {
      await saveStudyPatch(snapshotStudy.id, snapshotStudy, message);
      pushMessage(message);
    } catch (error) {
      pushMessage(error instanceof Error ? error.message : "Could not update undo history.");
    }
  }

  async function handleRunSimulation() {
    if (!study) return;
    if (!effectiveCanRunSimulation) {
      pushMessage(effectiveMissingRunItems.length ? `Complete before running: ${effectiveMissingRunItems.join(", ")}.` : "Simulation is already running.");
      return;
    }
    setResultPlaybackPlaying(false);
    setRunError(null);
    pushMessage("Starting simulation run.");
    pushMessage(runDiagnosticsMessage(study, displayModel ?? undefined));
    let response: Awaited<ReturnType<typeof runSimulation>>;
    try {
      response = await runSimulation(study.id, study, displayModel ?? undefined, {
        onRunStatus: pushMessage,
        resultRenderBounds,
        // A-M4 local-first meshing: when the run meshes geometry before
        // solving, persist the meshed study (with its stored artifact) so
        // later runs reuse it instead of re-meshing.
        onStudyMeshed: (meshedStudy) => {
          setProject((current) => current
            ? { ...current, studies: current.studies.map((item) => (item.id === meshedStudy.id ? meshedStudy : item)) }
            : current);
        }
      });
    } catch (error) {
      setProcessingRunId(null);
      setRunProgress(0);
      setRunTiming(null);
      setResultPlaybackPlaying(false);
      const message = errorMessage(error, "Could not start simulation.");
      setRunError(message);
      pushMessage(message);
      return;
    }
    setActiveRunId(response.run.id);
    setCompletedRunId("");
    setReportCaptures(null);
    setProcessingRunId(response.run.id);
    setRunProgress(0);
    setRunTiming(null);
    pushMessage(response.message);
    const source = subscribeToRun(response.run.id, async (event: RunEvent) => {
      if (typeof event.progress === "number") setRunProgress(event.progress);
      setRunTiming(timingFromRunEvent(event));
      pushMessage(messageWithEta(event));
      if (event.type === "complete") {
        source.close();
        if (activeRunSourceRef.current === source) activeRunSourceRef.current = null;
        if (processingRunIdRef.current === response.run.id) processingRunIdRef.current = null;
        setProcessingRunId(null);
        setRunTiming(null);
        try {
          const results = await getResults(response.run.id);
          if (study.type === "dynamic_structural" && !hasDynamicPlaybackFrames(results.summary, results.fields)) {
            pushMessage("Dynamic results did not include animation frames.");
            setResultPlaybackPlaying(false);
            setRunProgress(0);
            return;
          }
          setResultSummary(results.summary);
          setResultFields(withDerivedSurfaceSafetyFactorFields(results));
          setResultSurfaceMesh(results.surfaceMesh);
          setSolverMeshSummary(solverMeshSummaryFromResults(results));
          setReportCaptures(results.reportCaptures ? { runId: response.run.id, captures: results.reportCaptures } : null);
          setResultFrameIndex(0);
          setResultPlaybackPlaying(false);
          if (study.type === "dynamic_structural") setResultMode("stress");
          setCompletedRunId(response.run.id);
          setViewMode("results");
          setActiveStep("results");
        } catch (error) {
          const message = errorMessage(error, "Could not load simulation results.");
          setRunError(message);
          pushMessage(message);
          setResultPlaybackPlaying(false);
          setRunProgress(0);
        }
      } else if (event.type === "cancelled" || event.type === "error") {
        source.close();
        if (activeRunSourceRef.current === source) activeRunSourceRef.current = null;
        if (processingRunIdRef.current === response.run.id) processingRunIdRef.current = null;
        setProcessingRunId(null);
        setResultPlaybackPlaying(false);
        setRunProgress(0);
        setRunTiming(null);
        if (event.type === "error") setRunError(event.message || "Simulation run failed.");
      }
    });
    activeRunSourceRef.current = source;
    processingRunIdRef.current = response.run.id;
  }

  async function handleCancelSimulation() {
    const runId = processingRunIdRef.current;
    activeRunSourceRef.current?.close();
    activeRunSourceRef.current = null;
    processingRunIdRef.current = null;
    setProcessingRunId(null);
    setResultPlaybackPlaying(false);
    setRunProgress(0);
    setRunTiming(null);
    if (!runId) {
      pushMessage("Simulation processing stopped.");
      return;
    }
    try {
      const response = await cancelRun(runId);
      pushMessage(response.message);
    } catch (error) {
      pushMessage(error instanceof Error ? error.message : "Simulation processing stopped locally.");
    }
  }

  function handleOpenStartMenu() {
    setHomeRequested(true);
  }

  function handleToggleSingleKeyShortcuts() {
    setSingleKeyShortcutsEnabled((enabled) => {
      const next = !enabled;
      try {
        window.localStorage.setItem("opencae.shortcuts.singleKey", next ? "on" : "off");
      } catch {
        // Ignore storage failures (e.g. private browsing); keep in-memory state.
      }
      return next;
    });
  }

  function renderTopbar(showRunButton: boolean) {
    if (!project) return null;
    return (
      <header className="topbar">
        <button className="brand brand-button" type="button" onClick={handleOpenStartMenu} title="Back to start menu" aria-label="Back to start menu">
          <OpenCaeLogoMark />OpenCAE <span className="beta-tag">Beta</span>
        </button>
        <div className="topbar-divider topbar-divider-project" />
        <div className="breadcrumb">
          <ProjectNameChip name={project.name} onRename={handleRenameProject} />
          {study ? <><span className="breadcrumb-sep">/</span><span>{study.name}</span></> : <><span className="breadcrumb-sep">/</span><span>No simulation</span></>}
        </div>
        <div className="topbar-tools" aria-label="Workspace tools">
          <div className="history-tools" role="group" aria-label="Undo and redo">
            <button className="icon-button history-button" type="button" title="Undo last change" aria-label="Undo last change" disabled={!canUndoAction} onClick={handleUndoAction}><UndoIcon /></button>
            <button className="icon-button history-button" type="button" title="Redo last change" aria-label="Redo last change" disabled={!canRedoAction} onClick={handleRedoAction}><RedoIcon /></button>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-pressed={singleKeyShortcutsEnabled}
            title={singleKeyShortcutsEnabled ? "Single-key shortcuts on" : "Single-key shortcuts off"}
            aria-label="Single-key shortcuts"
            onClick={handleToggleSingleKeyShortcuts}
          >
            Keys
          </button>
        </div>
        {showRunButton ? (
          <button
            className={`primary topbar-action ${solverRunning ? "running" : ""}`}
            onClick={handleRunSimulation}
            disabled={!effectiveCanRunSimulation}
            title={effectiveMissingRunItems.length ? `Complete before running: ${effectiveMissingRunItems.join(", ")}` : "Run simulation"}
            aria-label={solverRunning ? "Running…" : "Run simulation"}
          >
            <span aria-hidden="true">▶</span><span className="topbar-action-label">{solverRunning ? "Running…" : "Run simulation"}</span>
          </button>
        ) : null}
        <button className="secondary topbar-action" type="button" onClick={handleSaveProject} title="Save project to local disk" aria-label="Save project">
          <Save size={16} aria-hidden="true" />
          <span className="topbar-action-label">Save project</span>
        </button>
      </header>
    );
  }

  if (shouldShowStartScreen({ homeRequested, hasProject: Boolean(project), hasDisplayModel: Boolean(displayModel), hasStudy: Boolean(study) }) || !project || !displayModel || !displayModelForUi) {
    return <StartScreen onLoadSample={handleLoadSample} onCreateProject={handleCreateProject} onOpenProject={handleOpenProject} />;
  }

  if (project && displayModel && displayModelForUi && !study) {
    return (
      <div className={`app-shell theme-${themeMode} simulation-type-shell ${isStepbarCollapsed ? "stepbar-collapsed" : ""}`}>
        {renderTopbar(false)}
        <CreateSimulationScreen
          onCreateStatic={handleCreateStaticSimulation}
          onCreateDynamic={handleCreateDynamicSimulation}
        />
        <BottomPanel status={status} logs={logs} projectName={project.name} studyName="No simulation" meshStatus="Not generated" solverStatus="Idle" backendStatus="core" onClearLogs={clearLogs} />
      </div>
    );
  }

  if (!study) return null;

  return (
    <div className={`app-shell theme-${themeMode} ${isStepbarCollapsed ? "stepbar-collapsed" : ""}`}>
      <a className="skip-link" href="#workspace-main">Skip to main content</a>
      <h1 className="visually-hidden">{project?.name ? `OpenCAE — ${project.name}` : "OpenCAE workspace"}</h1>
      {renderTopbar(true)}

      <main className="workspace" id="workspace-main" tabIndex={-1}>
        <StepBar
          activeStep={activeStep}
          collapsed={isStepbarCollapsed}
          project={project}
          themeMode={themeMode}
          onSelect={handleStepSelect}
          onToggleCollapsed={() => setIsStepbarCollapsed((collapsed) => !collapsed)}
          onToggleTheme={() => setThemeMode((mode) => (mode === "dark" ? "light" : "dark"))}
          onUnitSystemChange={handleUnitSystemChange}
          study={study}
          hasResults={viewMode === "results" || resultFields.length > 0}
        />
        <Suspense fallback={<section className="viewer-shell viewer-loading" aria-label="3D CAD viewer loading">Loading viewer…</section>}>
          <CadViewer
            displayModel={displayModelForUi}
            activeStep={activeStep}
            selectedFaceId={selectedFaceId}
            payloadObjectSelectionMode={Boolean(study && activeStep === "loads" && draftLoadType === "gravity")}
            selectedPayloadObject={selectedPayloadObject}
            onViewerMiss={handleViewerMiss}
            onSelectFace={handleViewportFaceSelect}
            viewMode={viewMode}
            resultMode={resultMode}
            showDeformed={showDeformed}
            resultPlaybackPlaying={resultPlaybackPlaying}
            showDimensions={showDimensions}
            stressExaggeration={stressExaggeration}
            resultFields={visibleResultFieldsForUi}
            surfaceMesh={resultSurfaceMesh}
            resultPlaybackBufferCache={resultPlaybackBufferCacheForViewer}
            resultPlaybackFrameController={resultPlaybackPlaying ? resultPlaybackFrameControllerRef.current : undefined}
            meshSummary={solverMeshSummary ?? study.meshSettings.summary}
            unitSystem={displayUnitSystem}
            themeMode={themeMode}
            fitSignal={fitSignal}
            viewAxis={viewAxis}
            viewAxisSignal={viewAxisSignal}
            loadMarkers={loadMarkers}
            supportMarkers={supportMarkers}
            printLayerOrientation={printLayerOrientation}
            onMeasureDisplayModelDimensions={handleMeasureDisplayModelDimensions}
            onResultRenderBoundsChange={setResultRenderBounds}
            onViewerInteractionChange={handleViewerInteractionChange}
            onRegisterCapture={handleRegisterViewerCapture}
          />
        </Suspense>
        <RightPanel
          activeStep={activeStep}
          project={project}
          displayModel={displayModelForUi}
          study={study}
          selectedFace={selectedFace}
          viewMode={viewMode}
          resultMode={resultMode}
          showDeformed={showDeformed}
          showDimensions={showDimensions}
          stressExaggeration={stressExaggeration}
          resultSummary={resultSummaryForUi}
          resultFields={resultFieldsForUi}
          runProgress={runProgress}
          runError={runError}
          runTiming={runTiming}
          onGenerateReport={handleGenerateReport}
          reportBusy={reportBusy}
          reportError={reportError}
          reportDisabled={solverRunning}
          sampleModel={sampleModel}
          sampleAnalysisType={sampleAnalysisType}
          draftLoadType={draftLoadType}
          draftLoadValue={draftLoadValue}
          draftLoadDirection={draftLoadDirection}
          selectedLoadPoint={selectedLoadPoint}
          selectedPayloadObject={selectedPayloadObject}
          onFitView={handleFitDefaultView}
          onRotateModel={handleRotateModel}
          onResetModelOrientation={handleResetModelOrientation}
          onLoadSample={handleLoadSample}
          onUploadModel={handleUploadModel}
          onRepairModel={() => void handleRepairModel()}
          isRepairingModel={isRepairingModel}
          onSampleModelChange={handleLoadSample}
          onSampleAnalysisTypeChange={(analysisType) => void handleLoadSample(sampleModel, analysisType)}
          onViewModeChange={setViewMode}
          onResultModeChange={setResultMode}
          onToggleDeformed={() => setShowDeformed((value) => !value)}
          onToggleDimensions={() => setShowDimensions((value) => !value)}
          onStressExaggerationChange={setStressExaggeration}
          onAssignMaterial={(materialId, parameters) =>
            updateStudy(assignMaterial(study.id, materialId, parameters, study), shouldAutoAdvanceAfterMaterialAssignment() ? "supports" : undefined)
          }
          onPreviewPrintLayerOrientation={setPreviewPrintLayerOrientation}
          onAddSupport={(selectionRef) => updateStudy(addSupport(study.id, selectionRef, study))}
          onUpdateSupport={(support: Constraint) =>
            updateStudy(
              saveStudyPatch(
                study.id,
                { constraints: study.constraints.map((item) => (item.id === support.id ? support : item)) },
                "Support updated.",
                study
              )
            )
          }
          onRemoveSupport={(supportId) =>
            updateStudy(saveStudyPatch(study.id, { constraints: study.constraints.filter((item) => item.id !== supportId) }, "Support removed.", study))
          }
          onDraftLoadTypeChange={(type) => {
            setDraftLoadType(type);
          }}
          onDraftLoadValueChange={(value) => {
            setDraftLoadValue(value);
          }}
          onDraftLoadDirectionChange={(direction) => {
            setDraftLoadDirection(direction);
          }}
          onAddLoad={(type, value, selectionRef, direction, payloadMetadata = {}) => {
            const selection = study.namedSelections.find((item) => item.id === selectionRef);
            const faceId = selection?.geometryRefs[0]?.entityId;
            const payloadObject = type === "gravity" ? selectedPayloadObject : null;
            const fallbackPayloadFace = payloadObject ? faceForPayloadObject(payloadObject) : null;
            const face = selectedFace?.id === faceId || (!selection && selectedFace) ? selectedFace : displayModel.faces.find((item) => item.id === faceId) ?? fallbackPayloadFace;
            if (!face) return;
            const applicationPoint = type === "gravity" && payloadObject ? payloadObject.center : selectedLoadPoint;
            if (type !== "gravity" && !applicationPoint) {
              pushMessage("Select a point on the model before adding a load.");
              return;
            }
            if (selection) {
              updateStudy(addLoad(study.id, type, value, selection.id, directionVectorForLabel(direction, face, displayModel ?? undefined), applicationPoint, payloadObject, study, payloadMetadata, direction));
              setSelectedLoadPoint(null);
              if (type === "gravity") setSelectedPayloadObject(null);
              return;
            }
            void addLoadForFace(type, value, face, direction, applicationPoint, payloadObject, payloadMetadata);
            setSelectedLoadPoint(null);
            if (type === "gravity") setSelectedPayloadObject(null);
          }}
          onDraftPayloadPreviewChange={setDraftPayloadPreview}
          onUpdateLoad={(load: Load) =>
            updateStudy(
              saveStudyPatch(study.id, { loads: study.loads.map((item) => (item.id === load.id ? load : item)) }, "Load updated.", study)
            )
          }
          onPreviewLoadEdit={setPreviewLoadEdit}
          onRemoveLoad={(loadId) =>
            updateStudy(saveStudyPatch(study.id, { loads: study.loads.filter((item) => item.id !== loadId) }, "Load removed.", study))
          }
          onGenerateMesh={handleGenerateMesh}
          meshPhaseProgress={meshPhaseProgress}
          onUpdateSolverSettings={handleUpdateSolverSettings}
          onChangeStudyType={handleChangeStudyType}
          onRunSimulation={handleRunSimulation}
          onCancelSimulation={handleCancelSimulation}
          canCancelSimulation={solverRunning}
          canRunSimulation={effectiveCanRunSimulation}
          missingRunItems={effectiveMissingRunItems}
          resultFrameIndex={resultFrameIndex}
          resultFramePosition={resultVisualFramePosition}
          resultFrameOrdinalPosition={resultVisualOrdinalPosition}
          onResultFrameChange={handleResultFrameChange}
          resultPlaybackPlaying={resultPlaybackPlaying}
          resultPlaybackFps={resultPlaybackFps}
          resultPlaybackReverseLoop={resultPlaybackReverseLoop}
          resultPlaybackCacheLabel={resultPlaybackCacheLabel}
          onResultPlaybackToggle={handleResultPlaybackToggle}
          onResultPlaybackFpsChange={setResultPlaybackFps}
          onResultPlaybackReverseLoopChange={setResultPlaybackReverseLoop}
          onStepSelect={handleStepSelect}
        />
        {showBoundaryConditionMenu && study ? (
          <BoundaryConditionMenu
            open
            onSelect={handleBoundaryConditionType}
            onClose={() => setShowBoundaryConditionMenu(false)}
          />
        ) : null}
      </main>

      <BottomPanel
        status={status}
        logs={logs}
        projectName={project.name}
        studyName={study?.name ?? "No simulation"}
        meshStatus={study?.meshSettings.status === "complete" ? "Ready" : "Not generated"}
        solverStatus={solverRunning ? "Running" : runProgress >= 100 ? "Complete" : "Idle"}
        backendStatus="core"
        onClearLogs={clearLogs}
      />
    </div>
  );
}

function ProjectNameChip({ name, onRename }: { name: string; onRename: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);
  useEffect(() => {
    if (!editing) setDraftName(name);
  }, [editing, name]);

  async function commitName() {
    const nextName = draftName.trim().replace(/\s+/g, " ");
    setEditing(false);
    if (nextName) await onRename(nextName);
  }

  if (editing) {
    return (
      <input
        className="breadcrumb-chip breadcrumb-input"
        value={draftName}
        autoFocus
        onChange={(event) => setDraftName(event.currentTarget.value)}
        onBlur={() => void commitName()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commitName();
          if (event.key === "Escape") {
            setDraftName(name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button className="breadcrumb-chip breadcrumb-button" type="button" onClick={() => setEditing(true)} title="Rename project">
      {name}
    </button>
  );
}

function hasSeededBracketDemoRun(project: Project | undefined): boolean {
  const study = project?.studies[0];
  return Boolean(study?.runs.some((run) => run.id === "run-bracket-demo-seeded" && (run.resultRef || isRunResultReadyStatus(run.status))));
}

function cloneProjectSharingEmbeddedModels(project: Project): Project {
  const clone = structuredClone(project);
  // Embedded model files are immutable after upload; sharing them by reference keeps
  // undo/redo snapshots from duplicating large base64 payloads.
  clone.geometryFiles.forEach((geometry, index) => {
    const embeddedModel = project.geometryFiles[index]?.metadata.embeddedModel;
    if (embeddedModel) geometry.metadata.embeddedModel = embeddedModel;
  });
  return clone;
}

function latestCompletedRunId(study: Study | null, activeRunId: string): string | null {
  if (!study) return null;
  if (study.runs.some((run) => run.id === activeRunId && (run.resultRef || isRunResultReadyStatus(run.status)))) return activeRunId;
  const completed = [...study.runs].reverse().find((run) => run.resultRef || isRunResultReadyStatus(run.status));
  return completed?.id ?? null;
}

function runDiagnosticsMessage(study: Study, displayModel?: DisplayModel): string {
  const fidelity = solverFidelityForDiagnostics(study);
  const resolvedBackend = resolveSolverBackend(study, displayModel);
  return [
    `Run diagnostics: backend=${resolvedBackend.backend}${resolvedBackend.source === "auto" ? " (auto)" : ""}`,
    `fidelity=${fidelity}`,
    `analysis=${study.type}`,
    `materials=${study.materialAssignments.length}`,
    `supports=${study.constraints.length}`,
    `loads=${study.loads.length}`,
    `mesh=${study.meshSettings.status}`
  ].join("; ") + ".";
}

function solverFidelityForDiagnostics(study: Study): SimulationFidelity {
  const fidelity = (study.solverSettings as { fidelity?: unknown }).fidelity;
  return fidelity === "detailed" || fidelity === "ultra" || fidelity === "standard" ? fidelity : "standard";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

function timingFromRunEvent(event: RunEvent): RunTimingEstimate | null {
  const timing: RunTimingEstimate = {};
  if (typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs)) timing.elapsedMs = event.elapsedMs;
  if (typeof event.estimatedDurationMs === "number" && Number.isFinite(event.estimatedDurationMs)) timing.estimatedDurationMs = event.estimatedDurationMs;
  if (typeof event.estimatedRemainingMs === "number" && Number.isFinite(event.estimatedRemainingMs)) timing.estimatedRemainingMs = event.estimatedRemainingMs;
  return Object.keys(timing).length ? timing : null;
}

function messageWithEta(event: RunEvent): string {
  if (event.type === "complete" || event.type === "cancelled" || event.type === "error") return event.message;
  if (typeof event.estimatedRemainingMs !== "number" || !Number.isFinite(event.estimatedRemainingMs)) return event.message;
  if (event.estimatedRemainingMs <= 1500) return `${event.message} Almost done.`;
  return `${event.message} About ${formatLogDuration(event.estimatedRemainingMs)} remaining.`;
}

function formatLogDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function endpointHoldForPlaybackOrdinal(ordinalPosition: number, frameCount: number): number {
  if (!Number.isFinite(ordinalPosition) || frameCount < 2) return 0;
  const lastOrdinal = frameCount - 1;
  return ordinalPosition <= PLAYBACK_ENDPOINT_EPSILON || ordinalPosition >= lastOrdinal - PLAYBACK_ENDPOINT_EPSILON
    ? PLAYBACK_ENDPOINT_HOLD_MS
    : 0;
}

function playbackDirectionForLoopStart(ordinalPosition: number, frameCount: number, reverseLoop: boolean): PlaybackDirection {
  if (!reverseLoop || frameCount < 2) return 1;
  const lastOrdinal = frameCount - 1;
  return ordinalPosition >= lastOrdinal - PLAYBACK_ENDPOINT_EPSILON ? -1 : 1;
}

function readinessForStudy(study: Study | null) {
  return [
    { label: "Material assigned", done: Boolean(study?.materialAssignments.length) },
    { label: "Support added", done: Boolean(study?.constraints.length) },
    { label: "Load added", done: Boolean(study?.loads.length) },
    { label: "Mesh generated", done: study?.meshSettings.status === "complete" }
  ];
}

function createResultPlaybackFrameController(): MutableResultPlaybackFrameController {
  let snapshot: ReturnType<ResultPlaybackFrameController["getSnapshot"]> = null;
  const listeners = new Set<(snapshot: NonNullable<ReturnType<ResultPlaybackFrameController["getSnapshot"]>>) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    setPackedFrame(cache, framePosition) {
      const nextSnapshot = { cache, framePosition };
      snapshot = nextSnapshot;
      for (const listener of listeners) listener(nextSnapshot);
    }
  };
}

function resultFieldsSignatureForCache(fields: ResultField[]): string {
  return fields.map((field) => {
    const firstValue = field.values[0];
    const lastValue = field.values[field.values.length - 1];
    const firstSample = field.samples?.[0];
    const lastSample = field.samples?.[field.samples.length - 1];
    return [
      field.type,
      field.location,
      field.frameIndex ?? "static",
      field.timeSeconds ?? "no-time",
      field.min,
      field.max,
      field.values.length,
      field.samples?.length ?? 0,
      finiteSignatureValue(firstValue),
      finiteSignatureValue(lastValue),
      finiteSignatureValue(firstSample?.value),
      finiteSignatureValue(lastSample?.value)
    ].join(":");
  }).join("|");
}

function finiteSignatureValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? Number(value).toPrecision(8) : "na";
}

function debugResultField(field: ResultField | undefined) {
  if (!field) return null;
  return {
    type: field.type,
    location: field.location,
    min: field.min,
    max: field.max,
    values: field.values.slice(0, 5),
    sampleValues: field.samples?.slice(0, 5).map((sample) => sample.value) ?? [],
    sampleVectors: field.samples?.slice(0, 5).map((sample) => sample.vector ?? null) ?? []
  };
}

function namedSelectionForFace(study: Study, face: DisplayFace): NamedSelection {
  const bodyId = study.geometryScope[0]?.bodyId ?? "body-uploaded";
  return {
    id: `selection-${face.id}`,
    name: face.label,
    entityType: "face",
    geometryRefs: [{ bodyId, entityType: "face", entityId: face.id, label: face.label }],
    fingerprint: `${face.id}-${face.center.map((value) => value.toFixed(3)).join("-")}`
  };
}

function faceForPayloadObject(payloadObject: PayloadObjectSelection): DisplayFace {
  return {
    id: `payload-face-${payloadObject.id}`,
    label: payloadObject.label,
    color: "#4da3ff",
    center: payloadObject.center,
    normal: [0, 0, 1],
    stressValue: 0
  };
}

function defaultValueForLoadType(type: LoadType) {
  if (type === "pressure") return 100;
  if (type === "gravity") return 5;
  return 500;
}

async function saveProjectToLocalDisk(project: Project, displayModel: DisplayModel, results?: LocalResultBundle): Promise<string | null> {
  const savedAt = new Date().toISOString();
  const filename = suggestedProjectFilename(project.name);
  const savedResults = results?.fields.length ? results : undefined;
  const blob = new Blob([JSON.stringify(buildLocalProjectFile(project, displayModel, savedAt, savedResults), null, 2)], {
    type: "application/json"
  });
  const outcome = await saveBlobToDisk(blob, filename, {
    description: "OpenCAE project",
    accept: { "application/json": [".json", ".opencae"] }
  });
  return outcome === "saved" ? savedAt : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createProjectActionClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function UndoIcon() {
  return <RotateCcw size={18} aria-hidden="true" />;
}

function RedoIcon() {
  return <RotateCcw className="redo-icon" size={18} aria-hidden="true" />;
}
