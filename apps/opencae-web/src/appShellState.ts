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
  return homeRequested || !hasProject || !hasDisplayModel || !hasStudy;
}

export function shouldAutoAdvanceAfterMeshGeneration() {
  return false;
}

export function canNavigateToStep(step: string, { meshStatus }: { meshStatus: string }) {
  if (step !== "run") return true;
  return meshStatus === "complete";
}

export function printLayerOrientationForViewer<T extends string>(assigned: T | null, preview: T | null | undefined): T | null {
  return preview === undefined ? assigned : preview;
}
