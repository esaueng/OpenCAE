import {
  ProjectSchema,
  ResultFieldSchema,
  ResultSummarySchema,
  type DisplayFace,
  type DisplayModel,
  type Project
} from "@opencae/schema";
import { BRACKET_GEOMETRY_MIGRATION_NOTE, refreshBracketSampleGeometry } from "./bracketGeometryMigration";
import { buildLocalProjectFile, type EmbeddedModelFile, type LocalProjectFile, type LocalResultBundle } from "./projectFile";
import { LOAD_DIRECTION_LABELS, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType } from "./loadPreview";
import { AUTOSAVE_STORAGE_KEY, AUTOSAVE_UI_STORAGE_KEY, getBrowserStorage, readStorageItem, type StorageLike } from "./autosaveStorage";
import type { WorkspaceLogEntry } from "./components/BottomPanel";
import type { StepId } from "./components/StepBar";
import type { SampleAnalysisType, SampleModelId } from "./lib/api";
import type { CapturedResultView } from "./report/captureResultViews";
import type { PayloadObjectSelection, ResultMode, StressComponent, ThemeMode, ViewMode } from "./workspaceViewTypes";
import type { ResultColorScaleSettings } from "./resultColorScale";

export { AUTOSAVE_STORAGE_KEY, AUTOSAVE_UI_STORAGE_KEY } from "./autosaveStorage";
export type { ThemeMode } from "./workspaceViewTypes";
export const WORKSPACE_LOG_LIMIT = 100;

export interface WorkspaceUiSnapshot {
  activeStep: StepId;
  homeRequested: boolean;
  selectedFaceId: string | null;
  selectedLoadPoint: LoadApplicationPoint | null;
  selectedPayloadObject: PayloadObjectSelection | null;
  viewMode: ViewMode;
  themeMode: ThemeMode;
  resultMode: ResultMode;
  stressComponent?: StressComponent;
  resultColorScaleSettings?: ResultColorScaleSettings;
  showDeformed: boolean;
  showDimensions: boolean;
  stressExaggeration: number;
  resultFrameIndex?: number;
  resultPlaybackFps?: number;
  resultPlaybackReverseLoop?: boolean;
  isStepbarCollapsed?: boolean;
  draftLoadType: LoadType;
  draftLoadValue: number;
  draftLoadDirection: LoadDirectionLabel;
  sampleModel: SampleModelId;
  sampleAnalysisType: SampleAnalysisType;
  activeRunId: string;
  completedRunId: string;
  runProgress: number;
  undoStack: Project[];
  redoStack: Project[];
  status: string;
  logs: WorkspaceLogEntry[];
}

export interface AutosavedWorkspace {
  version: 1;
  savedAt: string;
  projectFile: LocalProjectFile;
  ui: WorkspaceUiSnapshot;
}

export interface AutosavedWorkspaceUiSnapshot {
  version: 1;
  savedAt: string;
  ui: WorkspaceUiSnapshot;
}

