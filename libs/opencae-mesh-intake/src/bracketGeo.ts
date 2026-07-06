// Mirrored from opencae-core@5fff277 services/opencae-core-cloud/src/geometry/bracket.ts — pure .geo generation only.
// Upstream extraction into a shared package is planned (plan 016, A-M2). Do not diverge without syncing.
//
// Excluded from the mirror: generateBracketCoreVolumeMesh (drives the Node gmsh
// runner in mesh/gmsh.ts; the browser path drives gmsh-wasm instead).
import type { SourceSelectionMetadata } from "./types";

export type BracketGeometryDescriptor = {
  base?: {
    length?: number;
    width?: number;
    height?: number;
  };
  upright?: {
    height?: number;
    width?: number;
    thickness?: number;
    depth?: number;
  };
  gusset?: {
    length?: number;
    height?: number;
    thickness?: number;
  };
  rib?: {
    length?: number;
    height?: number;
    thickness?: number;
  };
  holes?: Array<{
    center?: [number, number, number];
    diameter?: number;
  }>;
  baseLength?: number;
  baseDepth?: number;
  baseHeight?: number;
  uprightHeight?: number;
  uprightWidth?: number;
  uprightDepth?: number;
  gussetLength?: number;
  gussetHeight?: number;
  gussetThickness?: number;
  loadFaceId?: string;
  supportFaceId?: string;
  meshSize?: number;
  holeDiameters?: number[];
  holeCenters?: Array<[number, number, number]>;
};

export function bracketGeometrySourceMetadata(): Record<string, SourceSelectionMetadata> {
  return {
    fixed_support: { sourceSelectionRef: "FS1", sourceFaceId: "face-base-left" },
    load_surface: { sourceSelectionRef: "L1", sourceFaceId: "face-load-top" },
    hole_surfaces: { sourceFaceId: "bracket-hole-surfaces" },
    base_surfaces: { sourceFaceId: "bracket-base-surfaces" },
    upright_surfaces: { sourceFaceId: "bracket-upright-surfaces" },
    gusset_surfaces: { sourceFaceId: "bracket-gusset-surfaces" }
  };
}

// Mesh preset scaling for the gmsh characteristic length (preset names match the
// structured block presets; 1.0 keeps the long-standing 18 mm default for "medium").
export const BRACKET_MESH_SIZE_SCALE: Record<string, number> = {
  coarse: 1.4,
  medium: 1,
  fine: 0.7,
  ultra: 0.5
};
export const BRACKET_DEFAULT_MESH_SIZE_MM = 18;

type BracketHole = {
  center: [number, number, number];
  radius: number;
};

const BRACKET_HOLE_FIRST_TAG = 201;
// Overshoot the bores past the host faces so the boolean cut never has to
// resolve coincident surfaces at the cylinder ends.
const BRACKET_HOLE_OVERSHOOT_MM = 1;

