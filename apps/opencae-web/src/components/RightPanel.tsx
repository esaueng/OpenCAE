import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Anchor, ArrowDown, Check, CircleHelp, Eye, Gauge, Grid3X3, Maximize2, Play, Plus, RotateCcw, Ruler, ScanLine, ShieldCheck, Upload, Weight, X } from "lucide-react";
import { defaultPrintParametersFor, effectiveMaterialProperties, massKgForPayloadMaterial, normalizePrintParameters, payloadMaterialForId, payloadMaterials, starterMaterials, type PayloadMaterialCategory, type PrintMaterialParameters } from "@opencae/materials";
import { assessResultFailure, estimateAllowableLoadForSafetyFactor } from "@opencae/schema";
import type { Constraint, DisplayFace, DisplayModel, DynamicSolverSettings, Load, Project, ResultField, ResultSummary, Study } from "@opencae/schema";
import { inferCriticalPrintAxis } from "@opencae/study-core";
import type { ResultMode, ViewMode } from "./CadViewer";
import type { StepId } from "./StepBar";
import { applicationPointForLoad, createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, equivalentForceForLoad, loadMarkerOrdinalLabel, payloadObjectForLoad, unitsForLoadType, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType, type PayloadLoadMetadata, type PayloadMassMode, type PayloadObjectSelection } from "../loadPreview";
import type { SampleModelId } from "../lib/api";
import { dimensionValuesForDisplayModel } from "../modelDimensions";
import { formatModelOrientation, getModelOrientation, type RotationAxis } from "../modelOrientation";
import { shouldShowSampleModelPicker } from "../modelPanelState";
import { SETTING_HELP, type SettingHelpId, type SettingHelpVisual } from "../settingHelp";
import { supportDisplayLabel } from "../supportLabels";
import { getViewportTooltipPosition } from "../tooltipPosition";
import { forceForUnits, formatDensity, formatMass, formatMaterialStress, formatVolume, loadValueForUnits, type UnitSystem } from "../unitDisplay";
import { canNavigateToStep } from "../appShellState";
import { MaterialLibraryModal, ResultsFieldSelector } from "./SimulationWorkflow";

interface RightPanelProps {
  activeStep: StepId;
  project: Project;
  displayModel: DisplayModel;
  study: Study;
  selectedFace: DisplayFace | null;
  viewMode: ViewMode;
  resultMode: ResultMode;
  showDeformed: boolean;
  showDimensions: boolean;
  stressExaggeration: number;
  resultSummary: ResultSummary;
  resultFields?: ResultField[];
  runProgress: number;
  sampleModel: SampleModelId;
  draftLoadType: LoadType;
  draftLoadValue: number;
  draftLoadDirection: LoadDirectionLabel;
  selectedLoadPoint: LoadApplicationPoint | null;
  selectedPayloadObject: PayloadObjectSelection | null;
  onFitView: () => void;
  onRotateModel: (axis: RotationAxis) => void;
  onResetModelOrientation: () => void;
  onLoadSample: (sample?: SampleModelId) => void;
  onUploadModel: (file: File) => void;
  onSampleModelChange: (sample: SampleModelId) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onResultModeChange: (mode: ResultMode) => void;
  onToggleDeformed: () => void;
  onToggleDimensions: () => void;
  onStressExaggerationChange: (value: number) => void;
  onAssignMaterial: (materialId: string, parameters?: Record<string, unknown>) => void;
  onPreviewPrintLayerOrientation?: (orientation: "x" | "y" | "z" | null) => void;
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
  onGenerateMesh: (preset: "coarse" | "medium" | "fine") => void;
  onUpdateSolverSettings?: (settings: Partial<DynamicSolverSettings>) => void;
  onRunSimulation: () => void;
  canRunSimulation: boolean;
  missingRunItems: string[];
  resultFrameIndex?: number;
  onResultFrameChange?: (frameIndex: number) => void;
  onStepSelect: (step: StepId) => void;
}

const EMPTY_PARAMETERS: Record<string, unknown> = {};
const noopDraftPayloadPreviewChange = () => undefined;

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

