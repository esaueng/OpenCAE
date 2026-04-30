import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Constraint, DisplayFace, DisplayModel, DynamicSolverSettings, Load, NamedSelection, Project, ResultField, ResultSummary, RunEvent, RunTimingEstimate, SimulationFidelity, SolverBackend, Study } from "@opencae/schema";
import { Coffee, RotateCcw, Save } from "lucide-react";
import { addLoad, addSupport, assignMaterial, cancelRun, createProject, generateMesh, getResults, importLocalProject, loadSampleProject, renameProject, runSimulation, subscribeToRun, updateStudy as saveStudyPatch, uploadModel, type SampleAnalysisType, type SampleModelId } from "./lib/api";
import { normalizePrintParameters, starterMaterials } from "@opencae/materials";
import { BottomPanel } from "./components/BottomPanel";
import { OpenCaeLogoMark } from "./components/OpenCaeLogoMark";
import { RightPanel } from "./components/RightPanel";
import { StartScreen } from "./components/StartScreen";
import { StepBar, type StepId } from "./components/StepBar";
import { BoundaryConditionMenu, CreateSimulationScreen } from "./components/SimulationWorkflow";
import type { PrintLayerOrientation, ResultMode, ResultPlaybackFrameController, ViewMode, ViewerLoadMarker, ViewerSupportMarker } from "./components/CadViewer";
import {
  createViewerLoadMarkers,
  directionVectorForLabel,
  unitsForLoadType,
  type DraftLoadPreview,
  type LoadDirectionLabel,
  type PayloadObjectSelection,
  type PayloadLoadMetadata,
  type LoadType
} from "./loadPreview";
import { resetDisplayModelOrientation, type RotationAxis } from "./modelOrientation";
import { buildLocalProjectFile, suggestedProjectFilename, type LocalResultBundle } from "./projectFile";
import { buildAutosavedWorkspace, buildAutosavedWorkspaceUiSnapshot, readAutosavedWorkspace, scheduleAutosavedUiSnapshotWrite, scheduleAutosavedWorkspaceWrite, type ThemeMode } from "./appPersistence";
import type { AutosavedWorkspace, WorkspaceUiSnapshot } from "./appPersistence";
import {
  canNavigateToStep,
  printLayerOrientationForViewer,
  shouldAutoAdvanceAfterMaterialAssignment,
  shouldAutoAdvanceAfterMeshGeneration,
  shouldShowStartScreen
} from "./appShellState";
import { displayModelForUnits, loadValueForUnits, resultFieldForUnits, resultSummaryForUnits, type UnitSystem } from "./unitDisplay";
import { supportDisplayLabel } from "./supportLabels";
import { nextSelectedPayloadObject, shouldClearPayloadSelectionOnViewerMiss } from "./payloadSelection";
import { createLocalDynamicStructuralStudy, createLocalStaticStressStudy } from "./localProjectFactory";
import { createPackedResultPlaybackCache, createResultFrameCache, hasDynamicPlaybackFrames } from "./resultFields";
import { packResultFieldsForPlayback, packedPreparedPlaybackFrameOrdinal, playbackFieldsForResultMode, playbackMemoryBudgetBytes, type PackedPreparedPlaybackCache, type PreparedPlaybackFrameCache } from "./resultPlaybackCache";
import {
  boundedPlaybackOrdinalDelta,
  frameIndexForPlaybackOrdinal,
  loopedPlaybackOrdinalPosition,
  playbackOrdinalForSolverFramePosition,
  solverFramePositionForPlaybackOrdinal
} from "./resultPlaybackTimeline";
import { preparePlaybackFramesInWorker } from "./workers/performanceClient";
import type { WorkspaceInitialAction } from "./App";

const lazyCadViewerImport = () => import("./components/CadViewer").then((module) => ({ default: module.CadViewer }));
const CadViewer = lazy(lazyCadViewerImport);
const DEBUG_RESULT_PARAMS = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const DEBUG_RESULTS = import.meta.env.DEV && DEBUG_RESULT_PARAMS.get("debugResults") === "1";
const DEBUG_RESULT_FRAME_CACHE_ONLY = DEBUG_RESULTS && DEBUG_RESULT_PARAMS.get("bypassPacked") === "1";

