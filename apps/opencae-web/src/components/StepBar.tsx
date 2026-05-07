import type { Project, Study } from "@opencae/schema";
import { Activity, Anchor, Atom, Box, Layers3, Moon, PanelLeftClose, PanelLeftOpen, Play, Sun, Weight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { canNavigateToStep } from "../appShellState";
import type { UnitSystem } from "../unitDisplay";
import type { ThemeMode } from "../appPersistence";

export type StepId = "model" | "material" | "supports" | "loads" | "mesh" | "run" | "results";

interface StepBarProps {
  activeStep: StepId;
  project: Project;
  study: Study;
  hasResults: boolean;
  collapsed: boolean;
  themeMode: ThemeMode;
  onSelect: (step: StepId) => void;
  onToggleCollapsed: () => void;
  onToggleTheme: () => void;
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

export function StepBar({ activeStep, project, study, hasResults, collapsed, themeMode, onSelect, onToggleCollapsed, onToggleTheme, onUnitSystemChange }: StepBarProps) {
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
  const studyTypeLabel = study.type === "dynamic_structural" ? "dynamic" : "static";
  const backend = (study.solverSettings as { backend?: unknown }).backend;
  const backendLabel = backend === "local_detailed" ? "local" : "core";
  const ThemeIcon = themeMode === "dark" ? Sun : Moon;

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
          <button
            className="stepbar-link"
            type="button"
            onClick={onToggleTheme}
            title={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            <ThemeIcon size={14} aria-hidden="true" />
            {themeMode === "dark" ? "Light" : "Dark"}
          </button>
        </div>
        <div><span>study</span><strong>{studyTypeLabel}</strong></div>
        <div className="unit-switch">
          <span>units</span>
          <strong>{unitShort}</strong>
          <button type="button" className="unit-toggle" aria-label={`Switch to ${nextUnitSystem === "SI" ? "metric" : "imperial"} units`} onClick={() => onUnitSystemChange(nextUnitSystem)}>
            <span className="unit-toggle-label">{currentUnitLabel}</span>
            <span className="unit-toggle-short" aria-hidden="true">{unitShort}</span>
          </button>
        </div>
        <div><span>backend</span><strong>{backendLabel}</strong></div>
      </div>
    </nav>
  );
}
