import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Anchor, ArrowDown, Atom, Check, ChevronDown, ChevronRight, CircleHelp, Eye, Factory, FileDown, Gauge, Grid3X3, Layers3, Maximize2, Pause, Play, Plus, RotateCcw, Ruler, ScanLine, ShieldCheck, Upload, Weight, Wrench, X } from "lucide-react";
import { compatibleManufacturingProcessesFor, defaultManufacturingParametersFor, defaultManufacturingProcessIdFor, effectiveMaterialProperties, fdmPropertyFactorsFor, isManufacturingProcessCompatible, manufacturingParametersForAssignment, manufacturingProcessForId, massKgForPayloadMaterial, materialCatalog, materialCategoryLabel, normalizeManufacturingParameters, payloadMaterialForId, payloadMaterials, type ManufacturingParameters, type ManufacturingProcessId, type PayloadMaterialCategory } from "@opencae/materials";
import { assessResultFailure, estimateAllowableLoadForSafetyFactor, isModalResultSummary } from "@opencae/schema";
import type { Constraint, CustomMaterial, DisplayFace, DisplayModel, DynamicSolverSettings, Load, LoadCase, LoadCombination, Material, MeshConvergenceRecord, MeshQuality, ModalResultSummary, ModalSolverSettings, Project, ResultField, ResultSummary, RunTimingEstimate, RunVariantRef, SimulationFidelity, StructuralResultSummary, Study } from "@opencae/schema";
import { inferGlobalCriticalPrintAxis } from "@opencae/study-core";
import type { StepId } from "./StepBar";
import { applicationPointForLoad, createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, equivalentForceForLoad, LOAD_DIRECTION_LABELS, loadMarkerOrdinalLabel, payloadObjectForLoad, unitsForLoadType, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType, type PayloadLoadMetadata, type PayloadMassMode } from "../loadPreview";
import { DEFAULT_SECTION_PLANE, type PayloadObjectSelection, type ResultMode, type SectionPlaneState, type StressComponent, type ViewMode } from "../workspaceViewTypes";
import type { ResolvedResultProbe } from "../resultSelection";
import type { SampleAnalysisType, SampleModelId } from "../lib/api";
import type { WasmMeshPhaseProgress } from "../lib/wasmMeshing";
import { defaultConvergenceProbe, type ConvergenceProbe } from "../meshConvergence";
import { stepGeometryMetadataForProject } from "../stepGeometryState";
import { dimensionValuesForDisplayModel } from "../modelDimensions";
import { formatModelOrientation, getModelOrientation, type RotationAxis } from "../modelOrientation";
import { shouldShowSampleModelPicker } from "../modelPanelState";
import { SETTING_HELP, type SettingHelpId, type SettingHelpVisual } from "../settingHelp";
import { supportDisplayLabel } from "../supportLabels";
import { getViewportTooltipPosition } from "../tooltipPosition";
import { forceForUnits, formatDensity, formatMass, formatMaterialStress, formatMeshSourceLabel, formatResultMetric, formatResultProvenanceLabel, formatVolume, hasResultUnit, legacyResultWarningForProvenance, loadValueForUnits, solverMethodForResult, solverRunnerLabelForResult, type UnitSystem } from "../unitDisplay";
import { canNavigateToStep } from "../appShellState";
import { MaterialLibraryModal } from "./SimulationWorkflow";
import { ParametricPartBuilder } from "./ParametricPartBuilder";
import { SampleOptionCard } from "./SampleOptionCard";
import { SAMPLE_OPTIONS, sampleOptionFor } from "./sampleOptions";
import { dynamicPlaybackFrames } from "../resultFields";
import { INVALID_REACTION_WARNING, PREVIEW_GEOMETRY_WARNING, canShowReverseLoadCapacity, hasInvalidReactionForce, hasUnavailableReactionDiagnostic, shouldBlockPreviewResultsForDisplayModel } from "../resultProvenance";
import {
  frameIndexForRoundedPlaybackOrdinal,
  playbackOrdinalForSolverFramePosition
} from "../resultPlaybackTimeline";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.001;
const STRESS_EXAGGERATION_COMMIT_DELAY_MS = 120;
const DYNAMIC_LOAD_PROFILE_OPTIONS: Array<{ value: DynamicSolverSettings["loadProfile"]; label: string; helper: string }> = [
  { value: "ramp", label: "Ramp to full load", helper: "Ramp: load starts at 0 and reaches full value at end time." },
  { value: "step", label: "Step load", helper: "Step: full load is applied immediately." },
  { value: "quasi_static", label: "Quasi-static ramp", helper: "Quasi-static ramp: slow ramp profile intended to reduce inertial effects." },
  { value: "sinusoidal", label: "Sinusoidal", helper: "Sinusoidal: load varies sinusoidally over the time window." }
];
const DEFAULT_DYNAMIC_LOAD_PROFILE_HELPER = DYNAMIC_LOAD_PROFILE_OPTIONS[0]?.helper ?? "Ramp: load starts at 0 and reaches full value at end time.";

interface RightPanelProps {
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
  resultVariants?: RunVariantRef[];
  activeResultVariantId?: string;
  onResultVariantChange?: (variantId: string) => void | Promise<void>;
  resultProbes?: ResolvedResultProbe[];
  resultProbeLimitReached?: boolean;
  runProgress: number;
  runError?: string | null;
  runTiming?: RunTimingEstimate | null;
  onGenerateReport?: (options?: { targetSafetyFactor?: number }) => Promise<void>;
  reportBusy?: boolean;
  reportError?: string | null;
  reportDisabled?: boolean;
  sampleModel: SampleModelId;
  sampleAnalysisType?: SampleAnalysisType;
  draftLoadType: LoadType;
  draftLoadValue: number;
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
  onSampleModelChange: (sample: SampleModelId) => void;
  onSampleAnalysisTypeChange?: (analysisType: SampleAnalysisType) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onResultModeChange: (mode: ResultMode) => void;
  onSelectedModeIndexChange?: (modeIndex: number) => void;
  onStressComponentChange?: (component: StressComponent) => void;
  onRemoveResultProbe?: (probeId: string) => void;
  onClearResultProbes?: () => void;
  onToggleDeformed: () => void;
  onToggleDimensions: () => void;
  onSectionPlaneChange?: (state: SectionPlaneState) => void;
  onStressExaggerationChange: (value: number) => void;
  onAssignMaterial: (materialId: string, parameters?: Record<string, unknown>) => void;
  onSaveCustomMaterial?: (material: CustomMaterial) => void;
  onDeleteCustomMaterial?: (materialId: string) => void;
  /** null suppresses the preview while editing; undefined clears the preview so the assigned orientation shows again. */
  onPreviewPrintLayerOrientation?: (orientation: "x" | "y" | "z" | null | undefined) => void;
  onAddSupport: (selectionRef?: string) => void;
  onUpdateSupport: (support: Constraint) => void;
  onRemoveSupport: (supportId: string) => void;
  onDraftLoadTypeChange: (type: LoadType) => void;
  onDraftLoadValueChange: (value: number) => void;
  onDraftLoadDirectionChange: (direction: LoadDirectionLabel) => void;
  onDraftPayloadPreviewChange?: (preview: { value: number; metadata: PayloadLoadMetadata } | null) => void;
  onAddLoad: (type: LoadType, value: number, selectionRef: string | undefined, direction: LoadDirectionLabel, payloadMetadata?: PayloadLoadMetadata) => void;
  onUpdateLoad: (load: Load) => void;
  onPreviewLoadEdit: (load: Load | null) => void;
  onRemoveLoad: (loadId: string) => void;
  onLoadCasesChange?: (loadCases: LoadCase[], loadCombinations: LoadCombination[]) => void;
  onGenerateMesh: (preset: MeshQuality) => void;
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

const EMPTY_PARAMETERS: Record<string, unknown> = {};
const noopDraftPayloadPreviewChange = () => undefined;
type SolverSettingsPatch = Partial<DynamicSolverSettings & ModalSolverSettings> & { fidelity?: SimulationFidelity };
const MESH_PRESETS: MeshQuality[] = ["coarse", "medium", "fine", "ultra"];
const SIMULATION_FIDELITIES: SimulationFidelity[] = ["standard", "detailed", "ultra"];

export function RightPanel(props: RightPanelProps) {
  return (
    <aside className="side-panel">
      {props.activeStep === "model" && <ModelPanel {...props} />}
      {props.activeStep === "material" && <MaterialPanel {...props} />}
      {props.activeStep === "supports" && <SupportsPanel {...props} />}
      {props.activeStep === "loads" && <LoadsPanel {...props} />}
      {props.activeStep === "mesh" && <MeshPanel {...props} />}
      {props.activeStep === "run" && <RunPanel {...props} />}
      {props.activeStep === "results" && <ResultsPanel {...props} />}
      <WorkflowNav activeStep={props.activeStep} study={props.study} onStepSelect={props.onStepSelect} />
    </aside>
  );
}

function ModelPanel({ project, displayModel, study, viewMode, showDimensions, sectionPlane = DEFAULT_SECTION_PLANE, sampleModel, sampleAnalysisType = "static_stress", onFitView, onRotateModel, onResetModelOrientation, onViewModeChange, onToggleDimensions, onSectionPlaneChange, onLoadSample, onUploadModel, onRepairModel, isRepairingModel = false, onSampleModelChange, onSampleAnalysisTypeChange }: RightPanelProps) {
  const [confirmSampleLoad, setConfirmSampleLoad] = useState(false);
  const [pendingSampleModel, setPendingSampleModel] = useState<SampleModelId>(sampleModel);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setPendingSampleModel(sampleModel);
  }, [sampleModel]);
  const geometry = project.geometryFiles[0];
  const isBlankProject = !geometry;
  const isUploadedProject = geometry?.metadata.source === "local-upload";
  const showSampleModelPicker = shouldShowSampleModelPicker(project);
  const uploadPreviewFormat = typeof geometry?.metadata.previewFormat === "string" ? geometry.metadata.previewFormat.toUpperCase() : "";
  const isNativeCadImport = Boolean(geometry?.metadata.nativeCadImport);
  const faceCount = Number(geometry?.metadata.faceCount ?? 0);
  const bodyCount = Number(geometry?.metadata.bodyCount ?? 0);
  const stepGeometry = stepGeometryMetadataForProject(project);
  const stepGeometryResolvedByMesh = Boolean(study.meshSettings.summary?.artifacts?.actualCoreModel);
  const sampleLabel = sampleOptionFor(pendingSampleModel).title;
  const sampleAnalysisLabel = sampleAnalysisType === "dynamic_structural" ? "Dynamic Structural" : "Static Stress";
  const sampleForceLabel = formatEquivalentForce(500, project.unitSystem);
  // The beam summary describes the structural body only. The separate
  // 0.498 kg payload is reported below as a load and must not be counted as
  // beam material mass.
  const sampleSummaryVolumeMm3 = pendingSampleModel === "plate" ? 28_590 : 41_280;
  const sampleSummaryMassG = pendingSampleModel === "plate" ? 77 : 111;
  const sampleLoadTitle = pendingSampleModel === "plate" ? `Payload mass · ${formatMass(0.497664, "kg", project.unitSystem)}` : `Force · ${sampleForceLabel}`;
  const orientation = getModelOrientation(displayModel);
  const hasCustomOrientation = orientation.x !== 0 || orientation.y !== 0 || orientation.z !== 0;
  const preconfigured =
    pendingSampleModel === "bracket"
      ? { support: "2 mounting holes · flange", load: "top face · -Z direction", callout: "An L-bracket is bolted at the flange; a vertical load on the top face creates a peak stress at the inside corner, reduced by the gusset rib." }
      : pendingSampleModel === "plate"
        ? { support: "fixed end face", load: "end payload mass · -Y direction", callout: "A simple beam is fixed at one end and carries a payload mass sitting on the free end, producing bending stress along the span." }
        : { support: "fixed end face", load: "free end face · -Z direction", callout: "A cantilever beam is fixed at one end and loaded at the free end, producing bending stress along the beam span." };

  function handleLoadSampleClick() {
    if (!confirmSampleLoad) {
      setConfirmSampleLoad(true);
      return;
    }
    setConfirmSampleLoad(false);
    onLoadSample(pendingSampleModel, sampleAnalysisType);
  }

  function handleSampleSelect(sample: SampleModelId) {
    setPendingSampleModel(sample);
    setConfirmSampleLoad(false);
  }

  function handleSampleOpen(sample: SampleModelId) {
    setPendingSampleModel(sample);
    setConfirmSampleLoad(false);
    onLoadSample(sample, sampleAnalysisType);
  }

  return (
    <Panel title="Model" helper="Inspect the 3D part. Orbit with left-drag, pan with right-drag, zoom with scroll.">
      {showSampleModelPicker && (
        <div className="field">
          <HelpLabel helpId="sampleModel">Sample model</HelpLabel>
          <div className="sample-option-grid panel-sample-grid" role="group" aria-label="Sample model">
            {SAMPLE_OPTIONS.map((option) => (
              <SampleOptionCard
                key={option.id}
                option={option}
                selected={pendingSampleModel === option.id}
                compact
                analysisType={sampleAnalysisType}
                onSelect={handleSampleSelect}
                onOpen={handleSampleOpen}
              />
            ))}
          </div>
          <HelpLabel helpId="sampleModel">Analysis type</HelpLabel>
          <div className="segmented analysis-type" role="group" aria-label="Analysis type">
            <button className={sampleAnalysisType === "static_stress" ? "active" : ""} type="button" aria-pressed={sampleAnalysisType === "static_stress"} onClick={() => onSampleAnalysisTypeChange?.("static_stress")}>Static</button>
            <button className={sampleAnalysisType === "dynamic_structural" ? "active" : ""} type="button" aria-pressed={sampleAnalysisType === "dynamic_structural"} onClick={() => onSampleAnalysisTypeChange?.("dynamic_structural")}>Dynamic</button>
          </div>
          <button
            className={confirmSampleLoad ? "primary wide" : "secondary wide"}
            type="button"
            onClick={handleLoadSampleClick}
            title={confirmSampleLoad ? "Click again to reload the sample project" : "Prepare to reload the sample project"}
          >
            <RotateCcw size={16} />
            {confirmSampleLoad ? "Click again to load sample" : `Load ${sampleAnalysisType === "dynamic_structural" ? "dynamic" : "static"} sample`}
          </button>
          {confirmSampleLoad && <span className="panel-copy confirm-copy">This will reload {sampleLabel} as {sampleAnalysisLabel} and reset the sample setup.</span>}
        </div>
      )}
      <input
        ref={uploadInputRef}
        className="hidden-file-input"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        accept=".step,.stp,.stl,.obj"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onUploadModel(file);
        }}
      />
      <button className={isBlankProject ? "primary wide" : "secondary wide"} type="button" onClick={() => uploadInputRef.current?.click()}>
        <Upload size={16} />
        {isBlankProject ? "Upload model" : "Replace model"}
      </button>
      {isBlankProject ? (
        <Callout>Upload STEP, STP, or STL to import a model. STL files use the mesh preview; STEP files import as a selectable CAD body.</Callout>
      ) : isUploadedProject ? (
        <Callout>{isNativeCadImport ? `${geometry.filename} is loaded as a selectable STEP import.` : uploadPreviewFormat ? `${geometry.filename} is loaded with a ${uploadPreviewFormat} viewport preview.` : `${geometry.filename} cannot be previewed in this local viewer. Replace it with STEP, STP, or STL.`}</Callout>
      ) : null}
      {stepGeometry?.status === "repairable" && !stepGeometryResolvedByMesh && (
        <div className="step-repair-card" role="alert" aria-label="Open STEP surfaces detected">
          <p className="panel-warning"><AlertTriangle size={16} />{stepGeometry.message ?? "This STEP model has open or invalid surfaces and is not a closed simulation solid."}</p>
          <button className="outline-action wide" type="button" onClick={onRepairModel} disabled={isRepairingModel || !onRepairModel}>
            <Wrench size={16} />
            {isRepairingModel ? "Fixing model..." : "Fix open surfaces"}
          </button>
          <p className="panel-copy">Fix model sews small gaps and may patch closed boundary loops. Review the repaired shape; face-based setup will be reset.</p>
        </div>
      )}
      {(stepGeometry?.status === "unrepairable" || stepGeometry?.status === "invalid") && !stepGeometryResolvedByMesh && (
        <p className="panel-warning" role="alert"><AlertTriangle size={16} />{stepGeometry.message ?? "This STEP model is not a closed solid and automatic repair could not produce one. Repair it in CAD and upload it again."}</p>
      )}
      {(stepGeometry?.status === "repaired" || (stepGeometryResolvedByMesh && stepGeometry?.status === "repairable")) && (
        <Callout>Geometry repair complete. Open boundaries were converted into a closed solid for simulation; review the shape before relying on results.</Callout>
      )}
      <Collapsible title="Create parametric part" subtitle="Analytic STEP solid" defaultOpen={isBlankProject}>
        <ParametricPartBuilder onCreatePart={onUploadModel} />
      </Collapsible>
      <div className="summary-box">
        <Info label="Project" value={project.name} />
        <Info label="Model" value={geometry?.filename ?? "No model loaded"} />
        <Info label="Bodies" value={String(bodyCount)} />
        <Info label="Faces" value={String(faceCount)} />
        {showSampleModelPicker && (
          <>
            <Info label="Volume" value={formatVolume(sampleSummaryVolumeMm3, "mm^3", project.unitSystem)} />
            <Info label="Mass" value={formatMass(sampleSummaryMassG, "g", project.unitSystem)} />
          </>
        )}
        <Info label="Units" value={project.unitSystem === "US" ? "in" : "mm"} />
      </div>
      <button className={showDimensions ? "primary wide" : "secondary wide"} type="button" onClick={onToggleDimensions}>
        <Ruler size={16} />
        {showDimensions ? "Hide dimensions" : "Show dimensions"}
      </button>
      <HelpNote helpId="dimensions" />
      {showDimensions && <ModelDimensions displayModel={displayModel} />}
      <SectionTitle>Open section</SectionTitle>
      <button
        className={sectionPlane.enabled ? "primary wide" : "secondary wide"}
        type="button"
        aria-pressed={sectionPlane.enabled}
        onClick={() => onSectionPlaneChange?.({ ...sectionPlane, enabled: !sectionPlane.enabled })}
      >
        <ScanLine size={16} />
        {sectionPlane.enabled ? "Close section" : "Open section"}
      </button>
      {sectionPlane.enabled ? (
        <div className="section-plane-controls">
          <div className="segmented" role="group" aria-label="Section plane axis">
            {(["x", "y", "z"] as const).map((axis) => (
              <button
                key={axis}
                className={sectionPlane.axis === axis ? "active" : ""}
                type="button"
                aria-pressed={sectionPlane.axis === axis}
                onClick={() => onSectionPlaneChange?.({ ...sectionPlane, axis })}
              >{axis.toUpperCase()}</button>
            ))}
          </div>
          <label className="field">
            <span>Normalized offset · {Math.round(sectionPlane.offset * 100)}%</span>
            <input type="range" min="0" max="1" step="0.01" value={sectionPlane.offset} onChange={(event) => onSectionPlaneChange?.({ ...sectionPlane, offset: Number(event.currentTarget.value) })} />
          </label>
          <button className="secondary wide" type="button" onClick={() => onSectionPlaneChange?.({ ...sectionPlane, flipped: !sectionPlane.flipped })}>
            <RotateCcw size={15} />Flip cut side
          </button>
          <p className="panel-copy">Geometry, mesh, result contours, feature edges, and the undeformed outline are clipped. Loads, supports, probes, and annotations stay visible.</p>
        </div>
      ) : null}
      <SectionTitle helpId="orientation">Orientation</SectionTitle>
      <div className="orientation-controls" role="group" aria-label="Axis view">
        {(["x", "y", "z"] as const).map((axis) => (
          <button key={axis} className="secondary" type="button" onClick={() => onRotateModel(axis)} title={`View perpendicular to ${axis.toUpperCase()} axis`}>
            <Eye size={15} />
            {axis.toUpperCase()}
          </button>
        ))}
        <button className="secondary" type="button" onClick={onResetModelOrientation} disabled={!hasCustomOrientation} title="Reset model orientation">
          <RotateCcw size={15} />
          Reset
        </button>
      </div>
      <p className="orientation-readout">{formatModelOrientation(displayModel)}</p>
      <div className="button-grid">
        <button className="secondary" onClick={onFitView}><Maximize2 size={16} />Fit view</button>
        <button className={viewMode === "mesh" ? "primary" : "secondary"} onClick={() => onViewModeChange(viewMode === "mesh" ? "model" : "mesh")}><Eye size={16} />Toggle mesh</button>
      </div>
      {!isBlankProject && !isUploadedProject && (
        <>
          <SectionTitle>Preconfigured</SectionTitle>
          <div className="concept-card-list">
            <ConceptCard icon={<SupportIcon />} title="Fixed support" detail={preconfigured.support} tone="warning" />
            <ConceptCard icon={<ArrowDown size={18} />} title={sampleLoadTitle} detail={preconfigured.load} tone="accent" />
          </div>
          <Callout>{preconfigured.callout}</Callout>
        </>
      )}
      <Info label="Study" value={study.name} />
      {showSampleModelPicker && <Info label="Sample analysis" value={sampleAnalysisLabel} />}
    </Panel>
  );
}

