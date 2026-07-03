import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Grid3X3, Plus, Search, X } from "lucide-react";
import { starterMaterials } from "@opencae/materials";
import { isRunResultReadyStatus } from "@opencae/schema";
import type { Material, ResultField, Study } from "@opencae/schema";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { formatDensity, formatMaterialStress, type UnitSystem } from "../unitDisplay";
import dynamicAnalysisImage from "../assets/simulation-showcase/dynamic-analysis.png";
import staticAnalysisImage from "../assets/simulation-showcase/static-analysis.png";
import type { ResultMode } from "./CadViewer";
import type { StepId } from "./StepBar";

type BoundaryConditionType = "fixed" | "prescribed_displacement" | "force" | "pressure" | "gravity";

interface CreateSimulationModalProps {
  open: boolean;
  onCreateStatic: () => void;
  onCreateDynamic: () => void;
  onClose: () => void;
}

export function CreateSimulationModal({ open, onCreateStatic, onCreateDynamic, onClose }: CreateSimulationModalProps) {
  const dialogRef = useFocusTrap<HTMLElement>(open, onClose);
  if (!open) return null;
  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section ref={dialogRef} className="workflow-modal create-simulation-dialog" role="dialog" aria-modal="true" aria-labelledby="create-simulation-title">
        <header className="workflow-modal-header">
          <h2 id="create-simulation-title">Create Simulation</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close create simulation">
            <X size={18} />
          </button>
        </header>
        <SimulationTypePicker onCreateStatic={onCreateStatic} onCreateDynamic={onCreateDynamic} />
      </section>
    </div>
  );
}

export function CreateSimulationScreen({ onCreateStatic, onCreateDynamic }: Omit<CreateSimulationModalProps, "open" | "onClose">) {
  return (
    <main className="simulation-type-screen" aria-labelledby="simulation-type-title">
      <section className="workflow-modal create-simulation-dialog simulation-type-card">
        <header className="workflow-modal-header simulation-type-header">
          <span>
            <small>New project</small>
            <h2 id="simulation-type-title">Choose Simulation Type</h2>
          </span>
        </header>
        <SimulationTypePicker onCreateStatic={onCreateStatic} onCreateDynamic={onCreateDynamic} />
      </section>
    </main>
  );
}

type AnalysisChoice = "static" | "dynamic";

