import type { Project, Study } from "@opencae/schema";
import { Activity, Anchor, Atom, Box, Layers3, Moon, PanelLeftClose, PanelLeftOpen, Play, Sun, Weight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { canNavigateToStep } from "../appShellState";
import type { RunReadinessItem } from "../runReadiness";
import type { UnitSystem } from "../unitDisplay";
import type { ThemeMode } from "../workspaceViewTypes";

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
  /** Run-gate rows; a step with a blocker renders as blocked rather than done. */
  readiness?: readonly RunReadinessItem[];
  /** Steps carrying the workspace notice (failed mesh/run, cleared results). */
  notices?: Partial<Record<StepId, "error" | "warning">>;
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

/** Which step owns each readiness row, so the rail can show a blocked state where the fix lives. */
const READINESS_STEP: Record<string, StepId> = {
  "Material assigned": "material",
  "Support added": "supports",
  "Load added": "loads",
  "Mesh generated": "mesh",
  "Run settings valid": "run",
  "Study valid": "run"
};

export function readinessBlockersByStep(readiness: readonly RunReadinessItem[]): Partial<Record<StepId, string[]>> {
  const blockers: Partial<Record<StepId, string[]>> = {};
  for (const item of readiness) {
    if (item.done || !item.blockers.length) continue;
    const step = READINESS_STEP[item.label] ?? "run";
    blockers[step] = [...(blockers[step] ?? []), ...item.blockers];
  }
  return blockers;
}

export function StepBar({ activeStep, project, study, hasResults, readiness = [], notices = {}, collapsed, themeMode, onSelect, onToggleCollapsed, onToggleTheme, onUnitSystemChange }: StepBarProps) {
  // Done means "present and valid": a step whose readiness row lists a blocker
  // is shown as blocked, not ticked (2026-09 review D14). Run and Results tick
  // only for results the viewer can show — a seeded sample run record used to
  // tick both beside an empty Results panel.
  const blockersByStep = readinessBlockersByStep(readiness);
  const completed: Record<StepId, boolean> = {
    model: true,
    material: study.materialAssignments.length > 0 && !blockersByStep.material,
    supports: study.constraints.length > 0 && !blockersByStep.supports,
    loads: (study.type === "modal_analysis" || study.loads.length > 0) && !blockersByStep.loads,
    mesh: study.meshSettings.status === "complete" && !blockersByStep.mesh,
    run: hasResults,
    results: hasResults
  };

  const unitShort = project.unitSystem === "SI" ? "mm" : "in";
  const currentUnitLabel = project.unitSystem === "SI" ? "Metric" : "Imperial";
  const nextUnitSystem = project.unitSystem === "SI" ? "US" : "SI";
  const studyTypeLabel = study.type === "dynamic_structural"
    ? "dynamic"
    : study.type === "modal_analysis"
      ? "modal"
      : study.type === "steady_state_thermal"
        ? "thermal"
        : "static";
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
      {steps.filter((step) => study.type !== "modal_analysis" || step.id !== "loads").map((step) => {
        const isActive = activeStep === step.id;
        const isComplete = completed[step.id];
        const canSelect = canNavigateToStep(step.id, { meshStatus: study.meshSettings.status });
        const StepIcon = step.Icon;
        const stepBlockers = blockersByStep[step.id];
        const notice = notices[step.id];
        return (
          <button
            key={step.id}
            className={`step ${isActive ? "active" : ""}`}
            disabled={!canSelect}
            onClick={() => onSelect(step.id)}
            aria-current={isActive ? "step" : undefined}
            title={stepBlockers?.length ? stepBlockers.join(" ") : undefined}
            aria-label={stepBlockers?.length ? `${step.label}: ${stepBlockers.join(" ")}` : notice ? `${step.label}: needs attention` : undefined}
          >
            <span className={`step-icon ${isComplete ? "done" : stepBlockers?.length ? "blocked" : ""}`} aria-hidden="true">
              <StepIcon size={18} strokeWidth={1.8} />
              {notice && <i className={`step-badge ${notice}`} />}
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
      </div>
    </nav>
  );
}
