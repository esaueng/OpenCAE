/** Dimensionless policies for mapping display selections onto solver topology. */
export const TOPOLOGY_MAPPING_POLICY = Object.freeze({
  /** Plane-to-facet matching band as a fraction of the selected axis span. */
  selectionPlaneRelativeTolerance: 1e-5,
  /** Machine-precision multiplier used only to protect collapsed-span arithmetic. */
  spanEpsilonMultiplier: 64
});

export function topologySpanTolerance(characteristicLength: number): number {
  return TOPOLOGY_MAPPING_POLICY.spanEpsilonMultiplier * Number.EPSILON * Math.max(0, Math.abs(characteristicLength));
}

export function topologySpanIsUsable(span: number, characteristicLength: number): boolean {
  return Number.isFinite(span) && span > topologySpanTolerance(characteristicLength);
}

export function selectionPlaneTolerance(axisSpan: number, characteristicLength: number): number {
  return Math.max(
    Math.abs(axisSpan) * TOPOLOGY_MAPPING_POLICY.selectionPlaneRelativeTolerance,
    topologySpanTolerance(characteristicLength)
  );
}

export function selectionPlaneMatches(offset: number, axisSpan: number, characteristicLength: number): boolean {
  return Number.isFinite(offset) && Math.abs(offset) <= selectionPlaneTolerance(axisSpan, characteristicLength);
}