function SimulationTypePicker({ onCreateStatic, onCreateDynamic }: Omit<CreateSimulationModalProps, "open" | "onClose">) {
  const [selectedType, setSelectedType] = useState<AnalysisChoice>("static");
  const selectedAnalysis = selectedType === "static" ? staticAnalysisOption : dynamicAnalysisOption;
  const handleCreate = selectedType === "static" ? onCreateStatic : onCreateDynamic;
  return (
    <>
      <div className="simulation-picker-layout">
        <section className="simulation-choice-list" aria-label="Choose simulation type">
          <h3>Choose simulation type</h3>
          {[staticAnalysisOption, dynamicAnalysisOption].map((option) => (
            <button
              key={option.type}
              className={`simulation-choice-card ${selectedType === option.type ? "active" : ""}`}
              type="button"
              aria-pressed={selectedType === option.type}
              onClick={() => setSelectedType(option.type)}
            >
              <AnalysisShowcase option={option} variant="compact" />
              <span>
                <strong>{option.title}</strong>
                <small>{option.summary}</small>
              </span>
            </button>
          ))}
        </section>
        <article className="analysis-description selected-analysis-summary">
          <AnalysisShowcase option={selectedAnalysis} variant="large" />
          <h3>{selectedAnalysis.title}</h3>
          <p>{selectedAnalysis.description}</p>
          <div className="analysis-tags" aria-label={`${selectedAnalysis.title} capabilities`}>
            {selectedAnalysis.tags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </article>
      </div>
      <footer className="workflow-modal-footer">
        <span><strong>Need Help?</strong> Static handles steady loads; Dynamic handles transient loads with inertia.</span>
        <button className="primary" type="button" onClick={handleCreate}>Create Simulation</button>
      </footer>
    </>
  );
}

interface AnalysisOption {
  type: AnalysisChoice;
  title: string;
  summary: string;
  description: string;
  imageAlt: string;
  image: string;
  tags: string[];
}

function AnalysisShowcase({ option, variant }: { option: AnalysisOption; variant: "compact" | "large" }) {
  return (
    <figure className={`analysis-showcase analysis-showcase--${variant} analysis-showcase--${option.type}`}>
      <img src={option.image} alt={variant === "large" ? `${option.imageAlt} large preview` : option.imageAlt} />
      {option.type === "static" ? <StaticShowcaseOverlay /> : <DynamicShowcaseOverlay />}
    </figure>
  );
}

function StaticShowcaseOverlay() {
  return (
    <svg className="analysis-showcase-overlay" viewBox="0 0 720 360" aria-hidden="true" focusable="false">
      <path className="showcase-support-line" d="M112 108 L112 272" />
      <path className="showcase-support-arrow" d="M88 122 L112 96 L136 122" />
      <path className="showcase-support-arrow" d="M88 258 L112 284 L136 258" />
      <path className="showcase-load-line" d="M616 56 L616 116" />
      <path className="showcase-load-head" d="M584 108 L616 164 L648 108 Z" />
      <text className="showcase-load-label" x="560" y="48">500 N</text>
      <text className="showcase-caption showcase-caption--support" x="76" y="324">Fixed support</text>
      <text className="showcase-caption showcase-caption--result" x="424" y="324">Static peak stress</text>
    </svg>
  );
}

function DynamicShowcaseOverlay() {
  return (
    <svg className="analysis-showcase-overlay" viewBox="0 0 720 360" aria-hidden="true" focusable="false">
      <path className="showcase-support-line" d="M92 98 L92 276" />
      <path className="showcase-support-arrow" d="M68 112 L92 86 L116 112" />
      <path className="showcase-support-arrow" d="M68 262 L92 288 L116 262" />
      <path className="showcase-load-line" d="M612 52 L612 112" />
      <path className="showcase-load-head" d="M580 104 L612 160 L644 104 Z" />
      <text className="showcase-load-label" x="532" y="46">Impulse load</text>
      <path className="showcase-frame-arc" d="M270 284 C330 244 420 244 480 284" />
      <circle className="showcase-frame-dot showcase-frame-dot--one" cx="270" cy="284" r="8" />
      <circle className="showcase-frame-dot showcase-frame-dot--two" cx="374" cy="252" r="8" />
      <circle className="showcase-frame-dot showcase-frame-dot--three" cx="480" cy="284" r="8" />
      <text className="showcase-frame-label" x="236" y="324">Frame 1</text>
      <text className="showcase-frame-label" x="340" y="324">Frame 2</text>
      <text className="showcase-frame-label" x="444" y="324">Frame 3</text>
    </svg>
  );
}

const staticAnalysisOption = {
  type: "static" as AnalysisChoice,
  title: "Static Analysis",
  summary: "Steady load stress and deflection",
  description: "Determine displacements, stresses, and strains caused by constraints and loads. This local workflow supports linear elastic static stress simulation.",
  imageAlt: "Static stress example",
  image: staticAnalysisImage,
  tags: ["Solid", "Steady loads", "Linear", "Local solver"]
} satisfies AnalysisOption;

const dynamicAnalysisOption = {
  type: "dynamic" as AnalysisChoice,
  title: "Dynamic Analysis",
  summary: "Time-dependent stress response",
  description: "Time-dependent structural response with inertia, damping, velocity, and acceleration using local Newmark integration.",
  imageAlt: "Dynamic stress frame sequence example",
  image: dynamicAnalysisImage,
  tags: ["Solid", "Transient loads", "Newmark", "Playback frames"]
} satisfies AnalysisOption;

interface StudyTreeProps {
  activeStep: StepId;
  study: Study;
  hasGeometry: boolean;
  hasResults: boolean;
  runProgress: number;
  onSelect: (step: StepId) => void;
  onOpenBoundaryMenu: () => void;
}

export function StudyTree({ activeStep, study, hasGeometry, hasResults, runProgress, onSelect, onOpenBoundaryMenu }: StudyTreeProps) {
  const status = workflowStatus(study, hasGeometry, hasResults, runProgress);
  return (
    <nav className="study-tree" aria-label="Simulation setup tree">
      <TreeSection title="Geometries">
        <TreeButton label="Geometry" step="model" activeStep={activeStep} status={status.geometry} onSelect={onSelect} />
      </TreeSection>
      <TreeSection title="Simulations" action={<TreePlus label="Create boundary condition" onClick={onOpenBoundaryMenu} />}>
        <TreeButton label={study.name} step="model" activeStep={activeStep} status="complete" onSelect={onSelect} />
        <div className="study-tree-children">
          <TreeButton label="Geometry" step="model" activeStep={activeStep} status={status.geometry} onSelect={onSelect} />
          <TreeButton label="Materials" step="material" activeStep={activeStep} status={status.materials} onSelect={onSelect} />
          <TreeButton label="Boundary conditions" step="supports" activeStep={activeStep} status={status.boundaryConditions} onSelect={onSelect} action={<TreePlus label="Add boundary condition" onClick={onOpenBoundaryMenu} />} />
          <TreeButton label="Numerics" step="run" activeStep={activeStep} status="complete" onSelect={onSelect} />
          <TreeButton label="Simulation control" step="run" activeStep={activeStep} status={status.simulationControl} onSelect={onSelect} />
          <TreeButton label="Result control" step="results" activeStep={activeStep} status={status.resultControl} onSelect={onSelect} />
          <TreeButton label="Mesh" step="mesh" activeStep={activeStep} status={status.mesh} onSelect={onSelect} />
          <TreeButton label="Simulation runs" step="run" activeStep={activeStep} status={status.runs} onSelect={onSelect} />
          {study.runs.map((run, index) => (
            <button key={run.id} className="tree-run-item" type="button" onClick={() => onSelect(isRunResultReadyStatus(run.status) ? "results" : "run")}>
              {(() => {
                const runStatus = isRunResultReadyStatus(run.status) ? "complete" : run.status === "failed" ? "missing" : "running";
                return <span className={`setup-status ${runStatus}`} role="img" aria-label={runStatus} />;
              })()}
              Run {index + 1}
            </button>
          ))}
        </div>
      </TreeSection>
      <TreeSection title="Job status">
        <span className={`job-status-row ${status.runs}`}>{runProgress > 0 && runProgress < 100 ? `Run in progress · ${runProgress}%` : hasResults ? "Latest run complete" : "No active job"}</span>
      </TreeSection>
    </nav>
  );
}

type SetupStatus = "complete" | "missing" | "running" | "inactive";
interface WorkflowStatus {
  geometry: SetupStatus;
  materials: SetupStatus;
  boundaryConditions: SetupStatus;
  simulationControl: SetupStatus;
  resultControl: SetupStatus;
  mesh: SetupStatus;
  runs: SetupStatus;
}

function workflowStatus(study: Study, hasGeometry: boolean, hasResults: boolean, runProgress: number): WorkflowStatus {
  const running = runProgress > 0 && runProgress < 100;
  return {
    geometry: hasGeometry ? "complete" : "missing",
    materials: study.materialAssignments.length ? "complete" : "missing",
    boundaryConditions: study.constraints.length && study.loads.length ? "complete" : "missing",
    simulationControl: study.meshSettings.status === "complete" ? "complete" : "inactive",
    resultControl: "complete",
    mesh: running ? "running" : study.meshSettings.status === "complete" ? "complete" : "missing",
    runs: running ? "running" : hasResults || study.runs.some((run) => isRunResultReadyStatus(run.status)) ? "complete" : "missing"
  };
}

function TreeSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="study-tree-section">
      <div className="study-tree-section-header">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function TreeButton({ label, step, activeStep, status, action, onSelect }: { label: string; step: StepId; activeStep: StepId; status: SetupStatus; action?: ReactNode; onSelect: (step: StepId) => void }) {
  return (
    <div className={`tree-row ${activeStep === step ? "active" : ""}`}>
      <button type="button" aria-current={activeStep === step ? "step" : undefined} onClick={() => onSelect(step)}>
        <span className={`setup-status ${status}`} role="img" aria-label={status} />
        {label}
      </button>
      {action}
    </div>
  );
}

function TreePlus({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="tree-plus" type="button" onClick={onClick} aria-label={label} title={label}>
      <Plus size={14} />
    </button>
  );
}

interface MaterialLibraryModalProps {
  open: boolean;
  selectedMaterialId: string;
  assignedSelectionLabel: string;
  unitSystem: UnitSystem;
  onSelectMaterial: (materialId: string) => void;
  onApply: (materialId: string) => void;
  onClose: () => void;
}

export function MaterialLibraryModal({ open, selectedMaterialId, assignedSelectionLabel, unitSystem, onSelectMaterial, onApply, onClose }: MaterialLibraryModalProps) {
  const dialogRef = useFocusTrap<HTMLElement>(open, onClose);
  const [query, setQuery] = useState("");
  const selectedMaterial = materialForId(selectedMaterialId);
  const groupedMaterials = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return starterMaterials.filter((material) => !normalized || material.name.toLowerCase().includes(normalized));
  }, [query]);
  if (!open) return null;
  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section ref={dialogRef} className="workflow-modal material-library-dialog" role="dialog" aria-modal="true" aria-labelledby="material-library-title">
        <header className="workflow-modal-header">
          <h2 id="material-library-title">Material</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close material library">
            <X size={18} />
          </button>
        </header>
        <div className="material-library-layout">
          <aside className="material-list-pane">
            <label className="material-search">
              <span className="visually-hidden">Search materials</span>
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search materials" />
              <Search size={18} />
            </label>
            <h3>DEFAULT</h3>
            <div className="material-list">
              {groupedMaterials.map((material) => (
                <button key={material.id} className={material.id === selectedMaterialId ? "active" : ""} type="button" aria-pressed={material.id === selectedMaterialId} onClick={() => onSelectMaterial(material.id)}>
                  {material.name}
                </button>
              ))}
            </div>
          </aside>
          <article className="material-preview-pane">
            <h3>{selectedMaterial.name}</h3>
            <PreviewRow label="Material behavior" value="Linear elastic" />
            <PreviewRow label="Directional dependency" value="Isotropic" />
            <PreviewRow label="Young's modulus" value={formatMaterialStress(selectedMaterial.youngsModulus, unitSystem)} />
            <PreviewRow label="Poisson's ratio" value={String(selectedMaterial.poissonRatio)} />
            <PreviewRow label="Density" value={formatDensity(selectedMaterial.density, "kg/m^3", unitSystem)} />
            <div className="assigned-volumes">
              <strong>Assigned Volumes</strong>
              <span>{assignedSelectionLabel}</span>
            </div>
          </article>
        </div>
        <footer className="workflow-modal-footer">
          <button className="primary" type="button" onClick={() => onApply(selectedMaterialId)}>Apply</button>
          <button className="secondary" type="button" onClick={onClose}>Cancel</button>
        </footer>
      </section>
    </div>
  );
}

