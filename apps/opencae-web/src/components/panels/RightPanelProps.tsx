/* Shared RightPanel contracts: props, step constants, and tiny shared helpers.
   Panels import from here; they never import each other. */
import { useEffect, useLayoutEffect } from "react";

import type { Constraint, CustomMaterial, DisplayFace, DisplayModel, DynamicSolverSettings, Load, LoadCase, LoadCombination, MeshConnection, MeshQuality, ModalSolverSettings, Project, ResultField, ResultSummary, RunTimingEstimate, RunVariantRef, SimulationFidelity, Study } from "@opencae/schema";

import type { RunReadinessItem } from "../../runReadiness";
import type { WorkspaceNotice } from "../../workspaceNotice";

import type { StepId } from "../StepBar";
import { type LoadApplicationPoint, type LoadDirectionLabel, type LoadType, type PayloadLoadMetadata } from "../../loadPreview";
import { type PayloadObjectSelection, type ResultMode, type SectionPlaneState, type StressComponent, type ViewMode } from "../../workspaceViewTypes";
import { type ResolvedResultProbe } from "../../resultSelection";
import { type SampleAnalysisType, type SampleModelId } from "../../lib/api";
import type { WasmMeshPhaseProgress } from "../../lib/wasmMeshing";
import { type ConvergenceProbe } from "../../meshConvergence";

import { type RotationAxis } from "../../modelOrientation";

import { type ResolvedResultColorScale, type ResultColorScaleSetting } from "../../resultColorScale";

export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
export const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
export const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.001;
export const STRESS_EXAGGERATION_COMMIT_DELAY_MS = 120;
export const DYNAMIC_LOAD_PROFILE_OPTIONS: Array<{ value: DynamicSolverSettings["loadProfile"]; label: string; helper: string }> = [
  { value: "ramp", label: "Ramp to full load", helper: "Ramp: load starts at 0 and reaches full value at end time." },
  { value: "step", label: "Step load", helper: "Step: full load is applied immediately." },
  { value: "quasi_static", label: "Quasi-static ramp", helper: "Quasi-static: smooth eased ramp (3s²−2s³) that reduces inertial effects; not a step load." },
  { value: "sinusoidal", label: "Half-sine pulse", helper: "Half-sine pulse: sin(πs) lobe over the window — zero at both ends, peaking mid-window." }
];
export const DEFAULT_DYNAMIC_LOAD_PROFILE_HELPER = DYNAMIC_LOAD_PROFILE_OPTIONS[0]?.helper ?? "Ramp: load starts at 0 and reaches full value at end time.";