function MaterialPanel({ project, displayModel, study, onAssignMaterial, onSaveCustomMaterial, onDeleteCustomMaterial, onPreviewPrintLayerOrientation }: RightPanelProps) {
  const materials = useMemo(() => materialCatalog(project.customMaterials), [project.customMaterials]);
  const defaultMaterial = materials[0]!;
  const currentAssignment = study.materialAssignments[0];
  const current = currentAssignment?.materialId ?? "mat-aluminum-6061";
  const currentParameters = currentAssignment?.parameters ?? EMPTY_PARAMETERS;
  const initialMaterial = materialForId(current, materials) ?? defaultMaterial;
  const [selectedMaterialId, setSelectedMaterialId] = useState(initialMaterial.id);
  const [manufacturingParameters, setManufacturingParameters] = useState<ManufacturingParameters>(() =>
    normalizeManufacturingParameters(initialMaterial, currentParameters)
  );
  const [showLibrary, setShowLibrary] = useState(false);
  const [compatibilityNote, setCompatibilityNote] = useState<string | null>(null);

  useEffect(() => {
    const material = materialForId(current, materials) ?? defaultMaterial;
    setSelectedMaterialId(material.id);
    setManufacturingParameters(normalizeManufacturingParameters(material, currentParameters));
    setCompatibilityNote(null);
  }, [current, currentParameters, defaultMaterial, materials]);

  const selectedMaterial = materialForId(selectedMaterialId, materials) ?? defaultMaterial;
  const resolvedAssignedMaterial = materialForId(current, materials);
  const assignedMaterial = resolvedAssignedMaterial ?? defaultMaterial;
  const selectedProcessId = manufacturingParameters.manufacturingProcessId ?? defaultManufacturingProcessIdFor(selectedMaterial);
  const selectedProcess = manufacturingProcessForId(selectedProcessId)!;
  const compatibleProcesses = compatibleManufacturingProcessesFor(selectedMaterial);
  const processUsesBuildDirection = selectedProcess.settingsKind === "fdm" || selectedProcess.settingsKind === "build_direction";
  const criticalLayerAxis = inferGlobalCriticalPrintAxis(study, displayModel.faces.map((face) => ({
    entityId: face.id,
    center: face.center,
    ...(face.area ? { areaM2: face.area * 1e-6 } : {})
  })), displayModel);
  const effectiveMaterial = effectiveMaterialProperties(selectedMaterial, { ...manufacturingParameters }, { criticalLayerAxis });
  const fdmFactors = fdmPropertyFactorsFor(selectedMaterial, manufacturingParameters, { criticalLayerAxis });
  const assignedParameters = currentAssignment ? normalizeManufacturingParameters(assignedMaterial, currentParameters) : undefined;
  const assignedProcess = assignedParameters?.manufacturingProcessId ? manufacturingProcessForId(assignedParameters.manufacturingProcessId) : undefined;
  const assignedDetail = assignedProcess
    ? `${assignedProcess.label}${assignedProcess.id === "fdm" ? ` · ${assignedParameters?.infillDensity}% infill` : ""}`
    : "Process not selected";
  const assignedSelectionLabel = study.geometryScope[0]?.label ?? displayModel.name;

  useEffect(() => {
    onPreviewPrintLayerOrientation?.(processUsesBuildDirection ? manufacturingParameters.layerOrientation ?? "z" : null);
    return () => onPreviewPrintLayerOrientation?.(undefined);
  }, [manufacturingParameters.layerOrientation, onPreviewPrintLayerOrientation, processUsesBuildDirection]);

  function handleMaterialChange(materialId: string) {
    const material = materialForId(materialId, materials);
    if (!material) return;
    const previousProcessId = manufacturingParameters.manufacturingProcessId;
    const canKeepProcess = previousProcessId ? isManufacturingProcessCompatible(material, previousProcessId) : false;
    const nextProcessId = canKeepProcess ? previousProcessId! : defaultManufacturingProcessIdFor(material);
    const nextParameters = canKeepProcess
      ? normalizeManufacturingParameters(material, { ...manufacturingParameters, manufacturingProcessId: nextProcessId })
      : defaultManufacturingParametersFor(material, nextProcessId);
    setSelectedMaterialId(materialId);
    setManufacturingParameters(nextParameters);
    if (previousProcessId && !canKeepProcess) {
      const previousProcess = manufacturingProcessForId(previousProcessId);
      const nextProcess = manufacturingProcessForId(nextProcessId);
      setCompatibilityNote(`${previousProcess?.label ?? "The selected process"} is not available for ${material.name}. Switched to ${nextProcess?.label ?? "a compatible process"}.`);
    } else {
      setCompatibilityNote(null);
    }
  }

  function handleProcessChange(processId: ManufacturingProcessId) {
    setManufacturingParameters(defaultManufacturingParametersFor(selectedMaterial, processId));
    setCompatibilityNote(null);
  }

  function updateManufacturingParameters(patch: Partial<ManufacturingParameters>) {
    setManufacturingParameters((previous) => normalizeManufacturingParameters(selectedMaterial, { ...previous, ...patch }));
  }

  return (
    <Panel title="Material" helper="Choose the material, then how it is made.">
      <SectionTitle helpId="materialLibrary">Base Material</SectionTitle>
      <div className="base-material-card">
        <button className="base-material-selector" type="button" onClick={() => setShowLibrary(true)} aria-label={`Change base material. Current material: ${selectedMaterial.name}`}>
          <span className="base-material-icon"><Atom size={20} aria-hidden="true" /></span>
          <span className="base-material-name">
            <strong>{selectedMaterial.name}</strong>
            <small>{materialCategoryLabel(selectedMaterial)}</small>
          </span>
          <span className="base-material-change">Change <ChevronRight size={15} aria-hidden="true" /></span>
        </button>
        <div className="base-material-properties">
          <Info label="Modulus" value={formatMaterialStress(selectedMaterial.youngsModulus, project.unitSystem)} />
          <Info label="Density" value={formatDensity(selectedMaterial.density, "kg/m^3", project.unitSystem)} />
          <Info label="Yield strength" value={formatMaterialStress(selectedMaterial.yieldStrength, project.unitSystem)} />
        </div>
      </div>

      <SectionTitle helpId="manufacturingProcess">Manufacturing Process</SectionTitle>
      <p className="material-process-helper">Compatible with {selectedMaterial.name}. Only validated options are shown.</p>
      <div className="material-process-list" role="radiogroup" aria-label="Manufacturing process">
        {compatibleProcesses.map((process) => {
          const active = process.id === selectedProcessId;
          return (
            <button
              key={process.id}
              className={`material-process-option ${active ? "active" : ""}`}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => handleProcessChange(process.id)}
            >
              <span className="material-process-radio" aria-hidden="true">{active ? <Check size={14} /> : null}</span>
              <span className="material-process-icon"><ManufacturingProcessIcon processId={process.id} /></span>
              <span className="material-process-copy">
                <strong>{process.label}</strong>
                <small>{process.description}</small>
              </span>
            </button>
          );
        })}
      </div>
      {compatibilityNote ? <p className="material-compatibility-note" role="status">{compatibilityNote}</p> : null}

      {processUsesBuildDirection ? (
        <>
          <SectionTitle helpId="printSettings">{selectedProcess.shortLabel} Settings</SectionTitle>
          <div className="print-settings">
            <div className={`print-settings-grid ${selectedProcess.settingsKind === "fdm" ? "" : "build-direction-only"}`}>
              {selectedProcess.settingsKind === "fdm" ? (
                <>
                  <label className="field">
                    <HelpLabel helpId="infillDensity">Infill density</HelpLabel>
                    <span className="input-with-unit">
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={manufacturingParameters.infillDensity ?? 100}
                        onChange={(event) => updateManufacturingParameters({ infillDensity: Number(event.currentTarget.value) })}
                      />
                      <span>%</span>
                    </span>
                  </label>
                  <label className="field">
                    <HelpLabel helpId="wallCount">Wall count</HelpLabel>
                    <span className="input-with-unit">
                      <input
                        type="number"
                        min="1"
                        max="12"
                        value={manufacturingParameters.wallCount ?? 1}
                        onChange={(event) => updateManufacturingParameters({ wallCount: Number(event.currentTarget.value) })}
                      />
                      <span>walls</span>
                    </span>
                  </label>
                </>
              ) : null}
              <label className="field">
                <HelpLabel helpId="layerDirection">Build direction</HelpLabel>
                <select
                  value={manufacturingParameters.layerOrientation ?? "z"}
                  onChange={(event) => updateManufacturingParameters({ layerOrientation: event.currentTarget.value as ManufacturingParameters["layerOrientation"] })}
                >
                  <option value="z">Z build direction</option>
                  <option value="x">X build direction</option>
                  <option value="y">Y build direction</option>
                </select>
              </label>
            </div>
          </div>
        </>
      ) : null}

      <SectionTitle>Simulation Properties</SectionTitle>
      <div className="summary-box material-simulation-properties">
        {fdmFactors ? <Info label="Governing load path" value={fdmFactors.criticalAxis ? `${fdmFactors.criticalAxis.toUpperCase()} axis` : "Conservative"} /> : null}
        {fdmFactors ? <Info label="Layer response" value={fdmLayerResponseLabel(fdmFactors.loadPathRelation)} /> : null}
        <Info label="Effective modulus" value={formatMaterialStress(effectiveMaterial.youngsModulus, project.unitSystem)} />
        <Info label="Effective density" value={formatDensity(effectiveMaterial.density, "kg/m^3", project.unitSystem)} />
        <Info label="Effective yield" value={formatMaterialStress(effectiveMaterial.yieldStrength, project.unitSystem)} />
        <Info label="Poisson ratio" value={String(selectedMaterial.poissonRatio)} />
      </div>

      <button className="primary wide material-apply-button" type="button" onClick={() => onAssignMaterial(selectedMaterialId, manufacturingParametersForAssignment(selectedMaterial, manufacturingParameters))}>Apply material &amp; process</button>
      <MaterialLibraryModal
        open={showLibrary}
        selectedMaterialId={selectedMaterialId}
        assignedSelectionLabel={assignedSelectionLabel}
        unitSystem={project.unitSystem}
        materials={materials}
        customMaterialIds={project.customMaterials?.map((material) => material.id)}
        assignedMaterialIds={project.studies.flatMap((candidate) => candidate.materialAssignments.map((assignment) => assignment.materialId))}
        onSaveCustomMaterial={onSaveCustomMaterial}
        onDeleteCustomMaterial={onDeleteCustomMaterial}
        onApply={(materialId) => {
          handleMaterialChange(materialId);
          setShowLibrary(false);
        }}
        onClose={() => setShowLibrary(false)}
      />
      <SectionTitle>Assigned</SectionTitle>
      {currentAssignment && !resolvedAssignedMaterial ? <Callout>Unknown material “{currentAssignment.materialId}”. Choose a valid material before solving.</Callout> : null}
      {currentAssignment ? (
        <div className="concept-card-list">
          <ConceptCard icon={<Check size={18} />} title={resolvedAssignedMaterial?.name ?? currentAssignment.materialId} detail={`${assignedSelectionLabel} · ${resolvedAssignedMaterial ? assignedDetail : "Unresolved material"}`} tone="accent" />
        </div>
      ) : (
        <Callout>No material assigned</Callout>
      )}
    </Panel>
  );
}