export function bracketGeoScript(descriptor: BracketGeometryDescriptor = {}): string {
  const baseLength = positive(descriptor.base?.length ?? descriptor.baseLength, 120);
  const baseDepth = positive(descriptor.base?.width ?? descriptor.upright?.thickness ?? descriptor.upright?.depth ?? descriptor.baseDepth ?? descriptor.uprightDepth, 34);
  const baseHeight = positive(descriptor.base?.height ?? descriptor.baseHeight, 10);
  const uprightHeight = positive(descriptor.upright?.height ?? descriptor.uprightHeight, 88);
  const uprightWidth = positive(descriptor.upright?.width ?? descriptor.uprightWidth, 18);
  const uprightDepth = positive(descriptor.upright?.thickness ?? descriptor.upright?.depth ?? descriptor.uprightDepth, baseDepth);
  const gussetLength = positive(descriptor.gusset?.length ?? descriptor.rib?.length ?? descriptor.gussetLength, 72);
  const gussetHeight = positive(descriptor.gusset?.height ?? descriptor.rib?.height ?? descriptor.gussetHeight, 58);
  const gussetThickness = Math.min(
    positive(descriptor.gusset?.thickness ?? descriptor.rib?.thickness ?? descriptor.gussetThickness, baseDepth),
    baseDepth
  );
  // A gusset thinner than the base depth is a centered rib.
  const gussetOffset = (baseDepth - gussetThickness) / 2;
  const meshSize = positive(descriptor.meshSize, 18);
  const holes = bracketHoles(descriptor, { baseLength, baseDepth, baseHeight, uprightWidth, uprightDepth, uprightHeight });
  const dims = { baseHeight, uprightDepth };

  // Without holes, keep the long-standing conformal-glue topology (three
  // volumes joined by Coherence). With holes, fuse the solids and subtract
  // the bore cylinders so each hole cuts cleanly through the fused part.
  // The boolean chain already leaves a single fused volume, so no Coherence
  // pass is needed (and BooleanFragments on the finished part can fail).
  const solidLines = holes.length
    ? [
        "fused[] = BooleanUnion{ Volume{1}; Delete; }{ Volume{2, rib[1]}; Delete; };",
        ...holes.map((hole, index) => cylinderLine(BRACKET_HOLE_FIRST_TAG + index, hole, dims)),
        `part[] = BooleanDifference{ Volume{fused[]}; Delete; }{ Volume{${holes.map((_hole, index) => BRACKET_HOLE_FIRST_TAG + index).join(", ")}}; Delete; };`
      ]
    : ["Coherence;"];

  const holeSurfaceLines = holes.length
    ? [
        "holeSurfaces[] = {};",
        ...holes.map((hole) => `holeSurfaces[] += Surface In BoundingBox{${holeBoundingBox(hole, dims)}};`)
      ]
    : [];

  return [
    'SetFactory("OpenCASCADE");',
    "Mesh.MshFileVersion = 2.2;",
    // No Mesh.ElementOrder here: gmsh defaults to order 1 and the runner's
    // -order flag must stay in control (a script value overrides the CLI).
    `Mesh.CharacteristicLengthMin = ${fmt(meshSize * 0.45)};`,
    `Mesh.CharacteristicLengthMax = ${fmt(meshSize)};`,
    // Keep drilled holes round even when the global mesh size exceeds the bore.
    ...(holes.length ? ["Mesh.MinimumCirclePoints = 12;"] : []),
    `Box(1) = {0, 0, 0, ${fmt(baseLength)}, ${fmt(baseDepth)}, ${fmt(baseHeight)}};`,
    `Box(2) = {0, 0, ${fmt(baseHeight)}, ${fmt(uprightWidth)}, ${fmt(uprightDepth)}, ${fmt(uprightHeight - baseHeight)}};`,
    `Point(101) = {${fmt(uprightWidth)}, ${fmt(gussetOffset)}, ${fmt(baseHeight)}, ${fmt(meshSize)}};`,
    `Point(102) = {${fmt(uprightWidth)}, ${fmt(gussetOffset)}, ${fmt(Math.min(uprightHeight, baseHeight + gussetHeight))}, ${fmt(meshSize)}};`,
    `Point(103) = {${fmt(Math.min(baseLength, uprightWidth + gussetLength))}, ${fmt(gussetOffset)}, ${fmt(baseHeight)}, ${fmt(meshSize)}};`,
    "Line(101) = {101, 102};",
    "Line(102) = {102, 103};",
    "Line(103) = {103, 101};",
    "Curve Loop(101) = {101, 102, 103};",
    "Plane Surface(101) = {101};",
    `rib[] = Extrude {0, ${fmt(gussetThickness)}, 0} { Surface{101}; };`,
    ...solidLines,
    "eps = 0.01;",
    `fixed[] = Surface In BoundingBox{-eps, -eps, -eps, ${fmt(baseLength)} + eps, ${fmt(baseDepth)} + eps, eps};`,
    `load[] = Surface In BoundingBox{-eps, -eps, ${fmt(uprightHeight)} - eps, ${fmt(uprightWidth)} + eps, ${fmt(baseDepth)} + eps, ${fmt(uprightHeight)} + eps};`,
    `base[] = Surface In BoundingBox{-eps, -eps, -eps, ${fmt(baseLength)} + eps, ${fmt(baseDepth)} + eps, ${fmt(baseHeight)} + eps};`,
    `upright[] = Surface In BoundingBox{-eps, -eps, ${fmt(baseHeight)} - eps, ${fmt(uprightWidth)} + eps, ${fmt(baseDepth)} + eps, ${fmt(uprightHeight)} + eps};`,
    `gusset[] = Surface In BoundingBox{${fmt(uprightWidth)} - eps, ${fmt(gussetOffset)} - eps, ${fmt(baseHeight)} - eps, ${fmt(Math.min(baseLength, uprightWidth + gussetLength))} + eps, ${fmt(gussetOffset + gussetThickness)} + eps, ${fmt(Math.min(uprightHeight, baseHeight + gussetHeight))} + eps};`,
    ...holeSurfaceLines,
    holes.length ? 'Physical Volume("solid") = {part[]};' : 'Physical Volume("solid") = {1, 2, rib[1]};',
    "Physical Surface(\"fixed_support\") = {fixed[]};",
    "Physical Surface(\"load_surface\") = {load[]};",
    "Physical Surface(\"base_surfaces\") = {base[]};",
    "Physical Surface(\"upright_surfaces\") = {upright[]};",
    "Physical Surface(\"gusset_surfaces\") = {gusset[]};",
    ...(holes.length ? ['Physical Surface("hole_surfaces") = {holeSurfaces[]};'] : []),
    ""
  ].join("\n");
}

