import { useEffect, useRef, useState, type ReactNode } from "react";
import { Anchor, ArrowDown, Check, Download, Eye, FileText, Grid3X3, Maximize2, Play, Plus, RotateCcw, Ruler, Upload, X } from "lucide-react";
import { starterMaterials } from "@opencae/materials";
import type { Constraint, DisplayFace, DisplayModel, Load, Project, ResultSummary, Study } from "@opencae/schema";
import type { ResultMode, ViewMode } from "./CadViewer";
import type { StepId } from "./StepBar";
import { directionLabelForLoad, directionVectorForLabel, unitsForLoadType, type LoadDirectionLabel, type LoadType } from "../loadPreview";
import type { SampleModelId } from "../lib/api";

interface RightPanelProps {
  activeStep: StepId;
  project: Project;
  displayModel: DisplayModel;
  study: Study;
  selectedFace: DisplayFace | null;
  viewMode: ViewMode;
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  resultSummary: ResultSummary;
  runProgress: number;
  sampleModel: SampleModelId;
  draftLoadType: LoadType;
  draftLoadValue: number;
  draftLoadDirection: LoadDirectionLabel;
  onFitView: () => void;
  onLoadSample: (sample?: SampleModelId) => void;
  onUploadModel: (file: File) => void;
  onSampleModelChange: (sample: SampleModelId) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onResultModeChange: (mode: ResultMode) => void;
  onToggleDeformed: () => void;
  onStressExaggerationChange: (value: number) => void;
  onAssignMaterial: (materialId: string) => void;
  onAddSupport: (selectionRef?: string) => void;
  onUpdateSupport: (support: Constraint) => void;
  onDraftLoadTypeChange: (type: LoadType) => void;
  onDraftLoadValueChange: (value: number) => void;
  onDraftLoadDirectionChange: (direction: LoadDirectionLabel) => void;
  onLoadEditorActiveChange: (active: boolean) => void;
  onAddLoad: (type: LoadType, value: number, selectionRef: string, direction: LoadDirectionLabel) => void;
  onUpdateLoad: (load: Load) => void;
  onGenerateMesh: (preset: "coarse" | "medium" | "fine") => void;
  onRunSimulation: () => void;
  canGenerateReport: boolean;
  reportUrl?: string;
  reportFilename?: string;
  onGenerateReport: () => void;
  onStepSelect: (step: StepId) => void;
}

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