interface IdleCallbackHandle {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

const STEPS: StepId[] = ["model", "material", "supports", "loads", "mesh", "run", "results"];
const VIEW_MODES: ViewMode[] = ["model", "mesh", "results"];
const RESULT_MODES: ResultMode[] = ["stress", "displacement", "safety_factor", "velocity", "acceleration"];
const STRESS_COMPONENTS: StressComponent[] = ["von_mises", "principal_max", "principal_min", "max_shear"];
const THEMES: ThemeMode[] = ["dark", "light"];
const LOAD_TYPES: LoadType[] = ["force", "pressure", "gravity"];
const LOAD_DIRECTIONS: LoadDirectionLabel[] = [...LOAD_DIRECTION_LABELS];
const SAMPLE_MODELS: SampleModelId[] = ["bracket", "plate", "cantilever"];
const SAMPLE_ANALYSIS_TYPES: SampleAnalysisType[] = ["static_stress", "dynamic_structural"];

export function buildAutosavedWorkspace({
  project,
  displayModel,
  savedAt = new Date().toISOString(),
  results,
  ui
}: {
  project: Project;
  displayModel: DisplayModel;
  savedAt?: string;
  results?: LocalResultBundle;
  ui: WorkspaceUiSnapshot;
}): AutosavedWorkspace {
  return {
    version: 1,
    savedAt,
    projectFile: buildLocalProjectFile(project, displayModel, savedAt, results?.fields.length ? results : undefined),
    ui: stripEmbeddedModelsFromUiSnapshot(normalizeUiRunState(ui))
  };
}

export function buildAutosavedWorkspaceUiSnapshot(ui: WorkspaceUiSnapshot, savedAt = new Date().toISOString()): AutosavedWorkspaceUiSnapshot {
  return {
    version: 1,
    savedAt,
    ui: stripEmbeddedModelsFromUiSnapshot(normalizeUiRunState(ui))
  };
}

export function parseAutosavedWorkspacePayload(payload: string): AutosavedWorkspace | null {
  try {
    return parseAutosavedWorkspace(JSON.parse(payload) as unknown);
  } catch {
    return null;
  }
}

export function readAutosavedWorkspace(storage = getBrowserStorage()): AutosavedWorkspace | null {
  if (!storage) return null;
  const payload = readStorageItem(storage, AUTOSAVE_STORAGE_KEY);
  const workspace = payload ? parseAutosavedWorkspacePayload(payload) : null;
  if (!workspace) return null;
  const uiPayload = readStorageItem(storage, AUTOSAVE_UI_STORAGE_KEY);
  const uiSnapshot = uiPayload ? parseAutosavedWorkspaceUiSnapshotPayload(uiPayload) : null;
  const merged = uiSnapshot && isNewerOrSameTimestamp(uiSnapshot.savedAt, workspace.savedAt) ? { ...workspace, ui: uiSnapshot.ui } : workspace;
  const ui = reattachEmbeddedModelsToUiSnapshot(merged.ui, merged.projectFile.project);
  // Autosaved Bracket Demo projects embed their solver geometry (and a mesh
  // built from it); refresh outdated descriptors so a save from before the
  // bracket fix stops solving the old wedge, and say so - never silently.
  const bracket = refreshBracketSampleGeometry(merged.projectFile.project, merged.projectFile.displayModel);
  if (!bracket.migrated) return { ...merged, ui };
  return {
    ...merged,
    projectFile: {
      ...merged.projectFile,
      project: bracket.project,
      displayModel: bracket.displayModel ?? merged.projectFile.displayModel
    },
    ui: {
      ...ui,
      // Undo entries carry the same embedded geometry and stale mesh; refresh
      // them too so undo cannot resurrect the wedge.
      undoStack: ui.undoStack.map((item) => refreshBracketSampleGeometry(item).project),
      redoStack: ui.redoStack.map((item) => refreshBracketSampleGeometry(item).project),
      status: BRACKET_GEOMETRY_MIGRATION_NOTE,
      logs: [{ message: BRACKET_GEOMETRY_MIGRATION_NOTE, at: Date.now() }, ...ui.logs].slice(0, WORKSPACE_LOG_LIMIT)
    }
  };
}

export function localRunIdForResultsRestore(workspace: AutosavedWorkspace | null): string | null {
  if (!workspace || workspace.projectFile.results?.fields.length) return null;
  const runId = workspace.ui.completedRunId || workspace.ui.activeRunId;
  return runId.startsWith("run-local-") ? runId : null;
}

export type AutosaveWriteOutcome = "full" | "slim" | "failed";

/**
 * Persist the workspace autosave. A real project (embedded CAD + stored Core
 * mesh artifact + dynamic result frames) can exceed the ~5 MB localStorage
 * quota, so a failed full write retries with a slim snapshot that keeps the
 * whole project SETUP but drops the regenerable heavyweights: the results
 * bundle (re-runnable; also persisted per run in IndexedDB) and the studies'
 * stored mesh artifacts (the run flow re-meshes when absent).
 */
export function writeAutosavedWorkspace(snapshot: AutosavedWorkspace, storage = getBrowserStorage()): AutosaveWriteOutcome {
  if (writeJsonStorageItem(AUTOSAVE_STORAGE_KEY, snapshot, storage)) return "full";
  const slim = slimAutosavedWorkspaceForQuota(snapshot);
  if (slim && writeJsonStorageItem(AUTOSAVE_STORAGE_KEY, slim, storage)) return "slim";
  return "failed";
}

function slimAutosavedWorkspaceForQuota(snapshot: AutosavedWorkspace): AutosavedWorkspace | null {
  const projectFile = snapshot.projectFile;
  const slimProject = stripHeavyMeshArtifactsFromProject(projectFile.project);
  const hasResults = Boolean(projectFile.results);
  if (!hasResults && slimProject === projectFile.project) return null; // Nothing to shed; retry would fail identically.
  const { results: _results, ...projectFileWithoutResults } = projectFile;
  return {
    ...snapshot,
    projectFile: { ...projectFileWithoutResults, project: slimProject }
  };
}

export function writeAutosavedUiSnapshot(snapshot: AutosavedWorkspaceUiSnapshot, storage = getBrowserStorage()): boolean {
  return writeJsonStorageItem(AUTOSAVE_UI_STORAGE_KEY, snapshot, storage);
}

export function flushAutosavedWorkspace(
  workspace: AutosavedWorkspace,
  uiSnapshot: AutosavedWorkspaceUiSnapshot,
  storage = getBrowserStorage()
): { workspace: AutosaveWriteOutcome; ui: boolean } {
  return {
    ui: writeAutosavedUiSnapshot(uiSnapshot, storage),
    workspace: writeAutosavedWorkspace(workspace, storage)
  };
}

export function scheduleAutosavedWorkspaceWrite(
  snapshot: AutosavedWorkspace | (() => AutosavedWorkspace),
  storage = getBrowserStorage(),
  delayMs = 5000,
  onWriteFailed?: () => void,
  onWriteDegraded?: () => void
): () => void {
  return scheduleStorageWrite(
    () => {
      const outcome = writeAutosavedWorkspace(readSnapshot(snapshot), storage);
      if (outcome === "slim") onWriteDegraded?.();
      return outcome !== "failed";
    },
    storage,
    delayMs,
    onWriteFailed
  );
}

export function scheduleAutosavedUiSnapshotWrite(
  snapshot: AutosavedWorkspaceUiSnapshot | (() => AutosavedWorkspaceUiSnapshot),
  storage = getBrowserStorage(),
  delayMs = 650,
  onWriteFailed?: () => void
): () => void {
  return scheduleStorageWrite(() => writeAutosavedUiSnapshot(readSnapshot(snapshot), storage), storage, delayMs, onWriteFailed);
}

function stripEmbeddedModelsFromUiSnapshot(ui: WorkspaceUiSnapshot): WorkspaceUiSnapshot {
  const undoStack = ui.undoStack.map(stripEmbeddedModelsFromProject);
  const redoStack = ui.redoStack.map(stripEmbeddedModelsFromProject);
  const unchanged = undoStack.every((item, index) => item === ui.undoStack[index]) && redoStack.every((item, index) => item === ui.redoStack[index]);
  return unchanged ? ui : { ...ui, undoStack, redoStack };
}

function stripEmbeddedModelsFromProject(project: Project): Project {
  const withoutModels = project.geometryFiles.some((geometry) => geometry.metadata.embeddedModel)
    ? {
        ...project,
        geometryFiles: project.geometryFiles.map((geometry) => {
          if (!geometry.metadata.embeddedModel) return geometry;
          const { embeddedModel: _embeddedModel, ...metadata } = geometry.metadata;
          return { ...geometry, metadata };
        })
      }
    : project;
  // Undo/redo snapshots also carry each study's stored Core-model artifact
  // (hundreds of KB per real mesh); a handful of undo entries can exceed the
  // localStorage quota on their own. The artifact is regenerable (the run
  // flow re-meshes when it is absent), so history never needs it.
  return stripHeavyMeshArtifactsFromProject(withoutModels);
}

/** Drop regenerable multi-hundred-KB mesh artifacts (Core model / volume mesh) from every study. */
function stripHeavyMeshArtifactsFromProject(project: Project): Project {
  const studies = project.studies.map((study) => {
    const artifacts = study.meshSettings.summary?.artifacts as Record<string, unknown> | undefined;
    if (!artifacts || (!artifacts.actualCoreModel && !artifacts.coreModel && !artifacts.volumeMesh)) return study;
    const { actualCoreModel: _actual, coreModel: _core, volumeMesh: _volume, ...lightArtifacts } = artifacts;
    return {
      ...study,
      meshSettings: {
        ...study.meshSettings,
        summary: { ...study.meshSettings.summary!, artifacts: lightArtifacts }
      }
    };
  });
  return studies.every((study, index) => study === project.studies[index]) ? project : { ...project, studies };
}

function reattachEmbeddedModelsToUiSnapshot(ui: WorkspaceUiSnapshot, project: Project): WorkspaceUiSnapshot {
  const embeddedModelsByGeometryId = new Map<string, EmbeddedModelFile>(
    project.geometryFiles.flatMap((geometry) => {
      const embeddedModel = geometry.metadata.embeddedModel;
      return isEmbeddedModelFile(embeddedModel) ? [[geometry.id, embeddedModel] as const] : [];
    })
  );
  if (!embeddedModelsByGeometryId.size) return ui;
  const reattach = (stack: Project[]) => stack.map((item) => ({
    ...item,
    geometryFiles: item.geometryFiles.map((geometry) => {
      if (geometry.metadata.embeddedModel) return geometry;
      const embeddedModel = embeddedModelsByGeometryId.get(geometry.id);
      return embeddedModel ? { ...geometry, metadata: { ...geometry.metadata, embeddedModel } } : geometry;
    })
  }));
  return { ...ui, undoStack: reattach(ui.undoStack), redoStack: reattach(ui.redoStack) };
}

function isEmbeddedModelFile(value: unknown): value is EmbeddedModelFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.filename === "string" &&
    typeof value.contentType === "string" &&
    typeof value.size === "number" &&
    typeof value.contentBase64 === "string" &&
    value.contentBase64.length > 0
  );
}

