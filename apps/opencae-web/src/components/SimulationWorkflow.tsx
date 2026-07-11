import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Grid3X3, Plus, Search, X } from "lucide-react";
import { compatibleManufacturingProcessesFor, materialCategoryLabel, starterMaterials } from "@opencae/materials";
import { isRunResultReadyStatus } from "@opencae/schema";
import type { Material, ResultField, Study } from "@opencae/schema";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { formatDensity, formatMaterialStress, type UnitSystem } from "../unitDisplay";
import dynamicAnalysisImage from "../assets/simulation-showcase/dynamic-analysis.png";
import staticAnalysisImage from "../assets/simulation-showcase/static-analysis.png";
import type { ResultMode } from "../workspaceViewTypes";
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
              onDoubleClick={() => (option.type === "static" ? onCreateStatic : onCreateDynamic)()}
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
      <path className="showcase-support-post" d="M104 106 L104 274" />
      <path
        className="showcase-support-hatch"
        d="M104 120 l-15 13 M104 148 l-15 13 M104 176 l-15 13 M104 204 l-15 13 M104 232 l-15 13 M104 260 l-15 13"
      />
      <path className="showcase-load-shaft" d="M616 58 L616 138" />
      <path className="showcase-load-chevron" d="M606 126 L616 140 L626 126" />
      <text className="showcase-label showcase-label--load" x="616" y="44" textAnchor="middle">500 N</text>
      <g className="showcase-callout">
        <circle className="showcase-callout-anchor" cx="112" cy="240" r="4" />
        <path className="showcase-callout-leader" d="M116 243 L172 314 L318 314" />
        <text className="showcase-label" x="180" y="306">Fixed support</text>
      </g>
      <g className="showcase-callout">
        <circle className="showcase-callout-anchor" cx="632" cy="258" r="4" />
        <path className="showcase-callout-leader" d="M628 262 L566 318 L392 318" />
        <text className="showcase-label" x="400" y="310">Static peak stress</text>
      </g>
    </svg>
  );
}

function DynamicShowcaseOverlay() {
  return (
    <svg className="analysis-showcase-overlay" viewBox="0 0 720 360" aria-hidden="true" focusable="false">
      <path className="showcase-support-post" d="M86 98 L86 276" />
      <path
        className="showcase-support-hatch"
        d="M86 112 l-15 13 M86 140 l-15 13 M86 168 l-15 13 M86 196 l-15 13 M86 224 l-15 13 M86 252 l-15 13"
      />
      <path className="showcase-load-shaft" d="M612 54 L612 134" />
      <path className="showcase-load-chevron" d="M602 122 L612 136 L622 122" />
      <text className="showcase-label showcase-label--load" x="612" y="40" textAnchor="middle">Impulse load</text>
      <path className="showcase-frame-cross" d="M262 282 h16 M270 274 v16" />
      <path className="showcase-frame-cross" d="M366 250 h16 M374 242 v16" />
      <path className="showcase-frame-cross" d="M472 282 h16 M480 274 v16" />
      <text className="showcase-frame-label" x="270" y="316" textAnchor="middle">Frame 1</text>
      <text className="showcase-frame-label" x="374" y="316" textAnchor="middle">Frame 2</text>
      <text className="showcase-frame-label" x="480" y="316" textAnchor="middle">Frame 3</text>
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
  onApply: (materialId: string) => void;
  onClose: () => void;
}

export function MaterialLibraryModal({ open, selectedMaterialId, assignedSelectionLabel, unitSystem, onApply, onClose }: MaterialLibraryModalProps) {
  const dialogRef = useFocusTrap<HTMLElement>(open, onClose);
  const [query, setQuery] = useState("");
  const [draftMaterialId, setDraftMaterialId] = useState(selectedMaterialId);
  useEffect(() => {
    if (open) {
      setDraftMaterialId(selectedMaterialId);
      setQuery("");
    }
  }, [open, selectedMaterialId]);
  const selectedMaterial = materialForId(draftMaterialId);
  const groupedMaterials = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = starterMaterials.filter((material) => !normalized || material.name.toLowerCase().includes(normalized));
    return [
      { id: "metal", label: "Metals", materials: filtered.filter((material) => material.category === "metal") },
      { id: "plastic", label: "Thermoplastics", materials: filtered.filter((material) => material.category === "plastic") },
      { id: "composite", label: "Composites", materials: filtered.filter((material) => material.category === "composite") },
      { id: "resin", label: "Photopolymer resins", materials: filtered.filter((material) => material.category === "resin") }
    ].filter((group) => group.materials.length > 0);
  }, [query]);
  const compatibleProcesses = compatibleManufacturingProcessesFor(selectedMaterial);
  if (!open) return null;
  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section ref={dialogRef} className="workflow-modal material-library-dialog" role="dialog" aria-modal="true" aria-labelledby="material-library-title">
        <header className="workflow-modal-header">
          <h2 id="material-library-title">Material library</h2>
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
            {groupedMaterials.map((group) => (
              <div className="material-list-group" key={group.id}>
                <h3>{group.label}</h3>
                <div className="material-list">
                  {group.materials.map((material) => {
                    const processCount = compatibleManufacturingProcessesFor(material).length;
                    return (
                      <button key={material.id} className={material.id === draftMaterialId ? "active" : ""} type="button" aria-pressed={material.id === draftMaterialId} onClick={() => setDraftMaterialId(material.id)}>
                        <span>
                          <strong>{material.name}</strong>
                          <small>{processCount} compatible {processCount === 1 ? "process" : "processes"}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {groupedMaterials.length === 0 ? <p className="material-list-empty">No materials match “{query}”.</p> : null}
          </aside>
          <article className="material-preview-pane">
            <h3>{selectedMaterial.name}</h3>
            <p className="material-preview-category">{materialCategoryLabel(selectedMaterial)}</p>
            <PreviewRow label="Material behavior" value="Linear elastic" />
            <PreviewRow label="Directional dependency" value="Isotropic" />
            <PreviewRow label="Young's modulus" value={formatMaterialStress(selectedMaterial.youngsModulus, unitSystem)} />
            <PreviewRow label="Poisson's ratio" value={String(selectedMaterial.poissonRatio)} />
            <PreviewRow label="Density" value={formatDensity(selectedMaterial.density, "kg/m^3", unitSystem)} />
            <div className="material-compatible-processes">
              <strong>Compatible processes</strong>
              <ul>
                {compatibleProcesses.map((process) => <li key={process.id}>{process.label}</li>)}
              </ul>
            </div>
            <div className="assigned-volumes">
              <strong>Apply to</strong>
              <span>{assignedSelectionLabel}</span>
            </div>
          </article>
        </div>
        <footer className="workflow-modal-footer">
          <button className="primary" type="button" onClick={() => onApply(draftMaterialId)}>Select material</button>
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
