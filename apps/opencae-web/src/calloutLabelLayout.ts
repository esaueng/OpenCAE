const PAYLOAD_MASS_LABEL_LANES = [-0.42, -0.14, 0.14, 0.42] as const;

export function payloadMassLabelOffset(labelIndex: number): { tangent: number; lift: number } {
  const safeIndex = Number.isFinite(labelIndex) && labelIndex >= 0 ? Math.floor(labelIndex) : 0;
  const lane = safeIndex % PAYLOAD_MASS_LABEL_LANES.length;
  const row = Math.floor(safeIndex / PAYLOAD_MASS_LABEL_LANES.length);
  return {
    tangent: PAYLOAD_MASS_LABEL_LANES[lane] ?? 0,
    lift: Number((0.16 + row * 0.28).toFixed(2))
  };
}