function parseAutosavedWorkspace(value: unknown): AutosavedWorkspace | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.savedAt !== "string") return null;
  const projectFile = parseProjectFile(value.projectFile);
  const ui = parseUiSnapshot(value.ui);
  if (!projectFile || !ui) return null;
  return {
    version: 1,
    savedAt: value.savedAt,
    projectFile,
    ui
  };
}

function parseAutosavedWorkspaceUiSnapshotPayload(payload: string): AutosavedWorkspaceUiSnapshot | null {
  try {
    return parseAutosavedWorkspaceUiSnapshot(JSON.parse(payload) as unknown);
  } catch {
    return null;
  }
}

function parseAutosavedWorkspaceUiSnapshot(value: unknown): AutosavedWorkspaceUiSnapshot | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.savedAt !== "string") return null;
  const ui = parseUiSnapshot(value.ui);
  if (!ui) return null;
  return {
    version: 1,
    savedAt: value.savedAt,
    ui
  };
}

function parseProjectFile(value: unknown): LocalProjectFile | null {
  if (!isRecord(value) || value.format !== "opencae-local-project" || value.version !== 2 || typeof value.savedAt !== "string") return null;
  const project = ProjectSchema.safeParse(value.project);
  const displayModel = parseDisplayModel(value.displayModel);
  if (!project.success || !displayModel) return null;
  const results = parseResultBundle(value.results);
  return {
    format: "opencae-local-project",
    version: 2,
    savedAt: value.savedAt,
    project: project.data,
    displayModel,
    ...(results ? { results } : {})
  };
}