function ModelPanel({ project, displayModel, study, viewMode, sampleModel, onFitView, onViewModeChange, onLoadSample, onUploadModel, onSampleModelChange }: RightPanelProps) {
  const [confirmSampleLoad, setConfirmSampleLoad] = useState(false);
  const [showDimensions, setShowDimensions] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const geometry = project.geometryFiles[0];
  const isBlankProject = !geometry;
  const isUploadedProject = geometry?.metadata.source === "local-upload";
  const uploadPreviewFormat = typeof geometry?.metadata.previewFormat === "string" ? geometry.metadata.previewFormat.toUpperCase() : "";
  const isNativeCadImport = Boolean(geometry?.metadata.nativeCadImport);
  const faceCount = Number(geometry?.metadata.faceCount ?? 0);
  const bodyCount = Number(geometry?.metadata.bodyCount ?? 0);
  const sampleLabel = sampleModel === "bracket" ? "Bracket Demo" : sampleModel === "plate" ? "Plate Demo" : "Cantilever Demo";
  const preconfigured =
    sampleModel === "bracket"
      ? { support: "2 mounting holes · flange", load: "top face · -Y direction", callout: "An L-bracket is bolted at the flange; a vertical load on the top face creates a peak stress at the inside corner, reduced by the gusset rib." }
      : sampleModel === "plate"
        ? { support: "left clamp face", load: "right load pad · -Y direction", callout: "A flat plate is constrained on the left and loaded on the opposite pad, with the central hole acting as the stress concentration." }
        : { support: "fixed end face", load: "free end face · -Y direction", callout: "A cantilever beam is fixed at one end and loaded at the free end, producing bending stress along the beam span." };

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
      <label className="field">
        Sample model
        <div className="segmented" role="group" aria-label="Sample model">
          {(["bracket", "plate", "cantilever"] as const).map((sample) => (
            <button key={sample} className={sampleModel === sample ? "active" : ""} type="button" onClick={() => onSampleModelChange(sample)}>
              {capitalize(sample)}
            </button>
          ))}
        </div>
      </label>
      <div className="summary-box">
        <Info label="Project" value={project.name} />
        <Info label="Model" value={geometry?.filename ?? "No model loaded"} />
        <Info label="Bodies" value={String(bodyCount)} />
        <Info label="Faces" value={String(faceCount)} />
        <Info label="Volume" value="41,280 mm^3" />
        <Info label="Mass" value="111 g" />
        <Info label="Units" value="mm" />
      </div>
      <button className={showDimensions ? "primary wide" : "secondary wide"} type="button" onClick={() => setShowDimensions((value) => !value)}>
        <Ruler size={16} />
        {showDimensions ? "Hide dimensions" : "Show dimensions"}
      </button>
      {showDimensions && <ModelDimensions displayModel={displayModel} />}
      <div className="button-grid">
        <button className="secondary" onClick={onFitView}><Maximize2 size={16} />Fit view</button>
        <button className={viewMode === "mesh" ? "primary" : "secondary"} onClick={() => onViewModeChange(viewMode === "mesh" ? "model" : "mesh")}><Eye size={16} />Toggle mesh</button>
      </div>
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
      <button
        className={confirmSampleLoad ? "primary wide" : "secondary wide"}
        onClick={handleLoadSampleClick}
        title={confirmSampleLoad ? "Click again to reload the sample project" : "Prepare to reload the sample project"}
      >
        <RotateCcw size={16} />
        {confirmSampleLoad ? "Click again to load sample" : "Load sample project"}
      </button>
      {confirmSampleLoad && <p className="panel-copy confirm-copy">This will reload {sampleLabel} and reset the sample setup.</p>}
      {isBlankProject ? (
        <Callout>Upload STEP, STP, or STL to import a model. STL files use the mesh preview; STEP files import as a selectable CAD body.</Callout>
      ) : isUploadedProject ? (
        <Callout>{isNativeCadImport ? `${geometry.filename} is loaded as a selectable STEP import.` : uploadPreviewFormat ? `${geometry.filename} is loaded with a ${uploadPreviewFormat} viewport preview.` : `${geometry.filename} cannot be previewed in this local viewer. Replace it with STEP, STP, or STL.`}</Callout>
      ) : (
        <>
          <SectionTitle>Preconfigured</SectionTitle>
          <div className="concept-card-list">
            <ConceptCard icon={<SupportIcon />} title="Fixed support" detail={preconfigured.support} tone="warning" />
            <ConceptCard icon={<ArrowDown size={18} />} title="Force · 500 N" detail={preconfigured.load} tone="accent" />
          </div>
          <Callout>{preconfigured.callout}</Callout>
        </>
      )}
      <Info label="Study" value={study.name} />
    </Panel>
  );
}

function MaterialPanel({ study, onAssignMaterial }: RightPanelProps) {
  const current = study.materialAssignments[0]?.materialId ?? "mat-aluminum-6061";
  const [selectedMaterialId, setSelectedMaterialId] = useState(current);
  useEffect(() => {
    setSelectedMaterialId(current);
  }, [current]);
  const selectedMaterial = starterMaterials.find((material) => material.id === selectedMaterialId) ?? starterMaterials[0];
  const assignedMaterial = starterMaterials.find((material) => material.id === current) ?? starterMaterials[0];
  return (
    <Panel title="Material" helper="Choose what the part is made of.">
      <label className="field">
        Material library
        <select value={selectedMaterialId} onChange={(event) => setSelectedMaterialId(event.currentTarget.value)}>
          {starterMaterials.map((material) => (
            <option key={material.id} value={material.id}>{material.name}</option>
          ))}
        </select>
      </label>
      {selectedMaterial && (
        <div className="summary-box">
          <Info label="Young's modulus" value={`${formatMPa(selectedMaterial.youngsModulus)} MPa`} />
          <Info label="Poisson ratio" value={String(selectedMaterial.poissonRatio)} />
          <Info label="Density" value={`${selectedMaterial.density.toLocaleString()} kg/m^3`} />
          <Info label="Yield strength" value={`${formatMPa(selectedMaterial.yieldStrength)} MPa`} />
        </div>
      )}
      <button className="primary wide" onClick={() => onAssignMaterial(selectedMaterialId)}>Apply to bracket</button>
      <SectionTitle>Assigned</SectionTitle>
      <div className="concept-card-list">
        <ConceptCard icon={<Check size={18} />} title={assignedMaterial?.name ?? "Material"} detail="bracket · all bodies" tone="accent" />
      </div>
    </Panel>
  );
}

