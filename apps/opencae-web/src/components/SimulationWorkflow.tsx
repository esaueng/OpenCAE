import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Grid3X3, Plus, Search, X } from "lucide-react";
import { starterMaterials } from "@opencae/materials";
import type { Material, ResultField, Study } from "@opencae/schema";
import { formatDensity, formatMaterialStress, type UnitSystem } from "../unitDisplay";
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
  const [selectedType, setSelectedType] = useState<"static" | "dynamic">("static");
  if (!open) return null;
  const selectedAnalysis = selectedType === "static" ? staticAnalysisOption : dynamicAnalysisOption;
  const handleCreate = selectedType === "static" ? onCreateStatic : onCreateDynamic;
  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section className="workflow-modal create-simulation-dialog" role="dialog" aria-modal="true" aria-labelledby="create-simulation-title">
        <header className="workflow-modal-header">
          <h2 id="create-simulation-title">Create Simulation</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close create simulation">
            <X size={18} />
          </button>
        </header>
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
                <img src={option.image} alt={option.imageAlt} />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.summary}</small>
                </span>
              </button>
            ))}
          </section>
          <article className="analysis-description selected-analysis-summary">
            <img className="analysis-example-image" src={selectedAnalysis.image} alt={`${selectedAnalysis.imageAlt} large preview`} />
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
      </section>
    </div>
  );
}

type AnalysisChoice = "static" | "dynamic";

const staticAnalysisOption = {
  type: "static" as AnalysisChoice,
  title: "Static Analysis",
  summary: "Steady load stress and deflection",
  description: "Determine displacements, stresses, and strains caused by constraints and loads. This local workflow supports linear elastic static stress simulation.",
  imageAlt: "Static stress example",
  image: svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360">
    <rect width="720" height="360" fill="#0b131d"/>
    <rect x="70" y="106" width="56" height="150" rx="4" fill="#2f4053"/>
    <path d="M126 132 L592 82 L612 150 L146 212 Z" fill="#8b98a5"/>
    <path d="M146 212 L612 150 L612 188 L146 250 Z" fill="#66727f"/>
    <path d="M126 132 L146 212 L146 250 L126 172 Z" fill="#a5b0bb"/>
    <path d="M128 137 L250 124 L356 112 L470 99 L606 84 L611 145 L470 165 L356 181 L250 197 L142 211 Z" fill="url(#stress)"/>
    <path d="M120 96 L120 270" stroke="#48a4ff" stroke-width="6"/>
    <path d="M96 108 L120 84 L144 108" fill="none" stroke="#48a4ff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M96 258 L120 282 L144 258" fill="none" stroke="#48a4ff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M544 42 L544 88" stroke="#ffc233" stroke-width="8" stroke-linecap="round"/>
    <path d="M518 78 L544 122 L570 78 Z" fill="#ffc233"/>
    <text x="474" y="42" fill="#ffd36a" font-family="Arial, sans-serif" font-size="26" font-weight="700">500 N</text>
    <text x="72" y="308" fill="#9fb7d2" font-family="Arial, sans-serif" font-size="22" font-weight="700">Fixed support</text>
    <text x="392" y="315" fill="#d7e0ea" font-family="Arial, sans-serif" font-size="22" font-weight="700">Static peak stress</text>
    <defs>
      <linearGradient id="stress" x1="0" x2="1">
        <stop offset="0" stop-color="#1a78ff"/>
        <stop offset="0.28" stop-color="#28d4ff"/>
        <stop offset="0.5" stop-color="#27d65f"/>
        <stop offset="0.7" stop-color="#f4df23"/>
        <stop offset="1" stop-color="#f0472e"/>
      </linearGradient>
    </defs>
  </svg>`),
  tags: ["Solid", "Steady loads", "Linear", "Local solver"]
};

const dynamicAnalysisOption = {
  type: "dynamic" as AnalysisChoice,
  title: "Dynamic Analysis",
  summary: "Time-dependent stress response",
  description: "Time-dependent structural response with inertia, damping, velocity, and acceleration using local Newmark integration.",
  imageAlt: "Dynamic stress frame sequence example",
  image: svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360">
    <rect width="720" height="360" fill="#0b131d"/>
    <g opacity="0.28">
      <path d="M112 104 L574 74 L604 132 L142 184 Z" fill="#6d7783"/>
      <path d="M142 184 L604 132 L604 165 L142 222 Z" fill="#53606b"/>
    </g>
    <path d="M112 112 C252 95 356 88 574 80 L606 144 C384 158 252 180 144 210 Z" fill="url(#frameA)" opacity="0.65"/>
    <path d="M112 138 C260 132 382 136 582 128 L612 194 C392 178 260 174 144 236 Z" fill="url(#frameB)" opacity="0.8"/>
    <path d="M80 88 L80 270" stroke="#48a4ff" stroke-width="6"/>
    <path d="M56 100 L80 76 L104 100" fill="none" stroke="#48a4ff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M56 258 L80 282 L104 258" fill="none" stroke="#48a4ff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M548 42 L548 88" stroke="#ffc233" stroke-width="8" stroke-linecap="round"/>
    <path d="M522 78 L548 122 L574 78 Z" fill="#ffc233"/>
    <path d="M256 286 C320 246 402 246 466 286" fill="none" stroke="#4da3ff" stroke-width="6" stroke-linecap="round"/>
    <circle cx="256" cy="286" r="10" fill="#4da3ff"/>
    <circle cx="360" cy="254" r="10" fill="#ffce42"/>
    <circle cx="466" cy="286" r="10" fill="#f15b45"/>
    <text x="224" y="326" fill="#d7e0ea" font-family="Arial, sans-serif" font-size="22" font-weight="700">Frame 1</text>
    <text x="330" y="326" fill="#d7e0ea" font-family="Arial, sans-serif" font-size="22" font-weight="700">Frame 2</text>
    <text x="436" y="326" fill="#d7e0ea" font-family="Arial, sans-serif" font-size="22" font-weight="700">Frame 3</text>
    <text x="452" y="42" fill="#ffd36a" font-family="Arial, sans-serif" font-size="26" font-weight="700">Impulse load</text>
    <defs>
      <linearGradient id="frameA" x1="0" x2="1">
        <stop offset="0" stop-color="#1a78ff"/>
        <stop offset="0.46" stop-color="#27d65f"/>
        <stop offset="1" stop-color="#f0472e"/>
      </linearGradient>
      <linearGradient id="frameB" x1="0" x2="1">
        <stop offset="0" stop-color="#174bdb"/>
        <stop offset="0.28" stop-color="#25c8ff"/>
        <stop offset="0.62" stop-color="#f4df23"/>
        <stop offset="1" stop-color="#ff5d2d"/>
      </linearGradient>
    </defs>
  </svg>`),
  tags: ["Solid", "Transient loads", "Newmark", "Playback frames"]
};

