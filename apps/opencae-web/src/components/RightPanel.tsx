import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Anchor, ArrowDown, Check, CircleHelp, Download, Eye, FileText, Grid3X3, Maximize2, Play, Plus, RotateCcw, Ruler, ShieldCheck, Upload, X } from "lucide-react";
import { defaultPrintParametersFor, effectiveMaterialProperties, normalizePrintParameters, starterMaterials, type PrintMaterialParameters } from "@opencae/materials";
import { assessResultFailure, estimateAllowableLoadForSafetyFactor } from "@opencae/schema";
import type { Constraint, DisplayFace, DisplayModel, Load, Project, ResultSummary, Study } from "@opencae/schema";
import type { ResultMode, ViewMode } from "./CadViewer";
import type { StepId } from "./StepBar";
import { applicationPointForLoad, directionLabelForLoad, directionVectorForLabel, equivalentForceForLoad, unitsForLoadType, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType } from "../loadPreview";
import type { SampleModelId } from "../lib/api";
import { formatModelOrientation, getModelOrientation, type RotationAxis } from "../modelOrientation";
import { shouldShowSampleModelPicker } from "../modelPanelState";
import { SETTING_HELP, type SettingHelpId, type SettingHelpVisual } from "../settingHelp";
import { supportDisplayLabel } from "../supportLabels";
import { getViewportTooltipPosition } from "../tooltipPosition";
import { forceForUnits, formatDensity, formatMass, formatMaterialStress, formatVolume, loadValueForUnits, type UnitSystem } from "../unitDisplay";

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
  runProgress: number;
  sampleModel: SampleModelId;
  draftLoadType: LoadType;
  draftLoadValue: number;
  draftLoadDirection: LoadDirectionLabel;
  selectedLoadPoint: LoadApplicationPoint | null;
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
  onAddSupport: (selectionRef?: string) => void;
  onUpdateSupport: (support: Constraint) => void;
  onRemoveSupport: (supportId: string) => void;
  onDraftLoadTypeChange: (type: LoadType) => void;
  onDraftLoadValueChange: (value: number) => void;
  onDraftLoadDirectionChange: (direction: LoadDirectionLabel) => void;
  onLoadEditorActiveChange: (active: boolean) => void;
  onAddLoad: (type: LoadType, value: number, selectionRef: string | undefined, direction: LoadDirectionLabel) => void;
  onUpdateLoad: (load: Load) => void;
  onRemoveLoad: (loadId: string) => void;
  onGenerateMesh: (preset: "coarse" | "medium" | "fine") => void;
  onRunSimulation: () => void;
  canRunSimulation: boolean;
  missingRunItems: string[];
  canGenerateReport: boolean;
  reportUrl?: string;
  reportFilename?: string;
  onGenerateReport: () => void;
  onStepSelect: (step: StepId) => void;
}

const EMPTY_PARAMETERS: Record<string, unknown> = {};

export function RightPanel(props: RightPanelProps) {
  return (
    <aside className="side-panel">
      {props.selectedFace && <div className="selection-readout">Face selected: {props.selectedFace.label}</div>}
      {props.activeStep === "model" && <ModelPanel {...props} />}
      {props.activeStep === "material" && <MaterialPanel {...props} />}
      {props.activeStep === "supports" && <SupportsPanel {...props} />}
      {props.activeStep === "loads" && <LoadsPanel {...props} />}
      {props.activeStep === "mesh" && <MeshPanel {...props} />}
      {props.activeStep === "run" && <RunPanel {...props} />}
      {props.activeStep === "results" && <ResultsPanel {...props} />}
      {props.activeStep === "report" && <ReportPanel {...props} />}
      <WorkflowNav activeStep={props.activeStep} onStepSelect={props.onStepSelect} />
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
  const sampleLabel = sampleModel === "bracket" ? "Bracket Demo" : sampleModel === "plate" ? "Plate Demo" : "Cantilever Demo";
  const sampleForceLabel = formatEquivalentForce(500, project.unitSystem);
  const orientation = getModelOrientation(displayModel);
  const hasCustomOrientation = orientation.x !== 0 || orientation.y !== 0 || orientation.z !== 0;
  const preconfigured =
    sampleModel === "bracket"
      ? { support: "2 mounting holes · flange", load: "top face · -Z direction", callout: "An L-bracket is bolted at the flange; a vertical load on the top face creates a peak stress at the inside corner, reduced by the gusset rib." }
      : sampleModel === "plate"
        ? { support: "left clamp face", load: "right load pad · -Z direction", callout: "A flat plate is constrained on the left and loaded on the opposite pad, with the central hole acting as the stress concentration." }
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
                {capitalize(sample)}
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
        <Info label="Volume" value={formatVolume(41_280, "mm^3", project.unitSystem)} />
        <Info label="Mass" value={formatMass(111, "g", project.unitSystem)} />
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
            <ConceptCard icon={<ArrowDown size={18} />} title={`Force · ${sampleForceLabel}`} detail={preconfigured.load} tone="accent" />
          </div>
          <Callout>{preconfigured.callout}</Callout>
        </>
      )}
      <Info label="Study" value={study.name} />
    </Panel>
  );
}

