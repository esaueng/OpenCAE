export function shouldShowStartScreen({
  homeRequested,
  hasProject,
  hasDisplayModel,
  hasStudy
}: {
  homeRequested: boolean;
  hasProject: boolean;
  hasDisplayModel: boolean;
  hasStudy: boolean;
}) {
  return homeRequested || !hasProject || !hasDisplayModel;
}

export function shouldAutoAdvanceAfterMeshGeneration() {
  return false;
}

export function shouldAutoAdvanceAfterMaterialAssignment() {
  return false;
}

export function canNavigateToStep(step: string, { meshStatus }: { meshStatus: string }) {
  if (step !== "run") return true;
  return meshStatus === "complete";
}

const WORKFLOW_STEP_ORDER = ["model", "material", "supports", "loads", "mesh", "run", "results"] as const;

export type WorkflowShortcutStep = (typeof WORKFLOW_STEP_ORDER)[number];

export function workflowStepForShortcut(
  shortcut: string,
  activeStep: string,
  { meshStatus }: { meshStatus: string }
): WorkflowShortcutStep | null {
  const activeIndex = WORKFLOW_STEP_ORDER.findIndex((step) => step === activeStep);
  if (activeIndex < 0) return null;
  const key = shortcut.toLowerCase();
  const targetIndex = key === "n" ? activeIndex + 1 : key === "b" ? activeIndex - 1 : -1;
  const target = WORKFLOW_STEP_ORDER[targetIndex];
  if (!target || !canNavigateToStep(target, { meshStatus })) return null;
  return target;
}

export function isEditableShortcutTarget(target: Pick<HTMLElement, "tagName" | "isContentEditable"> | null) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function printLayerOrientationForViewer<T extends string>(assigned: T | null, preview: T | null | undefined): T | null {
  return preview === undefined ? assigned : preview;
}