function fdmLayerResponseLabel(relation: "within_layers" | "across_layers" | "conservative") {
  if (relation === "within_layers") return "Within layers";
  if (relation === "across_layers") return "Across layers · weakest";
  return "Across layers · conservative";
}

function ManufacturingProcessIcon({ processId }: { processId: ManufacturingProcessId }) {
  if (processId === "cnc_machining") return <Wrench size={18} aria-hidden="true" />;
  if (processId === "injection_molding") return <Factory size={18} aria-hidden="true" />;
  return <Layers3 size={18} aria-hidden="true" />;
}

function SupportsPanel({ selectedFace, study, onAddSupport, onUpdateSupport, onRemoveSupport }: RightPanelProps) {
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const addLabel = study.constraints.length ? "Add another fixed support" : "Add fixed support";
  return (
    <Panel title="Supports" helper="Choose where the part is held fixed. Select a face, or click inside a cylindrical hole to constrain its wall. You can add more than one support.">
      <HelpNote helpId="supportPlacement" />
      <PlacementReadout selectedRef={selectedFromViewport} fallbackLabel={selectedFace?.label} />
      <button className="outline-action wide" disabled={!selectedFromViewport} onClick={() => selectedFromViewport && onAddSupport(selectedFromViewport.id)}><Plus size={18} />{addLabel}</button>
      <SupportEditorList study={study} onUpdateSupport={onUpdateSupport} onRemoveSupport={onRemoveSupport} />
      <Callout>Fixed supports prevent any motion of the selected face.</Callout>
    </Panel>
  );
}

function LoadsPanel({
  project,
  displayModel,
  selectedFace,
  study,
  draftLoadType,
  draftLoadValue,
  draftLoadDirection,
  selectedLoadPoint,
  selectedPayloadObject,
  onDraftLoadTypeChange,
  onDraftLoadValueChange,
  onDraftLoadDirectionChange,
  onDraftPayloadPreviewChange = noopDraftPayloadPreviewChange,
  onAddLoad,
  onUpdateLoad,
  onPreviewLoadEdit,
  onRemoveLoad,
  onLoadCasesChange
}: RightPanelProps) {
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const placementSelection = draftLoadType === "gravity" ? undefined : selectedFromViewport;
  const units = unitsForLoadType(draftLoadType);
  const valueLabel = draftLoadType === "gravity" ? "Payload mass" : "Magnitude";
  const addLabel = draftLoadType === "gravity" ? "Add payload mass" : "Add load";
  const [payloadMaterialId, setPayloadMaterialId] = useState("payload-steel");
  const [payloadMassMode, setPayloadMassMode] = useState<PayloadMassMode>("material");
  const payloadVolumeM3 = selectedPayloadObject?.volumeM3;
  const calculatedPayloadMass = payloadVolumeM3 ? massKgForPayloadMaterial(payloadMaterialId, payloadVolumeM3) : 0;
  const effectiveDraftValue = draftLoadType === "gravity" && payloadMassMode === "material" && calculatedPayloadMass > 0 ? calculatedPayloadMass : draftLoadValue;
  const displayDraftLoad = loadValueForUnits(effectiveDraftValue, units, project.unitSystem);
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const canAddPayloadMass = payloadMassMode === "manual" ? draftLoadValue > 0 : calculatedPayloadMass > 0;
  const canAddDraftLoad = draftLoadType === "gravity" ? Boolean(selectedPayloadObject) && canAddPayloadMass : Boolean(selectedFace && selectedLoadPoint);
  const payloadMetadata: PayloadLoadMetadata = draftLoadType === "gravity"
    ? {
      payloadMaterialId,
      ...(payloadVolumeM3 ? { payloadVolumeM3 } : {}),
      payloadMassMode
    }
    : {};
  function handleDraftValueChange(displayValue: number) {
    const baseValue = loadValueForUnits(displayValue, displayDraftLoad.units, "SI");
    onDraftLoadValueChange(baseValue.value);
  }
  useEffect(() => {
    onDraftPayloadPreviewChange(
      draftLoadType === "gravity"
        ? { value: effectiveDraftValue, metadata: payloadMetadata }
        : null
    );
  }, [draftLoadType, effectiveDraftValue, onDraftPayloadPreviewChange, payloadMassMode, payloadMaterialId, payloadVolumeM3]);
  const loadCases = study.type === "modal_analysis" ? [] : structuralLoadCasesForPanel(study);
  const loadCombinations = study.type === "static_stress" ? study.loadCombinations ?? [] : [];
  function assignLoadToCase(loadId: string, caseId: string) {
    if (!onLoadCasesChange) return;
    onLoadCasesChange(loadCases.map((loadCase) => ({
      ...loadCase,
      loadIds: loadCase.id === caseId
        ? [...loadCase.loadIds.filter((id) => id !== loadId), loadId]
        : loadCase.loadIds.filter((id) => id !== loadId)
    })), loadCombinations);
  }
  return (
    <Panel title="Loads" helper={draftLoadType === "gravity" ? "Choose the object carrying payload mass, then add its weight as a load." : "Select a point on the model, then click Add load."}>
      <HelpNote helpId="loadPlacement" />
      <PlacementReadout
        selectedRef={placementSelection}
        fallbackLabel={selectedPayloadObject?.label ?? selectedFace?.label}
        detail={selectedPayloadObject ? "object selected" : selectedLoadPoint ? "point picked" : undefined}
      />
      <div className="field">
        <HelpLabel helpId="loadType">Load type</HelpLabel>
        <div className="segmented" role="group" aria-label="Load type">
          {(["force", "pressure", "gravity"] as const).map((type) => (
            <button
              key={type}
              className={draftLoadType === type ? "active" : ""}
              type="button"
              aria-pressed={draftLoadType === type}
              onClick={() => {
                onDraftLoadTypeChange(type);
                if (type !== draftLoadType) onDraftLoadValueChange(defaultValueForLoadType(type));
              }}
            >
              {loadTypeLabel(type)}
            </button>
          ))}
        </div>
      </div>
      {draftLoadType === "gravity" ? (
        <PayloadMassControls
          unitSystem={project.unitSystem}
          payloadObject={selectedPayloadObject}
          payloadMaterialId={payloadMaterialId}
          payloadMassMode={payloadMassMode}
          manualMassKg={draftLoadValue}
          onPayloadMaterialChange={setPayloadMaterialId}
          onPayloadMassModeChange={setPayloadMassMode}
          onManualMassChange={handleDraftValueChange}
        />
      ) : (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">{valueLabel}</HelpLabel>
          <span className="input-with-unit">
            <input
              id="load-value"
              type="number"
              value={formatInputValue(displayDraftLoad.value)}
              onChange={(event) => handleDraftValueChange(Number(event.currentTarget.value))}
            />
            <span>{displayDraftLoad.units}</span>
          </span>
        </label>
      )}
      {draftLoadType === "gravity" && (
        <>
          <Info label="Selected density" value={formatDensity(selectedPayloadMaterial.density, "kg/m^3", project.unitSystem)} />
          <Info label="Calculated mass" value={formatMass(calculatedPayloadMass, "kg", project.unitSystem)} />
          <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: effectiveDraftValue } }), project.unitSystem)} equivalent weight.</Callout>
        </>
      )}
      <label className="field">
        <HelpLabel helpId="loadDirection">Direction</HelpLabel>
        <select value={draftLoadDirection} onChange={(event) => onDraftLoadDirectionChange(event.currentTarget.value as LoadDirectionLabel)}>
          {LOAD_DIRECTION_LABELS.map((option) => (
            <option key={option} value={option}>{directionOptionLabel(option)}</option>
          ))}
        </select>
      </label>
      <button className="outline-action wide" disabled={!canAddDraftLoad} onClick={() => canAddDraftLoad && onAddLoad(draftLoadType, effectiveDraftValue, selectedFromViewport?.id, draftLoadDirection, payloadMetadata)}><Plus size={18} />{addLabel}</button>
      {study.type !== "modal_analysis" && (
        <LoadCasesEditor
          studyType={study.type}
          loadCases={loadCases}
          loadCombinations={loadCombinations}
          onChange={(cases, combinations) => onLoadCasesChange?.(cases, combinations)}
        />
      )}
      <LoadEditorList study={study} displayModel={displayModel} unitSystem={project.unitSystem} loadCases={loadCases} onAssignLoadToCase={assignLoadToCase} onUpdateLoad={onUpdateLoad} onPreviewLoadEdit={onPreviewLoadEdit} onRemoveLoad={onRemoveLoad} />
    </Panel>
  );
}

const PAYLOAD_CATEGORY_ORDER: PayloadMaterialCategory[] = ["metal", "plastic", "composite", "resin", "ceramic-glass", "semiconductor", "rubber", "wood", "concrete-stone", "liquid", "misc"];

function PayloadMassControls({
  unitSystem,
  payloadObject,
  payloadMaterialId,
  payloadMassMode,
  manualMassKg,
  onPayloadMaterialChange,
  onPayloadMassModeChange,
  onManualMassChange
}: {
  unitSystem: UnitSystem;
  payloadObject: PayloadObjectSelection | null;
  payloadMaterialId: string;
  payloadMassMode: PayloadMassMode;
  manualMassKg: number;
  onPayloadMaterialChange: (materialId: string) => void;
  onPayloadMassModeChange: (mode: PayloadMassMode) => void;
  onManualMassChange: (displayValue: number) => void;
}) {
  const materialListId = useId();
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const [materialQuery, setMaterialQuery] = useState(selectedPayloadMaterial.name);
  const displayManualMass = loadValueForUnits(manualMassKg, "kg", unitSystem);
  const volumeSource = payloadObject?.volumeStatus === "estimated" ? "estimated from bounds" : payloadObject?.volumeSource ?? "not available";

  useEffect(() => {
    setMaterialQuery(selectedPayloadMaterial.name);
  }, [selectedPayloadMaterial.name]);

  function handleMaterialInput(value: string) {
    setMaterialQuery(value);
    const exactMaterial = payloadMaterials.find((material) => material.name.toLowerCase() === value.trim().toLowerCase());
    if (exactMaterial && exactMaterial.id !== payloadMaterialId) {
      onPayloadMaterialChange(exactMaterial.id);
    }
  }

  return (
    <>
      <label className="field">
        <HelpLabel helpId="loadMagnitude">Payload material</HelpLabel>
        <input
          list={materialListId}
          value={materialQuery}
          onChange={(event) => handleMaterialInput(event.currentTarget.value)}
          onBlur={() => setMaterialQuery(payloadMaterialForId(payloadMaterialId).name)}
        />
        <datalist id={materialListId}>
          {PAYLOAD_CATEGORY_ORDER.flatMap((category) =>
            payloadMaterials
              .filter((material) => material.category === category)
              .map((material) => (
                <option key={material.id} value={material.name} />
              ))
          )}
        </datalist>
      </label>
      <Info label="Payload volume" value={payloadObject?.volumeM3 ? `${formatVolume(payloadObject.volumeM3, "m^3", unitSystem)} · ${volumeSource}` : "Select a closed object or use manual mass"} />
      <Callout>Disconnected payload objects are carried weight, not bonded structure. Add each rod or carried part separately; unselected objects do not add weight to the solve.</Callout>
      <label className="toggle material-print-toggle">
        <input
          type="checkbox"
          checked={payloadMassMode === "manual"}
          onChange={(event) => onPayloadMassModeChange(event.currentTarget.checked ? "manual" : "material")}
        />
        <span>
          <strong>Manual mass override</strong>
          <small>Use a measured mass instead of material density times model volume.</small>
        </span>
      </label>
      {payloadMassMode === "manual" && (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">Payload mass</HelpLabel>
          <span className="input-with-unit">
            <input type="number" value={formatInputValue(displayManualMass.value)} onChange={(event) => onManualMassChange(Number(event.currentTarget.value))} />
            <span>{displayManualMass.units}</span>
          </span>
        </label>
      )}
    </>
  );
}