export function parseResultBundle(value: unknown): LocalResultBundle | undefined {
  if (!isRecord(value)) return undefined;
  const summary = ResultSummarySchema.safeParse(value.summary);
  const fields = ResultFieldSchema.array().safeParse(value.fields);
  const surfaceMesh = parseSolverSurfaceMesh(value.surfaceMesh);
  const solverMeshSummary = parseSolverMeshSummary(value.solverMeshSummary);
  const reportCaptures = parseResultViewCaptures(value.reportCaptures);
  if (!summary.success || !fields.success || fields.data.length === 0) return undefined;
  return {
    activeRunId: typeof value.activeRunId === "string" ? value.activeRunId : undefined,
    completedRunId: typeof value.completedRunId === "string" ? value.completedRunId : undefined,
    summary: summary.data,
    fields: fields.data,
    ...(surfaceMesh ? { surfaceMesh } : {}),
    ...(solverMeshSummary ? { solverMeshSummary } : {}),
    ...(reportCaptures ? { reportCaptures } : {})
  };
}

function parseResultViewCaptures(value: unknown): LocalResultBundle["reportCaptures"] | undefined {
  if (!isRecord(value)) return undefined;
  const parseCapture = (capture: unknown): CapturedResultView | undefined => {
    if (!isRecord(capture) || typeof capture.png !== "string" || !capture.png.startsWith("data:image/png;base64,")) return undefined;
    if (typeof capture.fieldId !== "string" || (capture.selection !== "peak" && capture.selection !== "static")) return undefined;
    return {
      png: capture.png,
      fieldId: capture.fieldId,
      selection: capture.selection,
      ...(typeof capture.frameIndex === "number" && Number.isInteger(capture.frameIndex) ? { frameIndex: capture.frameIndex } : {}),
      ...(typeof capture.timeSeconds === "number" && Number.isFinite(capture.timeSeconds) ? { timeSeconds: capture.timeSeconds } : {})
    };
  };
  const stress = parseCapture(value.stress);
  const displacement = parseCapture(value.displacement);
  const boundary = isRecord(value.boundary) && typeof value.boundary.png === "string" && value.boundary.png.startsWith("data:image/png;base64,")
    ? { png: value.boundary.png }
    : undefined;
  return stress || displacement || boundary
    ? { ...(stress ? { stress } : {}), ...(displacement ? { displacement } : {}), ...(boundary ? { boundary } : {}) }
    : undefined;
}

