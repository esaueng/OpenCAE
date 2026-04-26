import {
  ProjectSchema,
  ResultFieldSchema,
  ResultSummarySchema,
  type DisplayFace,
  type DisplayModel,
  type Project
} from "@opencae/schema";
import { buildLocalProjectFile, type LocalProjectFile, type LocalResultBundle } from "./projectFile";
import type { LoadDirectionLabel, LoadType } from "./loadPreview";
import type { LoadApplicationPoint } from "./loadPreview";
import type { ResultMode, ViewMode } from "./components/CadViewer";
import type { StepId } from "./components/StepBar";
import type { SampleModelId } from "./lib/api";

export const AUTOSAVE_STORAGE_KEY = "opencae.workspace.autosave.v1";

export type ThemeMode = "dark" | "light";

export interface WorkspaceUiSnapshot {
  activeStep: StepId;
  selectedFaceId: string | null;
  selectedLoadPoint: LoadApplicationPoint | null;
  viewMode: ViewMode;
  themeMode: ThemeMode;
  resultMode: ResultMode;
  showDeformed: boolean;
  showDimensions: boolean;
  stressExaggeration: number;
  draftLoadType: LoadType;
  draftLoadValue: number;
  draftLoadDirection: LoadDirectionLabel;
  sampleModel: SampleModelId;
  activeRunId: string;
  completedRunId: string;
  runProgress: number;
  undoStack: Project[];
  redoStack: Project[];
  status: string;
  logs: string[];
}

export interface AutosavedWorkspace {
  version: 1;
  savedAt: string;
  projectFile: LocalProjectFile;
  ui: WorkspaceUiSnapshot;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const STEPS: StepId[] = ["model", "material", "supports", "loads", "mesh", "run", "results", "report"];
const VIEW_MODES: ViewMode[] = ["model", "mesh", "results"];
const RESULT_MODES: ResultMode[] = ["stress", "displacement", "safety_factor"];
const THEMES: ThemeMode[] = ["dark", "light"];
const LOAD_TYPES: LoadType[] = ["force", "pressure", "gravity"];
const LOAD_DIRECTIONS: LoadDirectionLabel[] = ["-Y", "+Y", "+X", "-X", "+Z", "-Z", "Normal"];
const SAMPLE_MODELS: SampleModelId[] = ["bracket", "plate", "cantilever"];

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
    ui
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
  const payload = storage.getItem(AUTOSAVE_STORAGE_KEY);
  return payload ? parseAutosavedWorkspacePayload(payload) : null;
}

export function writeAutosavedWorkspace(snapshot: AutosavedWorkspace, storage = getBrowserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
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

function parseResultBundle(value: unknown): LocalResultBundle | undefined {
  if (!isRecord(value)) return undefined;
  const summary = ResultSummarySchema.safeParse(value.summary);
  const fields = ResultFieldSchema.array().safeParse(value.fields);
  if (!summary.success || !fields.success || fields.data.length === 0) return undefined;
  return {
    activeRunId: typeof value.activeRunId === "string" ? value.activeRunId : undefined,
    completedRunId: typeof value.completedRunId === "string" ? value.completedRunId : undefined,
    summary: summary.data,
    fields: fields.data
  };
}

function parseUiSnapshot(value: unknown): WorkspaceUiSnapshot | null {
  if (!isRecord(value)) return null;
  return {
    activeStep: readEnum(value.activeStep, STEPS, "model"),
    selectedFaceId: typeof value.selectedFaceId === "string" ? value.selectedFaceId : null,
    selectedLoadPoint: isVector3(value.selectedLoadPoint) ? value.selectedLoadPoint : null,
    viewMode: readEnum(value.viewMode, VIEW_MODES, "model"),
    themeMode: readEnum(value.themeMode, THEMES, "dark"),
    resultMode: readEnum(value.resultMode, RESULT_MODES, "stress"),
    showDeformed: value.showDeformed === true,
    showDimensions: value.showDimensions === true,
    stressExaggeration: readFiniteNumber(value.stressExaggeration, 1.8),
    draftLoadType: readEnum(value.draftLoadType, LOAD_TYPES, "force"),
    draftLoadValue: readFiniteNumber(value.draftLoadValue, 500),
    draftLoadDirection: readEnum(value.draftLoadDirection, LOAD_DIRECTIONS, "-Z"),
    sampleModel: readEnum(value.sampleModel, SAMPLE_MODELS, "bracket"),
    activeRunId: typeof value.activeRunId === "string" ? value.activeRunId : "",
    completedRunId: typeof value.completedRunId === "string" ? value.completedRunId : "",
    runProgress: clamp(readFiniteNumber(value.runProgress, 0), 0, 100),
    undoStack: parseProjectArray(value.undoStack),
    redoStack: parseProjectArray(value.redoStack),
    status: typeof value.status === "string" ? value.status : "Ready",
    logs: Array.isArray(value.logs) ? value.logs.filter((item): item is string => typeof item === "string").slice(0, 32) : []
  };
}

function parseDisplayModel(value: unknown): DisplayModel | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function getBrowserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