function LoadCasesEditor({ studyType, loadCases, loadCombinations, onChange }: {
  studyType: "static_stress" | "dynamic_structural";
  loadCases: LoadCase[];
  loadCombinations: LoadCombination[];
  onChange: (loadCases: LoadCase[], loadCombinations: LoadCombination[]) => void;
}) {
  const referencedCaseIds = new Set(loadCombinations.flatMap((combination) => combination.factors.map((factor) => factor.caseId)));
  const updateCase = (caseId: string, patch: Partial<LoadCase>) => onChange(
    loadCases.map((loadCase) => loadCase.id === caseId ? { ...loadCase, ...patch } : loadCase),
    loadCombinations
  );
  const updateCombination = (combinationId: string, patch: Partial<LoadCombination>) => onChange(
    loadCases,
    loadCombinations.map((combination) => combination.id === combinationId ? { ...combination, ...patch } : combination)
  );
  return (
    <section className="load-case-editor" aria-label="Load cases">
      <SectionTitle>Load cases</SectionTitle>
      {loadCases.map((loadCase) => {
        const canDelete = loadCases.length > 1 && loadCase.loadIds.length === 0 && !referencedCaseIds.has(loadCase.id);
        return (
          <div className="load-case-row" key={loadCase.id}>
            <input aria-label={`Load case name ${loadCase.name}`} value={loadCase.name} onChange={(event) => updateCase(loadCase.id, { name: event.currentTarget.value || "Untitled case" })} />
            <label className="toggle compact-toggle">
              <input type="checkbox" checked={loadCase.enabled} onChange={(event) => updateCase(loadCase.id, { enabled: event.currentTarget.checked })} />
              <span>Enabled</span>
            </label>
            <small>{loadCase.loadIds.length} load{loadCase.loadIds.length === 1 ? "" : "s"}</small>
            <button type="button" className="remove-glyph" aria-label={`Delete load case ${loadCase.name}`} disabled={!canDelete} onClick={() => onChange(loadCases.filter((candidate) => candidate.id !== loadCase.id), loadCombinations)}><X size={15} /></button>
          </div>
        );
      })}
      <button className="secondary wide" type="button" onClick={() => onChange([
        ...loadCases,
        { id: `case-${crypto.randomUUID()}`, name: `Case ${loadCases.length + 1}`, enabled: true, loadIds: [] }
      ], loadCombinations)}><Plus size={16} />Add load case</button>
      {studyType === "static_stress" && (
        <>
          <SectionTitle>Combinations</SectionTitle>
          {loadCombinations.map((combination) => (
            <div className="load-combination-row" key={combination.id}>
              <input aria-label={`Combination name ${combination.name}`} value={combination.name} onChange={(event) => updateCombination(combination.id, { name: event.currentTarget.value || "Untitled combination" })} />
              <label className="toggle compact-toggle">
                <input type="checkbox" checked={combination.enabled} onChange={(event) => updateCombination(combination.id, { enabled: event.currentTarget.checked })} />
                <span>Enabled</span>
              </label>
              {combination.factors.map((factor) => (
                <label className="combination-factor" key={factor.caseId}>
                  <span>{loadCases.find((loadCase) => loadCase.id === factor.caseId)?.name ?? factor.caseId}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={factor.factor}
                    onChange={(event) => updateCombination(combination.id, {
                      factors: combination.factors.map((candidate) => candidate.caseId === factor.caseId
                        ? { ...candidate, factor: Number.isFinite(Number(event.currentTarget.value)) ? Number(event.currentTarget.value) : 0 }
                        : candidate)
                    })}
                  />
                </label>
              ))}
              <button type="button" className="secondary" onClick={() => onChange(loadCases, loadCombinations.filter((candidate) => candidate.id !== combination.id))}>Delete combination</button>
            </div>
          ))}
          <button className="secondary wide" type="button" disabled={!loadCases.length} onClick={() => onChange(loadCases, [
            ...loadCombinations,
            {
              id: `combination-${crypto.randomUUID()}`,
              name: `Combination ${loadCombinations.length + 1}`,
              enabled: true,
              factors: loadCases.slice(0, 2).map((loadCase) => ({ caseId: loadCase.id, factor: 1 }))
            }
          ])}><Plus size={16} />Add combination</button>
        </>
      )}
    </section>
  );
}

function structuralLoadCasesForPanel(study: Extract<Study, { type: "static_stress" | "dynamic_structural" }>): LoadCase[] {
  return study.loadCases?.length
    ? study.loadCases
    : [{ id: "case-default", name: "Default", enabled: true, loadIds: study.loads.map((load) => load.id) }];
}