function bracketHoles(
  descriptor: BracketGeometryDescriptor,
  bounds: { baseLength: number; baseDepth: number; baseHeight: number; uprightWidth: number; uprightDepth: number; uprightHeight: number }
): BracketHole[] {
  const entries: Array<{ center?: unknown; diameter?: unknown }> = Array.isArray(descriptor.holes) && descriptor.holes.length
    ? descriptor.holes
    : Array.isArray(descriptor.holeCenters)
      ? descriptor.holeCenters.map((center, index) => ({ center, diameter: descriptor.holeDiameters?.[index] }))
      : [];
  const holes: BracketHole[] = [];
  for (const entry of entries) {
    const center = vector3(entry?.center);
    const radius = typeof entry?.diameter === "number" && Number.isFinite(entry.diameter) && entry.diameter > 0 ? entry.diameter / 2 : undefined;
    if (!center || !radius) continue;
    const throughBase = center[2] <= bounds.baseHeight;
    // Base holes are drilled along Z through the base plate; anything higher
    // is drilled along Y through the upright thickness. Skip bores that would
    // breach the host solid's outline.
    const fits = throughBase
      ? center[0] - radius > 0 && center[0] + radius < bounds.baseLength && center[1] - radius > 0 && center[1] + radius < bounds.baseDepth
      : center[0] - radius > 0 && center[0] + radius < bounds.uprightWidth && center[2] - radius > bounds.baseHeight && center[2] + radius < bounds.uprightHeight;
    if (!fits) continue;
    holes.push({ center, radius });
  }
  return holes;
}

function cylinderLine(tag: number, hole: BracketHole, dims: { baseHeight: number; uprightDepth: number }): string {
  const [x, y, z] = hole.center;
  if (z <= dims.baseHeight) {
    return `Cylinder(${tag}) = {${fmt(x)}, ${fmt(y)}, ${fmt(-BRACKET_HOLE_OVERSHOOT_MM)}, 0, 0, ${fmt(dims.baseHeight + 2 * BRACKET_HOLE_OVERSHOOT_MM)}, ${fmt(hole.radius)}};`;
  }
  return `Cylinder(${tag}) = {${fmt(x)}, ${fmt(-BRACKET_HOLE_OVERSHOOT_MM)}, ${fmt(z)}, 0, ${fmt(dims.uprightDepth + 2 * BRACKET_HOLE_OVERSHOOT_MM)}, 0, ${fmt(hole.radius)}};`;
}

function holeBoundingBox(hole: BracketHole, dims: { baseHeight: number; uprightDepth: number }): string {
  const [x, y, z] = hole.center;
  const r = hole.radius;
  if (z <= dims.baseHeight) {
    return `${fmt(x - r)} - eps, ${fmt(y - r)} - eps, -eps, ${fmt(x + r)} + eps, ${fmt(y + r)} + eps, ${fmt(dims.baseHeight)} + eps`;
  }
  return `${fmt(x - r)} - eps, -eps, ${fmt(z - r)} - eps, ${fmt(x + r)} + eps, ${fmt(dims.uprightDepth)} + eps, ${fmt(z + r)} + eps`;
}

function vector3(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const components = value.map((component) => Number(component));
  return components.every((component) => Number.isFinite(component)) ? (components as [number, number, number]) : undefined;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