interface SaveFilePickerHandle {
  createWritable: () => Promise<{ write: (content: Blob) => Promise<void>; close: () => Promise<void> }>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<SaveFilePickerHandle>;
}

const seededSummary: ResultSummary = {
  maxStress: 142,
  maxStressUnits: "MPa",
  maxDisplacement: 0.184,
  maxDisplacementUnits: "mm",
  safetyFactor: 1.8,
  reactionForce: 500,
  reactionForceUnits: "N"
};
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const PLAYBACK_UI_COMMIT_INTERVAL_MS = 250;
const PLAYBACK_CACHE_PREP_FPS = 30;
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
  const [showDeformed, setShowDeformed] = useState(restoredUi?.showDeformed ?? false);
  const [showDimensions, setShowDimensions] = useState(restoredUi?.showDimensions ?? false);
  const [stressExaggeration, setStressExaggeration] = useState(restoredUi?.stressExaggeration ?? 1.8);
  const [fitSignal, setFitSignal] = useState(0);
  const [viewAxis, setViewAxis] = useState<RotationAxis | null>(null);
  const [viewAxisSignal, setViewAxisSignal] = useState(0);
  const [status, setStatus] = useState(restoredUi?.status ?? (restoredProjectFile ? "Workspace restored after reload." : "Ready"));
  const [logs, setLogs] = useState<string[]>(restoredUi?.logs.length ? restoredUi.logs : restoredProjectFile ? ["Workspace restored after reload.", "Ready | Local Mode"] : ["Ready | Local Mode"]);
  const [runProgress, setRunProgress] = useState(restoredUi?.runProgress ?? (restoredResults?.fields.length ? 100 : 0));
  const [runTiming, setRunTiming] = useState<RunTimingEstimate | null>(null);
  const [activeRunId, setActiveRunId] = useState(restoredUi?.activeRunId || restoredResults?.activeRunId || restoredResults?.completedRunId || "run-bracket-demo-seeded");
  const [completedRunId, setCompletedRunId] = useState(restoredUi?.completedRunId || restoredResults?.completedRunId || "run-bracket-demo-seeded");
  const [processingRunId, setProcessingRunId] = useState<string | null>(null);
  const [resultSummary, setResultSummary] = useState<ResultSummary>(restoredResults?.summary ?? seededSummary);
  const [resultFields, setResultFields] = useState<ResultField[]>(restoredResults?.fields ?? []);
  const [resultFrameIndex, setResultFrameIndex] = useState(0);
  const [resultPlaybackFramePosition, setResultPlaybackFramePosition] = useState(0);
  const [resultPlaybackOrdinalPosition, setResultPlaybackOrdinalPosition] = useState(0);
  const [resultPlaybackPlaying, setResultPlaybackPlaying] = useState(false);
  const [resultPlaybackFps, setResultPlaybackFps] = useState(12);
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
  const didRequestRestoredHomeView = useRef(false);
  const activeRunSourceRef = useRef<EventSource | null>(null);
  const processingRunIdRef = useRef<string | null>(null);
  const resultFrameIndexRef = useRef(0);
  const resultPlaybackFramePositionRef = useRef(0);
  const resultPlaybackOrdinalPositionRef = useRef(0);
  const resultPlaybackFrameControllerRef = useRef<MutableResultPlaybackFrameController | null>(null);
  const viewerInteractingRef = useRef(false);
  const initialActionConsumedRef = useRef(false);
  if (!resultPlaybackFrameControllerRef.current) {
    resultPlaybackFrameControllerRef.current = createResultPlaybackFrameController();
  }

  const study = project?.studies[0] ?? null;
  const assignedPrintLayerOrientation = useMemo<PrintLayerOrientation | null>(() => {
    const assignment = study?.materialAssignments[0];
    if (!assignment) return null;
    const material = starterMaterials.find((candidate) => candidate.id === assignment.materialId);
    if (!material?.printProfile) return null;
    const parameters = normalizePrintParameters(material, assignment.parameters ?? {});
    return parameters.printed ? parameters.layerOrientation ?? "z" : null;
  }, [study?.materialAssignments]);
  const printLayerOrientation = printLayerOrientationForViewer(assignedPrintLayerOrientation, previewPrintLayerOrientation);
  const selectedFace = useMemo(() => displayModel?.faces.find((face) => face.id === selectedFaceId) ?? null, [displayModel, selectedFaceId]);
  const displayUnitSystem = project?.unitSystem ?? "SI";
  const displayModelForUi = useMemo(() => displayModel ? displayModelForUnits(displayModel, displayUnitSystem) : null, [displayModel, displayUnitSystem]);
  const resultSummaryForUi = useMemo(() => resultSummaryForUnits(resultSummary, displayUnitSystem), [displayUnitSystem, resultSummary]);
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
    resultFrameCache.frameIndexes.join(",")
  ].join("|"), [activeRunId, completedRunId, displayModelForUi, displayUnitSystem, resultFieldsSignature, resultFrameCache.frameIndexes, resultMode, showDeformed, stressExaggeration, study?.meshSettings.preset]);
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
  const runReadiness = useMemo(() => readinessForStudy(study), [study]);
  const canRunSimulation = runReadiness.every((item) => item.done) && !solverRunning;
  const missingRunItems = runReadiness.filter((item) => !item.done).map((item) => item.label);
  const canUndoAction = undoStack.length > 0;
  const canRedoAction = redoStack.length > 0;

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
    setResultPlaybackFramePosition(nextFramePosition);
    setResultPlaybackOrdinalPosition(nextOrdinalPosition);
  }, [playbackFrameIndexes]);

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
    const advancePlaybackFrame = (timestamp: number) => {
      if (lastTimestamp !== null) {
        const frameDelta = boundedPlaybackOrdinalDelta(timestamp - lastTimestamp, frameDurationMs);
        ordinalPosition = loopedPlaybackOrdinalPosition(playbackFrameIndexes.length, ordinalPosition + frameDelta);
        const framePosition = solverFramePositionForPlaybackOrdinal(playbackFrameIndexes, ordinalPosition);
        resultPlaybackFramePositionRef.current = framePosition;
        resultPlaybackOrdinalPositionRef.current = ordinalPosition;
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
  }, [activeStep, commitPlaybackViewerFrame, playbackFrameIndexes, resultPlaybackFps, resultPlaybackPlaying]);

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
  }, [playbackFrameIndexes]);

  function handleResultPlaybackToggle() {
    setResultPlaybackPlaying((playing) => {
      if (!playing) setShowDeformed(true);
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
          direction: directionVectorForLabel(draftLoadDirection, face),
          applicationPoint: point,
          ...(isPayloadMass && selectedPayloadObject ? { payloadObject: selectedPayloadObject } : {}),
          ...payloadMetadata
        },
        status: "complete"
      }
    };
  }, [activeStep, draftLoadDirection, draftLoadType, draftLoadValue, draftPayloadPreview, selectedFace, selectedLoadPoint, selectedPayloadObject, study]);

  const loadMarkers = useMemo<ViewerLoadMarker[]>(() => {
    const markers = createViewerLoadMarkers({ study, loadPreviews: previewLoadEdit ? [previewLoadEdit] : [], draftLoadPreview });
    return markers.map((marker) => {
      const converted = loadValueForUnits(marker.value, marker.units, displayUnitSystem);
      return { ...marker, value: converted.value, units: converted.units };
    });
  }, [displayUnitSystem, draftLoadPreview, previewLoadEdit, study]);
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

  useEffect(() => {
    if (!project || !displayModel) return;
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveProject();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedoAction();
        } else {
          handleUndoAction();
        }
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [displayModel, project, undoStack, redoStack]);

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

  useEffect(() => {
    if (!project || !displayModel) return;
    return scheduleAutosavedUiSnapshotWrite(
      () => buildAutosavedWorkspaceUiSnapshot(autosaveUiSnapshot),
      undefined,
      AUTOSAVE_UI_WRITE_DELAY_MS
    );
  }, [autosaveUiSnapshot, displayModel, project]);

  useEffect(() => {
    if (!project || !displayModel) return;
    return scheduleAutosavedWorkspaceWrite(() => buildAutosavedWorkspace({
      project,
      displayModel,
      results: resultFields.length ? {
        activeRunId,
        completedRunId,
        summary: resultSummary,
        fields: resultFields
      } : undefined,
      ui: autosaveUiSnapshot
    }), undefined, AUTOSAVE_HEAVY_WRITE_DELAY_MS);
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
    resultSummary,
    runProgress,
    sampleAnalysisType,
    sampleModel,
    selectedFaceId,
    selectedLoadPoint,
    selectedPayloadObject,
    showDeformed,
    showDimensions,
    themeMode,
    undoStack,
    viewMode
  ]);

  async function openProjectResponse(
    action: Promise<{ project: Project; displayModel: DisplayModel; message?: string; results?: LocalResultBundle }>,
    options?: { nextStep?: StepId }
  ) {
    const response = await action;
    setHomeRequested(false);
    setProject(response.project);
    setDisplayModel(response.displayModel);
    requestDefaultHomeView();
    setUndoStack([]);
    setRedoStack([]);
    setSelectedLoadPoint(null);
    setSelectedPayloadObject(null);
    if (response.results?.fields.length) {
      setResultSummary(response.results.summary);
      setResultFields(response.results.fields);
      setResultFrameIndex(0);
      const restoredRunId = response.results.completedRunId ?? response.results.activeRunId ?? latestCompletedRunId(response.project.studies[0] ?? null, "") ?? "";
      setActiveRunId(response.results.activeRunId ?? restoredRunId);
      setCompletedRunId(restoredRunId);
      setRunProgress(100);
      if (options?.nextStep) {
        applyStep(options.nextStep);
        setViewMode("model");
      } else {
        setViewMode("results");
        setActiveStep("results");
      }
    } else {
      applyStep("model");
      setViewMode("model");
      setResultFields([]);
      setResultFrameIndex(0);
      setRunProgress(0);
      const nextCompletedRunId = latestCompletedRunId(response.project.studies[0] ?? null, "") ?? "";
      setActiveRunId(nextCompletedRunId);
      setCompletedRunId(nextCompletedRunId);
    }
    pushMessage(response.message ?? "Project opened.");
  }

  async function handleLoadSample(nextSample = sampleModel, nextAnalysisType = sampleAnalysisType) {
    setSampleModel(nextSample);
    setSampleAnalysisType(nextAnalysisType);
    await openProjectResponse(loadSampleProject(nextSample, nextAnalysisType), { nextStep: "model" });
  }

  function handleCreateProject() {
    void openProjectResponse(createProject());
  }

  function handleOpenProject(file: File) {
    void openProjectResponse(importLocalProject(file)).catch((error: unknown) => {
      pushMessage(error instanceof Error ? error.message : "Could not open local project.");
    });
  }

  function handleUploadModel(file: File) {
    if (!project) return;
    void openProjectResponse(uploadModel(project.id, file, project)).catch((error: unknown) => {
      pushMessage(error instanceof Error ? error.message : "Could not upload model.");
    });
  }

  async function handleSaveProject() {
    if (!project || !displayModel) return;
    try {
      const savedAt = await saveProjectToLocalDisk(project, displayModel, {
        activeRunId,
        completedRunId,
        summary: resultSummary,
        fields: resultFields
      });
      setProject({ ...project, updatedAt: savedAt });
      pushMessage("Project saved to local disk.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      pushMessage(error instanceof Error ? error.message : "Could not save project.");
    }
  }

  function pushMessage(message: string) {
    setStatus(message);
    setLogs((current) => [message, ...current].slice(0, 32));
  }

  async function updateStudy(action: Promise<{ study: Study; message: string }>, nextStep?: StepId) {
    const response = await action;
    if (project) {
      recordUndoSnapshot(project);
      setProject({ ...project, studies: project.studies.map((item) => (item.id === response.study.id ? response.study : item)) });
    }
    pushMessage(response.message);
    if (nextStep) navigateToStep(nextStep);
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
      parameters: { value, units: unitsForLoadType(type), direction: directionVectorForLabel(direction, face), ...(applicationPoint ? { applicationPoint } : {}), ...(payloadObject ? { payloadObject } : {}), ...(type === "gravity" ? payloadMetadata : {}) },
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
    setUndoStack((history) => [...history, structuredClone(snapshot)].slice(-30));
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
    setActiveRunId("");
    setRunProgress(0);
    setResultFields([]);
    setResultFrameIndex(0);
    setResultPlaybackFramePosition(0);
    setResultPlaybackPlaying(false);
  }

  function handleUpdateSolverSettings(settings: Partial<DynamicSolverSettings> & { backend?: SolverBackend; fidelity?: SimulationFidelity }) {
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

  function normalizedDynamicSolverSettings(
    currentSettings: DynamicSolverSettings,
    mergedSettings: DynamicSolverSettings & { backend?: SolverBackend; fidelity?: SimulationFidelity },
    patch: Partial<DynamicSolverSettings>
  ) {
    return {
      ...mergedSettings,
      outputInterval: Math.max(
        patch.outputInterval ?? currentSettings.outputInterval,
        mergedSettings.timeStep,
        MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS
      )
    };
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
    setRedoStack([...redoStack, structuredClone(project)]);
    setProject(structuredClone(previous));
    void persistProjectSnapshot(previous, "Undo applied.");
  }

  function handleRedoAction() {
    if (!project || !canRedoAction) return;
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, structuredClone(project)].slice(-30));
    setProject(structuredClone(next));
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
    if (!canRunSimulation) {
      pushMessage(missingRunItems.length ? `Complete before running: ${missingRunItems.join(", ")}.` : "Simulation is already running.");
      return;
    }
    setResultPlaybackPlaying(false);
    const response = await runSimulation(study.id, study, displayModel ?? undefined);
    setActiveRunId(response.run.id);
    setCompletedRunId("");
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
            pushMessage("Cloud FEA dynamic results did not include animation frames.");
            setResultPlaybackPlaying(false);
            setRunProgress(0);
            return;
          }
          setResultSummary(results.summary);
          setResultFields(results.fields);
          setResultFrameIndex(0);
          setResultPlaybackPlaying(false);
          if (study.type === "dynamic_structural") setResultMode("stress");
          setCompletedRunId(response.run.id);
          setViewMode("results");
          setActiveStep("results");
        } catch (error) {
          pushMessage(error instanceof Error ? error.message : "Could not load simulation results.");
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

  function renderTopbar(showRunButton: boolean) {
    if (!project) return null;
    return (
      <header className="topbar">
        <button className="brand brand-button" type="button" onClick={handleOpenStartMenu} title="Back to start menu" aria-label="Back to start menu">
          <OpenCaeLogoMark />OpenCAE <span className="beta-tag">beta</span>
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
        </div>
        <a className="secondary topbar-action donate-action donate-action-intro" href="https://ko-fi.com/petergustafson" target="_blank" rel="noreferrer" title="Support OpenCAE on Ko-fi">
          <Coffee size={16} aria-hidden="true" />
          <span>Buy me a coffee</span>
        </a>
        {showRunButton ? (
          <button
            className={`primary topbar-action ${solverRunning ? "running" : ""}`}
            onClick={handleRunSimulation}
            disabled={!canRunSimulation}
            title={missingRunItems.length ? `Complete before running: ${missingRunItems.join(", ")}` : "Run simulation"}
          >
            <span aria-hidden="true">▶</span>{solverRunning ? "Running…" : "Run simulation"}
          </button>
        ) : null}
        <button className="secondary topbar-action" type="button" onClick={handleSaveProject} title="Save project to local disk">
          <Save size={16} aria-hidden="true" />
          Save project
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
        <BottomPanel status={status} logs={logs} projectName={project.name} studyName="No simulation" meshStatus="Not generated" solverStatus="Idle" />
      </div>
    );
  }

  if (!study) return null;

  return (
    <div className={`app-shell theme-${themeMode} ${isStepbarCollapsed ? "stepbar-collapsed" : ""}`}>
      {renderTopbar(true)}

      <main className="workspace">
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
            resultPlaybackBufferCache={resultPlaybackBufferCacheForViewer}
            resultPlaybackFrameController={resultPlaybackPlaying ? resultPlaybackFrameControllerRef.current : undefined}
            meshSummary={study.meshSettings.summary}
            unitSystem={displayUnitSystem}
            themeMode={themeMode}
            fitSignal={fitSignal}
            viewAxis={viewAxis}
            viewAxisSignal={viewAxisSignal}
            loadMarkers={loadMarkers}
            supportMarkers={supportMarkers}
            printLayerOrientation={printLayerOrientation}
            onResetView={handleFitDefaultView}
            onMeasureDisplayModelDimensions={handleMeasureDisplayModelDimensions}
            onViewerInteractionChange={handleViewerInteractionChange}
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
          runTiming={runTiming}
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
              updateStudy(addLoad(study.id, type, value, selection.id, directionVectorForLabel(direction, face), applicationPoint, payloadObject, study, payloadMetadata));
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
          onGenerateMesh={(preset) => updateStudy(generateMesh(study.id, preset, study, displayModel), shouldAutoAdvanceAfterMeshGeneration() ? "run" : undefined)}
          onUpdateSolverSettings={handleUpdateSolverSettings}
          onRunSimulation={handleRunSimulation}
          onCancelSimulation={handleCancelSimulation}
          canCancelSimulation={solverRunning}
          canRunSimulation={canRunSimulation}
          missingRunItems={missingRunItems}
          resultFrameIndex={resultFrameIndex}
          resultFramePosition={resultVisualFramePosition}
          resultFrameOrdinalPosition={resultVisualOrdinalPosition}
          onResultFrameChange={handleResultFrameChange}
          resultPlaybackPlaying={resultPlaybackPlaying}
          resultPlaybackFps={resultPlaybackFps}
          resultPlaybackCacheLabel={resultPlaybackCacheLabel}
          onResultPlaybackToggle={handleResultPlaybackToggle}
          onResultPlaybackFpsChange={setResultPlaybackFps}
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

      <BottomPanel status={status} logs={logs} projectName={project.name} studyName={study?.name ?? "No simulation"} meshStatus={study?.meshSettings.status === "complete" ? "Ready" : "Not generated"} solverStatus={solverRunning ? "Running" : runProgress >= 100 ? "Complete" : "Idle"} />
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

function latestCompletedRunId(study: Study | null, activeRunId: string): string | null {
  if (!study) return null;
  if (study.runs.some((run) => run.id === activeRunId && (run.resultRef || run.status === "complete"))) return activeRunId;
  const completed = [...study.runs].reverse().find((run) => run.resultRef || run.status === "complete");
  return completed?.id ?? null;
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

async function saveProjectToLocalDisk(project: Project, displayModel: DisplayModel, results?: LocalResultBundle): Promise<string> {
  const savedAt = new Date().toISOString();
  const filename = suggestedProjectFilename(project.name);
  const savedResults = results?.fields.length ? results : undefined;
  const blob = new Blob([JSON.stringify(buildLocalProjectFile(project, displayModel, savedAt, savedResults), null, 2)], {
    type: "application/json"
  });
  const savePicker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (savePicker) {
    const handle = await savePicker({
      suggestedName: filename,
      types: [{ description: "OpenCAE project", accept: { "application/json": [".json", ".opencae"] } }]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return savedAt;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return savedAt;
}

function UndoIcon() {
  return <RotateCcw size={18} aria-hidden="true" />;
}

function RedoIcon() {
  return <RotateCcw className="redo-icon" size={18} aria-hidden="true" />;
}