function ModelPanel({ project, displayModel, study, viewMode, showDimensions, sampleModel, onFitView, onRotateModel, onResetModelOrientation, onViewModeChange, onToggleDimensions, onLoadSample, onUploadModel, onSampleModelChange }: RightPanelProps) {
  const [confirmSampleLoad, setConfirmSampleLoad] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const geometry = project.geometryFiles[0];
  const isBlankProject = !geometry;
  const isUploadedProject = geometry?.metadata.source === "local-upload";
  const showSampleModelPicker = shouldShowSampleModelPicker(project);
  const uploadPreviewFormat = typeof geometry?.metadata.previewFormat === "string" ? geometry.metadata.previewFormat.toUpperCase() : "";
  const isNativeCadImport = Boolean(geometry?.metadata.nativeCadImport);
  const faceCount = Number(geometry?.metadata.faceCount ?? 0);
  const bodyCount = Number(geometry?.metadata.bodyCount ?? 0);
  const sampleLabel = sampleModel === "bracket" ? "Bracket Demo" : sampleModel === "plate" ? "Beam Demo" : "Cantilever Demo";
  const sampleForceLabel = formatEquivalentForce(500, project.unitSystem);
  const sampleSummaryVolumeMm3 = sampleModel === "plate" ? 184_320 : 41_280;
  const sampleSummaryMassG = sampleModel === "plate" ? 498 : 111;
  const sampleLoadTitle = sampleModel === "plate" ? `Payload mass · ${formatMass(0.497664, "kg", project.unitSystem)}` : `Force · ${sampleForceLabel}`;
  const orientation = getModelOrientation(displayModel);
  const hasCustomOrientation = orientation.x !== 0 || orientation.y !== 0 || orientation.z !== 0;
  const preconfigured =
    sampleModel === "bracket"
      ? { support: "2 mounting holes · flange", load: "top face · -Z direction", callout: "An L-bracket is bolted at the flange; a vertical load on the top face creates a peak stress at the inside corner, reduced by the gusset rib." }
      : sampleModel === "plate"
        ? { support: "fixed end face", load: "end payload mass · -Z direction", callout: "A simple beam is fixed at one end and carries a payload mass sitting on the free end, producing bending stress along the span." }
        : { support: "fixed end face", load: "free end face · -Z direction", callout: "A cantilever beam is fixed at one end and loaded at the free end, producing bending stress along the beam span." };

  function handleLoadSampleClick() {
    if (!confirmSampleLoad) {
      setConfirmSampleLoad(true);
      return;
    }
    setConfirmSampleLoad(false);
    onLoadSample(sampleModel);
  }

  return (
    <Panel title="Model" helper="Inspect the 3D part. Orbit with left-drag, pan with right-drag, zoom with scroll.">
      {showSampleModelPicker && (
        <label className="field">
          <HelpLabel helpId="sampleModel">Sample model</HelpLabel>
          <div className="segmented" role="group" aria-label="Sample model">
            {(["bracket", "plate", "cantilever"] as const).map((sample) => (
              <button key={sample} className={sampleModel === sample ? "active" : ""} type="button" onClick={() => onSampleModelChange(sample)}>
                {sample === "plate" ? "Beam" : capitalize(sample)}
              </button>
            ))}
          </div>
          <button
            className={confirmSampleLoad ? "primary wide" : "secondary wide"}
            type="button"
            onClick={handleLoadSampleClick}
            title={confirmSampleLoad ? "Click again to reload the sample project" : "Prepare to reload the sample project"}
          >
            <RotateCcw size={16} />
            {confirmSampleLoad ? "Click again to load sample" : "Load sample project"}
          </button>
          {confirmSampleLoad && <span className="panel-copy confirm-copy">This will reload {sampleLabel} and reset the sample setup.</span>}
        </label>
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
      <div className="summary-box">
        <Info label="Project" value={project.name} />
        <Info label="Model" value={geometry?.filename ?? "No model loaded"} />
        <Info label="Bodies" value={String(bodyCount)} />
        <Info label="Faces" value={String(faceCount)} />
        <Info label="Volume" value={formatVolume(sampleSummaryVolumeMm3, "mm^3", project.unitSystem)} />
        <Info label="Mass" value={formatMass(sampleSummaryMassG, "g", project.unitSystem)} />
        <Info label="Units" value={project.unitSystem === "US" ? "in" : "mm"} />
      </div>
      <button className={showDimensions ? "primary wide" : "secondary wide"} type="button" onClick={onToggleDimensions}>
        <Ruler size={16} />
        {showDimensions ? "Hide dimensions" : "Show dimensions"}
      </button>
      <HelpNote helpId="dimensions" />
      {showDimensions && <ModelDimensions displayModel={displayModel} />}
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
    </Panel>
  );
}

function MaterialPanel({ project, displayModel, study, onAssignMaterial, onPreviewPrintLayerOrientation }: RightPanelProps) {
  const currentAssignment = study.materialAssignments[0];
  const current = currentAssignment?.materialId ?? "mat-aluminum-6061";
  const currentParameters = currentAssignment?.parameters ?? EMPTY_PARAMETERS;
  const [selectedMaterialId, setSelectedMaterialId] = useState(current);
  const [printParameters, setPrintParameters] = useState<PrintMaterialParameters>(() => {
    const material = materialForId(current);
    return material.printProfile ? normalizePrintParameters(material, currentParameters) : defaultPrintParametersFor(material);
  });
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    const material = materialForId(current);
    setSelectedMaterialId(current);
    setPrintParameters(material.printProfile ? normalizePrintParameters(material, currentParameters) : defaultPrintParametersFor(material));
  }, [current, currentParameters]);

  const selectedMaterial = materialForId(selectedMaterialId);
  const assignedMaterial = materialForId(current);
  const printable = Boolean(selectedMaterial.printProfile);
  const criticalLayerAxis = inferCriticalPrintAxis(study, displayModel.faces.map((face) => ({ entityId: face.id, center: face.center })));
  const effectiveMaterial = effectiveMaterialProperties(selectedMaterial, printable ? { ...printParameters } : {}, { criticalLayerAxis });
  const assignedPrintParameters = assignedMaterial.printProfile ? normalizePrintParameters(assignedMaterial, currentParameters) : undefined;
  const assignedDetail = assignedPrintParameters?.printed
    ? `3D printed · ${assignedPrintParameters.infillDensity}% infill`
    : "all bodies";

  useEffect(() => {
    onPreviewPrintLayerOrientation?.(printable && printParameters.printed ? printParameters.layerOrientation ?? "z" : null);
  }, [onPreviewPrintLayerOrientation, printable, printParameters.layerOrientation, printParameters.printed]);

  function handleMaterialChange(materialId: string) {
    const material = materialForId(materialId);
    setSelectedMaterialId(materialId);
    setPrintParameters(material.printProfile ? defaultPrintParametersFor(material) : { printed: false, infillDensity: 100, wallCount: 1, layerOrientation: "z" });
  }

  function updatePrintParameters(patch: Partial<PrintMaterialParameters>) {
    setPrintParameters((previous) => normalizePrintParameters(selectedMaterial, { ...previous, ...patch }));
  }

  return (
    <Panel title="Material" helper="Choose what the part is made of.">
      <label className="field">
        <HelpLabel helpId="materialLibrary">Material library</HelpLabel>
        <select value={selectedMaterialId} onChange={(event) => handleMaterialChange(event.currentTarget.value)}>
          {starterMaterials.map((material) => (
            <option key={material.id} value={material.id}>{material.name}</option>
          ))}
        </select>
      </label>
      <button className="secondary wide" type="button" onClick={() => setShowLibrary(true)}>Open material library</button>
      <div className="summary-box">
        <Info label={printable && printParameters.printed ? "Effective modulus" : "Young's modulus"} value={formatMaterialStress(effectiveMaterial.youngsModulus, project.unitSystem)} />
        <Info label="Poisson ratio" value={String(selectedMaterial.poissonRatio)} />
        <Info label={printable && printParameters.printed ? "Effective density" : "Density"} value={formatDensity(effectiveMaterial.density, "kg/m^3", project.unitSystem)} />
        <Info label={printable && printParameters.printed ? "Effective yield" : "Yield strength"} value={formatMaterialStress(effectiveMaterial.yieldStrength, project.unitSystem)} />
        {printable && printParameters.printed && selectedMaterial.printProfile && <Info label="Print process" value={selectedMaterial.printProfile.process} />}
      </div>
      {printable && (
        <>
          <SectionTitle helpId="printSettings">3D Print Settings</SectionTitle>
          <div className="print-settings">
            <label className="toggle material-print-toggle">
              <input
                type="checkbox"
                checked={Boolean(printParameters.printed)}
                onChange={(event) => updatePrintParameters({ printed: event.currentTarget.checked })}
              />
              <HelpLabel helpId="printedPart">3D printed part</HelpLabel>
            </label>
            {printParameters.printed && (
              <div className="print-settings-grid">
                <label className="field">
                  <HelpLabel helpId="infillDensity">Infill density</HelpLabel>
                  <span className="input-with-unit">
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={printParameters.infillDensity ?? 100}
                      onChange={(event) => updatePrintParameters({ infillDensity: Number(event.currentTarget.value) })}
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
                      value={printParameters.wallCount ?? 1}
                      onChange={(event) => updatePrintParameters({ wallCount: Number(event.currentTarget.value) })}
                    />
                    <span>walls</span>
                  </span>
                </label>
                <label className="field">
                  <HelpLabel helpId="layerDirection">Layer direction</HelpLabel>
                  <select
                    value={printParameters.layerOrientation ?? "z"}
                    onChange={(event) => updatePrintParameters({ layerOrientation: event.currentTarget.value as PrintMaterialParameters["layerOrientation"] })}
                  >
                    <option value="z">Z build direction</option>
                    <option value="x">X build direction</option>
                    <option value="y">Y build direction</option>
                  </select>
                </label>
              </div>
            )}
          </div>
        </>
      )}
      <button className="primary wide" onClick={() => onAssignMaterial(selectedMaterialId, printable ? { ...printParameters } : {})}>Apply material</button>
      <MaterialLibraryModal
        open={showLibrary}
        selectedMaterialId={selectedMaterialId}
        assignedSelectionLabel={study.geometryScope[0]?.label ?? displayModel.name}
        unitSystem={project.unitSystem}
        onSelectMaterial={handleMaterialChange}
        onApply={(materialId) => {
          const material = materialForId(materialId);
          const parameters = materialId === selectedMaterialId ? printParameters : defaultPrintParametersFor(material);
          onAssignMaterial(materialId, material.printProfile ? { ...parameters } : {});
          setShowLibrary(false);
        }}
        onClose={() => setShowLibrary(false)}
      />
      <SectionTitle>Assigned</SectionTitle>
      <div className="concept-card-list">
        <ConceptCard icon={<Check size={18} />} title={assignedMaterial?.name ?? "Material"} detail={`bracket · ${assignedDetail}`} tone="accent" />
      </div>
    </Panel>
  );
}