function parseSolverMeshSummary(value: unknown): LocalResultBundle["solverMeshSummary"] | undefined {
  if (!isRecord(value) || value.source !== "core_solver") return undefined;
  if (typeof value.nodes !== "number" || !Number.isInteger(value.nodes) || value.nodes <= 0) return undefined;
  if (typeof value.elements !== "number" || !Number.isInteger(value.elements) || value.elements <= 0) return undefined;
  return {
    nodes: value.nodes,
    elements: value.elements,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === "string") : [],
    source: "core_solver"
  };
}

function parseSolverSurfaceMesh(value: unknown): LocalResultBundle["surfaceMesh"] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string") return undefined;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.triangles)) return undefined;
  const nodes = value.nodes.filter(isVector3);
  const triangles = value.triangles.filter((triangle): triangle is [number, number, number] =>
    Array.isArray(triangle) &&
    triangle.length === 3 &&
    triangle.every((node) => Number.isInteger(node) && node >= 0)
  );
  if (nodes.length !== value.nodes.length || triangles.length !== value.triangles.length) return undefined;
  return {
    id: value.id,
    nodes,
    triangles,
    coordinateSpace: typeof value.coordinateSpace === "string" ? value.coordinateSpace : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    nodeMap: Array.isArray(value.nodeMap) && value.nodeMap.every((node) => Number.isInteger(node) && node >= 0)
      ? value.nodeMap
      : undefined,
    volumeNodeCount: typeof value.volumeNodeCount === "number" && Number.isFinite(value.volumeNodeCount)
      ? value.volumeNodeCount
      : undefined
  };
}

