import type { Study } from "@opencae/schema";
import { Activity, Box, Check, Crosshair, FileText, FlaskConical, Layers3, Play, Shield } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type StepId = "model" | "material" | "supports" | "loads" | "mesh" | "run" | "results" | "report";

interface StepBarProps {
  activeStep: StepId;
  study: Study;
  hasResults: boolean;
  onSelect: (step: StepId) => void;
}

const steps: ReadonlyArray<{ id: StepId; label: string; Icon: LucideIcon }> = [
  { id: "model", label: "Model", Icon: Box },
  { id: "material", label: "Material", Icon: FlaskConical },
  { id: "supports", label: "Supports", Icon: Shield },
  { id: "loads", label: "Loads", Icon: Crosshair },
  { id: "mesh", label: "Mesh", Icon: Layers3 },
  { id: "run", label: "Run", Icon: Play },
  { id: "results", label: "Results", Icon: Activity },
  { id: "report", label: "Report", Icon: FileText }
] as const;

export function StepBar({ activeStep, study, hasResults, onSelect }: StepBarProps) {
  const completed: Record<StepId, boolean> = {
    model: true,
    material: study.materialAssignments.length > 0,
    supports: study.constraints.length > 0,
    loads: study.loads.length > 0,
    mesh: study.meshSettings.status === "complete",
    run: hasResults || study.runs.some((run) => run.status === "complete"),
    results: hasResults || study.runs.some((run) => run.status === "complete"),
    report: study.runs.some((run) => Boolean(run.reportRef))
  };

  return (
    <nav className="stepbar" aria-label="Simulation workflow">
      <div className="stepbar-eyebrow">workflow</div>
      <div className="step-list">
      {steps.map((step, index) => {
        const isActive = activeStep === step.id;
        const isComplete = completed[step.id];
        const StepIcon = step.Icon;
        return (
          <button key={step.id} className={`step ${isActive ? "active" : ""}`} onClick={() => onSelect(step.id)} aria-current={isActive ? "step" : undefined}>
            <span className={`step-icon ${isComplete ? "done" : ""}`} aria-hidden="true">
              <StepIcon size={18} strokeWidth={1.8} />
              {isComplete ? <span className="step-check"><Check size={11} strokeWidth={2.5} /></span> : <span className="step-number">{index + 1}</span>}
            </span>
            <span>{step.label}</span>
            <span className={`step-dot ${isComplete ? "done" : ""}`} />
          </button>
        );
      })}
      </div>
      <div className="stepbar-footer">
        <div><span>study</span><strong>static</strong></div>
        <div><span>units</span><strong>SI · mm</strong></div>
        <div><span>backend</span><strong>local</strong></div>
      </div>
    </nav>
  );
}
