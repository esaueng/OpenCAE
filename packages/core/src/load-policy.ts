/** Domain-owned, dimensionless policies for load distribution and equilibrium. */
export const LOAD_EQUILIBRIUM_POLICY = Object.freeze({
  /** Relative resultant-force error permitted after remote/preload distribution. */
  forceBalanceRelativeTolerance: 1e-9,
  /** Relative resultant-moment error permitted for a six-component remote wrench. */
  remoteMomentBalanceRelativeTolerance: 1e-9,
  /** Preload moment cancellation is less well conditioned across two independently integrated faces. */
  preloadMomentBalanceRelativeTolerance: 1e-6,
  /** Relative face-size threshold for treating two preload centroids as coincident. */
  centroidSeparationRelativeTolerance: 1e-12,
  /** Relative pivot threshold for the dimensionless normalized 6x6 remote-wrench Gram matrix. */
  remoteGramPivotRelativeTolerance: 1e-12
});

export function relativeBalanceError(errorMagnitude: number, referenceMagnitude: number): number {
  if (!(referenceMagnitude > 0) || !Number.isFinite(referenceMagnitude)) return errorMagnitude === 0 ? 0 : Number.POSITIVE_INFINITY;
  return errorMagnitude / referenceMagnitude;
}

export function centroidSeparationTolerance(...characteristicLengths: number[]): number {
  let scale = 0;
  for (const length of characteristicLengths) {
    if (Number.isFinite(length) && length > scale) scale = length;
  }
  return LOAD_EQUILIBRIUM_POLICY.centroidSeparationRelativeTolerance * scale;
}

export function remoteGramPivotTolerance(matrixScale: number): number {
  return LOAD_EQUILIBRIUM_POLICY.remoteGramPivotRelativeTolerance * Math.max(0, matrixScale);
}