function materialForId(materialId: string): Material {
  return starterMaterials.find((material) => material.id === materialId) ?? starterMaterials[0]!;
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="material-preview-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function BoundaryConditionMenu({ open, onSelect, onClose }: { open: boolean; onSelect: (type: BoundaryConditionType) => void; onClose: () => void }) {
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) firstButtonRef.current?.focus();
  }, [open]);
  if (!open) return null;
  const enabled: Array<{ type: BoundaryConditionType; label: string }> = [
    { type: "fixed", label: "Fixed support" },
    { type: "prescribed_displacement", label: "Prescribed displacement" },
    { type: "force", label: "Force" },
    { type: "pressure", label: "Pressure" },
    { type: "gravity", label: "Payload mass" }
  ];
  const future = ["Bolt preload", "Elastic support", "Remote displacement", "Remote force", "Surface load", "Volume load", "Hinge constraint"];
  return (
    <div
      className="condition-menu"
      role="group"
      aria-label="Add boundary condition"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="condition-menu-header">
        <strong>Add boundary condition</strong>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close boundary condition menu"><X size={16} /></button>
      </div>
      {enabled.map((item, index) => (
        <button key={item.type} ref={index === 0 ? firstButtonRef : undefined} type="button" onClick={() => onSelect(item.type)}>
          {item.label}
        </button>
      ))}
      {future.map((label) => (
        <button key={label} className="disabled" type="button" disabled>
          {label}
          <small>Coming soon</small>
        </button>
      ))}
    </div>
  );
}

