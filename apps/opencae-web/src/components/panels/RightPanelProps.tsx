/* Shared RightPanel contracts: props, step constants, and tiny shared helpers.
   Panels import from here; they never import each other. */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Anchor, ArrowDown, Atom, Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Eye, Factory, FileCode2, FileDown, FileImage, FolderDown, Gauge, Grid3X3, Layers3, Maximize2, Pause, Play, Plus, RotateCcw, Ruler, ScanLine, ShieldCheck, Table2, Upload, Weight, Wrench, X } from "lucide-react";
import { finiteExtrema } from "@opencae/core";
import { compatibleManufacturingProcessesFor, defaultManufacturingParametersFor, defaultManufacturingProcessIdFor, effectiveMaterialProperties, fdmPropertyFactorsFor, isManufacturingProcessCompatible, manufacturingParametersForAssignment, manufacturingProcessForId, massKgForPayloadMaterial, materialCatalog, materialCategoryLabel, normalizeManufacturingParameters, payloadMaterialForId, payloadMaterials, type ManufacturingParameters, type ManufacturingProcessId, type PayloadMaterialCategory } from "@opencae/materials";
import { assessResultFailure, estimateAllowableLoadForSafetyFactor, isModalResultSummary, isThermalResultSummary } from "@opencae/schema";
import type { Constraint, CustomMaterial, DisplayFace, DisplayModel, DynamicSolverSettings, Load, LoadCase, LoadCombination, Material, MeshConnection, MeshConvergenceRecord, MeshQuality, ModalResultSummary, ModalSolverSettings, Project, ResultField, ResultSummary, RunTimingEstimate, RunVariantRef, SimulationFidelity, StructuralResultSummary, Study, ThermalResultSummary } from "@opencae/schema";
import { inferGlobalCriticalPrintAxis } from "@opencae/study-core";
import type { RunReadinessItem } from "../../runReadiness";
import type { WorkspaceNotice } from "../../workspaceNotice";
import { STUDY_TYPE_LABELS, studyTypeSwitchConsequence } from "../../studyTypeSwitch";
import { GEOMETRY_FILE_ACCEPT, PREVIEW_ONLY_GEOMETRY_NOTICE, SUPPORTED_GEOMETRY_FORMAT_LABEL, isPreviewOnlyGeometry } from "../../geometryFormats";
import type { StepId } from "../StepBar";
import { applicationPointForLoad, createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, equivalentForceForLoad, LOAD_DIRECTION_LABELS, loadMagnitudeError, loadMarkerOrdinalLabel, payloadObjectForLoad, unitsForLoadType, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType, type PayloadLoadMetadata, type PayloadMassMode } from "../../loadPreview";
import { DEFAULT_SECTION_PLANE, type PayloadObjectSelection, type ResultMode, type SectionPlaneState, type StressComponent, type ViewMode } from "../../workspaceViewTypes";
import { availableStressComponents, type ResolvedResultProbe } from "../../resultSelection";
import { meshTargetSizeMmForPreset, type SampleAnalysisType, type SampleModelId } from "../../lib/api";
import type { WasmMeshPhaseProgress } from "../../lib/wasmMeshing";
import { defaultConvergenceProbe, type ConvergenceProbe } from "../../meshConvergence";
import { stepGeometryMetadataForProject } from "../../stepGeometryState";
import { dimensionValuesForDisplayModel } from "../../modelDimensions";
import { formatModelOrientation, getModelOrientation, type RotationAxis } from "../../modelOrientation";
import { shouldShowSampleModelPicker } from "../../modelPanelState";
import { SETTING_HELP, type SettingHelpId, type SettingHelpVisual } from "../../settingHelp";
import { supportDisplayLabel } from "../../supportLabels";
import { getViewportTooltipPosition } from "../../tooltipPosition";
import { defaultSolverMethodForStudy, forceForUnits, formatDensity, formatDisplayNumber, formatMass, formatMaterialStress, formatMeshSourceLabel, formatResultMetric, formatResultNumber, formatResultProvenanceLabel, formatVolume, hasResultUnit, legacyResultWarningForProvenance, loadValueForUnits, solverMethodForResult, solverRunnerLabelForResult, type UnitSystem } from "../../unitDisplay";
import { canNavigateToStep } from "../../appShellState";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { MaterialLibraryModal } from "../SimulationWorkflow";
import { ParametricPartBuilder } from "../ParametricPartBuilder";
import { SampleOptionCard } from "../SampleOptionCard";
import { SAMPLE_ANALYSIS_OPTIONS, sampleAnalysisOptionFor } from "../sampleAnalysisOptions";
import { SAMPLE_OPTIONS, sampleOptionFor } from "../sampleOptions";
import { dynamicPlaybackFrames } from "../../resultFields";
import { resultScaleCssGradient, validManualResultRange, type ResolvedResultColorScale, type ResultColorScaleSetting } from "../../resultColorScale";
import { INVALID_REACTION_WARNING, PREVIEW_GEOMETRY_WARNING, canShowReverseLoadCapacity, hasInvalidReactionForce, hasUnavailableReactionDiagnostic, shouldBlockPreviewResultsForDisplayModel } from "../../resultProvenance";
import {
  frameIndexForRoundedPlaybackOrdinal,
  playbackOrdinalForSolverFramePosition
} from "../../resultPlaybackTimeline";

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
  onAddSupport: (selectionRef?: string, options?: { type: "fixed" | "prescribed_temperature"; value?: number }) => void;
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