function SupportsPanel({ selectedFace, study, onAddSupport, onUpdateSupport }: RightPanelProps) {
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const addLabel = study.constraints.length ? "Add another fixed support" : "Add fixed support";
  return (
    <Panel title="Supports" helper="Choose where the part is held fixed. Select a face, then add a fixed support. You can add more than one.">
      <PlacementReadout selectedRef={selectedFromViewport} fallbackLabel={selectedFace?.label} />
      <button className="outline-action wide" disabled={!selectedFromViewport} onClick={() => selectedFromViewport && onAddSupport(selectedFromViewport.id)}><Plus size={18} />{addLabel}</button>
      <SectionTitle>Applied</SectionTitle>
      <SupportEditorList study={study} onUpdateSupport={onUpdateSupport} />
      <Callout>Fixed supports prevent any motion of the selected face.</Callout>
    </Panel>
  );
}

function LoadsPanel({
  selectedFace,
  study,
  draftLoadType,
  draftLoadValue,
  draftLoadDirection,
  onDraftLoadTypeChange,
  onDraftLoadValueChange,
  onDraftLoadDirectionChange,
  onAddLoad,
  onUpdateLoad,
  onLoadEditorActiveChange
}: RightPanelProps) {
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const units = unitsForLoadType(draftLoadType);
  return (
    <Panel title="Loads" helper="Choose where force or pressure is applied. Select a face, then add a load.">
      <PlacementReadout selectedRef={selectedFromViewport} fallbackLabel={selectedFace?.label} />
      <label className="field">
        Load type
        <div className="segmented" role="group" aria-label="Load type">
          {(["force", "pressure", "gravity"] as const).map((type) => (
            <button key={type} className={draftLoadType === type ? "active" : ""} type="button" onClick={() => onDraftLoadTypeChange(type)}>{capitalize(type)}</button>
          ))}
        </div>
      </label>
      <label className="field">
        Magnitude
        <span className="input-with-unit">
          <input
            id="load-value"
            type="number"
            value={draftLoadValue}
            onChange={(event) => onDraftLoadValueChange(Number(event.currentTarget.value))}
          />
          <span>{units}</span>
        </span>
      </label>
      <label className="field">
        Direction
        <div className="segmented direction-options" role="group" aria-label="Direction">
          {(["-Y", "+Y", "+X", "-X", "+Z", "-Z", "Normal"] as const).map((option) => (
            <button key={option} className={draftLoadDirection === option ? "active" : ""} type="button" onClick={() => onDraftLoadDirectionChange(option)}>{option}</button>
          ))}
        </div>
      </label>
      <button className="outline-action wide" disabled={!selectedFromViewport} onClick={() => selectedFromViewport && onAddLoad(draftLoadType, draftLoadValue, selectedFromViewport.id, draftLoadDirection)}><Plus size={18} />Add load</button>
      <SectionTitle>Applied</SectionTitle>
      <LoadEditorList study={study} onUpdateLoad={onUpdateLoad} onEditingChange={onLoadEditorActiveChange} />
    </Panel>
  );
}