function MaterialPanel({ project, study, onAssignMaterial }: RightPanelProps) {
  const currentAssignment = study.materialAssignments[0];
  const current = currentAssignment?.materialId ?? "mat-aluminum-6061";
  const currentParameters = currentAssignment?.parameters ?? EMPTY_PARAMETERS;
  const [selectedMaterialId, setSelectedMaterialId] = useState(current);
  const [printParameters, setPrintParameters] = useState<PrintMaterialParameters>(() => {
    const material = materialForId(current);
    return material.printProfile ? normalizePrintParameters(material, currentParameters) : defaultPrintParametersFor(material);
  });

  useEffect(() => {
    const material = materialForId(current);
    setSelectedMaterialId(current);
    setPrintParameters(material.printProfile ? normalizePrintParameters(material, currentParameters) : defaultPrintParametersFor(material));
  }, [current, currentParameters]);

  const selectedMaterial = materialForId(selectedMaterialId);
  const assignedMaterial = materialForId(current);
  const printable = Boolean(selectedMaterial.printProfile);
  const effectiveMaterial = effectiveMaterialProperties(selectedMaterial, printable ? { ...printParameters } : {});
  const assignedPrintParameters = assignedMaterial.printProfile ? normalizePrintParameters(assignedMaterial, currentParameters) : undefined;
  const assignedDetail = assignedPrintParameters?.printed
    ? `3D printed · ${assignedPrintParameters.infillDensity}% infill`
    : "all bodies";

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
      <div className="summary-box">
        <Info label={printable && printParameters.printed ? "Effective modulus" : "Young's modulus"} value={formatMaterialStress(effectiveMaterial.youngsModulus, project.unitSystem)} />
        <Info label="Poisson ratio" value={String(selectedMaterial.poissonRatio)} />
        <Info label={printable && printParameters.printed ? "Effective density" : "Density"} value={formatDensity(effectiveMaterial.density, "kg/m^3", project.unitSystem)} />
        <Info label={printable && printParameters.printed ? "Effective yield" : "Yield strength"} value={formatMaterialStress(effectiveMaterial.yieldStrength, project.unitSystem)} />
        {selectedMaterial.printProfile && <Info label="Print process" value={selectedMaterial.printProfile.process} />}
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
  onDraftLoadTypeChange,
  onDraftLoadValueChange,
  onDraftLoadDirectionChange,
  onAddLoad,
  onUpdateLoad,
  onRemoveLoad,
  onLoadEditorActiveChange
}: RightPanelProps) {
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const hasSelectedFace = Boolean(selectedFace);
  const units = unitsForLoadType(draftLoadType);
  const displayDraftLoad = loadValueForUnits(draftLoadValue, units, project.unitSystem);
  const valueLabel = draftLoadType === "gravity" ? "Payload mass" : "Magnitude";
  const addLabel = draftLoadType === "gravity" ? "Add payload mass" : "Add load";
  function handleDraftValueChange(displayValue: number) {
    const baseValue = loadValueForUnits(displayValue, displayDraftLoad.units, "SI");
    onDraftLoadValueChange(baseValue.value);
  }
  return (
    <Panel title="Loads" helper="Choose where force, pressure, or payload weight is applied. Click a specific point on a face, then add a load.">
      <HelpNote helpId="loadPlacement" />
      <PlacementReadout selectedRef={selectedFromViewport} fallbackLabel={selectedFace?.label} detail={selectedLoadPoint ? "point picked" : undefined} />
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
      {draftLoadType === "gravity" && <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: draftLoadValue } }), project.unitSystem)} equivalent weight.</Callout>}
      <label className="field">
        <HelpLabel helpId="loadDirection">Direction</HelpLabel>
        <select value={draftLoadDirection} onChange={(event) => onDraftLoadDirectionChange(event.currentTarget.value as LoadDirectionLabel)}>
          {(["-Y", "+Y", "+X", "-X", "+Z", "-Z", "Normal"] as const).map((option) => (
            <option key={option} value={option}>{directionOptionLabel(option)}</option>
          ))}
        </select>
      </label>
      <button className="outline-action wide" disabled={!hasSelectedFace} onClick={() => hasSelectedFace && onAddLoad(draftLoadType, draftLoadValue, selectedFromViewport?.id, draftLoadDirection)}><Plus size={18} />{addLabel}</button>
      <SectionTitle>Applied</SectionTitle>
      <LoadEditorList study={study} unitSystem={project.unitSystem} onUpdateLoad={onUpdateLoad} onRemoveLoad={onRemoveLoad} onEditingChange={onLoadEditorActiveChange} />
    </Panel>
  );
}

