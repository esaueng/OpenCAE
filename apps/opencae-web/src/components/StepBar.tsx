import type { Project, Study } from "@opencae/schema";
import { Activity, Anchor, Atom, Box, Github, Layers3, MessageSquare, PanelLeftClose, PanelLeftOpen, Play, Weight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { canNavigateToStep } from "../appShellState";
import type { UnitSystem } from "../unitDisplay";

export type StepId = "model" | "material" | "supports" | "loads" | "mesh" | "run" | "results";

interface StepBarProps {
  activeStep: StepId;
  project: Project;
  study: Study;
  hasResults: boolean;
  collapsed: boolean;
  onSelect: (step: StepId) => void;
  onToggleCollapsed: () => void;
  onUnitSystemChange: (unitSystem: UnitSystem) => void;
}

const steps: ReadonlyArray<{ id: StepId; label: string; Icon: LucideIcon }> = [
  { id: "model", label: "Model", Icon: Box },
  { id: "material", label: "Material", Icon: Atom },
  { id: "supports", label: "Supports", Icon: Anchor },
  { id: "loads", label: "Loads", Icon: Weight },
  { id: "mesh", label: "Mesh", Icon: Layers3 },
  { id: "run", label: "Run", Icon: Play },
  { id: "results", label: "Results", Icon: Activity }
] as const;

export function StepBar({ activeStep, project, study, hasResults, collapsed, onSelect, onToggleCollapsed, onUnitSystemChange }: StepBarProps) {
  const completed: Record<StepId, boolean> = {
    model: true,
    material: study.materialAssignments.length > 0,
    supports: study.constraints.length > 0,
    loads: study.loads.length > 0,
    mesh: study.meshSettings.status === "complete",
    run: hasResults || study.runs.some((run) => run.status === "complete"),
    results: hasResults || study.runs.some((run) => run.status === "complete")
  };

  const unitShort = project.unitSystem === "SI" ? "mm" : "in";
  const currentUnitLabel = project.unitSystem === "SI" ? "Metric" : "Imperial";
  const nextUnitSystem = project.unitSystem === "SI" ? "US" : "SI";

  return (
    <nav className={`stepbar ${collapsed ? "collapsed" : ""}`} aria-label="Simulation workflow">
      <div className="stepbar-header">
        <div className="stepbar-eyebrow">workflow</div>
        <button
          type="button"
          className="stepbar-collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand workflow" : "Collapse workflow"}
          aria-label={collapsed ? "Expand workflow" : "Collapse workflow"}
          aria-pressed={collapsed}
        >
          {collapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
        </button>
      </div>
      <div className="step-list">
      {steps.map((step) => {
        const isActive = activeStep === step.id;
        const isComplete = completed[step.id];
        const canSelect = canNavigateToStep(step.id, { meshStatus: study.meshSettings.status });
        const StepIcon = step.Icon;
        return (
          <button key={step.id} className={`step ${isActive ? "active" : ""}`} disabled={!canSelect} onClick={() => onSelect(step.id)} aria-current={isActive ? "step" : undefined}>
            <span className={`step-icon ${isComplete ? "done" : ""}`} aria-hidden="true">
              <StepIcon size={18} strokeWidth={1.8} />
            </span>
            <span>{step.label}</span>
          </button>
        );
      })}
      </div>
      <div className="stepbar-footer">
        <div className="stepbar-actions" aria-label="Project links">
          <button type="button" className="stepbar-link" onClick={() => undefined}>
            <MessageSquare size={14} aria-hidden="true" />
            Feedback
          </button>
          <a className="stepbar-link" href="https://github.com/esaueng/opencae-beta" target="_blank" rel="noreferrer">
            <Github size={14} aria-hidden="true" />
            GitHub
          </a>
        </div>
        <div><span>study</span><strong>static</strong></div>
        <div className="unit-switch">
          <span>units</span>
          <strong>{unitShort}</strong>
          <button type="button" className="unit-toggle" aria-label={`Switch to ${nextUnitSystem === "SI" ? "metric" : "imperial"} units`} onClick={() => onUnitSystemChange(nextUnitSystem)}>
            <span className="unit-toggle-label">{currentUnitLabel}</span>
            <span className="unit-toggle-short" aria-hidden="true">{unitShort}</span>
          </button>
        </div>
        <div><span>backend</span><strong>local</strong></div>
      </div>
    </nav>
  );
}