function parseUiSnapshot(value: unknown): WorkspaceUiSnapshot | null {
  if (!isRecord(value)) return null;
  return normalizeUiRunState({
    activeStep: readEnum(value.activeStep, STEPS, "model"),
    homeRequested: value.homeRequested === true,
    selectedFaceId: typeof value.selectedFaceId === "string" ? value.selectedFaceId : null,
    selectedLoadPoint: isVector3(value.selectedLoadPoint) ? value.selectedLoadPoint : null,
    selectedPayloadObject: parsePayloadObject(value.selectedPayloadObject),
    viewMode: readEnum(value.viewMode, VIEW_MODES, "model"),
    themeMode: readEnum(value.themeMode, THEMES, "dark"),
    resultMode: readEnum(value.resultMode, RESULT_MODES, "stress"),
    stressComponent: readEnum(value.stressComponent, STRESS_COMPONENTS, "von_mises"),
    resultColorScaleSettings: parseResultColorScaleSettings(value.resultColorScaleSettings),
    showDeformed: value.showDeformed === true,
    showDimensions: value.showDimensions === true,
    stressExaggeration: readFiniteNumber(value.stressExaggeration, 1.8),
    resultFrameIndex: Math.max(0, Math.trunc(readFiniteNumber(value.resultFrameIndex, 0))),
    resultPlaybackFps: clamp(readFiniteNumber(value.resultPlaybackFps, 12), 1, 60),
    resultPlaybackReverseLoop: value.resultPlaybackReverseLoop === true,
    isStepbarCollapsed: value.isStepbarCollapsed === true,
    draftLoadType: readEnum(value.draftLoadType, LOAD_TYPES, "force"),
    draftLoadValue: readFiniteNumber(value.draftLoadValue, 500),
    draftLoadDirection: readEnum(value.draftLoadDirection, LOAD_DIRECTIONS, "-Z"),
    sampleModel: readEnum(value.sampleModel, SAMPLE_MODELS, "bracket"),
    sampleAnalysisType: readEnum(value.sampleAnalysisType, SAMPLE_ANALYSIS_TYPES, "static_stress"),
    activeRunId: typeof value.activeRunId === "string" ? value.activeRunId : "",
    completedRunId: typeof value.completedRunId === "string" ? value.completedRunId : "",
    runProgress: clamp(readFiniteNumber(value.runProgress, 0), 0, 100),
    undoStack: parseProjectArray(value.undoStack),
    redoStack: parseProjectArray(value.redoStack),
    status: typeof value.status === "string" ? value.status : "Ready",
    logs: parseLogEntries(value.logs)
  });
}

function parseResultColorScaleSettings(value: unknown): ResultColorScaleSettings {
  if (!isRecord(value)) return {};
  const settings: ResultColorScaleSettings = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!key || !isRecord(candidate)) continue;
    const rangeMode = candidate.rangeMode === "manual" ? "manual" : "auto";
    const bands = candidate.bands === "bands8" ? "bands8" : "continuous";
    const manualMin = typeof candidate.manualMin === "number" && Number.isFinite(candidate.manualMin) ? candidate.manualMin : undefined;
    const manualMax = typeof candidate.manualMax === "number" && Number.isFinite(candidate.manualMax) ? candidate.manualMax : undefined;
    settings[key] = {
      rangeMode,
      bands,
      ...(manualMin !== undefined ? { manualMin } : {}),
      ...(manualMax !== undefined ? { manualMax } : {})
    };
  }
  return settings;
}