function LoadEditorList({ study, unitSystem, onUpdateLoad, onRemoveLoad, onEditingChange }: { study: Study; unitSystem: UnitSystem; onUpdateLoad: (load: Load) => void; onRemoveLoad: (loadId: string) => void; onEditingChange: (active: boolean) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => {
    onEditingChange(editingId !== null);
    return () => onEditingChange(false);
  }, [editingId, onEditingChange]);
  if (!study.loads.length) return <EmptyEditableList title="Loads" />;

  return (
    <div className="editable-list">
      <h3>Loads</h3>
      {study.loads.map((load) => {
        const editing = editingId === load.id;
        const units = String(load.parameters.units ?? unitsForLoadType(load.type));
        const displayLoad = loadValueForUnits(Number(load.parameters.value ?? 0), units, unitSystem);
        const selection = study.namedSelections.find((candidate) => candidate.id === load.selectionRef);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        const pointLabel = applicationPointForLoad(load) ? " · point load" : "";
        const equivalentForce = load.type === "gravity" ? ` · ${formatEquivalentForce(equivalentForceForLoad(load), unitSystem)} weight` : "";
        return (
          <div className="editable-item" key={load.id}>
            <div className="editable-summary">
              <span className="item-icon"><ArrowDown size={18} /></span>
              <strong>{loadTypeLabel(load.type)} · {formatNumber(displayLoad.value)} {displayLoad.units}</strong>
              <small>{label}{pointLabel} · {directionLabelForLoad(load)} direction{equivalentForce}</small>
              <button className="remove-glyph" type="button" aria-label={`Remove ${loadTypeLabel(load.type)} load`} onClick={() => onRemoveLoad(load.id)}><X size={16} /></button>
            </div>
            {editing ? (
              <LoadEditForm
                load={load}
                study={study}
                unitSystem={unitSystem}
                onCancel={() => setEditingId(null)}
                onSave={(nextLoad) => {
                  onUpdateLoad(nextLoad);
                  setEditingId(null);
                }}
              />
            ) : (
              <button className="secondary wide" type="button" onClick={() => setEditingId(load.id)}>Edit load</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LoadEditForm({ load, study, unitSystem, onSave, onCancel }: { load: Load; study: Study; unitSystem: UnitSystem; onSave: (load: Load) => void; onCancel: () => void }) {
  const [type, setType] = useState<"force" | "pressure" | "gravity">(load.type);
  const [value, setValue] = useState(() => {
    const initialUnits = String(load.parameters.units ?? unitsForLoadType(load.type));
    return formatInputValue(loadValueForUnits(Number(load.parameters.value ?? 500), initialUnits, unitSystem).value);
  });
  const [direction, setDirection] = useState<LoadDirectionLabel>(directionLabelForLoad(load));
  const units = unitsForLoadType(type);
  const displayUnits = loadValueForUnits(defaultValueForLoadType(type), units, unitSystem).units;
  const selectedRef = study.namedSelections.find((selection) => selection.id === load.selectionRef);
  const selectedFace = selectedRef?.geometryRefs[0];
  const directionFace: DisplayFace = {
    id: selectedFace?.entityId ?? "selected-face",
    label: selectedFace?.label ?? "selected face",
    color: "#fff",
    center: [0, 0, 0],
    normal: direction === "Normal" && Array.isArray(load.parameters.direction) ? load.parameters.direction as [number, number, number] : [0, 1, 0],
    stressValue: 0
  };
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
      <label className="field">
        <HelpLabel helpId="loadMagnitude">{type === "gravity" ? "Payload mass" : "Magnitude"}</HelpLabel>
        <span className="input-with-unit">
          <input type="number" value={value} onChange={(event) => setValue(event.currentTarget.value)} />
          <span>{displayUnits}</span>
        </span>
      </label>
      {type === "gravity" && <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: loadValueForUnits(Number(value), displayUnits, "SI").value } }), unitSystem)} equivalent weight.</Callout>}
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
          onClick={() => onSave({ ...load, type, parameters: { ...load.parameters, value: loadValueForUnits(Number(value), displayUnits, "SI").value, units, direction: directionVectorForLabel(direction, directionFace) } })}
        >
          Save
        </button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
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

function RunPanel({ study, runProgress, onRunSimulation, canRunSimulation, missingRunItems }: RightPanelProps) {
  const checks = [
    ["Material assigned", study.materialAssignments.length > 0],
    ["Support added", study.constraints.length > 0],
    ["Load added", study.loads.length > 0],
    ["Mesh generated", study.meshSettings.status === "complete"]
  ] as const;
  return (
    <Panel title="Run" helper="Run the simulation to estimate stress and displacement.">
      <SectionTitle helpId="runReadiness">Readiness</SectionTitle>
      <div className="checklist">
        {checks.map(([label, done]) => <span key={label} className={done ? "check done" : "check"}><span>{done ? <Check size={18} /> : null}</span>{label}</span>)}
      </div>
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
        <Info label="Backend" value="local-static-superposition" />
        <Info label="Version" value="0.1.0" />
        <Info label="Runner" value="local-in-memory" />
        <Info label="Progress" value={`${runProgress}%`} />
      </div>
    </Panel>
  );
}

function ResultsPanel({
  resultMode,
  showDeformed,
  stressExaggeration,
  resultSummary,
  onResultModeChange,
  onToggleDeformed,
  onStressExaggerationChange,
  canGenerateReport,
  reportUrl,
  reportFilename,
  onGenerateReport
}: RightPanelProps) {
  const [targetSafetyFactor, setTargetSafetyFactor] = useState(1.5);
  const assessment = resultSummary.failureAssessment ?? assessResultFailure(resultSummary);
  const loadCapacity = estimateAllowableLoadForSafetyFactor(resultSummary, targetSafetyFactor);
  const canEstimateLoad = loadCapacity.status === "available";
  const AssessmentIcon = assessment.status === "pass" ? ShieldCheck : AlertTriangle;
  return (
    <Panel title="Results" helper="View stress and displacement directly on the 3D model.">
      <div className={`failure-assessment ${assessment.status}`}>
        <span className="assessment-icon"><AssessmentIcon size={20} /></span>
        <span>
          <strong>{assessment.title}</strong>
          <small>{assessment.message}</small>
        </span>
      </div>
      <HelpNote helpId="resultMode" />
      <div className="result-buttons">
        <button className={resultMode === "stress" ? "primary" : "secondary"} onClick={() => onResultModeChange("stress")}>Stress</button>
        <button className={resultMode === "displacement" ? "primary" : "secondary"} onClick={() => onResultModeChange("displacement")}>Displacement</button>
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
      <ReportDownloadAction
        canGenerateReport={canGenerateReport}
        reportUrl={reportUrl}
        reportFilename={reportFilename}
        onGenerateReport={onGenerateReport}
        label="Generate report"
        icon={<FileText size={16} />}
      />
    </Panel>
  );
}

function ReportPanel({ canGenerateReport, reportUrl, reportFilename, onGenerateReport }: RightPanelProps) {
  return (
    <Panel title="Report" helper="Generate a polished PDF report you can share.">
      <HelpNote helpId="reportOutput" />
      <div className="summary-box">
        <Info label="Format" value="PDF · print ready" />
        <Info label="Companion" value="HTML · self-contained" />
        <Info label="Output" value="./data/reports" />
      </div>
      <ReportDownloadAction
        canGenerateReport={canGenerateReport}
        reportUrl={reportUrl}
        reportFilename={reportFilename}
        onGenerateReport={onGenerateReport}
        label="Generate & download PDF"
        icon={<Download size={18} />}
      />
      <SectionTitle>Contents</SectionTitle>
      <div className="report-list">
        {["Project & study", "Material & boundary conditions", "Mesh summary", "Stress field & max locations", "Displacement field", "Reaction forces", "Diagnostics"].map((item) => (
          <div key={item}>{item}</div>
        ))}
      </div>
    </Panel>
  );
}

function ReportDownloadAction({
  canGenerateReport,
  reportUrl,
  reportFilename,
  onGenerateReport,
  label,
  icon
}: {
  canGenerateReport: boolean;
  reportUrl?: string;
  reportFilename?: string;
  onGenerateReport: () => void;
  label: string;
  icon: ReactNode;
}) {
  if (!canGenerateReport || !reportUrl) {
    return <button className="primary wide" type="button" onClick={onGenerateReport}>{icon}{label}</button>;
  }
  return (
    <a className="primary wide" href={reportUrl} download={reportFilename} onClick={onGenerateReport}>
      {icon}{label}
    </a>
  );
}

function Panel({ title, helper, children }: { title: string; helper: string; children: ReactNode }) {
  const step = ["Model", "Material", "Supports", "Loads", "Mesh", "Run", "Results", "Report"].indexOf(title) + 1;
  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-eyebrow">Step {step || 1} of 8</div>
        <h2>{title}</h2>
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
  { id: "results", label: "Results" },
  { id: "report", label: "Report" }
];

function WorkflowNav({ activeStep, onStepSelect }: { activeStep: StepId; onStepSelect: (step: StepId) => void }) {
  const index = WORKFLOW_STEPS.findIndex((step) => step.id === activeStep);
  const previousStep = index > 0 ? WORKFLOW_STEPS[index - 1] : undefined;
  const nextStep = index >= 0 && index < WORKFLOW_STEPS.length - 1 ? WORKFLOW_STEPS[index + 1] : undefined;
  return (
    <div className="workflow-nav" aria-label="Workflow navigation">
      <button className="secondary" type="button" disabled={!previousStep} onClick={() => previousStep && onStepSelect(previousStep.id)}>
        {previousStep ? `Back: ${previousStep.label}` : "Back"}
      </button>
      <button className="primary" type="button" disabled={!nextStep} onClick={() => nextStep && onStepSelect(nextStep.id)}>
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
  const dimensions = displayModel.dimensions;
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
      <Info label="Overall" value={`${formatDimension(dimensions.x)} x ${formatDimension(dimensions.z)} x ${formatDimension(dimensions.y)} ${dimensions.units}`} />
      <Info label="X length" value={`${formatDimension(dimensions.x)} ${dimensions.units}`} />
      <Info label="Y depth" value={`${formatDimension(dimensions.z)} ${dimensions.units}`} />
      <Info label="Z height" value={`${formatDimension(dimensions.y)} ${dimensions.units}`} />
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
