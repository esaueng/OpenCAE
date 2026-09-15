import { useCallback, useRef } from "react";
import type { StepId } from "./StepBar";
import type { Study } from "@opencae/schema";
import type { RightPanelProps } from "./panels/RightPanelProps";
import { ModelPanel } from "./panels/ModelPanel";
import { MaterialPanel } from "./panels/MaterialPanel";
import { SupportsPanel, LoadsPanel } from "./panels/SupportsLoadsPanels";
import { MeshPanel } from "./panels/MeshPanel";
import { RunPanel } from "./panels/RunPanel";
import { ResultsPanel } from "./panels/ResultsPanels";
import { WorkflowNav, WorkspaceNoticeBanner } from "./panels/PanelChrome";

export type { RightPanelProps, SolverSettingsPatch } from "./panels/RightPanelProps";
export { dynamicSettingConstraintMessage, editableNumberCommitValue } from "./panels/RunPanel";
export { rangeProgressPercent, playbackPeakMarkerPercent, resultModeExplanation } from "./panels/ResultsPanels";
export function RightPanel(props: RightPanelProps) {
  // A panel may register work to commit when Next is pressed (Material applies
  // the previewed selection). The N shortcut and the rail bypass it on purpose:
  // only the in-panel Next reads as "finish this step".
  const beforeNextRef = useRef<(() => void) | null>(null);
  const registerBeforeNext = useCallback((handler: (() => void) | null) => {
    beforeNextRef.current = handler;
  }, []);
  const handleStepSelect = useCallback((step: StepId) => {
    beforeNextRef.current?.();
    props.onStepSelect(step);
  }, [props.onStepSelect]);
  return (
    <aside className="side-panel">
      {props.notice && <WorkspaceNoticeBanner notice={props.notice} activeStep={props.activeStep} onDismiss={props.onDismissNotice} onGoToStep={props.onNoticeStep} />}
      {props.activeStep === "model" && <ModelPanel {...props} />}
      {props.activeStep === "material" && <MaterialPanel {...props} registerBeforeNext={registerBeforeNext} />}
      {props.activeStep === "supports" && <SupportsPanel {...props} />}
      {props.activeStep === "loads" && <LoadsPanel {...props} />}
      {props.activeStep === "mesh" && <MeshPanel {...props} />}
      {props.activeStep === "run" && <RunPanel {...props} />}
      {props.activeStep === "results" && <ResultsPanel {...props} />}
      <WorkflowNav activeStep={props.activeStep} study={props.study} onStepSelect={handleStepSelect} />
    </aside>
  );
}