function LoadEditorList({ study, onUpdateLoad, onEditingChange }: { study: Study; onUpdateLoad: (load: Load) => void; onEditingChange: (active: boolean) => void }) {
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
        const units = String(load.parameters.units ?? (load.type === "pressure" ? "kPa" : "N"));
        const selection = study.namedSelections.find((candidate) => candidate.id === load.selectionRef);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        return (
          <div className="editable-item" key={load.id}>
            <div className="editable-summary">
              <span className="item-icon"><ArrowDown size={18} /></span>
              <strong>{capitalize(load.type)} · {String(load.parameters.value ?? "")} {units}</strong>
              <small>{label} · {directionLabelForLoad(load)} direction</small>
              <span className="remove-glyph" aria-hidden="true"><X size={16} /></span>
            </div>
            {editing ? (
              <LoadEditForm
                load={load}
                study={study}
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

function LoadEditForm({ load, study, onSave, onCancel }: { load: Load; study: Study; onSave: (load: Load) => void; onCancel: () => void }) {
  const [type, setType] = useState<"force" | "pressure" | "gravity">(load.type);
  const [value, setValue] = useState(String(load.parameters.value ?? 500));
  const [direction, setDirection] = useState<LoadDirectionLabel>(directionLabelForLoad(load));
  const units = unitsForLoadType(type);
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
        Load type
        <select value={type} onChange={(event) => setType(event.currentTarget.value as "force" | "pressure" | "gravity")}>
          <option value="force">Force</option>
          <option value="pressure">Pressure</option>
          <option value="gravity">Gravity</option>
        </select>
      </label>
      <label className="field">
        Magnitude
        <input type="number" value={value} onChange={(event) => setValue(event.currentTarget.value)} />
      </label>
      <PlacementReadout selectedRef={selectedRef} />
      <label className="field">
        Direction
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
          onClick={() => onSave({ ...load, type, parameters: { ...load.parameters, value: Number(value), units, direction: directionVectorForLabel(direction, directionFace) } })}
        >
          Save
        </button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function SupportEditorList({ study, onUpdateSupport }: { study: Study; onUpdateSupport: (support: Constraint) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!study.constraints.length) return <EmptyEditableList title="Supports" />;

  return (
    <div className="editable-list">
      <h3>Supports</h3>
      {study.constraints.map((support) => {
        const editing = editingId === support.id;
        const selection = study.namedSelections.find((candidate) => candidate.id === support.selectionRef);
        const label = selection?.geometryRefs[0]?.label ?? "selected face";
        return (
          <div className="editable-item" key={support.id}>
            <div className="editable-summary">
              <span className="item-icon warning"><SupportIcon /></span>
              <strong>{support.type === "fixed" ? "Fixed support" : "Prescribed displacement"}</strong>
              <small>{label}</small>
              <span className="remove-glyph" aria-hidden="true"><X size={16} /></span>
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
        Support type
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
        Quality preset
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

function RunPanel({ study, runProgress, onRunSimulation }: RightPanelProps) {
  const checks = [
    ["Material assigned", study.materialAssignments.length > 0],
    ["Support added", study.constraints.length > 0],
    ["Load added", study.loads.length > 0],
    ["Mesh generated", study.meshSettings.status === "complete"]
  ] as const;
  return (
    <Panel title="Run" helper="Run the simulation to estimate stress and displacement.">
      <SectionTitle>Readiness</SectionTitle>
      <div className="checklist">
        {checks.map(([label, done]) => <span key={label} className={done ? "check done" : "check"}><span>{done ? <Check size={18} /> : null}</span>{label}</span>)}
      </div>
      <button className="primary wide" onClick={onRunSimulation}><Play size={16} />Run simulation</button>
      <div className="progress"><span style={{ width: `${runProgress}%` }} /></div>
      <SectionTitle>Solver</SectionTitle>
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
  return (
    <Panel title="Results" helper="View stress and displacement directly on the 3D model.">
      <Callout>Use the mode controls to inspect stress, displacement, or factor of safety on the 3D model.</Callout>
      <div className="result-buttons">
        <button className={resultMode === "stress" ? "primary" : "secondary"} onClick={() => onResultModeChange("stress")}>Stress</button>
        <button className={resultMode === "displacement" ? "primary" : "secondary"} onClick={() => onResultModeChange("displacement")}>Displacement</button>
        <button className={resultMode === "safety_factor" ? "primary" : "secondary"} onClick={() => onResultModeChange("safety_factor")}>Safety factor</button>
      </div>
      {resultMode === "stress" && (
        <label className="field range-field">
          <span className="range-label"><span>Stress exaggeration</span><strong>{stressExaggeration.toFixed(1)}x</strong></span>
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
      <label className="toggle"><input type="checkbox" checked={showDeformed} onChange={onToggleDeformed} /> Deformed shape</label>
      <p className="panel-copy">Red areas have higher stress. Blue areas have lower stress.</p>
      <div className="summary-box">
        <Info label="Max stress" value={`${resultSummary.maxStress} ${resultSummary.maxStressUnits}`} />
        <Info label="Max displacement" value={`${resultSummary.maxDisplacement} ${resultSummary.maxDisplacementUnits}`} />
        <Info label="Safety factor" value={String(resultSummary.safetyFactor)} />
        <Info label="Reaction force" value={`${resultSummary.reactionForce} ${resultSummary.reactionForceUnits}`} />
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
      <Info label="Overall" value={`${formatDimension(dimensions.x)} x ${formatDimension(dimensions.y)} x ${formatDimension(dimensions.z)} ${dimensions.units}`} />
      <Info label="X length" value={`${formatDimension(dimensions.x)} ${dimensions.units}`} />
      <Info label="Y height" value={`${formatDimension(dimensions.y)} ${dimensions.units}`} />
      <Info label="Z depth" value={`${formatDimension(dimensions.z)} ${dimensions.units}`} />
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="section-title">{children}</h3>;
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

function PlacementReadout({ selectedRef, fallbackLabel }: { selectedRef: ReturnType<typeof selectionForFace> | undefined; fallbackLabel?: string }) {
  return (
    <div className={selectedRef ? "placement-chip ready" : "placement-chip"}>
      {selectedRef ? `Selected ${selectedRef.geometryRefs[0]?.label ?? fallbackLabel}` : "Select a face in the model viewport"}
    </div>
  );
}

function SupportIcon() {
  return <Anchor size={18} strokeWidth={1.8} aria-hidden="true" />;
}

function formatMPa(valuePa: number) {
  return Math.round(valuePa / 1_000_000).toLocaleString();
}

function formatDimension(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