function normalizeUiRunState(ui: WorkspaceUiSnapshot): WorkspaceUiSnapshot {
  const runProgress = ui.runProgress > 0 && ui.runProgress < 100 ? 0 : ui.runProgress;
  const logs = ui.logs.slice(0, WORKSPACE_LOG_LIMIT);
  return runProgress === ui.runProgress && logs.length === ui.logs.length ? ui : { ...ui, runProgress, logs };
}

export function parseDisplayModel(value: unknown): DisplayModel | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.bodyCount !== "number" || !Array.isArray(value.faces)) return null;
  if (!value.faces.every(isDisplayFace)) return null;
  return value as unknown as DisplayModel;
}

function isDisplayFace(value: unknown): value is DisplayFace {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.color === "string" &&
    typeof value.stressValue === "number" &&
    isVector3(value.center) &&
    isVector3(value.normal)
  );
}

function parseLogEntries(value: unknown): WorkspaceLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): WorkspaceLogEntry[] => {
    if (typeof item === "string") return [{ message: item, at: Date.now() }];
    if (isRecord(item) && typeof item.message === "string") {
      return [{ message: item.message, at: readFiniteNumber(item.at, Date.now()) }];
    }
    return [];
  }).slice(0, WORKSPACE_LOG_LIMIT);
}

function parseProjectArray(value: unknown): Project[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = ProjectSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }).slice(-30);
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isVector3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function parsePayloadObject(value: unknown): PayloadObjectSelection | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !isVector3(value.center)) return null;
  return {
    id: value.id,
    label: value.label,
    center: value.center,
    ...(typeof value.volumeM3 === "number" && Number.isFinite(value.volumeM3) && value.volumeM3 > 0 ? { volumeM3: value.volumeM3 } : {}),
    ...(value.volumeSource === "mesh" || value.volumeSource === "step" || value.volumeSource === "bounds-fallback" || value.volumeSource === "manual" ? { volumeSource: value.volumeSource } : {}),
    ...(value.volumeStatus === "available" || value.volumeStatus === "estimated" || value.volumeStatus === "unknown" ? { volumeStatus: value.volumeStatus } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function scheduleStorageWrite(write: () => boolean, storage: StorageLike | null, delayMs: number, onWriteFailed?: () => void): () => void {
  if (!storage) return () => undefined;
  const idleCallbacks = globalThis as typeof globalThis & IdleCallbackHandle;
  let idleHandle: number | null = null;
  const timeoutHandle = globalThis.setTimeout(() => {
    const runWrite = () => {
      idleHandle = null;
      if (!write()) onWriteFailed?.();
    };
    if (idleCallbacks.requestIdleCallback) {
      idleHandle = idleCallbacks.requestIdleCallback(runWrite, { timeout: 1500 });
    } else {
      runWrite();
    }
  }, delayMs);

  return () => {
    globalThis.clearTimeout(timeoutHandle);
    if (idleHandle !== null) idleCallbacks.cancelIdleCallback?.(idleHandle);
  };
}

export function installAutosavePageHideFlush(
  flush: () => void,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null = typeof window === "undefined" ? null : window
): () => void {
  if (!target) return () => undefined;
  target.addEventListener("pagehide", flush);
  return () => target.removeEventListener("pagehide", flush);
}

function writeJsonStorageItem(key: string, snapshot: unknown, storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

function readSnapshot<T>(snapshot: T | (() => T)): T {
  return typeof snapshot === "function" ? (snapshot as () => T)() : snapshot;
}

function isNewerOrSameTimestamp(candidate: string, baseline: string): boolean {
  const candidateTime = Date.parse(candidate);
  const baselineTime = Date.parse(baseline);
  if (!Number.isFinite(candidateTime) || !Number.isFinite(baselineTime)) return true;
  return candidateTime >= baselineTime;
}
