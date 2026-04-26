const PAYLOAD_MASS_LABEL_LANES = [-0.42, -0.14, 0.14, 0.42] as const;

export type LabelAnchor = { id: string; anchor: [number, number, number] };
export type LabelBounds = { min: [number, number, number]; max: [number, number, number] };
export type PositionedLabel = LabelAnchor & { position: [number, number, number] };
type LabelSide = "left" | "right" | "top" | "bottom";

export function payloadMassLabelOffset(labelIndex: number): { tangent: number; lift: number } {
  const safeIndex = Number.isFinite(labelIndex) && labelIndex >= 0 ? Math.floor(labelIndex) : 0;
  const lane = safeIndex % PAYLOAD_MASS_LABEL_LANES.length;
  const row = Math.floor(safeIndex / PAYLOAD_MASS_LABEL_LANES.length);
  return {
    tangent: PAYLOAD_MASS_LABEL_LANES[lane] ?? 0,
    lift: Number((0.16 + row * 0.28).toFixed(2))
  };
}

export function layoutOutsideModelLabels(anchors: LabelAnchor[], bounds: LabelBounds): PositionedLabel[] {
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerY = (bounds.min[1] + bounds.max[1]) / 2;
  const width = Math.max(0.001, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(0.001, bounds.max[1] - bounds.min[1]);
  const margin = Math.max(width, depth) * 0.12;
  const z = bounds.max[2] + Math.max(0.22, margin * 0.45);
  const groups: Record<LabelSide, LabelAnchor[]> = { left: [], right: [], top: [], bottom: [] };

  for (const anchor of anchors) {
    groups[labelSideForAnchor(anchor.anchor, centerX, centerY, width, depth)].push(anchor);
  }

  return (Object.entries(groups) as Array<[LabelSide, LabelAnchor[]]>).flatMap(([side, sideAnchors]) => (
    distributeSideLabels(side, sideAnchors, bounds, margin, z)
  ));
}

function labelSideForAnchor(anchor: [number, number, number], centerX: number, centerY: number, width: number, depth: number): LabelSide {
  const xScore = (anchor[0] - centerX) / width;
  const yScore = (anchor[1] - centerY) / depth;
  if (Math.abs(xScore) > Math.abs(yScore)) return xScore < 0 ? "left" : "right";
  return yScore < 0 ? "bottom" : "top";
}

function distributeSideLabels(side: LabelSide, anchors: LabelAnchor[], bounds: LabelBounds, margin: number, z: number): PositionedLabel[] {
  const sorted = [...anchors].sort((a, b) => (
    side === "left" || side === "right" ? a.anchor[1] - b.anchor[1] : a.anchor[0] - b.anchor[0]
  ));
  if (!sorted.length) return [];

  const start = side === "left" || side === "right" ? bounds.min[1] : bounds.min[0];
  const end = side === "left" || side === "right" ? bounds.max[1] : bounds.max[0];
  const padding = Math.max(0.16, margin * 0.55);
  const laneStart = start + padding;
  const laneEnd = end - padding;
  const span = Math.max(0, laneEnd - laneStart);

  return sorted.map((anchor, index) => {
    const anchorAlong = side === "left" || side === "right" ? anchor.anchor[1] : anchor.anchor[0];
    const along = sorted.length === 1 ? clamp(anchorAlong, laneStart, laneEnd) : laneStart + (span * index) / (sorted.length - 1);
    if (side === "left") return { ...anchor, position: [bounds.min[0] - margin, along, z] };
    if (side === "right") return { ...anchor, position: [bounds.max[0] + margin, along, z] };
    if (side === "bottom") return { ...anchor, position: [along, bounds.min[1] - margin, z] };
    return { ...anchor, position: [along, bounds.max[1] + margin, z] };
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
