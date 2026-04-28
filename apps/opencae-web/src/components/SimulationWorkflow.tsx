import { useMemo, useState, type ReactNode } from "react";
import { Activity, Atom, Box, Check, ChevronDown, Circle, Grid3X3, Plus, Search, X } from "lucide-react";
import { starterMaterials } from "@opencae/materials";
import type { Material, ResultField, Study } from "@opencae/schema";
import { formatDensity, formatMaterialStress, type UnitSystem } from "../unitDisplay";
import type { ResultMode } from "./CadViewer";
import type { StepId } from "./StepBar";

type BoundaryConditionType = "fixed" | "prescribed_displacement" | "force" | "pressure" | "gravity";

interface CreateSimulationModalProps {
  open: boolean;
  onCreateStatic: () => void;
  onClose: () => void;
}

export function CreateSimulationModal({ open, onCreateStatic, onClose }: CreateSimulationModalProps) {
  if (!open) return null;
  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section className="workflow-modal create-simulation-dialog" role="dialog" aria-modal="true" aria-labelledby="create-simulation-title">
        <header className="workflow-modal-header">
          <h2 id="create-simulation-title">Create Simulation</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close create simulation">
            <X size={18} />
          </button>
        </header>
        <div className="simulation-options-layout">
          <nav className="simulation-option-list" aria-label="Analysis families">
            <SimulationGroup title="Flow">
              <DisabledAnalysis label="Incompressible" />
              <DisabledAnalysis label="Compressible" />
              <DisabledAnalysis label="Convective Heat Transfer" />
            </SimulationGroup>
            <SimulationGroup title="Structural">
              <button className="analysis-option active" type="button" onClick={onCreateStatic}>
                <span className="analysis-option-icon"><Activity size={16} /></span>
                <span>Static</span>
              </button>
              <DisabledAnalysis label="Dynamic" />
              <DisabledAnalysis label="Heat Transfer" />
              <DisabledAnalysis label="Frequency Analysis" />
            </SimulationGroup>
            <SimulationGroup title="Electromagnetic">
              <DisabledAnalysis label="Electromagnetics" />
            </SimulationGroup>
          </nav>
          <article className="analysis-description">
            <div className="analysis-preview" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <h3>Static Analysis</h3>
            <p>Determine displacements, stresses, and strains caused by constraints and loads. This local workflow supports linear elastic static stress simulation.</p>
            <div className="analysis-tags" aria-label="Static analysis capabilities">
              <span>Solid</span>
              <span>Steady loads</span>
              <span>Linear</span>
              <span>Local solver</span>
            </div>
          </article>
        </div>
        <footer className="workflow-modal-footer">
          <span><strong>Need Help?</strong> Start with Static Analysis for a force, pressure, or payload load on a solid part.</span>
          <button className="primary" type="button" onClick={onCreateStatic}>Create Simulation</button>
        </footer>
      </section>
    </div>
  );
}

function SimulationGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="simulation-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function DisabledAnalysis({ label }: { label: string }) {
  return (
    <button className="analysis-option disabled" type="button" disabled>
      <span className="analysis-option-icon"><Circle size={14} /></span>
      <span>{label}</span>
      <small>Coming soon</small>
    </button>
  );
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
        <button className="result-unit-button" type="button">{resultMode === "safety_factor" ? "-" : stressUnits}</button>
      </div>
    </div>
  );
}

const resultOptions: Array<{ label: string; mode?: ResultMode; children?: boolean }> = [
  { label: "Von Mises Stress", mode: "stress" },
  { label: "Total Strain", children: true },
  { label: "Displacement", mode: "displacement", children: true },
  { label: "Cauchy Stress", children: true },
  { label: "Safety factor", mode: "safety_factor" }
];