export function ResultsFieldSelector({ resultMode, fields, unitSystem, defaultOpen = false, onResultModeChange }: { resultMode: ResultMode; fields: ResultField[]; unitSystem: UnitSystem; defaultOpen?: boolean; onResultModeChange: (mode: ResultMode) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const available = new Set(fields.map((field) => field.type));
  const active = resultOptions.find((option) => option.mode === resultMode) ?? resultOptions[0]!;
  const stressUnits = unitSystem === "US" ? "psi" : "Pa";
  return (
    <div
      className="result-field-selector"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) setOpen(false);
      }}
    >
      {open && (
        <div className="result-field-menu" role="group" aria-label="Result fields">
          {resultOptions.map((option) => {
            const enabled = option.mode ? available.has(option.mode) : false;
            const units = option.mode ? fields.find((field) => field.type === option.mode)?.units : undefined;
            return (
              <button
                key={option.label}
                className={`result-option ${enabled ? "" : "disabled"}`}
                type="button"
                disabled={!enabled}
                onClick={() => {
                  if (option.mode) onResultModeChange(option.mode);
                  setOpen(false);
                }}
              >
                {option.label}
                {units ? <small>{units}</small> : null}
                {option.children ? <ChevronDown size={14} /> : null}
              </button>
            );
          })}
        </div>
      )}
      <div className="result-field-controls">
        <button className="result-field-button" type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="true" aria-expanded={open}>
          {active.label}
          <Grid3X3 size={15} />
        </button>
        <button className="result-unit-button" type="button">{activeUnitForResult(resultMode, active.mode ? fields.find((field) => field.type === active.mode)?.units : undefined, stressUnits)}</button>
      </div>
    </div>
  );
}

const resultOptions: Array<{ label: string; mode?: ResultMode; children?: boolean }> = [
  { label: "Von Mises Stress", mode: "stress" },
  { label: "Total Strain", children: true },
  { label: "Displacement", mode: "displacement", children: true },
  { label: "Velocity", mode: "velocity" },
  { label: "Acceleration", mode: "acceleration" },
  { label: "Cauchy Stress", children: true },
  { label: "Safety factor", mode: "safety_factor" }
];

function activeUnitForResult(resultMode: ResultMode, units: string | undefined, stressUnits: string): string {
  if (resultMode === "safety_factor") return "-";
  if (units) return units;
  return resultMode === "stress" ? stressUnits : "";
}