function SupportsPanel({ selectedFace, study, onAddSupport, onUpdateSupport, onRemoveSupport }: RightPanelProps) {
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const addLabel = study.constraints.length ? "Add another fixed support" : "Add fixed support";
  return (
    <Panel title="Supports" helper="Choose where the part is held fixed. Select a face, then add a fixed support. You can add more than one.">
      <HelpNote helpId="supportPlacement" />
      <PlacementReadout selectedRef={selectedFromViewport} fallbackLabel={selectedFace?.label} />
      <button className="outline-action wide" disabled={!selectedFromViewport} onClick={() => selectedFromViewport && onAddSupport(selectedFromViewport.id)}><Plus size={18} />{addLabel}</button>
      <SectionTitle>Applied</SectionTitle>
      <SupportEditorList study={study} onUpdateSupport={onUpdateSupport} onRemoveSupport={onRemoveSupport} />
      <Callout>Fixed supports prevent any motion of the selected face.</Callout>
    </Panel>
  );
}

function LoadsPanel({
  project,
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
  onRemoveLoad
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
  return (
    <Panel title="Loads" helper={draftLoadType === "gravity" ? "Choose the object carrying payload mass, then add its weight as a load." : "Select a point on the model, then click Add load."}>
      <HelpNote helpId="loadPlacement" />
      <PlacementReadout
        selectedRef={placementSelection}
        fallbackLabel={selectedPayloadObject?.label ?? selectedFace?.label}
        detail={selectedPayloadObject ? "object selected" : selectedLoadPoint ? "point picked" : undefined}
      />
      <label className="field">
        <HelpLabel helpId="loadType">Load type</HelpLabel>
        <div className="segmented" role="group" aria-label="Load type">
          {(["force", "pressure", "gravity"] as const).map((type) => (
            <button
              key={type}
              className={draftLoadType === type ? "active" : ""}
              type="button"
              onClick={() => {
                onDraftLoadTypeChange(type);
                if (type !== draftLoadType) onDraftLoadValueChange(defaultValueForLoadType(type));
              }}
            >
              {loadTypeLabel(type)}
            </button>
          ))}
        </div>
      </label>
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
          {(["-Y", "+Y", "+X", "-X", "+Z", "-Z", "Normal"] as const).map((option) => (
            <option key={option} value={option}>{directionOptionLabel(option)}</option>
          ))}
        </select>
      </label>
      <button className="outline-action wide" disabled={!canAddDraftLoad} onClick={() => canAddDraftLoad && onAddLoad(draftLoadType, effectiveDraftValue, selectedFromViewport?.id, draftLoadDirection, payloadMetadata)}><Plus size={18} />{addLabel}</button>
      <SectionTitle>Applied</SectionTitle>
      <LoadEditorList study={study} unitSystem={project.unitSystem} onUpdateLoad={onUpdateLoad} onPreviewLoadEdit={onPreviewLoadEdit} onRemoveLoad={onRemoveLoad} />
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

function LoadEditorList({ study, unitSystem, onUpdateLoad, onPreviewLoadEdit, onRemoveLoad }: { study: Study; unitSystem: UnitSystem; onUpdateLoad: (load: Load) => void; onPreviewLoadEdit: (load: Load | null) => void; onRemoveLoad: (loadId: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!study.loads.length) return <EmptyEditableList title="Loads" />;
  const loadLabelsById = new Map(createViewerLoadMarkers({ study }).map((marker) => [marker.id, loadMarkerOrdinalLabel(marker)]));

  return (
    <div className="editable-list">
      <h3>Loads</h3>
      {study.loads.map((load) => {
        const editing = editingId === load.id;
        const units = String(load.parameters.units ?? unitsForLoadType(load.type));
        const displayLoad = loadValueForUnits(Number(load.parameters.value ?? 0), units, unitSystem);
        const selection = study.namedSelections.find((candidate) => candidate.id === load.selectionRef);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        const payloadObject = payloadObjectForLoad(load);
        const payloadMaterial = load.type === "gravity" && typeof load.parameters.payloadMaterialId === "string" ? payloadMaterialForId(load.parameters.payloadMaterialId).name : "";
        const pointLabel = payloadObject
          ? ` · ${payloadObject.label}${payloadMaterial ? ` · ${payloadMaterial}` : ""}`
          : applicationPointForLoad(load) ? " · point load" : "";
        const equivalentForce = load.type === "gravity" ? ` · ${formatEquivalentForce(equivalentForceForLoad(load), unitSystem)} weight` : "";
        const loadLabel = loadLabelsById.get(load.id);
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
              <small>{label}{pointLabel} · {directionLabelForLoad(load)} direction{equivalentForce}</small>
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

function LoadEditForm({ load, study, unitSystem, onSave, onCancel, onPreviewChange }: { load: Load; study: Study; unitSystem: UnitSystem; onSave: (load: Load) => void; onCancel: () => void; onPreviewChange: (load: Load | null) => void }) {
  const [type, setType] = useState<"force" | "pressure" | "gravity">(load.type);
  const [value, setValue] = useState(() => {
    const initialUnits = String(load.parameters.units ?? unitsForLoadType(load.type));
    return formatInputValue(loadValueForUnits(Number(load.parameters.value ?? 500), initialUnits, unitSystem).value);
  });
  const [direction, setDirection] = useState<LoadDirectionLabel>(directionLabelForLoad(load));
  const [payloadMaterialId, setPayloadMaterialId] = useState(String(load.parameters.payloadMaterialId ?? "payload-steel"));
  const [payloadMassMode, setPayloadMassMode] = useState<PayloadMassMode>(load.parameters.payloadMassMode === "manual" ? "manual" : "material");
  const units = unitsForLoadType(type);
  const displayUnits = loadValueForUnits(defaultValueForLoadType(type), units, unitSystem).units;
  const payloadObject = payloadObjectForLoad(load) ?? null;
  const payloadVolumeM3 = positiveNumber(load.parameters.payloadVolumeM3) ? load.parameters.payloadVolumeM3 : payloadObject?.volumeM3;
  const calculatedPayloadMass = payloadVolumeM3 ? massKgForPayloadMaterial(payloadMaterialId, payloadVolumeM3) : 0;
  const manualMassKg = loadValueForUnits(Number(value), displayUnits, "SI").value;
  const editedValue = type === "gravity" && payloadMassMode === "material" && calculatedPayloadMass > 0 ? calculatedPayloadMass : manualMassKg;
  const payloadMetadata: PayloadLoadMetadata = type === "gravity"
    ? { payloadMaterialId, ...(payloadVolumeM3 ? { payloadVolumeM3 } : {}), payloadMassMode }
    : {};
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const selectedRef = study.namedSelections.find((selection) => selection.id === load.selectionRef);
  const selectedFace = selectedRef?.geometryRefs[0];
  const directionFace: DisplayFace = useMemo(() => ({
    id: selectedFace?.entityId ?? "selected-face",
    label: selectedFace?.label ?? "selected face",
    color: "#fff",
    center: [0, 0, 0],
    normal: direction === "Normal" && Array.isArray(load.parameters.direction) ? load.parameters.direction as [number, number, number] : [0, 1, 0],
    stressValue: 0
  }), [direction, load.parameters.direction, selectedFace?.entityId, selectedFace?.label]);
  const previewLoad = useMemo(() => editedLoadForForm(load, type, value, displayUnits, units, direction, directionFace, payloadMetadata, editedValue), [direction, directionFace, displayUnits, editedValue, load, payloadMetadata, type, units, value]);

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
          {(["-Y", "+Y", "+X", "-X", "+Z", "-Z", "Normal"] as const).map((option) => (
            <option key={option} value={option}>{option}</option>
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

function editedLoadForForm(load: Load, type: LoadType, value: string, displayUnits: string, units: string, direction: LoadDirectionLabel, directionFace: DisplayFace, payloadMetadata: PayloadLoadMetadata = {}, overrideValue?: number): Load {
  return {
    ...load,
    type,
    parameters: {
      ...load.parameters,
      value: overrideValue ?? loadValueForUnits(Number(value), displayUnits, "SI").value,
      units,
      direction: directionVectorForLabel(direction, directionFace),
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

function MeshPanel({ study, onGenerateMesh }: RightPanelProps) {
  const [preset, setPreset] = useState<"coarse" | "medium" | "fine">(study.meshSettings.preset);
  return (
    <Panel title="Mesh" helper="The mesh breaks the model into small pieces so OpenCAE can calculate results.">
      <label className="field">
        <HelpLabel helpId="meshQuality">Quality preset</HelpLabel>
        <div className="segmented" role="group" aria-label="Mesh quality">
          {(["coarse", "medium", "fine"] as const).map((option) => (
            <button key={option} className={preset === option ? "active" : ""} type="button" onClick={() => setPreset(option)}>{capitalize(option)}</button>
          ))}
        </div>
      </label>
      <button className="primary wide" onClick={() => onGenerateMesh(preset)}><Grid3X3 size={18} />Generate mesh</button>
      <Callout>{capitalize(preset)} creates a {preset === "medium" ? "good balance between accuracy and speed" : preset === "coarse" ? "fast preview mesh for early setup checks" : "denser mesh for more detailed result gradients"}.</Callout>
      {study.meshSettings.summary && (
        <div className="summary-box">
          <Info label="Nodes" value={study.meshSettings.summary.nodes.toLocaleString()} />
          <Info label="Elements" value={study.meshSettings.summary.elements.toLocaleString()} />
          <Info label="Warnings" value={String(study.meshSettings.summary.warnings.length)} />
        </div>
      )}
    </Panel>
  );
}

function RunPanel({ study, runProgress, onRunSimulation, onUpdateSolverSettings, canRunSimulation, missingRunItems }: RightPanelProps) {
  const checks = [
    ["Material assigned", study.materialAssignments.length > 0],
    ["Support added", study.constraints.length > 0],
    ["Load added", study.loads.length > 0],
    ["Mesh generated", study.meshSettings.status === "complete"]
  ] as const;
  const dynamic = study.type === "dynamic_structural" ? study.solverSettings : null;
  const updateDynamicNumber = (key: keyof Pick<DynamicSolverSettings, "endTime" | "timeStep" | "outputInterval" | "dampingRatio">, value: number) => {
    if (Number.isFinite(value)) onUpdateSolverSettings?.({ [key]: value });
  };
  return (
    <Panel title="Run" helper="Run the simulation to estimate stress and displacement.">
      <SectionTitle helpId="runReadiness">Readiness</SectionTitle>
      <div className="checklist">
        {checks.map(([label, done]) => <span key={label} className={done ? "check done" : "check"}><span>{done ? <Check size={18} /> : null}</span>{label}</span>)}
      </div>
      {dynamic && (
        <>
          <SectionTitle>Dynamic settings</SectionTitle>
          <label className="field">
            <span>End time</span>
            <span className="input-with-unit"><input type="number" min={dynamic.timeStep} step={dynamic.timeStep} value={dynamic.endTime} onChange={(event) => updateDynamicNumber("endTime", Number(event.currentTarget.value))} /><span>s</span></span>
          </label>
          <label className="field">
            <span>Time step</span>
            <span className="input-with-unit"><input type="number" min="0.0001" step="0.0005" value={dynamic.timeStep} onChange={(event) => updateDynamicNumber("timeStep", Number(event.currentTarget.value))} /><span>s</span></span>
          </label>
          <label className="field">
            <span>Output interval</span>
            <span className="input-with-unit"><input type="number" min={dynamic.timeStep} step={dynamic.timeStep} value={dynamic.outputInterval} onChange={(event) => updateDynamicNumber("outputInterval", Number(event.currentTarget.value))} /><span>s</span></span>
          </label>
          <label className="field">
            <span>Damping ratio</span>
            <span className="input-with-unit"><input type="number" min="0" step="0.01" value={dynamic.dampingRatio} onChange={(event) => updateDynamicNumber("dampingRatio", Number(event.currentTarget.value))} /><span>ζ</span></span>
          </label>
        </>
      )}
      <button
        className="primary wide"
        onClick={onRunSimulation}
        disabled={!canRunSimulation}
        title={missingRunItems.length ? `Complete before running: ${missingRunItems.join(", ")}` : "Run simulation"}
      >
        <Play size={16} />Run simulation
      </button>
      {missingRunItems.length > 0 && <p className="panel-copy">Complete {missingRunItems.join(", ").toLowerCase()} before running.</p>}
      <div className="progress"><span style={{ width: `${runProgress}%` }} /></div>
      <SectionTitle helpId="solver">Solver</SectionTitle>
      <div className="summary-box">
        <Info label="Backend" value={study.type === "dynamic_structural" ? "local-dynamic-newmark" : "local-static-superposition"} />
        <Info label="Version" value="0.1.0" />
        <Info label="Runner" value="local-in-memory" />
        <Info label="Progress" value={`${runProgress}%`} />
      </div>
    </Panel>
  );
}

function ResultsPanel({
  project,
  resultMode,
  showDeformed,
  stressExaggeration,
  resultSummary,
  resultFields = [],
  study,
  resultFrameIndex = 0,
  onResultFrameChange,
  onResultModeChange,
  onToggleDeformed,
  onStressExaggerationChange
}: RightPanelProps) {
  const [targetSafetyFactor, setTargetSafetyFactor] = useState(1.5);
  const assessment = resultSummary.failureAssessment ?? assessResultFailure(resultSummary);
  const loadCapacity = estimateAllowableLoadForSafetyFactor(resultSummary, targetSafetyFactor);
  const canEstimateLoad = loadCapacity.status === "available";
  const AssessmentIcon = assessment.status === "pass" ? ShieldCheck : AlertTriangle;
  const frames = resultFrames(resultFields);
  const hasPlayback = frames.length > 1;
  const activeFrame = frames.find((frame) => frame.frameIndex === resultFrameIndex) ?? frames[0];
  const peakDisplacement = peakDisplacementFrame(resultFields);
  return (
    <Panel title="Results" helper="View stress and displacement directly on the 3D model.">
      <ResultsFieldSelector
        resultMode={resultMode}
        fields={resultFields}
        unitSystem={project.unitSystem}
        onResultModeChange={onResultModeChange}
      />
      <div className={`failure-assessment ${assessment.status}`}>
        <span className="assessment-icon"><AssessmentIcon size={20} /></span>
        <span>
          <strong>{assessment.title}</strong>
          <small>{assessment.message}</small>
        </span>
      </div>
      <HelpNote helpId="resultMode" />
      {hasPlayback && (
        <div className="dynamic-playback">
          <SectionTitle>Frame</SectionTitle>
          <label className="field range-field">
            <span className="range-label"><span>Current time</span><strong>{activeFrame ? `${activeFrame.timeSeconds.toFixed(4)} s` : "0 s"}</strong></span>
            <input
              type="range"
              min="0"
              max={Math.max(frames.length - 1, 0)}
              step="1"
              value={frames.findIndex((frame) => frame.frameIndex === (activeFrame?.frameIndex ?? 0))}
              onChange={(event) => onResultFrameChange?.(frames[Number(event.currentTarget.value)]?.frameIndex ?? 0)}
            />
          </label>
          <button className="secondary wide" type="button" onClick={() => {
            const currentIndex = frames.findIndex((frame) => frame.frameIndex === (activeFrame?.frameIndex ?? 0));
            onResultFrameChange?.(frames[(currentIndex + 1) % frames.length]?.frameIndex ?? 0);
          }}>Play</button>
          <Info label="Peak displacement" value={peakDisplacement ? `${peakDisplacement.value} ${peakDisplacement.units} at ${peakDisplacement.timeSeconds.toFixed(4)} s` : "Unavailable"} />
        </div>
      )}
      <div className="result-buttons">
        <button className={resultMode === "stress" ? "primary" : "secondary"} onClick={() => onResultModeChange("stress")}>Stress</button>
        <button className={resultMode === "displacement" ? "primary" : "secondary"} onClick={() => onResultModeChange("displacement")}>Displacement</button>
        {resultFields.some((field) => field.type === "velocity") && <button className={resultMode === "velocity" ? "primary" : "secondary"} onClick={() => onResultModeChange("velocity")}>Velocity</button>}
        {resultFields.some((field) => field.type === "acceleration") && <button className={resultMode === "acceleration" ? "primary" : "secondary"} onClick={() => onResultModeChange("acceleration")}>Acceleration</button>}
        <button className={resultMode === "safety_factor" ? "primary" : "secondary"} onClick={() => onResultModeChange("safety_factor")}>Safety factor</button>
      </div>
      {resultMode === "stress" && (
        <label className="field range-field">
          <span className="range-label"><HelpLabel helpId="stressExaggeration">Stress exaggeration</HelpLabel><strong>{stressExaggeration.toFixed(1)}x</strong></span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.1"
            value={stressExaggeration}
            style={{ "--range-progress": `${rangeProgressPercent(stressExaggeration, 1, 4)}%` } as CSSProperties}
            onChange={(event) => onStressExaggerationChange(Number(event.currentTarget.value))}
          />
        </label>
      )}
      <label className="toggle"><input type="checkbox" checked={showDeformed} onChange={onToggleDeformed} /> <HelpLabel helpId="deformedShape">Deformed shape</HelpLabel></label>
      <p className="panel-copy">Red areas have higher stress. Blue areas have lower stress.</p>
      <div className="summary-box">
        <Info label="Max stress" value={`${resultSummary.maxStress} ${resultSummary.maxStressUnits}`} />
        <Info label="Max displacement" value={`${resultSummary.maxDisplacement} ${resultSummary.maxDisplacementUnits}`} />
        <Info label="Safety factor" value={String(resultSummary.safetyFactor)} />
        <Info label="Failure check" value={assessment.title} />
        <Info label="Reaction force" value={`${resultSummary.reactionForce} ${resultSummary.reactionForceUnits}`} />
      </div>
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
          <strong>{canEstimateLoad ? `${formatLoadCapacity(loadCapacity.allowableLoad)} ${loadCapacity.loadUnits}` : "Unavailable"}</strong>
          <small>{canEstimateLoad ? `Current ${formatLoadCapacity(loadCapacity.currentLoad)} ${loadCapacity.loadUnits} · ${formatLoadCapacity(loadCapacity.loadScale)}x` : "Run a valid simulation first."}</small>
        </div>
      </div>
      <div className="legend"><span /> <small>Low</small><small>High</small></div>
    </Panel>
  );
}

export function rangeProgressPercent(value: number, min: number, max: number) {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
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
  const index = WORKFLOW_STEPS.findIndex((step) => step.id === activeStep);
  const previousStep = index > 0 ? WORKFLOW_STEPS[index - 1] : undefined;
  const nextStep = index >= 0 && index < WORKFLOW_STEPS.length - 1 ? WORKFLOW_STEPS[index + 1] : undefined;
  const canGoNext = Boolean(nextStep && canNavigateToStep(nextStep.id, { meshStatus: study.meshSettings.status }));
  return (
    <div className="workflow-nav" aria-label="Workflow navigation">
      <button className="secondary" type="button" disabled={!previousStep} onClick={() => previousStep && onStepSelect(previousStep.id)}>
        {previousStep ? `Back: ${previousStep.label}` : "Back"}
      </button>
      <button className="primary" type="button" disabled={!canGoNext} onClick={() => nextStep && canGoNext && onStepSelect(nextStep.id)}>
        {nextStep ? `Next: ${nextStep.label}` : "Next"}
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
  const help = SETTING_HELP[helpId];
  return (
    <div className="help-note">
      <HelpVisual kind={help.visual} />
      <span>
        <strong>{help.title}</strong>
        <small>{help.body}</small>
      </span>
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

  useLayoutEffect(() => {
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

function materialForId(materialId: string) {
  return starterMaterials.find((material) => material.id === materialId) ?? starterMaterials[0]!;
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

function resultFrames(fields: ResultField[]): Array<{ frameIndex: number; timeSeconds: number }> {
  const frames = new Map<number, number>();
  for (const field of fields) {
    const frameIndex = field.frameIndex ?? 0;
    const timeSeconds = field.timeSeconds ?? 0;
    frames.set(frameIndex, timeSeconds);
  }
  return [...frames.entries()]
    .map(([frameIndex, timeSeconds]) => ({ frameIndex, timeSeconds }))
    .sort((left, right) => left.frameIndex - right.frameIndex);
}

function peakDisplacementFrame(fields: ResultField[]): { value: number; units: string; timeSeconds: number } | null {
  const displacementFields = fields.filter((field) => field.type === "displacement");
  if (!displacementFields.length) return null;
  const peak = displacementFields.reduce((best, field) => field.max > best.max ? field : best, displacementFields[0]!);
  return { value: peak.max, units: peak.units, timeSeconds: peak.timeSeconds ?? 0 };
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 1 });
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
  return `Global ${direction}`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