function LoadEditorList({ study, displayModel, unitSystem, loadCases, onAssignLoadToCase, onUpdateLoad, onPreviewLoadEdit, onRemoveLoad }: { study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; loadCases: LoadCase[]; onAssignLoadToCase: (loadId: string, caseId: string) => void; onUpdateLoad: (load: Load) => void; onPreviewLoadEdit: (load: Load | null) => void; onRemoveLoad: (loadId: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!study.loads.length) return <EmptyEditableList title="Loads" />;
  const loadLabelsById = new Map(createViewerLoadMarkers({ study, displayModel }).map((marker) => [marker.id, loadMarkerOrdinalLabel(marker)]));

  return (
    <div className="editable-list">
      <h3>Loads</h3>
      {study.loads.map((load) => {
        const editing = editingId === load.id;
        const units = String(load.parameters.units ?? unitsForLoadType(load.type));
        const displayLoad = loadValueForUnits(Number(load.parameters.value ?? 0), units, unitSystem);
        const selection = study.namedSelections.find((candidate) => candidate.id === load.selectionRef);
        const selectedFace = displayModel.faces.find((candidate) => candidate.id === selection?.geometryRefs[0]?.entityId);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        const payloadObject = payloadObjectForLoad(load);
        const payloadMaterial = load.type === "gravity" && typeof load.parameters.payloadMaterialId === "string" ? payloadMaterialForId(load.parameters.payloadMaterialId).name : "";
        const pointLabel = payloadObject
          ? ` · ${payloadObject.label}${payloadMaterial ? ` · ${payloadMaterial}` : ""}`
          : applicationPointForLoad(load) ? " · point load" : "";
        const equivalentForce = load.type === "gravity" ? ` · ${formatEquivalentForce(equivalentForceForLoad(load), unitSystem)} weight` : "";
        const loadLabel = loadLabelsById.get(load.id);
        const loadCaseId = loadCases.find((loadCase) => loadCase.loadIds.includes(load.id))?.id ?? loadCases[0]?.id ?? "";
        const editLabel = `Edit ${loadLabel ? `${loadLabel} ` : ""}${load.type} load`;
        const beginEdit = () => setEditingId(load.id);
        return (
          <div
            className={`editable-item load-item ${editing ? "" : "clickable"}`}
            key={load.id}
            role={editing ? undefined : "button"}
            tabIndex={editing ? undefined : 0}
            aria-label={editing ? undefined : editLabel}
            onClick={editing ? undefined : beginEdit}
            onKeyDown={editing ? undefined : (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              beginEdit();
            }}
          >
            <div className="editable-summary">
              <span className={`item-icon load-type-icon ${load.type}`}><LoadTypeIcon type={load.type} /></span>
              <strong>{loadLabel ? `${loadLabel} · ` : ""}{loadTypeLabel(load.type)} · {formatNumber(displayLoad.value)} {displayLoad.units}</strong>
              <small>{label}{pointLabel} · {directionOptionLabel(directionLabelForLoad(load, displayModel, selectedFace))} direction{equivalentForce}</small>
              {loadCases.length > 1 && (
                <label className="load-case-assignment" onClick={(event) => event.stopPropagation()}>
                  <span>Case</span>
                  <select value={loadCaseId} onChange={(event) => onAssignLoadToCase(load.id, event.currentTarget.value)}>
                    {loadCases.map((loadCase) => <option key={loadCase.id} value={loadCase.id}>{loadCase.name}</option>)}
                  </select>
                </label>
              )}
              <button
                className="remove-glyph"
                type="button"
                aria-label={`Remove ${loadTypeLabel(load.type)} load`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveLoad(load.id);
                }}
              >
                <X size={16} />
              </button>
            </div>
            {editing ? (
              <LoadEditForm
                load={load}
                study={study}
                displayModel={displayModel}
                unitSystem={unitSystem}
                onPreviewChange={onPreviewLoadEdit}
                onCancel={() => setEditingId(null)}
                onSave={(nextLoad) => {
                  onPreviewLoadEdit(null);
                  onUpdateLoad(nextLoad);
                  setEditingId(null);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function LoadEditForm({ load, study, displayModel, unitSystem, onSave, onCancel, onPreviewChange }: { load: Load; study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; onSave: (load: Load) => void; onCancel: () => void; onPreviewChange: (load: Load | null) => void }) {
  const [type, setType] = useState<"force" | "pressure" | "gravity">(load.type);
  const [value, setValue] = useState(() => {
    const initialUnits = String(load.parameters.units ?? unitsForLoadType(load.type));
    return formatInputValue(loadValueForUnits(Number(load.parameters.value ?? 500), initialUnits, unitSystem).value);
  });
  const selectedRef = study.namedSelections.find((selection) => selection.id === load.selectionRef);
  const selectedFace = selectedRef?.geometryRefs[0];
  const selectedDisplayFace = displayModel.faces.find((face) => face.id === selectedFace?.entityId);
  const [direction, setDirection] = useState<LoadDirectionLabel>(directionLabelForLoad(load, displayModel, selectedDisplayFace));
  const [payloadMaterialId, setPayloadMaterialId] = useState(String(load.parameters.payloadMaterialId ?? "payload-steel"));
  const [payloadMassMode, setPayloadMassMode] = useState<PayloadMassMode>(load.parameters.payloadMassMode === "manual" ? "manual" : "material");
  const units = unitsForLoadType(type);
  const displayUnits = loadValueForUnits(defaultValueForLoadType(type), units, unitSystem).units;
  const payloadObject = payloadObjectForLoad(load) ?? null;
  const payloadVolumeM3 = positiveNumber(load.parameters.payloadVolumeM3) ? load.parameters.payloadVolumeM3 : payloadObject?.volumeM3;
  const calculatedPayloadMass = payloadVolumeM3 ? massKgForPayloadMaterial(payloadMaterialId, payloadVolumeM3) : 0;
  const manualMassKg = loadValueForUnits(Number(value), displayUnits, "SI").value;
  const editedValue = type === "gravity" && payloadMassMode === "material" && calculatedPayloadMass > 0 ? calculatedPayloadMass : manualMassKg;
  // Memoized on scalar inputs: a fresh object here would retrigger the preview effect every render and loop with the parent setState.
  const payloadMetadata = useMemo<PayloadLoadMetadata>(() => type === "gravity"
    ? { payloadMaterialId, ...(payloadVolumeM3 ? { payloadVolumeM3 } : {}), payloadMassMode }
    : {}, [payloadMassMode, payloadMaterialId, payloadVolumeM3, type]);
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const directionFace: DisplayFace = useMemo(() => selectedDisplayFace ?? ({
    id: selectedFace?.entityId ?? "selected-face",
    label: selectedFace?.label ?? "selected face",
    color: "#fff",
    center: [0, 0, 0],
    normal: [0, 1, 0],
    stressValue: 0
  }), [selectedDisplayFace, selectedFace?.entityId, selectedFace?.label]);
  const previewLoad = useMemo(() => editedLoadForForm(load, type, value, displayUnits, units, direction, directionFace, displayModel, payloadMetadata, editedValue), [direction, directionFace, displayModel, displayUnits, editedValue, load, payloadMetadata, type, units, value]);

  useEffect(() => {
    onPreviewChange(previewLoad);
    return () => onPreviewChange(null);
  }, [onPreviewChange, previewLoad]);

  return (
    <div className="edit-form">
      <label className="field">
        <HelpLabel helpId="loadType">Load type</HelpLabel>
        <select value={type} onChange={(event) => setType(event.currentTarget.value as "force" | "pressure" | "gravity")}>
          <option value="force">Force</option>
          <option value="pressure">Pressure</option>
          <option value="gravity">Payload mass</option>
        </select>
      </label>
      {type === "gravity" ? (
        <>
          <PayloadMassControls
            unitSystem={unitSystem}
            payloadObject={payloadObject}
            payloadMaterialId={payloadMaterialId}
            payloadMassMode={payloadMassMode}
            manualMassKg={manualMassKg}
            onPayloadMaterialChange={setPayloadMaterialId}
            onPayloadMassModeChange={setPayloadMassMode}
            onManualMassChange={(displayValue) => setValue(formatInputValue(displayValue))}
          />
          <Info label="Selected density" value={formatDensity(selectedPayloadMaterial.density, "kg/m^3", unitSystem)} />
          <Info label="Calculated mass" value={formatMass(calculatedPayloadMass, "kg", unitSystem)} />
          <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: editedValue } }), unitSystem)} equivalent weight.</Callout>
        </>
      ) : (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">Magnitude</HelpLabel>
          <span className="input-with-unit">
            <input type="number" value={value} onChange={(event) => setValue(event.currentTarget.value)} />
            <span>{displayUnits}</span>
          </span>
        </label>
      )}
      <PlacementReadout selectedRef={selectedRef} />
      <label className="field">
        <HelpLabel helpId="loadDirection">Direction</HelpLabel>
        <select value={direction} onChange={(event) => setDirection(event.currentTarget.value as LoadDirectionLabel)}>
          {LOAD_DIRECTION_LABELS.map((option) => (
            <option key={option} value={option}>{directionOptionLabel(option)}</option>
          ))}
        </select>
      </label>
      <div className="edit-actions">
        <button
          className="primary"
          type="button"
          onClick={() => onSave(previewLoad)}
        >
          Save
        </button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function editedLoadForForm(load: Load, type: LoadType, value: string, displayUnits: string, units: string, direction: LoadDirectionLabel, directionFace: DisplayFace, displayModel: DisplayModel, payloadMetadata: PayloadLoadMetadata = {}, overrideValue?: number): Load {
  return {
    ...load,
    type,
    parameters: {
      ...load.parameters,
      value: overrideValue ?? loadValueForUnits(Number(value), displayUnits, "SI").value,
      units,
      direction: directionVectorForLabel(direction, directionFace, displayModel),
      directionMode: direction,
      ...(type === "gravity" ? payloadMetadata : {})
    }
  };
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function SupportEditorList({ study, onUpdateSupport, onRemoveSupport }: { study: Study; onUpdateSupport: (support: Constraint) => void; onRemoveSupport: (supportId: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!study.constraints.length) return <EmptyEditableList title="Supports" />;
  let fixedSupportCount = 0;
  let prescribedSupportCount = 0;
  const supportItems = study.constraints.map((support) => {
    const supportOrdinal = support.type === "fixed" ? ++fixedSupportCount : ++prescribedSupportCount;
    return { support, displayLabel: supportDisplayLabel(support, supportOrdinal) };
  });

  return (
    <div className="editable-list">
      <h3>Supports</h3>
      {supportItems.map(({ support, displayLabel }) => {
        const editing = editingId === support.id;
        const selection = study.namedSelections.find((candidate) => candidate.id === support.selectionRef);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        return (
          <div className="editable-item" key={support.id}>
            <div className="editable-summary">
              <span className="item-icon warning"><SupportIcon /></span>
              <strong>{displayLabel} · {support.type === "fixed" ? "Fixed support" : "Prescribed displacement"}</strong>
              <small>{label}</small>
              <button className="remove-glyph" type="button" aria-label="Remove support" onClick={() => onRemoveSupport(support.id)}><X size={16} /></button>
            </div>
            {editing ? (
              <SupportEditForm
                support={support}
                study={study}
                onCancel={() => setEditingId(null)}
                onSave={(nextSupport) => {
                  onUpdateSupport(nextSupport);
                  setEditingId(null);
                }}
              />
            ) : (
              <button className="secondary wide" type="button" onClick={() => setEditingId(support.id)}>Edit support</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LoadTypeIcon({ type }: { type: LoadType }) {
  if (type === "pressure") return <Gauge size={16} />;
  if (type === "gravity") return <Weight size={16} />;
  return <ScanLine size={16} />;
}

function SupportEditForm({ support, study, onSave, onCancel }: { support: Constraint; study: Study; onSave: (support: Constraint) => void; onCancel: () => void }) {
  const [type, setType] = useState<"fixed" | "prescribed_displacement">(support.type);
  const selectedRef = study.namedSelections.find((selection) => selection.id === support.selectionRef);
  return (
    <div className="edit-form">
      <label className="field">
        <HelpLabel helpId="supportType">Support type</HelpLabel>
        <select value={type} onChange={(event) => setType(event.currentTarget.value as "fixed" | "prescribed_displacement")}>
          <option value="fixed">Fixed support</option>
          <option value="prescribed_displacement">Prescribed displacement</option>
        </select>
      </label>
      <PlacementReadout selectedRef={selectedRef} />
      <div className="edit-actions">
        <button className="primary" type="button" onClick={() => onSave({ ...support, type })}>Save</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function EmptyEditableList({ title }: { title: string }) {
  return (
    <div className="editable-list">
      <h3>{title}</h3>
      <p className="muted">None yet</p>
    </div>
  );
}

function selectionForFace(study: Study, faceId: string) {
  return study.namedSelections.find((item) => item.entityType === "face" && item.geometryRefs.some((ref) => ref.entityId === faceId));
}

function MeshPanel({ project, displayModel, study, onGenerateMesh, onCancelMesh, meshPhaseProgress, onRepairModel, isRepairingModel = false, onRunMeshConvergence, convergenceBusy = false, convergenceProgress = "" }: RightPanelProps) {
  const [preset, setPreset] = useState<MeshQuality>(study.meshSettings.preset);
  const meshing = Boolean(meshPhaseProgress);
  const stepGeometry = stepGeometryMetadataForProject(project);
  const stepGeometryResolvedByMesh = Boolean(study.meshSettings.summary?.artifacts?.actualCoreModel);
  const staticStudy = study.type === "static_stress" ? study : null;
  const convergenceCases = staticStudy ? structuralLoadCasesForPanel(staticStudy).filter((loadCase) => loadCase.enabled && loadCase.loadIds.length) : [];
  const [convergenceCaseId, setConvergenceCaseId] = useState(convergenceCases[0]?.id ?? "");
  const initialProbe = staticStudy && convergenceCaseId ? defaultConvergenceProbe(staticStudy, convergenceCaseId, displayModel) : null;
  const [probeCoordinates, setProbeCoordinates] = useState<[string, string, string]>(() => initialProbe
    ? initialProbe.point.map((value) => String(value)) as [string, string, string]
    : ["", "", ""]);
  const [probeEdited, setProbeEdited] = useState(false);
  useEffect(() => {
    if (!staticStudy || !convergenceCases.length) return;
    const caseId = convergenceCases.some((loadCase) => loadCase.id === convergenceCaseId) ? convergenceCaseId : convergenceCases[0]!.id;
    if (caseId !== convergenceCaseId) setConvergenceCaseId(caseId);
    const probe = defaultConvergenceProbe(staticStudy, caseId, displayModel);
    setProbeCoordinates(probe ? probe.point.map((value) => String(value)) as [string, string, string] : ["", "", ""]);
    setProbeEdited(false);
  }, [displayModel, staticStudy?.id, staticStudy?.loads, staticStudy?.loadCases, convergenceCaseId]);
  const probePoint = probeCoordinates.map(Number) as [number, number, number];
  const validProbe = probeCoordinates.every((value) => value.trim() !== "") && probePoint.every(Number.isFinite);
  const latestRecord = [...(project.convergenceRecords ?? [])]
    .reverse()
    .find((record) => record.studyId === study.id && record.caseId === convergenceCaseId);

  function selectConvergenceCase(caseId: string) {
    setConvergenceCaseId(caseId);
    if (!staticStudy) return;
    const probe = defaultConvergenceProbe(staticStudy, caseId, displayModel);
    setProbeCoordinates(probe ? probe.point.map((value) => String(value)) as [string, string, string] : ["", "", ""]);
    setProbeEdited(false);
  }

  function runConvergence() {
    if (!staticStudy || !validProbe || !convergenceCaseId) return;
    const fallback = defaultConvergenceProbe(staticStudy, convergenceCaseId, displayModel);
    onRunMeshConvergence?.(convergenceCaseId, {
      point: probePoint,
      source: probeEdited ? "explicit" : fallback?.source ?? "explicit",
      ...(probeEdited ? { label: "Explicit displacement probe" } : fallback?.label ? { label: fallback.label } : {})
    });
  }

  return (
    <Panel title="Mesh" helper="The mesh breaks the model into small pieces so OpenCAE can calculate results.">
      <div className="field">
        <HelpLabel helpId="meshQuality">Quality preset</HelpLabel>
        <div className="segmented mesh-quality" role="group" aria-label="Mesh quality">
          {MESH_PRESETS.map((option) => (
            <button key={option} className={preset === option ? "active" : ""} type="button" aria-pressed={preset === option} disabled={meshing || convergenceBusy} onClick={() => setPreset(option)}>{capitalize(option)}</button>
          ))}
        </div>
      </div>
      <button
        className="primary wide"
        type="button"
        disabled={convergenceBusy || (meshing && !onCancelMesh)}
        aria-label={meshing ? "Stop mesh generation" : "Generate mesh"}
        onClick={() => meshing ? onCancelMesh?.() : onGenerateMesh(preset)}
      >
        {meshing ? <X size={18} /> : <Grid3X3 size={18} />}
        {meshing ? "Stop meshing" : "Generate mesh"}
      </button>
      {stepGeometry?.status === "repairable" && !stepGeometryResolvedByMesh && (
        <div className="step-repair-card" role="alert" aria-label="Open STEP surfaces detected">
          <p className="panel-warning"><AlertTriangle size={16} />{stepGeometry.message ?? "This STEP model has open or invalid surfaces and is not a closed simulation solid."}</p>
          <button className="outline-action wide" type="button" onClick={onRepairModel} disabled={isRepairingModel || !onRepairModel}>
            <Wrench size={16} />
            {isRepairingModel ? "Fixing model..." : "Fix open surfaces"}
          </button>
          <p className="panel-copy">Fix model sews small gaps and may patch closed boundary loops. Review the repaired shape; face-based setup will be reset.</p>
        </div>
      )}
      {(stepGeometry?.status === "unrepairable" || stepGeometry?.status === "invalid") && !stepGeometryResolvedByMesh && (
        <p className="panel-warning" role="alert"><AlertTriangle size={16} />{stepGeometry.message ?? "Automatic repair cannot close this model. Re-export it from CAD as a solid body."}</p>
      )}
      {meshPhaseProgress && (
        <>
          {/* Honest phase progress: worker phase position, not a synthetic percent —
              phase durations vary with geometry and quality retries revisit phases. */}
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={meshPhaseProgress.phaseCount}
            aria-valuenow={meshPhaseProgress.phaseIndex + 1}
            aria-valuetext={meshPhaseProgress.message}
            aria-label="Mesh generation progress"
          >
            <span style={{ width: `${Math.round(((meshPhaseProgress.phaseIndex + 1) / meshPhaseProgress.phaseCount) * 100)}%` }} />
            <strong className="progress-label">{meshPhaseProgress.phaseIndex + 1} / {meshPhaseProgress.phaseCount}</strong>
          </div>
          <p className="panel-copy mesh-progress-message" aria-live="polite">{meshPhaseProgress.message}</p>
        </>
      )}
      <Callout>{capitalize(preset)} creates a {meshPresetDescription(preset)}.</Callout>
      {study.meshSettings.summary && (
        <div className="summary-box">
          <Info
            label={study.meshSettings.summary.source === "core_solver" ? "Nodes" : "Nodes (est.)"}
            value={study.meshSettings.summary.nodes.toLocaleString()}
          />
          <Info
            label={study.meshSettings.summary.source === "core_solver" ? "Elements" : "Elements (est.)"}
            value={study.meshSettings.summary.elements.toLocaleString()}
          />
          <Info label="Analysis samples" value={(study.meshSettings.summary.analysisSampleCount ?? 0).toLocaleString()} />
          <Info label="Warnings" value={String(study.meshSettings.summary.warnings.length)} />
        </div>
      )}
      <p className="panel-copy">Meshing runs locally in your browser at the selected quality; final node and element counts appear with the results.</p>
      {staticStudy ? (
        <section className="convergence-card" aria-label="Static mesh convergence">
          <h3>Mesh convergence</h3>
          <p className="panel-copy">Runs an isolated static case at coarse, medium, then fine. Your working mesh and active results stay unchanged.</p>
          <label className="field">
            <span>Static case</span>
            <select value={convergenceCaseId} disabled={convergenceBusy} onChange={(event) => selectConvergenceCase(event.currentTarget.value)}>
              {convergenceCases.map((loadCase) => <option key={loadCase.id} value={loadCase.id}>{loadCase.name}</option>)}
            </select>
          </label>
          <div className="field">
            <span>Displacement probe ({displayModel.dimensions?.units ?? "model units"})</span>
            <div className="convergence-probe-grid">
              {(["X", "Y", "Z"] as const).map((axis, index) => (
                <label key={axis}>
                  <span>{axis}</span>
                  <input
                    type="number"
                    value={probeCoordinates[index]}
                    disabled={convergenceBusy}
                    onChange={(event) => {
                      const next = [...probeCoordinates] as [string, string, string];
                      next[index] = event.currentTarget.value;
                      setProbeCoordinates(next);
                      setProbeEdited(true);
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
          {!validProbe && <p className="panel-warning"><AlertTriangle size={16} />Choose a finite displacement probe point before running convergence.</p>}
          <button className="secondary wide" type="button" disabled={!onRunMeshConvergence || convergenceBusy || meshing || !validProbe || !convergenceCaseId} onClick={runConvergence}>
            <ScanLine size={16} />{convergenceBusy ? "Running convergence…" : "Run coarse → medium → fine"}
          </button>
          {convergenceBusy && <p className="panel-copy" aria-live="polite">{convergenceProgress || "Running convergence study."}</p>}
          {latestRecord && <ConvergenceRecordCard record={latestRecord} />}
        </section>
      ) : (
        <p className="panel-copy">Mesh-convergence studies are available for static load cases only.</p>
      )}
    </Panel>
  );
}

function ConvergenceRecordCard({ record }: { record: MeshConvergenceRecord }) {
  const classification = record.classification === "apparent_convergence"
    ? "Apparent convergence"
    : record.classification === "unconverged"
      ? "Unconverged"
      : "Inconclusive";
  return (
    <div className="convergence-record">
      <strong>{classification}</strong>
      {record.lastStepChanges && (
        <small>Last step: displacement {(record.lastStepChanges.displacement * 100).toFixed(1)}% · stress {(record.lastStepChanges.stress * 100).toFixed(1)}%</small>
      )}
      <ConvergenceChart record={record} />
      <div className="convergence-rungs">
        {record.rungs.map((rung) => (
          <div key={rung.requestedPreset} className={`convergence-rung ${rung.status}`}>
            <span>{capitalize(rung.requestedPreset)}</span>
            <small>{rung.totalDofs?.toLocaleString() ?? "—"} total · {rung.freeDofs?.toLocaleString() ?? "—"} free DOF</small>
            <small>{rung.actualNodeCount?.toLocaleString() ?? "—"} nodes · {rung.actualElementCount?.toLocaleString() ?? "—"} elements · {formatCompact(rung.actualMeshSizeMm)} mm</small>
            <small>{rung.status === "complete"
              ? `${formatCompact(rung.probeDisplacement)} ${rung.displacementUnits} · ${formatCompact(rung.rawElementPeakVonMises)} ${rung.stressUnits}`
              : rung.skipReason ?? capitalize(rung.status)}</small>
          </div>
        ))}
      </div>
      <p className="panel-copy">Apparent convergence requires three increasing-DOF rungs, ≤5% displacement change, and ≤10% raw element stress change.</p>
    </div>
  );
}

function ConvergenceChart({ record }: { record: MeshConvergenceRecord }) {
  const plottable = record.rungs.filter((rung) => rung.totalDofs !== undefined);
  const complete = plottable.filter((rung) => rung.status === "complete" && rung.probeDisplacement !== undefined && rung.rawElementPeakVonMises !== undefined);
  if (!plottable.length) return null;
  const dofs = plottable.map((rung) => rung.totalDofs!);
  const minDof = Math.min(...dofs);
  const maxDof = Math.max(...dofs);
  const x = (dof: number) => 18 + ((dof - minDof) / Math.max(1, maxDof - minDof)) * 204;
  const normalizedY = (value: number, values: number[]) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    return 82 - ((value - min) / Math.max(Number.EPSILON, max - min)) * 58;
  };
  const displacementValues = complete.map((rung) => rung.probeDisplacement!);
  const stressValues = complete.map((rung) => rung.rawElementPeakVonMises!);
  const displacementPoints = complete.map((rung) => `${x(rung.totalDofs!)},${normalizedY(rung.probeDisplacement!, displacementValues)}`).join(" ");
  const stressPoints = complete.map((rung) => `${x(rung.totalDofs!)},${normalizedY(rung.rawElementPeakVonMises!, stressValues)}`).join(" ");
  return (
    <svg className="convergence-chart" viewBox="0 0 240 112" role="img" aria-label="Probe displacement and raw element peak stress versus actual degrees of freedom">
      <title>Convergence metrics versus actual degrees of freedom</title>
      <line x1="18" y1="86" x2="222" y2="86" className="chart-axis" />
      <line x1="18" y1="18" x2="18" y2="86" className="chart-axis" />
      {displacementPoints && <polyline points={displacementPoints} className="chart-displacement" />}
      {stressPoints && <polyline points={stressPoints} className="chart-stress" />}
      {complete.map((rung) => (
        <g key={`point-${rung.requestedPreset}`}>
          <circle cx={x(rung.totalDofs!)} cy={normalizedY(rung.probeDisplacement!, displacementValues)} r="3" className="chart-displacement" />
          <circle cx={x(rung.totalDofs!)} cy={normalizedY(rung.rawElementPeakVonMises!, stressValues)} r="3" className="chart-stress" />
        </g>
      ))}
      {plottable.filter((rung) => rung.status !== "complete").map((rung) => (
        <g key={`skip-${rung.requestedPreset}`} className="chart-skipped" aria-label={`${rung.requestedPreset} ${rung.status}`}>
          <line x1={x(rung.totalDofs!) - 4} y1="78" x2={x(rung.totalDofs!) + 4} y2="86" />
          <line x1={x(rung.totalDofs!) + 4} y1="78" x2={x(rung.totalDofs!) - 4} y2="86" />
        </g>
      ))}
      <text x="22" y="104" className="chart-displacement-label">Displacement</text>
      <text x="100" y="104" className="chart-stress-label">Stress</text>
      <text x="190" y="104" className="chart-axis-label">DOF</text>
    </svg>
  );
}

function formatCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(1) : Math.abs(value) >= 1 ? value.toFixed(3) : value.toExponential(3);
}

function RunPanel({ study, displayModel, runProgress, runError, runTiming, onRunSimulation, onCancelSimulation, canCancelSimulation, onUpdateSolverSettings, onChangeStudyType, canRunSimulation, missingRunItems }: RightPanelProps) {
  const progressPercent = Math.max(0, Math.min(100, Math.round(runProgress)));
  const isRunning = canCancelSimulation ?? (progressPercent > 0 && progressPercent < 100);
  const remainingLabel = formatSimulationEta(runTiming?.estimatedRemainingMs, isRunning);
  const elapsedLabel = formatSimulationElapsed(runTiming?.elapsedMs);
  const checks: Array<readonly [string, boolean]> = [
    ["Material assigned", study.materialAssignments.length > 0],
    ["Support added", study.constraints.length > 0],
    ...(study.type === "modal_analysis" ? [] : [["Load added", study.loads.length > 0] as const]),
    ["Mesh generated", study.meshSettings.status === "complete"]
  ];
  const dynamic = study.type === "dynamic_structural" ? study.solverSettings : null;
  const modal = study.type === "modal_analysis" ? study.solverSettings : null;
  const fidelity = solverFidelityForStudy(study);
  const updateSolverChoice = (settings: SolverSettingsPatch) => {
    onUpdateSolverSettings?.(settings);
  };
  const updateDynamicNumber = (key: keyof Pick<DynamicSolverSettings, "startTime" | "endTime" | "timeStep" | "outputInterval" | "dampingRatio">, value: number) => {
    if (!Number.isFinite(value)) return;
    onUpdateSolverSettings?.({ [key]: value });
  };
  const updateDynamicLoadProfile = (value: string) => {
    if (!isDynamicLoadProfile(value)) return;
    onUpdateSolverSettings?.({ loadProfile: value });
  };
  const frameEstimate = dynamic ? dynamicFrameEstimate(dynamic) : null;
  const outputIntervalMinimum = MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS;
  const outputIntervalValue = dynamic?.outputInterval ?? DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS;
  const loadProfile = isDynamicLoadProfile(dynamic?.loadProfile) ? dynamic.loadProfile : "ramp";
  const loadProfileHelper = DYNAMIC_LOAD_PROFILE_OPTIONS.find((option) => option.value === loadProfile)?.helper ?? DEFAULT_DYNAMIC_LOAD_PROFILE_HELPER;
  return (
    <Panel title="Run" helper={modal ? "Solve for natural frequencies and normalized mode shapes." : "Run the simulation to estimate stress and displacement."}>
      <SectionTitle helpId="runReadiness">Readiness</SectionTitle>
      <div className="checklist">
        {checks.map(([label, done]) => <span key={label} className={done ? "check done" : "check"}><span>{done ? <Check size={18} /> : null}</span>{label}</span>)}
      </div>
      {/* B5: the backend picker is gone — every simulation runs locally in the
          browser, so a choice would be routing theater. The Solver info block
          below states the backend; solverSettings.backend stays in the schema
          so older project files (including retired cloud selections) still
          round-trip. */}
      <SectionTitle>Simulation settings</SectionTitle>
      <div className="field">
        <span>Analysis type</span>
        <div className="segmented analysis-type" role="group" aria-label="Analysis type">
          <button
            className={study.type === "static_stress" ? "active" : ""}
            type="button"
            aria-pressed={study.type === "static_stress"}
            disabled={isRunning}
            onClick={() => study.type !== "static_stress" && onChangeStudyType?.("static_stress")}
          >Static</button>
          <button
            className={study.type === "dynamic_structural" ? "active" : ""}
            type="button"
            aria-pressed={study.type === "dynamic_structural"}
            disabled={isRunning}
            onClick={() => study.type !== "dynamic_structural" && onChangeStudyType?.("dynamic_structural")}
          >Dynamic</button>
          <button
            className={study.type === "modal_analysis" ? "active" : ""}
            type="button"
            aria-pressed={study.type === "modal_analysis"}
            disabled={isRunning}
            onClick={() => study.type !== "modal_analysis" && onChangeStudyType?.("modal_analysis")}
          >Modal</button>
        </div>
      </div>
      <label className="field">
        <span>Fidelity</span>
        <select value={fidelity} onChange={(event) => updateSolverChoice({ fidelity: event.currentTarget.value as SimulationFidelity })}>
          {SIMULATION_FIDELITIES.map((option) => <option key={option} value={option}>{capitalize(option)}</option>)}
        </select>
      </label>
      {dynamic && (
        <>
          <SectionTitle>Dynamic settings</SectionTitle>
          <DynamicNumberField label="Start time" helpId="dynamicStartTime" unit="s" value={dynamic.startTime} min={0} step={dynamic.timeStep} onCommit={(value) => updateDynamicNumber("startTime", value)} />
          <DynamicNumberField label="End time" helpId="dynamicEndTime" unit="s" value={dynamic.endTime} min={dynamic.startTime + dynamic.timeStep} step={dynamic.timeStep} onCommit={(value) => updateDynamicNumber("endTime", value)} />
          <DynamicNumberField label="Time step" helpId="dynamicTimeStep" unit="s" value={dynamic.timeStep} min={0.0001} step="0.0005" onCommit={(value) => updateDynamicNumber("timeStep", value)} />
          <DynamicNumberField label="Output interval" helpId="dynamicOutputInterval" unit="s" value={outputIntervalValue} min={outputIntervalMinimum} step={outputIntervalMinimum} onCommit={(value) => updateDynamicNumber("outputInterval", value)} />
          <label className="field">
            <HelpLabel helpId="dynamicLoadProfile">Load profile</HelpLabel>
            <select value={loadProfile} onChange={(event) => updateDynamicLoadProfile(event.currentTarget.value)}>
              {DYNAMIC_LOAD_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <p className="panel-copy">{loadProfileHelper}</p>
          <DynamicNumberField label="Damping ratio" helpId="dynamicDampingRatio" unit="ζ" value={dynamic.dampingRatio} min={0} step="0.01" onCommit={(value) => updateDynamicNumber("dampingRatio", value)} />
          <div className="summary-box">
            <Info label="Estimated frames" value={frameEstimate ? frameEstimate.count.toLocaleString() : "--"} />
            <Info label="Output cadence" value={`Every ${formatSeconds(normalizedDynamicOutputInterval(dynamic))}`} />
          </div>
          {frameEstimate && frameEstimate.count > 1000 && <p className="panel-copy">Large frame counts may slow result loading and playback.</p>}
          {frameEstimate?.hasFinalPartialStep && <p className="panel-copy">Final frame is clamped to the selected end time.</p>}
        </>
      )}
      {modal && (
        <>
          <SectionTitle>Modal settings</SectionTitle>
          <label className="field">
            <span>Requested modes</span>
            <select
              value={modal.modeCount}
              onChange={(event) => onUpdateSolverSettings?.({ modeCount: Number(event.currentTarget.value) })}
            >
              {Array.from({ length: 10 }, (_, index) => index + 1).map((modeCount) => <option key={modeCount} value={modeCount}>{modeCount}</option>)}
            </select>
          </label>
          <p className="panel-copy">Mode shapes are normalized for visualization. Applied loads are not used in modal analysis.</p>
        </>
      )}
      <button
        className="primary wide"
        type="button"
        onClick={isRunning ? onCancelSimulation : onRunSimulation}
        disabled={isRunning ? !onCancelSimulation : !canRunSimulation}
        title={isRunning ? "Stop simulation" : (missingRunItems.length ? `Complete before running: ${missingRunItems.join(", ")}` : "Run simulation")}
        aria-label={isRunning ? "Stop simulation" : "Run simulation"}
      >
        {isRunning ? <X size={16} /> : <Play size={16} />}
        {isRunning ? "Stop simulation" : "Run simulation"}
      </button>
      {missingRunItems.length > 0 && <p className="panel-copy">Complete {missingRunItems.join(", ").toLowerCase()} before running.</p>}
      {runError && !isRunning && <p className="panel-warning" role="alert">{runError}</p>}
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} aria-label="Simulation progress">
        <span style={{ width: `${progressPercent}%` }} />
        <strong className="progress-label">{progressPercent}%</strong>
      </div>
      {isRunning && (
        <div className="summary-box">
          <Info label="Time remaining" value={remainingLabel} />
          <Info label="Elapsed" value={elapsedLabel} />
        </div>
      )}
      <SectionTitle helpId="solver">Solver</SectionTitle>
      <div className="summary-box">
        <Info label="Backend" value={solverBackendLabelForRunPanel(study, displayModel)} />
        <Info label="Version" value="0.1.0" />
        <Info label="Solver method" value={solverMethodForStudy(study)} />
        <Info label="Runner" value={solverRunnerLabelForStudy(study, displayModel)} />
      </div>
    </Panel>
  );
}

function DynamicNumberField({
  label,
  helpId,
  unit,
  value,
  min,
  step,
  onCommit
}: {
  label: string;
  helpId: SettingHelpId;
  unit: string;
  value: number;
  min: number;
  step: number | string;
  onCommit: (value: number) => void;
}) {
  const formattedValue = formatEditableNumberValue(value);
  const [draftValue, setDraftValue] = useState(formattedValue);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraftValue(formattedValue);
  }, [editing, formattedValue]);

  function commitDraft(rawValue: string) {
    const parsed = editableNumberCommitValue(rawValue, min);
    if (parsed === null) return;
    onCommit(parsed);
  }

  return (
    <label className="field">
      <HelpLabel helpId={helpId}>{label}</HelpLabel>
      <span className="input-with-unit">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={editing ? draftValue : formattedValue}
          onFocus={() => {
            setEditing(true);
            setDraftValue(formattedValue);
          }}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            setDraftValue(nextValue);
            commitDraft(nextValue);
          }}
          onBlur={(event) => {
            setEditing(false);
            const parsed = editableNumberCommitValue(event.currentTarget.value, min);
            setDraftValue(formatEditableNumberValue(parsed ?? value));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span>{unit}</span>
      </span>
    </label>
  );
}

export function editableNumberCommitValue(rawValue: string, min: number): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min) return null;
  return parsed;
}

function formatEditableNumberValue(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function meshPresetDescription(preset: MeshQuality) {
  if (preset === "coarse") return "fast preview mesh for early setup checks";
  if (preset === "medium") return "good balance between accuracy and speed";
  if (preset === "fine") return "denser mesh for more detailed result gradients";
  return "ultra-dense local analysis samples for granular contour gradients";
}

function solverFidelityForStudy(study: Study): SimulationFidelity {
  const fidelity = (study.solverSettings as { fidelity?: unknown }).fidelity;
  return fidelity === "detailed" || fidelity === "ultra" ? fidelity : "standard";
}

// Solver info rows show the backend the run will actually use. Every run
// executes locally in the browser since the cloud retirement (B5), so the
// label is constant and there is nothing to pick.
function solverBackendLabelForRunPanel(study: Study, displayModel: DisplayModel): string {
  void study;
  void displayModel;
  return "Local (in-browser)";
}

function solverMethodForStudy(study: Study): "sparse_static" | "mdof_dynamic" | "block_shift_invert_modal" {
  return study.type === "dynamic_structural" ? "mdof_dynamic" : study.type === "modal_analysis" ? "block_shift_invert_modal" : "sparse_static";
}

function solverRunnerLabelForStudy(study: Study, displayModel: DisplayModel): string {
  void study;
  void displayModel;
  return "local core worker";
}

export function formatSimulationEta(remainingMs: number | undefined, isRunning = true): string {
  if (!isRunning) return "Complete";
  if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs)) return "Estimating...";
  if (remainingMs <= 1500) return "Almost done";
  return `About ${formatDurationSeconds(remainingMs)} remaining`;
}

function formatSimulationElapsed(elapsedMs: number | undefined): string {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return "--";
  return formatDurationSeconds(elapsedMs);
}

function formatDurationSeconds(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function ResultsPanel(props: RightPanelProps) {
  if (!props.resultSummary) {
    return (
      <Panel title="Results" helper="View stress and displacement directly on the 3D model.">
        <Callout>Run a simulation to see results.</Callout>
      </Panel>
    );
  }
  if (isModalResultSummary(props.resultSummary)) {
    return <ModalResultsPanelContent {...props} resultSummary={props.resultSummary} />;
  }
  return <ResultsPanelContent {...props} resultSummary={props.resultSummary} />;
}

function ModalResultsPanelContent({
  resultSummary,
  resultFields = [],
  selectedModeIndex = resultSummary.modes[0]?.modeIndex ?? 1,
  showDeformed,
  stressExaggeration,
  resultFrameIndex = 0,
  resultFramePosition = resultFrameIndex,
  resultFrameOrdinalPosition,
  resultPlaybackPlaying = false,
  resultPlaybackFps = 12,
  resultPlaybackReverseLoop = false,
  resultPlaybackCacheLabel = "",
  onSelectedModeIndexChange,
  onResultFrameChange,
  onResultPlaybackToggle,
  onResultPlaybackFpsChange,
  onResultPlaybackReverseLoopChange,
  onToggleDeformed,
  onStressExaggerationChange
}: RightPanelProps & { resultSummary: ModalResultSummary }) {
  const frames = dynamicPlaybackFrames(resultFields);
  const frameIndexes = frames.map((frame) => frame.frameIndex);
  const activeFramePosition = resultPlaybackPlaying ? resultFramePosition : resultFrameIndex;
  const sliderPosition = resultPlaybackPlaying && typeof resultFrameOrdinalPosition === "number"
    ? resultFrameOrdinalPosition
    : playbackOrdinalForSolverFramePosition(frameIndexes, activeFramePosition);
  const phaseDegrees = frames.length ? ((activeFramePosition / frames.length) * 360 + 360) % 360 : 0;
  const activeMode = resultSummary.modes.find((mode) => mode.modeIndex === selectedModeIndex) ?? resultSummary.modes[0];
  const resultProvenance = resultSummary.provenance;
  return (
    <Panel title="Results" helper="Inspect converged natural frequencies and normalized mode shapes.">
      {resultSummary.warning && <p className="panel-warning" role="status"><AlertTriangle size={16} />{resultSummary.warning}</p>}
      <div className="summary-box">
        <Info label="Converged modes" value={`${resultSummary.convergedModeCount} / ${resultSummary.requestedModeCount}`} />
        <Info label="Solver method" value="block_shift_invert_modal" />
        <Info label="Result source" value={resultSourceLabelForPanel(resultSummary)} />
        <Info label="Runner" value={solverRunnerLabelForResult(resultProvenance)} />
      </div>
      <SectionTitle>Modes</SectionTitle>
      <div className="modal-mode-table" role="list" aria-label="Converged modes">
        {resultSummary.modes.map((mode) => (
          <button
            key={mode.modeIndex}
            type="button"
            role="listitem"
            className={mode.modeIndex === selectedModeIndex ? "primary" : "secondary"}
            onClick={() => onSelectedModeIndexChange?.(mode.modeIndex)}
          >
            <strong>{`Mode ${mode.modeIndex}`}</strong>
            <span>{`${Number(mode.frequencyHz.toPrecision(6))} Hz`}</span>
            <small>{`Residual ${mode.scaledResidual.toExponential(2)}`}</small>
          </button>
        ))}
      </div>
      {activeMode && (
        <div className="summary-box">
          <Info label="Frequency" value={`${Number(activeMode.frequencyHz.toPrecision(6))} Hz`} />
          <Info label="Eigenvalue" value={Number(activeMode.eigenvalue.toPrecision(6)).toString()} />
          <Info label="Scaled residual" value={activeMode.scaledResidual.toExponential(3)} />
          <Info label="Shape units" value="normalized" />
        </div>
      )}
      {frames.length > 1 && (
        <div className="dynamic-playback">
          <SectionTitle>Phase</SectionTitle>
          <label className="field range-field">
            <span className="range-label"><span>Phase</span><strong>{`${phaseDegrees.toFixed(0)}°`}</strong></span>
            <input
              className="playback-time-range"
              type="range"
              aria-label="Mode phase"
              min="0"
              max={Math.max(frames.length - 1, 0)}
              step={resultPlaybackPlaying ? "0.01" : "1"}
              value={sliderPosition}
              onChange={(event) => onResultFrameChange?.(frameIndexForRoundedPlaybackOrdinal(frameIndexes, Number(event.currentTarget.value)))}
            />
          </label>
          <label className="field range-field">
            <span className="range-label"><span>Animation speed</span><strong>{Math.round(resultPlaybackFps)} fps</strong></span>
            <input type="range" min="1" max="30" step="1" value={resultPlaybackFps} onChange={(event) => onResultPlaybackFpsChange?.(Number(event.currentTarget.value))} />
          </label>
          <label className="toggle playback-loop-toggle">
            <input type="checkbox" checked={resultPlaybackReverseLoop} onChange={(event) => onResultPlaybackReverseLoopChange?.(event.currentTarget.checked)} />
            <span>Reverse loop</span>
          </label>
          <button className="secondary wide" type="button" onClick={onResultPlaybackToggle}>{resultPlaybackPlaying ? <Pause size={16} /> : <Play size={16} />}{resultPlaybackPlaying ? "Pause" : "Play"}</button>
          {resultPlaybackCacheLabel && <small className="playback-cache-status">{resultPlaybackCacheLabel}</small>}
        </div>
      )}
      <label className="toggle"><input type="checkbox" checked={showDeformed} onChange={onToggleDeformed} /> Animate mode shape</label>
      <label className="field range-field">
        <span className="range-label"><span>Visualization amplitude</span><strong>{stressExaggeration.toFixed(1)}x</strong></span>
        <input type="range" min="0.5" max="4" step="0.1" value={stressExaggeration} onChange={(event) => onStressExaggerationChange(Number(event.currentTarget.value))} />
      </label>
      <p className="panel-copy">Amplitude and phase are visualization-only. Normalized mode shapes are not physical displacements.</p>
      <div className="legend"><small>Node</small><span /><small>Antinode</small></div>
    </Panel>
  );
}

function ResultsPanelContent({
  displayModel,
  resultMode,
  showDeformed,
  stressExaggeration,
  resultSummary,
  resultFields = [],
  resultVariants = [],
  activeResultVariantId = resultVariants[0]?.id ?? "",
  resultProbes = [],
  resultProbeLimitReached = false,
  study,
  resultFrameIndex = 0,
  resultFramePosition = resultFrameIndex,
  resultFrameOrdinalPosition,
  resultPlaybackPlaying = false,
  resultPlaybackFps = 12,
  resultPlaybackReverseLoop = false,
  resultPlaybackCacheLabel = "",
  onResultFrameChange,
  onResultPlaybackToggle,
  onResultPlaybackFpsChange,
  onResultPlaybackReverseLoopChange,
  onResultModeChange,
  onResultVariantChange,
  onRemoveResultProbe,
  onClearResultProbes,
  onToggleDeformed,
  onStressExaggerationChange,
  onGenerateReport,
  reportBusy = false,
  reportError,
  reportDisabled = false
}: RightPanelProps & { resultSummary: StructuralResultSummary }) {
  const [targetSafetyFactor, setTargetSafetyFactor] = useState(1.5);
  const [draftStressExaggeration, setDraftStressExaggeration] = useState(stressExaggeration);
  const stressExaggerationCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedStressExaggerationRef = useRef(stressExaggeration);
  const assessment = resultSummary.failureAssessment ?? assessResultFailure(resultSummary);
  const loadCapacity = estimateAllowableLoadForSafetyFactor(resultSummary, targetSafetyFactor);
  const loadCapacityAtOne = estimateAllowableLoadForSafetyFactor(resultSummary, 1);
  const blockPreviewResults = shouldBlockPreviewResultsForDisplayModel(displayModel, resultSummary, resultFields, study);
  const reactionForceInvalid = hasInvalidReactionForce(resultSummary, study) || hasUnavailableReactionDiagnostic(resultSummary);
  const resultContractInvalid = resultContractHasMissingUnits(resultSummary, resultFields);
  const unitMissingDiagnostic = resultContractInvalid ? "Unit missing" : null;
  const canEstimateLoad = !resultContractInvalid && loadCapacity.status === "available" && canShowReverseLoadCapacity(resultSummary, displayModel, resultFields, study);
  const AssessmentIcon = assessment.status === "pass" ? ShieldCheck : AlertTriangle;
  const frames = dynamicPlaybackFrames(resultFields);
  const hasPlayback = frames.length > 1;
  const activeFrame = frames.find((frame) => frame.frameIndex === resultFrameIndex) ?? frames[0];
  const activeFramePosition = resultPlaybackPlaying ? resultFramePosition : activeFrame?.frameIndex ?? resultFrameIndex;
  const activeTimeSeconds = interpolatedFrameTimeSeconds(frames, activeFramePosition);
  const frameIndexes = frames.map((frame) => frame.frameIndex);
  const sliderPosition = resultPlaybackPlaying && typeof resultFrameOrdinalPosition === "number"
    ? resultFrameOrdinalPosition
    : playbackOrdinalForSolverFramePosition(frameIndexes, activeFramePosition);
  const currentFrameNumber = frames.length ? Math.min(frames.length, Math.max(1, Math.floor(sliderPosition) + 1)) : 0;
  const peakDisplacement = peakDisplacementFrame(resultFields, resultSummary);
  const peakMarkerPercent = peakDisplacement && hasPlayback ? playbackPeakMarkerPercent(frames, peakDisplacement.timeSeconds) : null;
  const peakMarkerLabel = peakDisplacement ? `Peak displacement at ${peakDisplacement.timeSeconds.toFixed(4)} s` : "";
  const resultProvenance = resultSummary.provenance;
  const legacyResultWarning = legacyResultWarningForProvenance(resultProvenance);

  useEffect(() => {
    committedStressExaggerationRef.current = stressExaggeration;
    setDraftStressExaggeration(stressExaggeration);
  }, [stressExaggeration]);

  useEffect(() => () => {
    if (stressExaggerationCommitTimerRef.current) clearTimeout(stressExaggerationCommitTimerRef.current);
  }, []);

  function commitStressExaggeration(value: number) {
    const nextValue = Number(value.toFixed(1));
    if (stressExaggerationCommitTimerRef.current) {
      clearTimeout(stressExaggerationCommitTimerRef.current);
      stressExaggerationCommitTimerRef.current = null;
    }
    if (Math.abs(nextValue - committedStressExaggerationRef.current) < 0.001) return;
    committedStressExaggerationRef.current = nextValue;
    onStressExaggerationChange(nextValue);
  }

  function scheduleStressExaggerationCommit(value: number) {
    if (stressExaggerationCommitTimerRef.current) clearTimeout(stressExaggerationCommitTimerRef.current);
    stressExaggerationCommitTimerRef.current = setTimeout(() => {
      commitStressExaggeration(value);
    }, STRESS_EXAGGERATION_COMMIT_DELAY_MS);
  }

  function updateDraftStressExaggeration(value: number) {
    const nextValue = Number(value.toFixed(1));
    setDraftStressExaggeration(nextValue);
    scheduleStressExaggerationCommit(nextValue);
  }

  return (
    <Panel title="Results" helper="View stress and displacement directly on the 3D model.">
      {resultVariants.length > 1 && (
        <label className="field result-variant-selector">
          <span>Run variant</span>
          <select value={activeResultVariantId} onChange={(event) => void onResultVariantChange?.(event.currentTarget.value)}>
            {resultVariants.map((variant) => (
              <option key={variant.id} value={variant.id}>{variant.name}{variant.kind === "envelope" ? " · envelope" : ""}</option>
            ))}
          </select>
        </label>
      )}
      {onGenerateReport && (
        <button className="primary wide" type="button" disabled={reportBusy || reportDisabled} onClick={() => void onGenerateReport({ targetSafetyFactor })}>
          <FileDown size={18} />{reportBusy ? "Generating…" : "Generate report"}
        </button>
      )}
      {reportError && <p className="panel-warning" role="alert"><AlertTriangle size={16} />{reportError}</p>}
      <div className={`failure-assessment ${assessment.status}`}>
        <span className="assessment-icon"><AssessmentIcon size={20} /></span>
        <span>
          <strong>{assessment.title}</strong>
          <small>{assessment.message}</small>
        </span>
      </div>
      {hasPlayback && (
        <div className="dynamic-playback">
          <SectionTitle>Frame</SectionTitle>
          <label className="field range-field">
            <span className="range-label"><span>Current time</span><strong>{`${activeTimeSeconds.toFixed(4)} s · Frame ${currentFrameNumber} / ${frames.length}`}</strong></span>
            <span
              className="playback-time-track"
              style={peakMarkerPercent !== null ? ({ "--playback-peak-position": `${peakMarkerPercent}%` } as CSSProperties) : undefined}
            >
              <input
                className="playback-time-range"
                type="range"
                aria-label="Playback time position"
                min="0"
                max={Math.max(frames.length - 1, 0)}
                step={resultPlaybackPlaying ? "0.01" : "1"}
                value={sliderPosition}
                onChange={(event) => onResultFrameChange?.(frameIndexForRoundedPlaybackOrdinal(frameIndexes, Number(event.currentTarget.value)))}
              />
              {peakMarkerPercent !== null && (
                <span
                  className="playback-peak-marker"
                  role="img"
                  aria-label={peakMarkerLabel}
                  title={peakMarkerLabel}
                />
              )}
            </span>
          </label>
          <label className="field range-field">
            <span className="range-label"><span>Animation speed</span><strong>{Math.round(resultPlaybackFps)} fps</strong></span>
            <input
              type="range"
              min="1"
              max="30"
              step="1"
              value={resultPlaybackFps}
              style={{ "--range-progress": `${rangeProgressPercent(resultPlaybackFps, 1, 30)}%` } as CSSProperties}
              onChange={(event) => onResultPlaybackFpsChange?.(Number(event.currentTarget.value))}
            />
          </label>
          <label className="toggle playback-loop-toggle">
            <input
              type="checkbox"
              checked={resultPlaybackReverseLoop}
              onChange={(event) => onResultPlaybackReverseLoopChange?.(event.currentTarget.checked)}
            />
            <span>Reverse loop</span>
          </label>
          <button className="secondary wide" type="button" onClick={() => {
            onResultPlaybackToggle?.();
          }}>{resultPlaybackPlaying ? <Pause size={16} /> : <Play size={16} />}{resultPlaybackPlaying ? "Pause" : "Play"}</button>
          {resultPlaybackCacheLabel && <small className="playback-cache-status">{resultPlaybackCacheLabel}</small>}
          <Info label="Peak displacement" value={peakDisplacement ? `${Number(peakDisplacement.value.toPrecision(3))} ${peakDisplacement.units} at ${peakDisplacement.timeSeconds.toFixed(4)} s` : "Unavailable"} />
        </div>
      )}
      <SectionTitle helpId="resultMode">Result mode</SectionTitle>
      <div className="result-buttons">
        <button className={resultMode === "stress" ? "primary" : "secondary"} onClick={() => onResultModeChange("stress")}>Stress</button>
        <button className={resultMode === "displacement" ? "primary" : "secondary"} onClick={() => onResultModeChange("displacement")}>Displacement</button>
        {resultFields.some((field) => field.type === "velocity") && <button className={resultMode === "velocity" ? "primary" : "secondary"} onClick={() => onResultModeChange("velocity")}>Velocity</button>}
        {resultFields.some((field) => field.type === "acceleration") && <button className={resultMode === "acceleration" ? "primary" : "secondary"} onClick={() => onResultModeChange("acceleration")}>Acceleration</button>}
        <button className={resultMode === "safety_factor" ? "primary" : "secondary"} onClick={() => onResultModeChange("safety_factor")}>Safety factor</button>
      </div>
      {(resultProbes.length > 0 || resultProbeLimitReached) && (
        <section className="result-probe-list" aria-label="Pinned result probes">
          <div className="result-probe-list-header">
            <SectionTitle>Pinned probes</SectionTitle>
            {resultProbes.length > 0 && onClearResultProbes && <button className="text-button" type="button" onClick={onClearResultProbes}>Clear All</button>}
          </div>
          {resultProbeLimitReached && <p className="panel-warning" role="status">Probe limit reached. Remove a pin to place another.</p>}
          {resultProbes.length > 0 && (
            <ol>
              {resultProbes.map((probe, index) => (
                <li key={probe.id}>
                  <span>
                    <strong>{`P${index + 1}`}</strong>
                    <small>{formatProbeReading(probe)}</small>
                    {probe.governingVariantName && <small>{`Governed near probe by ${probe.governingVariantName}`}</small>}
                  </span>
                  {onRemoveResultProbe && <button className="icon-button" type="button" aria-label={`Remove probe ${index + 1}`} onClick={() => onRemoveResultProbe(probe.id)}><X size={14} /></button>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {resultMode === "stress" && (
        <label className="field range-field">
          <span className="range-label"><HelpLabel helpId="stressExaggeration">Deformation scale</HelpLabel><strong>{draftStressExaggeration.toFixed(1)}x</strong></span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.1"
            value={draftStressExaggeration}
            style={{ "--range-progress": `${rangeProgressPercent(draftStressExaggeration, 1, 4)}%` } as CSSProperties}
            onChange={(event) => updateDraftStressExaggeration(Number(event.currentTarget.value))}
            onPointerUp={() => commitStressExaggeration(draftStressExaggeration)}
            onKeyUp={() => commitStressExaggeration(draftStressExaggeration)}
            onBlur={() => commitStressExaggeration(draftStressExaggeration)}
          />
        </label>
      )}
      <label className="toggle"><input type="checkbox" checked={showDeformed && !blockPreviewResults} disabled={blockPreviewResults} onChange={onToggleDeformed} /> <HelpLabel helpId="deformedShape">Deformed shape</HelpLabel></label>
      {blockPreviewResults && <p className="panel-warning">{PREVIEW_GEOMETRY_WARNING}</p>}
      {legacyResultWarning && <p className="panel-warning">{legacyResultWarning}</p>}
      {reactionForceInvalid && <p className="panel-warning">{INVALID_REACTION_WARNING}</p>}
      {unitMissingDiagnostic && <p className="panel-warning">{unitMissingDiagnostic}</p>}
      <p className="panel-copy">Red areas have higher stress. Blue areas have lower stress.</p>
      <div className="summary-box">
        <Info label="Result source" value={resultSourceLabelForPanel(resultSummary)} />
        <Info label="Mesh source" value={formatMeshSourceLabel(resultProvenance?.meshSource, displayModel)} />
        <Info label="Solver method" value={solverMethodForResult(resultSummary, study)} />
        <Info label="Runner" value={solverRunnerLabelForResult(resultProvenance)} />
        <Info label="Max stress" value={formatResultMetric(resultSummary.maxStress, resultSummary.maxStressUnits)} />
        <Info label="Max displacement" value={formatResultMetric(resultSummary.maxDisplacement, resultSummary.maxDisplacementUnits)} />
        <Info label="Safety factor" value={String(resultSummary.safetyFactor)} />
        <Info label="Failure check" value={assessment.title} />
        <Info label="Reaction force" value={formatResultMetric(resultSummary.reactionForce, resultSummary.reactionForceUnits)} />
      </div>
      {canEstimateLoad && (
        <>
          <SectionTitle helpId="targetSafetyFactor">Reverse Check</SectionTitle>
          <div className="load-capacity-tool">
            <label className="field">
              <HelpLabel helpId="targetSafetyFactor">Target factor of safety</HelpLabel>
              <span className="input-with-unit">
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={targetSafetyFactor}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value);
                    setTargetSafetyFactor(Number.isFinite(next) && next > 0 ? next : 1.5);
                  }}
                />
                <span>FoS</span>
              </span>
            </label>
            <div className="capacity-readout">
              <span>Max total load</span>
              <strong>{`${formatLoadCapacity(loadCapacity.allowableLoad)} ${loadCapacity.loadUnits}`}</strong>
              <small>{`Current ${formatLoadCapacity(loadCapacity.currentLoad)} ${loadCapacity.loadUnits} · ${formatLoadCapacity(loadCapacity.loadScale)}x`}</small>
              <small>{`Max force at 1.0 FoS · ${formatLoadCapacity(loadCapacityAtOne.allowableLoad)} ${loadCapacityAtOne.loadUnits}`}</small>
            </div>
          </div>
        </>
      )}
      <div className="legend"><small>Low</small><span /><small>High</small></div>
    </Panel>
  );
}

function formatProbeReading(probe: ResolvedResultProbe): string {
  const value = Number.isFinite(probe.value) ? Number(probe.value.toPrecision(6)) : probe.value;
  return `${value}${probe.units ? ` ${probe.units}` : ""}`;
}

function resultSourceLabelForPanel(resultSummary: ResultSummary): string {
  const label = formatResultProvenanceLabel(resultSummary.provenance);
  return label === "OpenCAE Core Local (in-browser)" ? "Local (in-browser)" : label;
}

function resultContractHasMissingUnits(summary: StructuralResultSummary, fields: ResultField[]): boolean {
  return !hasResultUnit(summary.maxStressUnits) ||
    !hasResultUnit(summary.maxDisplacementUnits) ||
    !hasResultUnit(summary.reactionForceUnits) ||
    fields.some((field) => !hasResultUnit(field.units));
}

export function rangeProgressPercent(value: number, min: number, max: number) {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

export function playbackPeakMarkerPercent(frames: Array<{ frameIndex: number; timeSeconds: number }>, peakTimeSeconds: number) {
  const finiteFrames = frames.filter((frame) => Number.isFinite(frame.timeSeconds));
  if (!Number.isFinite(peakTimeSeconds) || finiteFrames.length < 2) return 0;
  const first = finiteFrames[0]!;
  const last = finiteFrames[finiteFrames.length - 1]!;
  if (peakTimeSeconds <= first.timeSeconds) return 0;
  if (peakTimeSeconds >= last.timeSeconds) return 100;
  for (let index = 0; index < finiteFrames.length - 1; index += 1) {
    const lower = finiteFrames[index]!;
    const upper = finiteFrames[index + 1]!;
    if (peakTimeSeconds < lower.timeSeconds || peakTimeSeconds > upper.timeSeconds) continue;
    const blend = upper.timeSeconds === lower.timeSeconds
      ? 0
      : (peakTimeSeconds - lower.timeSeconds) / (upper.timeSeconds - lower.timeSeconds);
    return rangeProgressPercent(index + Math.max(0, Math.min(1, blend)), 0, finiteFrames.length - 1);
  }
  return 0;
}

function Panel({ title, helper, children }: { title: string; helper: string; children: ReactNode }) {
  const step = ["Model", "Material", "Supports", "Loads", "Mesh", "Run", "Results"].indexOf(title) + 1;
  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>{title}</h2>
          <div className="panel-eyebrow">Step {step || 1} of 7</div>
        </div>
        <p className="helper">{helper}</p>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

const WORKFLOW_STEPS: Array<{ id: StepId; label: string }> = [
  { id: "model", label: "Model" },
  { id: "material", label: "Material" },
  { id: "supports", label: "Supports" },
  { id: "loads", label: "Loads" },
  { id: "mesh", label: "Mesh" },
  { id: "run", label: "Run" },
  { id: "results", label: "Results" }
];

function WorkflowNav({ activeStep, study, onStepSelect }: { activeStep: StepId; study: Study; onStepSelect: (step: StepId) => void }) {
  const workflowSteps = study.type === "modal_analysis" ? WORKFLOW_STEPS.filter((step) => step.id !== "loads") : WORKFLOW_STEPS;
  const index = workflowSteps.findIndex((step) => step.id === activeStep);
  const previousStep = index > 0 ? workflowSteps[index - 1] : undefined;
  const nextStep = index >= 0 && index < workflowSteps.length - 1 ? workflowSteps[index + 1] : undefined;
  const canGoNext = Boolean(nextStep && canNavigateToStep(nextStep.id, { meshStatus: study.meshSettings.status }));
  const backLabel = previousStep ? `Back: ${previousStep.label}` : "Back";
  const nextLabel = nextStep ? `Next: ${nextStep.label}` : "Next";
  const backAriaLabel = previousStep ? `Previous workflow step: ${previousStep.label}. Shortcut B` : "Previous workflow step. Shortcut B";
  const nextAriaLabel = nextStep ? `Next workflow step: ${nextStep.label}. Shortcut N` : "Next workflow step. Shortcut N";

  return (
    <div className="workflow-nav" aria-label="Workflow navigation">
      <button className="secondary" type="button" title="Previous workflow step (B)" aria-label={backAriaLabel} disabled={!previousStep} onClick={() => previousStep && onStepSelect(previousStep.id)}>
        <span className="workflow-nav-label">{backLabel}</span>
        <kbd>B</kbd>
      </button>
      <button className="primary" type="button" title="Next workflow step (N)" aria-label={nextAriaLabel} disabled={!canGoNext} onClick={() => nextStep && canGoNext && onStepSelect(nextStep.id)}>
        <span className="workflow-nav-label">{nextLabel}</span>
        <kbd>N</kbd>
      </button>
    </div>
  );
}

function HelpLabel({ children, helpId }: { children: ReactNode; helpId: SettingHelpId }) {
  return (
    <span className="field-label-with-help">
      {children}
      <SettingHelpTrigger helpId={helpId} />
    </span>
  );
}

function HelpNote({ helpId }: { helpId: SettingHelpId }) {
  return (
    <div className="help-note help-note--collapsed">
      <SettingHelpTrigger helpId={helpId} />
    </div>
  );
}

function SettingHelpTrigger({ helpId }: { helpId: SettingHelpId }) {
  const tooltipId = useId();
  const help = SETTING_HELP[helpId];
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties | undefined>();

  const updateTooltipPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const position = getViewportTooltipPosition({
      triggerRect: trigger.getBoundingClientRect(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tooltip: { width: tooltipRect?.width || 340, height: tooltipRect?.height || 142 }
    });
    setTooltipStyle({ top: position.top, left: position.left });
  };

  useIsomorphicLayoutEffect(() => {
    if (!isTooltipOpen) return;
    updateTooltipPosition();
  }, [isTooltipOpen, helpId]);

  useEffect(() => {
    if (!isTooltipOpen || typeof window === "undefined") return;
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [isTooltipOpen]);

  return (
    <span
      ref={triggerRef}
      className="tooltip-trigger"
      tabIndex={0}
      role="button"
      aria-label={`${help.title} help`}
      aria-describedby={tooltipId}
      onMouseEnter={() => setIsTooltipOpen(true)}
      onMouseLeave={() => setIsTooltipOpen(false)}
      onFocus={() => setIsTooltipOpen(true)}
      onBlur={() => setIsTooltipOpen(false)}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsTooltipOpen((current) => !current);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <CircleHelp size={15} aria-hidden="true" />
      {isTooltipOpen &&
        createPortal(
          <span ref={tooltipRef} id={tooltipId} className="field-tooltip field-tooltip--floating" role="tooltip" style={tooltipStyle}>
            <HelpVisual kind={help.visual} />
            <strong>{help.title}</strong>
            <span>{help.body}</span>
          </span>,
          document.body
        )}
    </span>
  );
}

function HelpVisual({ kind }: { kind: SettingHelpVisual }) {
  return (
    <span className={`help-visual ${kind}`} aria-hidden="true">
      <span className="help-part" />
      <span className="help-force" />
      <span className="help-grid" />
    </span>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>;
}

function ModelDimensions({ displayModel }: { displayModel: DisplayModel }) {
  const dimensions = dimensionValuesForDisplayModel(displayModel);
  if (!dimensions) {
    return (
      <div className="summary-box dimension-box">
        <Info label="Dimensions" value="Unavailable" />
        <p>Real model extents are not available for this imported preview.</p>
      </div>
    );
  }

  return (
    <div className="summary-box dimension-box">
      <Info label="Overall" value={`${formatDimension(dimensions.x)} x ${formatDimension(dimensions.y)} x ${formatDimension(dimensions.z)} ${dimensions.units}`} />
      <Info label="X length" value={`${formatDimension(dimensions.x)} ${dimensions.units}`} />
      <Info label="Y depth" value={`${formatDimension(dimensions.y)} ${dimensions.units}`} />
      <Info label="Z height" value={`${formatDimension(dimensions.z)} ${dimensions.units}`} />
    </div>
  );
}

function SectionTitle({ children, helpId }: { children: ReactNode; helpId?: SettingHelpId }) {
  return <h3 className="section-title">{helpId ? <HelpLabel helpId={helpId}>{children}</HelpLabel> : children}</h3>;
}

function Callout({ children }: { children: ReactNode }) {
  return <p className="callout">{children}</p>;
}

function Collapsible({ title, subtitle, defaultOpen = false, children }: { title: string; subtitle?: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="collapsible-section" open={defaultOpen}>
      <summary className="collapsible-summary">
        <span className="collapsible-title">{title}</span>
        {subtitle && <span className="collapsible-subtitle">{subtitle}</span>}
        <ChevronDown className="collapsible-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

function ConceptCard({ icon, title, detail, tone = "accent" }: { icon: ReactNode; title: string; detail: string; tone?: "accent" | "warning" }) {
  return (
    <div className="concept-card">
      <span className={`concept-icon ${tone}`}>{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}

function PlacementReadout({ selectedRef, fallbackLabel, detail }: { selectedRef: ReturnType<typeof selectionForFace> | undefined; fallbackLabel?: string; detail?: string }) {
  const label = selectedRef?.geometryRefs[0]?.label ?? fallbackLabel;
  return (
    <div className={label ? "placement-chip ready" : "placement-chip"}>
      {label ? `Selected ${label}${detail ? ` · ${detail}` : ""}` : "Select a face in the model viewport"}
    </div>
  );
}

function materialForId(materialId: string, materials: readonly Material[]): Material | undefined {
  return materials.find((material) => material.id === materialId);
}

function SupportIcon() {
  return <Anchor size={18} strokeWidth={1.8} aria-hidden="true" />;
}

function formatDimension(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatLoadCapacity(value: number) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 2 });
}

function formatEquivalentForce(valueNewtons: number, unitSystem: UnitSystem) {
  const converted = forceForUnits(valueNewtons, "N", unitSystem);
  return `${formatNumber(converted.value)} ${converted.units}`;
}

function interpolatedFrameTimeSeconds(frames: Array<{ frameIndex: number; timeSeconds: number }>, framePosition: number): number {
  if (!frames.length) return 0;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  if (framePosition <= first.frameIndex) return first.timeSeconds;
  if (framePosition >= last.frameIndex) return last.timeSeconds;
  const lower = [...frames].reverse().find((frame) => frame.frameIndex <= framePosition) ?? first;
  const upper = frames.find((frame) => frame.frameIndex >= framePosition) ?? last;
  if (lower.frameIndex === upper.frameIndex) return lower.timeSeconds;
  const blend = (framePosition - lower.frameIndex) / (upper.frameIndex - lower.frameIndex);
  return lower.timeSeconds + (upper.timeSeconds - lower.timeSeconds) * Math.max(0, Math.min(1, blend));
}

function peakDisplacementFrame(fields: ResultField[], summary: StructuralResultSummary): { value: number; units: string; timeSeconds: number } | null {
  const displacementFields = fields.filter((field) => field.type === "displacement");
  if (!displacementFields.length) {
    if (!summary.transient || !Number.isFinite(summary.maxDisplacement)) return null;
    return {
      value: summary.maxDisplacement,
      units: summary.maxDisplacementUnits,
      timeSeconds: summary.transient.peakDisplacementTimeSeconds
    };
  }
  const peak = displacementFields
    .map((field) => ({ field, value: activeFieldAbsMax(field) }))
    .reduce((best, item) => item.value > best.value ? item : best, { field: displacementFields[0]!, value: activeFieldAbsMax(displacementFields[0]!) });
  return { value: peak.value, units: peak.field.units, timeSeconds: peak.field.timeSeconds ?? summary.transient?.peakDisplacementTimeSeconds ?? 0 };
}

function activeFieldAbsMax(field: ResultField): number {
  const values = [
    ...field.values.map((value) => Math.abs(value)).filter(Number.isFinite),
    ...(field.samples?.map((sample) => Math.abs(sample.value)).filter(Number.isFinite) ?? [])
  ];
  if (values.length) return Math.max(...values);
  return Math.max(Math.abs(Number(field.min) || 0), Math.abs(Number(field.max) || 0));
}

function dynamicFrameEstimate(settings: DynamicSolverSettings): { count: number; hasFinalPartialStep: boolean } {
  const duration = Math.max(0, settings.endTime - settings.startTime);
  const outputInterval = normalizedDynamicOutputInterval(settings);
  const wholeSteps = Math.floor(duration / outputInterval);
  const remainder = duration - wholeSteps * outputInterval;
  const hasFinalPartialStep = remainder > outputInterval * 1e-9;
  return {
    count: Math.max(1, wholeSteps + 1 + (hasFinalPartialStep ? 1 : 0)),
    hasFinalPartialStep
  };
}

function normalizedDynamicOutputInterval(settings: DynamicSolverSettings) {
  const requestedOutputInterval = Number.isFinite(settings.outputInterval) ? settings.outputInterval : DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS;
  const backendMinimum = Math.max(DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
  return Math.max(requestedOutputInterval, settings.timeStep, backendMinimum);
}

function isDynamicLoadProfile(value: unknown): value is DynamicSolverSettings["loadProfile"] {
  return value === "ramp" || value === "step" || value === "quasi_static" || value === "sinusoidal";
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 1 });
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} s`;
}

function formatInputValue(value: number) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toFixed(3)).toString();
}

function loadTypeLabel(type: LoadType) {
  if (type === "gravity") return "Payload mass";
  return capitalize(type);
}

function defaultValueForLoadType(type: LoadType) {
  if (type === "pressure") return 100;
  if (type === "gravity") return 5;
  return 500;
}

function directionOptionLabel(direction: LoadDirectionLabel) {
  if (direction === "Normal") return "Face normal";
  if (direction === "Opposite normal") return "Opposite face normal";
  return `Global ${direction}`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