export interface RightPanelProps {
  activeStep: StepId;
  project: Project;
  displayModel: DisplayModel;
  study: Study;
  selectedFace: DisplayFace | null;
  viewMode: ViewMode;
  resultMode: ResultMode;
  selectedModeIndex?: number;
  stressComponent?: StressComponent;
  showDeformed: boolean;
  showDimensions: boolean;
  sectionPlane?: SectionPlaneState;
  stressExaggeration: number;
  resultSummary: ResultSummary | null;
  resultFields?: ResultField[];
  resultColorScale?: ResolvedResultColorScale;
  resultColorScaleControl?: {
    setting: ResultColorScaleSetting;
    automaticMin: number;
    automaticMax: number;
    displayMin: number;
    displayMax: number;
    units: string;
  };
  onResultColorScaleSettingChange?: (setting: ResultColorScaleSetting) => void;
  resultProbes?: ResolvedResultProbe[];
  resultProbeLimitReached?: boolean;
  onRemoveResultProbe?: (probeId: string) => void;
  onClearResultProbes?: () => void;
  resultVariants?: RunVariantRef[];
  activeResultVariantId?: string;
  onResultVariantChange?: (variantId: string) => void | Promise<void>;
  runProgress: number;
  runError?: string | null;
  meshError?: string | null;
  runTiming?: RunTimingEstimate | null;
  /** Wall time of the run that produced the current results, once it is no longer an estimate. */
  solveElapsedMs?: number | null;
  onGenerateReport?: (options?: { targetSafetyFactor?: number }) => Promise<void>;
  onExportResultPng?: () => Promise<void>;
  onExportResultHtml?: () => Promise<void>;
  onExportResultData?: (format: "csv" | "vtu") => Promise<void>;
  onSaveProject?: () => Promise<void> | void;
  reportBusy?: boolean;
  reportError?: string | null;
  reportDisabled?: boolean;
  pngExportBusy?: boolean;
  pngExportError?: string | null;
  htmlExportBusy?: boolean;
  htmlExportError?: string | null;
  dataExportBusy?: "csv" | "vtu" | null;
  dataExportError?: string | null;
  sampleModel: SampleModelId;
  sampleAnalysisType?: SampleAnalysisType;
  draftLoadType: LoadType;
  draftLoadValue: number;
  /** Typed thermal boundary temperature (°C) shared with the viewer pick path. */
  draftSupportTemperature?: number;
  draftLoadDirection: LoadDirectionLabel;
  selectedLoadPoint: LoadApplicationPoint | null;
  selectedPayloadObject: PayloadObjectSelection | null;
  onFitView: () => void;
  onRotateModel: (axis: RotationAxis) => void;
  onResetModelOrientation: () => void;
  onLoadSample: (sample?: SampleModelId, analysisType?: SampleAnalysisType) => void;
  onUploadModel: (file: File) => void;
  onRepairModel?: () => void;
  isRepairingModel?: boolean;
  onSampleModelChange?: (sample: SampleModelId) => void;
  onSampleAnalysisTypeChange?: (analysisType: SampleAnalysisType) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onResultModeChange: (mode: ResultMode) => void;
  onSelectedModeIndexChange?: (modeIndex: number) => void;
  onStressComponentChange?: (component: StressComponent) => void;
  onToggleDeformed: () => void;
  onToggleDimensions: () => void;
  onSectionPlaneChange?: (state: SectionPlaneState) => void;
  onStressExaggerationChange: (value: number) => void;
  onAssignMaterial: (materialId: string, parameters?: Record<string, unknown>) => void;
  onSaveCustomMaterial?: (material: CustomMaterial) => void;
  onDeleteCustomMaterial?: (materialId: string) => void;
  /** null suppresses the preview while editing; undefined clears the preview so the assigned orientation shows again. */
  onPreviewPrintLayerOrientation?: (orientation: "x" | "y" | "z" | null | undefined) => void;
  onAddSupport: (selectionRef?: string, options?: { type: "fixed" | "prescribed_temperature" | "prescribed_displacement"; value?: number; component?: "x" | "y" | "z" }, extras?: { selectionRefs?: string[] }) => void;
  /** `targetFace` moves the support to a newly picked face (2026-09 review D3). */
  onUpdateSupport: (support: Constraint, targetFace?: DisplayFace) => void;
  onRemoveSupport: (supportId: string) => void;
  onDraftLoadTypeChange: (type: LoadType) => void;
  onDraftLoadValueChange: (value: number) => void;
  onDraftSupportTemperatureChange?: (value: number) => void;
  onDraftLoadDirectionChange: (direction: LoadDirectionLabel) => void;
  onDraftPayloadPreviewChange?: (preview: { value: number; metadata: PayloadLoadMetadata } | null) => void;
  onAddLoad: (type: LoadType, value: number, selectionRef: string | undefined, direction: LoadDirectionLabel, payloadMetadata?: PayloadLoadMetadata) => void;
  /** `targetFace` moves the load to a newly picked face (2026-09 review D3). */
  onUpdateLoad: (load: Load, targetFace?: DisplayFace) => void;
  onPreviewLoadEdit: (load: Load | null) => void;
  onRemoveLoad: (loadId: string) => void;
  onLoadCasesChange?: (loadCases: LoadCase[], loadCombinations: LoadCombination[]) => void;
  onGenerateMesh: (preset: MeshQuality) => void;
  onConnectionsChange?: (connections: MeshConnection[]) => void;
  onCancelMesh?: () => void;
  meshPhaseProgress?: WasmMeshPhaseProgress | null;
  onRunMeshConvergence?: (caseId: string, probe: ConvergenceProbe) => void;
  convergenceBusy?: boolean;
  convergenceProgress?: string;
  onUpdateSolverSettings?: (settings: SolverSettingsPatch) => void;
  onChangeStudyType?: (type: Study["type"]) => void;
  onRunSimulation: () => void;
  onCancelSimulation?: () => void;
  canCancelSimulation?: boolean;
  canRunSimulation: boolean;
  missingRunItems: string[];
  runReadiness: RunReadinessItem[];
  /** Workspace-wide notice rendered at the top of every step's panel. */
  notice?: WorkspaceNotice | null;
  onDismissNotice?: () => void;
  onNoticeStep?: (step: StepId) => void;
  /** True while report figures are captured through the viewer; result-mode controls hold (2026-09 review D15). */
  resultControlsBusy?: boolean;
  /** Lets a panel commit pending work when the user presses Next (Material applies the previewed selection, 2026-09 review F3). */
  registerBeforeNext?: (handler: (() => void) | null) => void;
  resultFrameIndex?: number;
  resultFramePosition?: number;
  resultFrameOrdinalPosition?: number;
  onResultFrameChange?: (frameIndex: number) => void;
  resultPlaybackPlaying?: boolean;
  resultPlaybackFps?: number;
  resultPlaybackReverseLoop?: boolean;
  resultPlaybackCacheLabel?: string;
  onResultPlaybackToggle?: () => void;
  onResultPlaybackFpsChange?: (fps: number) => void;
  onResultPlaybackReverseLoopChange?: (enabled: boolean) => void;
  onStepSelect: (step: StepId) => void;
}

export const EMPTY_PARAMETERS: Record<string, unknown> = {};
export const noopDraftPayloadPreviewChange = () => undefined;
export type SolverSettingsPatch = Partial<DynamicSolverSettings & ModalSolverSettings> & { fidelity?: SimulationFidelity };
export const MESH_PRESETS: MeshQuality[] = ["coarse", "medium", "fine", "ultra"];
export const SIMULATION_FIDELITIES: SimulationFidelity[] = ["standard", "detailed", "ultra"];

export function stressComponentLabel(component: StressComponent): string {
  if (component === "principal_max") return "σ₁";
  if (component === "principal_min") return "σ₃";
  if (component === "max_shear") return "Max shear";
  return "Von Mises";
}