function svgDataUri(svg: string) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

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
            <button key={run.id} className="tree-run-item" type="button" onClick={() => onSelect(run.status === "complete" ? "results" : "run")}>
              <span className={`setup-status ${run.status === "complete" ? "complete" : run.status === "failed" ? "missing" : "running"}`} />
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
    runs: running ? "running" : hasResults || study.runs.some((run) => run.status === "complete") ? "complete" : "missing"
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
      <button type="button" onClick={() => onSelect(step)}>
        <span className={`setup-status ${status}`} />
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
  const [query, setQuery] = useState("");
  const selectedMaterial = materialForId(selectedMaterialId);
  const groupedMaterials = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return starterMaterials.filter((material) => !normalized || material.name.toLowerCase().includes(normalized));
  }, [query]);
  if (!open) return null;
  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section className="workflow-modal material-library-dialog" role="dialog" aria-modal="true" aria-labelledby="material-library-title">
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
                <button key={material.id} className={material.id === selectedMaterialId ? "active" : ""} type="button" onClick={() => onSelectMaterial(material.id)}>
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
    <div className="condition-menu" role="menu" aria-label="Add boundary condition">
      <div className="condition-menu-header">
        <strong>Add boundary condition</strong>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close boundary condition menu"><X size={16} /></button>
      </div>
      {enabled.map((item) => (
        <button key={item.type} type="button" role="menuitem" onClick={() => onSelect(item.type)}>
          {item.label}
        </button>
      ))}
      {future.map((label) => (
        <button key={label} className="disabled" type="button" role="menuitem" disabled>
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
    <div className="result-field-selector">
      {open && (
        <div className="result-field-menu" role="menu" aria-label="Result fields">
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
        <button className="result-field-button" type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open}>
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
