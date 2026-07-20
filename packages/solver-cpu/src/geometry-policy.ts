/**
 * Element-geometry validity is dimensionless after scaling volume/Jacobian
 * determinants by the cube of the element's characteristic length.
 */
export const ELEMENT_GEOMETRY_POLICY = Object.freeze({
  /** Reject an element when |volume| / characteristicLength^3 is at or below this value. */
  relativeVolumeTolerance: 1e-12
});

/** Largest pairwise node distance, expressed in the coordinates' length unit. */
export function elementCharacteristicLength(coordinates: ArrayLike<number>): number {
  const nodeCount = Math.floor(coordinates.length / 3);
  let maximumSquared = 0;
  for (let a = 0; a < nodeCount; a += 1) {
    for (let b = a + 1; b < nodeCount; b += 1) {
      const dx = (coordinates[a * 3] ?? 0) - (coordinates[b * 3] ?? 0);
      const dy = (coordinates[a * 3 + 1] ?? 0) - (coordinates[b * 3 + 1] ?? 0);
      const dz = (coordinates[a * 3 + 2] ?? 0) - (coordinates[b * 3 + 2] ?? 0);
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > maximumSquared) maximumSquared = squared;
    }
  }
  return Math.sqrt(maximumSquared);
}

/** Absolute length^3 threshold derived from a dimensionless element-shape tolerance. */
export function elementVolumeTolerance(coordinates: ArrayLike<number>): number {
  const length = elementCharacteristicLength(coordinates);
  return ELEMENT_GEOMETRY_POLICY.relativeVolumeTolerance * length * length * length;
}
