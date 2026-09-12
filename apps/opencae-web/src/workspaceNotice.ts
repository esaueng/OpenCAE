import type { StepId } from "./components/StepBar";

export type WorkspaceNoticeTone = "error" | "warning";

/**
 * The one workspace-wide notice (2026-09 review D7). Before it, a failed mesh
 * rendered only on the Mesh panel, a failed run only on the Run panel, and a
 * study edit that cleared results left one line in the collapsed log drawer.
 */
export interface WorkspaceNotice {
  /** Stable identity so a dismissal survives re-renders but not a new event. */
  key: string;
  tone: WorkspaceNoticeTone;
  title: string;
  message: string;
  /** Step that can resolve the notice; rendered as a "Go to …" link and a rail badge. */
  step?: StepId;
  stepLabel?: string;
}

export interface WorkspaceNoticeInputs {
  meshError: string | null;
  meshing: boolean;
  runError: string | null;
  solverRunning: boolean;
  /** The edit message that cleared the last results, e.g. `Load updated.` */
  resultsOutdatedBy: string | null;
  dismissedKey: string | null;
}

export function workspaceNoticeFor(inputs: WorkspaceNoticeInputs): WorkspaceNotice | null {
  const notice = rawNoticeFor(inputs);
  if (!notice || notice.key === inputs.dismissedKey) return null;
  return notice;
}

function rawNoticeFor({ meshError, meshing, runError, solverRunning, resultsOutdatedBy }: WorkspaceNoticeInputs): WorkspaceNotice | null {
  if (meshError && !meshing) {
    return { key: `mesh:${meshError}`, tone: "error", title: "Mesh generation failed", message: meshError, step: "mesh", stepLabel: "Mesh" };
  }
  if (runError && !solverRunning) {
    return { key: `run:${runError}`, tone: "error", title: "Simulation did not complete", message: runError, step: "run", stepLabel: "Run" };
  }
  if (resultsOutdatedBy) {
    return {
      key: `outdated:${resultsOutdatedBy}`,
      tone: "warning",
      title: "Results cleared",
      message: `${resultsOutdatedBy.replace(/\.?$/, ".")} The previous results no longer match the study. Re-run to update them.`,
      step: "run",
      stepLabel: "Run"
    };
  }
  return null;
}
