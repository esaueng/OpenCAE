// STEP B-rep face registry (plan A-M3).
//
// occt-import-js tessellates every STEP body and reports per-mesh
// `brep_faces` triangle ranges — one range per real B-rep face. This module
// turns those ranges into a face registry:
//   - stable per-import faceIds ("step-face-<k>", global across meshes),
//   - real face metrics (area/centroid/average normal, in the STEP file's
//     model units — mm for everything we ingest),
//   - a quantized fingerprint so selections can be re-validated after
//     re-tessellation,
//   - viewer-space DisplayFace entries (normalized preview frame, matching
//     normalizedStepPreviewFromMeshes' 2.4/maxDimension transform), and
//   - the flattened attribution tessellation the mesh worker uses to stamp
//     gmsh boundary facets with sourceFaceIds (facetFaceAttribution.ts).
//
// Pure geometry lives in exported functions that take occt meshes, so Node
// tests can drive them with occt-import-js directly; the browser entry point
// (stepFaceRegistryFromBase64) lazy-loads the occt WASM module via
// stepPreview's shared importer and caches registries per STEP content.
import type { OcctMesh } from "occt-import-js";
import type { DisplayFace } from "@opencae/schema";
import { buildStepAttributionTessellation, type StepAttributionTessellation, type StepBodyBounds } from "@opencae/mesh-intake";
import {
  loadStepSurfacePreviewFallback,
  occtMeshesFromStepSurfacePreview,
  peekStepSurfacePreview,
  preferStepSurfacePreview
} from "./stepSurfacePreviewFallback";

export type StepFaceRecord = {
  /** Stable per-import id, global across meshes: "step-face-<k>". */
  faceId: string;
  meshIndex: number;
  /** Inclusive triangle range within the mesh's own triangle list. */
  triangleRange: [number, number];
  triangleCount: number;
  /** Face area in model units^2 (mm^2). */
  area: number;
  /** Area-weighted centroid in model units (mm, STEP model space). */
  centroid: [number, number, number];
  /** Area-weighted average unit normal (STEP model space). */
  avgNormal: [number, number, number];
  /** Tessellation-derived surface classification used by the picker and labels. */
  surfaceType: "planar" | "cylindrical" | "curved";
  /** Present for full cylindrical surfaces whose axis/radius can be resolved robustly. */
  cylinder?: {
    axis: [number, number, number];
    radius: number;
    length: number;
    /** True when the face normals point toward the cylinder axis (a hole wall). */
    interior: boolean;
  };
  /** Quantized area/centroid/normal digest; survives re-tessellation. */
  fingerprint: string;
};

export type StepFaceRegistryMesh = {
  positions: Float32Array;
  indices: Uint32Array;
  faceRanges: Array<{ first: number; last: number }>;
};

export type StepFaceRegistry = {
  faces: StepFaceRecord[];
  meshes: StepFaceRegistryMesh[];
  /** Model-space bounds over all meshes (mm). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** The normalized-preview transform: viewer = model * scale + offset. */
  normalization: { scale: number; offset: [number, number, number] };
  /** Viewer-space faces ready for DisplayModel.faces (center/normal in the normalized preview frame, area in mm^2). */
  displayFaces: DisplayFace[];
};

export type StepHoleWallPickDisk = {
  faceId: string;
  center: [number, number, number];
  normal: [number, number, number];
  radius: number;
};

const STEP_FACE_ID_PREFIX = "step-face-";
const GEOMETRY_EPSILON = 1e-9;
const PLANAR_NORMAL_DOT_TOLERANCE = 1e-6;
const CYLINDER_NORMAL_AXIS_TOLERANCE = 1e-3;
const CYLINDER_RADIUS_RELATIVE_TOLERANCE = 0.02;
const CYLINDER_MIN_NORMAL_VARIATION = 0.05;
const HOLE_WALL_PICK_RADIUS_FACTOR = 0.82;
const HOLE_CAP_NORMAL_ALIGNMENT_MIN = 0.95;
const HOLE_CAP_AREA_RELATIVE_TOLERANCE = 0.25;
const HOLE_CAP_CENTER_RADIUS_TOLERANCE = 0.08;

/** Matches the ids issued by buildStepFaceRegistry. */
export function isStepFaceId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(STEP_FACE_ID_PREFIX);
}

/**
 * Build the registry from occt-import-js meshes. Pure; safe in Node tests.
 * Meshes without positions/indices/brep_faces are kept as empty placeholders
 * so meshIndex still lines up with the viewer's preview children.
 */
export function buildStepFaceRegistry(meshes: OcctMesh[]): StepFaceRegistry {
  const registryMeshes: StepFaceRegistryMesh[] = meshes.map((mesh) => ({
    positions: Float32Array.from(mesh.attributes?.position?.array ?? []),
    indices: Uint32Array.from(mesh.index?.array ?? []),
    faceRanges: (mesh.brep_faces ?? []).map((face) => ({ first: face.first, last: face.last }))
  }));

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of registryMeshes) {
    for (let index = 0; index + 2 < mesh.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = mesh.positions[index + axis]!;
        if (value < min[axis]!) min[axis] = value;
        if (value > max[axis]!) max[axis] = value;
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const faces: StepFaceRecord[] = [];
  for (const [meshIndex, mesh] of registryMeshes.entries()) {
    for (const range of mesh.faceRanges) {
      faces.push(faceRecordForRange(mesh, meshIndex, range, faces.length));
    }
  }

  // Mirror normalizedStepPreviewFromMeshes: scale = 2.4 / maxDimension, then
  // recenter the model's bounding-box center onto the origin.
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const maxDimension = Math.max(size[0]!, size[1]!, size[2]!, 0.001);
  const scale = 2.4 / maxDimension;
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const offset: [number, number, number] = [-center[0]! * scale, -center[1]! * scale, -center[2]! * scale];

  const displayFaces = faces.map((face) => displayFaceForRecord(face, scale, offset));
  return {
    faces,
    meshes: registryMeshes,
    bounds: { min, max },
    normalization: { scale, offset },
    displayFaces
  };
}

/** Map a raycast hit (preview child mesh index + triangle index) to a faceId. */
export function stepFaceIdForMeshTriangle(registry: StepFaceRegistry, meshIndex: number, triangleIndex: number): string | null {
  const mesh = registry.meshes[meshIndex];
  if (!mesh) return null;
  // Face ranges are sorted and non-overlapping; binary-search the range.
  const candidates = registry.faces.filter((face) => face.meshIndex === meshIndex);
  let low = 0;
  let high = candidates.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const face = candidates[middle]!;
    if (triangleIndex < face.triangleRange[0]) high = middle - 1;
    else if (triangleIndex > face.triangleRange[1]) low = middle + 1;
    else return face.faceId;
  }
  return null;
}

export function stepFaceRecordForId(registry: StepFaceRegistry, faceId: string): StepFaceRecord | null {
  return registry.faces.find((face) => face.faceId === faceId) ?? null;
}

/**
 * Resolve a support picked on a blind hole's circular bottom to the matching
 * cylindrical wall. The match is intentionally strict so nearby planar faces
 * and the large annular face around a through-hole remain planar selections.
 */
export function stepSupportFaceIdForPickedFace(registry: StepFaceRegistry, pickedFaceId: string): string {
  const pickedFace = stepFaceRecordForId(registry, pickedFaceId);
  if (!pickedFace || pickedFace.surfaceType !== "planar") return pickedFaceId;

  const pickedNormalLength = Math.hypot(...pickedFace.avgNormal);
  if (!(pickedNormalLength > GEOMETRY_EPSILON)) return pickedFaceId;
  const pickedNormal = scale3(pickedFace.avgNormal, 1 / pickedNormalLength);
  let bestMatch: { faceId: string; score: number } | null = null;

  for (const candidate of registry.faces) {
    const cylinder = candidate.cylinder;
    if (
      candidate.meshIndex !== pickedFace.meshIndex ||
      !cylinder?.interior ||
      !(cylinder.radius > GEOMETRY_EPSILON) ||
      !(cylinder.length > GEOMETRY_EPSILON)
    ) continue;

    const normalAlignment = Math.abs(dot3(pickedNormal, cylinder.axis));
    if (normalAlignment < HOLE_CAP_NORMAL_ALIGNMENT_MIN) continue;

    const expectedCapArea = Math.PI * cylinder.radius * cylinder.radius;
    const relativeAreaError = Math.abs(pickedFace.area - expectedCapArea) / expectedCapArea;
    if (relativeAreaError > HOLE_CAP_AREA_RELATIVE_TOLERANCE) continue;

    const halfLength = cylinder.length / 2;
    const relativeCenter = subtract3(pickedFace.centroid, candidate.centroid);
    const axialOffset = dot3(relativeCenter, cylinder.axis);
    const radialOffset = subtract3(relativeCenter, scale3(cylinder.axis, axialOffset));
    const radialDistance = Math.hypot(...radialOffset);
    const endpointDistance = Math.abs(Math.abs(axialOffset) - halfLength);
    const centerTolerance = Math.max(cylinder.radius * HOLE_CAP_CENTER_RADIUS_TOLERANCE, GEOMETRY_EPSILON * 100);
    if (radialDistance > centerTolerance || endpointDistance > centerTolerance) continue;

    const score = (radialDistance + endpointDistance) / cylinder.radius
      + relativeAreaError
      + (1 - normalAlignment);
    if (!bestMatch || score < bestMatch.score) bestMatch = { faceId: candidate.faceId, score };
  }

  return bestMatch?.faceId ?? pickedFaceId;
}

/**
 * Invisible support-step targets that span the openings of recognized
 * cylindrical holes. The disk stays inside the rim so ordinary planar-face
 * clicks remain available while the much narrower barrel becomes easy to pick.
 */
export function stepHoleWallPickDisks(registry: StepFaceRegistry): StepHoleWallPickDisk[] {
  const { scale, offset } = registry.normalization;
  if (!(scale > GEOMETRY_EPSILON)) return [];
  return registry.faces.flatMap((face): StepHoleWallPickDisk[] => {
    const cylinder = face.cylinder;
    if (!cylinder?.interior || !(cylinder.radius > GEOMETRY_EPSILON) || !(cylinder.length > GEOMETRY_EPSILON)) return [];
    const halfLength = cylinder.length / 2;
    return [-1, 1].map((direction): StepHoleWallPickDisk => {
      const modelCenter: [number, number, number] = [
        face.centroid[0] + cylinder.axis[0] * halfLength * direction,
        face.centroid[1] + cylinder.axis[1] * halfLength * direction,
        face.centroid[2] + cylinder.axis[2] * halfLength * direction
      ];
      return {
        faceId: face.faceId,
        center: [
          modelCenter[0] * scale + offset[0],
          modelCenter[1] * scale + offset[1],
          modelCenter[2] * scale + offset[2]
        ],
        normal: [...cylinder.axis],
        radius: cylinder.radius * scale * HOLE_WALL_PICK_RADIUS_FACTOR
      };
    });
  });
}

/** Viewer STEP object ids are one-based (`step-object-1`); registry mesh indices are zero-based. */
export function stepMeshIndexFromObjectId(objectId: string | null | undefined): number | null {
  const match = /^step-object-(\d+)$/.exec(objectId ?? "");
  if (!match) return null;
  const oneBasedIndex = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(oneBasedIndex) && oneBasedIndex > 0 ? oneBasedIndex - 1 : null;
}

/** Exact model-space bounds for one preview body, used to identify the same OCC volume in gmsh. */
export function stepBodyBoundsForMesh(registry: StepFaceRegistry, meshIndex: number): StepBodyBounds | null {
  const mesh = registry.meshes[meshIndex];
  if (!mesh || mesh.positions.length < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[index + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/**
 * Find the retained structural face nearest a payload's contact point. A face
 * pointing against gravity wins ties, so a rod resting on a tray maps to the
 * tray's upper contact surface instead of a coincident wall or underside.
 */
export function nearestStepFaceIdOnMeshes(
  registry: StepFaceRegistry,
  point: [number, number, number],
  meshIndices: readonly number[],
  preferredNormal?: [number, number, number]
): string | null {
  const included = new Set(meshIndices);
  let nearestAny: { faceId: string; distance: number } | null = null;
  let nearestAligned: { faceId: string; distance: number; agreement: number } | null = null;
  for (const face of registry.faces) {
    if (!included.has(face.meshIndex)) continue;
    const mesh = registry.meshes[face.meshIndex];
    if (!mesh) continue;
    let faceDistance = Infinity;
    for (let triangle = face.triangleRange[0]; triangle <= face.triangleRange[1]; triangle += 1) {
      const distance = pointTriangleDistance(
        point,
        trianglePoint(mesh, triangle, 0),
        trianglePoint(mesh, triangle, 1),
        trianglePoint(mesh, triangle, 2)
      );
      if (distance < faceDistance) faceDistance = distance;
    }
    if (!Number.isFinite(faceDistance)) continue;
    if (!nearestAny || faceDistance < nearestAny.distance) nearestAny = { faceId: face.faceId, distance: faceDistance };
    if (!preferredNormal) continue;
    const agreement =
      face.avgNormal[0] * preferredNormal[0] +
      face.avgNormal[1] * preferredNormal[1] +
      face.avgNormal[2] * preferredNormal[2];
    if (agreement < 0.25) continue;
    if (
      !nearestAligned ||
      faceDistance < nearestAligned.distance - 1e-9 ||
      (Math.abs(faceDistance - nearestAligned.distance) <= 1e-9 && agreement > nearestAligned.agreement)
    ) {
      nearestAligned = { faceId: face.faceId, distance: faceDistance, agreement };
    }
  }
  if (nearestAligned && nearestAny) {
    const size = [
      registry.bounds.max[0] - registry.bounds.min[0],
      registry.bounds.max[1] - registry.bounds.min[1],
      registry.bounds.max[2] - registry.bounds.min[2]
    ];
    const alignmentTolerance = Math.max(Math.hypot(...size) * 0.01, 1e-6);
    if (nearestAligned.distance <= nearestAny.distance + alignmentTolerance) return nearestAligned.faceId;
  }
  return nearestAny?.faceId ?? nearestAligned?.faceId ?? null;
}

export type ResolvedPickedStepFace = {
  faceId: string;
  label: string;
  /** Point-to-face distance in model units (mm). */
  distanceModelUnits: number;
};

/**
 * Resolve a picked point (normalized preview frame, as stored on
 * "face-upload-picked-*" selections) to the B-rep face it lies on, by exact
 * point-to-triangle distance over every face's tessellation. The picked point
 * came from a raycast against this same tessellation, so the true face sits at
 * ~0 distance (bounded by the picked id's 0.01 viewer-unit quantization); the
 * nearest triangle's own normal must also agree with the picked normal so a
 * point near an edge cannot land on the back side of a thin wall.
 */
export function resolvePickedStepFace(
  registry: StepFaceRegistry,
  viewerCenter: [number, number, number],
  viewerNormal: [number, number, number] | undefined
): ResolvedPickedStepFace | null {
  const { scale, offset } = registry.normalization;
  if (!(scale > 0)) return null;
  const point: [number, number, number] = [
    (viewerCenter[0] - offset[0]) / scale,
    (viewerCenter[1] - offset[1]) / scale,
    (viewerCenter[2] - offset[2]) / scale
  ];
  // Picked ids quantize viewer coordinates to 0.01 on a 2.4-sized preview;
  // allow 2.5x that (in model units) so quantized picks still resolve.
  const tolerance = 0.025 / scale;
  const normalAgreementMin = 0.5;

  let best: { face: StepFaceRecord; distance: number } | null = null;
  for (const face of registry.faces) {
    const mesh = registry.meshes[face.meshIndex];
    if (!mesh) continue;
    for (let triangle = face.triangleRange[0]; triangle <= face.triangleRange[1]; triangle += 1) {
      const a = trianglePoint(mesh, triangle, 0);
      const b = trianglePoint(mesh, triangle, 1);
      const c = trianglePoint(mesh, triangle, 2);
      const distance = pointTriangleDistance(point, a, b, c);
      if (distance > tolerance || (best && distance >= best.distance)) continue;
      if (viewerNormal) {
        const normal = triangleNormal(a, b, c);
        const agreement = normal[0] * viewerNormal[0] + normal[1] * viewerNormal[1] + normal[2] * viewerNormal[2];
        if (agreement < normalAgreementMin) continue;
      }
      best = { face, distance };
    }
  }
  if (!best) return null;
  const display = registry.displayFaces.find((face) => face.id === best!.face.faceId);
  return { faceId: best.face.faceId, label: display?.label ?? best.face.faceId, distanceModelUnits: best.distance };
}

function trianglePoint(mesh: StepFaceRegistryMesh, triangle: number, corner: number): [number, number, number] {
  const vertex = mesh.indices[triangle * 3 + corner]!;
  return [mesh.positions[vertex * 3] ?? 0, mesh.positions[vertex * 3 + 1] ?? 0, mesh.positions[vertex * 3 + 2] ?? 0];
}

function triangleNormal(a: [number, number, number], b: [number, number, number], c: [number, number, number]): [number, number, number] {
  const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const length = Math.hypot(nx, ny, nz);
  return length > 0 ? [nx / length, ny / length, nz / length] : [0, 0, 0];
}

/** Exact point-to-triangle distance (Ericson, Real-Time Collision Detection). */
function pointTriangleDistance(p: [number, number, number], a: [number, number, number], b: [number, number, number], c: [number, number, number]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);

  const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(apx - v * abx, apy - v * aby, apz - v * abz);
  }

  const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(apx - w * acx, apy - w * acy, apz - w * acz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(bpx - w * (c[0] - b[0]), bpy - w * (c[1] - b[1]), bpz - w * (c[2] - b[2]));
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return Math.hypot(apx - (v * abx + w * acx), apy - (v * aby + w * acy), apz - (v * abz + w * acz));
}

/** Flattened tessellation for the mesh worker's facet->face attribution. */
export function stepAttributionForRegistry(registry: StepFaceRegistry, meshIndices?: readonly number[]): StepAttributionTessellation {
  const included = meshIndices ? new Set(meshIndices) : null;
  const meshes = registry.meshes
    .map((mesh, meshIndex) => ({ mesh, meshIndex }))
    .filter(({ meshIndex }) => !included || included.has(meshIndex));
  return buildStepAttributionTessellation(
    meshes.map(({ mesh }) => ({
      positions: mesh.positions,
      indices: mesh.indices,
      brepFaces: mesh.faceRanges
    })),
    {
      faceIds: meshes.flatMap(({ meshIndex }) => registry.faces.filter((face) => face.meshIndex === meshIndex).map((face) => face.faceId)),
      unitScale: 0.001
    }
  );
}

/**
 * Quantized digest of a face's intrinsic geometry: area to 3 significant
 * digits, centroid to 0.1 model units, normal to 0.02. Tessellation-density
 * independent for planar/cylindrical faces, so re-imports of the same STEP
 * body reproduce it.
 */
export function stepFaceFingerprint(area: number, centroid: [number, number, number], normal: [number, number, number]): string {
  const quantArea = area > 0 ? area.toPrecision(3) : "0";
  const quantCentroid = centroid.map((value) => (Math.round(value * 10) / 10).toFixed(1)).join(",");
  const quantNormal = normal.map((value) => (Math.round(value * 50) / 50).toFixed(2)).join(",");
  return `stepface:a=${quantArea}|c=${quantCentroid}|n=${quantNormal}`;
}

// ---------------------------------------------------------------------------
// Browser entry point: cached registry per STEP content.

const resolvedRegistries = new Map<string, StepFaceRegistry>();
const pendingRegistries = new Map<string, Promise<StepFaceRegistry>>();

/** Build (and cache) the registry for a base64 STEP payload via occt-import-js. */
export async function stepFaceRegistryFromBase64(contentBase64: string): Promise<StepFaceRegistry> {
  const key = registryCacheKey(contentBase64);
  const resolved = resolvedRegistries.get(key);
  if (resolved) return resolved;
  let pending = pendingRegistries.get(key);
  if (!pending) {
    pending = importStepRegistry(contentBase64)
      .then((registry) => {
        resolvedRegistries.set(key, registry);
        return registry;
      })
      .finally(() => {
        pendingRegistries.delete(key);
      });
    pendingRegistries.set(key, pending);
  }
  return pending;
}

/** Synchronous cache read for hot paths (viewer raycast handlers). */
export function peekStepFaceRegistryForBase64(contentBase64: string): StepFaceRegistry | null {
  return resolvedRegistries.get(registryCacheKey(contentBase64)) ?? null;
}

async function importStepRegistry(contentBase64: string): Promise<StepFaceRegistry> {
  const { getOcctImporter } = await import("./stepPreview");
  const importer = await getOcctImporter();
  const result = importer.ReadStepFile(base64ToUint8Array(contentBase64), null);
  if (!result.success) {
    throw new Error(`STEP face registry import failed${result.errorCode ? ` (${result.errorCode})` : ""}.`);
  }
  const meshes = result.meshes ?? [];
  if (meshes.some(hasRenderableMesh)) return buildStepFaceRegistry(meshes);

  // Some valid faceted B-Reps import topologically in occt-import-js (with
  // thousands of brep_faces) but return no positions or indices. Reuse the
  // Gmsh surface mesh generated by topology inspection instead of accepting a
  // registry whose every face is pinned to the origin.
  const cached = peekStepSurfacePreview(contentBase64) ?? await loadStepSurfacePreviewFallback(contentBase64);
  preferStepSurfacePreview(contentBase64);
  return buildStepFaceRegistry(occtMeshesFromStepSurfacePreview(cached.surfacePreview));
}

function hasRenderableMesh(mesh: OcctMesh): boolean {
  return (mesh.attributes?.position?.array?.length ?? 0) >= 9 && (mesh.index?.array?.length ?? 0) >= 3;
}

function registryCacheKey(contentBase64: string): string {
  // djb2 over the base64 payload; length included to keep collisions harmless.
  let hash = 5381;
  for (let index = 0; index < contentBase64.length; index += 1) {
    hash = ((hash << 5) + hash + contentBase64.charCodeAt(index)) | 0;
  }
  return `${contentBase64.length}:${hash}`;
}

// ---------------------------------------------------------------------------
// Internals

function faceRecordForRange(
  mesh: StepFaceRegistryMesh,
  meshIndex: number,
  range: { first: number; last: number },
  globalIndex: number
): StepFaceRecord {
  let area = 0;
  const centroid: [number, number, number] = [0, 0, 0];
  const normalSum: [number, number, number] = [0, 0, 0];
  const triangleNormals: [number, number, number][] = [];
  const triangleCenters: [number, number, number][] = [];
  const triangleAreas: number[] = [];
  for (let triangle = range.first; triangle <= range.last; triangle += 1) {
    const a = vertexAt(mesh, mesh.indices[triangle * 3]!);
    const b = vertexAt(mesh, mesh.indices[triangle * 3 + 1]!);
    const c = vertexAt(mesh, mesh.indices[triangle * 3 + 2]!);
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const doubleArea = Math.hypot(nx, ny, nz);
    const triangleArea = doubleArea / 2;
    area += triangleArea;
    centroid[0] += ((a[0] + b[0] + c[0]) / 3) * triangleArea;
    centroid[1] += ((a[1] + b[1] + c[1]) / 3) * triangleArea;
    centroid[2] += ((a[2] + b[2] + c[2]) / 3) * triangleArea;
    // Cross product magnitude is 2*area, so summing raw crosses IS area weighting.
    normalSum[0] += nx / 2;
    normalSum[1] += ny / 2;
    normalSum[2] += nz / 2;
    if (doubleArea > GEOMETRY_EPSILON) {
      triangleNormals.push([nx / doubleArea, ny / doubleArea, nz / doubleArea]);
      triangleCenters.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
      triangleAreas.push(triangleArea);
    }
  }
  if (area > 0) {
    centroid[0] /= area;
    centroid[1] /= area;
    centroid[2] /= area;
  }
  // Keep the true area-weighted mean instead of normalizing its magnitude.
  // Closed curved faces intentionally cancel toward zero; normalizing their
  // floating-point residue manufactures a bogus planar direction.
  const avgNormal: [number, number, number] = area > GEOMETRY_EPSILON
    ? [normalSum[0] / area, normalSum[1] / area, normalSum[2] / area]
    : [0, 0, 0];
  const surface = classifyStepSurface(mesh, range, centroid, triangleNormals, triangleCenters, triangleAreas);
  return {
    faceId: `${STEP_FACE_ID_PREFIX}${globalIndex}`,
    meshIndex,
    triangleRange: [range.first, range.last],
    triangleCount: range.last - range.first + 1,
    area,
    centroid,
    avgNormal,
    surfaceType: surface.surfaceType,
    ...(surface.cylinder ? { cylinder: surface.cylinder } : {}),
    fingerprint: stepFaceFingerprint(area, centroid, avgNormal)
  };
}

function classifyStepSurface(
  mesh: StepFaceRegistryMesh,
  range: { first: number; last: number },
  centroid: [number, number, number],
  triangleNormals: [number, number, number][],
  triangleCenters: [number, number, number][],
  triangleAreas: number[]
): Pick<StepFaceRecord, "surfaceType" | "cylinder"> {
  const reference = triangleNormals[0];
  if (!reference) return { surfaceType: "curved" };

  const minimumNormalAgreement = triangleNormals.reduce(
    (minimum, normal) => Math.min(minimum, dot3(reference, normal)),
    1
  );
  if (minimumNormalAgreement >= 1 - PLANAR_NORMAL_DOT_TOLERANCE) return { surfaceType: "planar" };

  let axisCandidate: [number, number, number] = [0, 0, 0];
  let axisCandidateLength = 0;
  for (const normal of triangleNormals) {
    const candidate = cross3(reference, normal);
    const candidateLength = Math.hypot(...candidate);
    if (candidateLength > axisCandidateLength + GEOMETRY_EPSILON) {
      axisCandidate = candidate;
      axisCandidateLength = candidateLength;
    }
  }
  if (!(axisCandidateLength > CYLINDER_MIN_NORMAL_VARIATION)) return { surfaceType: "curved" };

  const axis = canonicalDirection(scale3(axisCandidate, 1 / axisCandidateLength));
  const maximumNormalAxisAgreement = triangleNormals.reduce(
    (maximum, normal) => Math.max(maximum, Math.abs(dot3(normal, axis))),
    0
  );
  if (maximumNormalAxisAgreement > CYLINDER_NORMAL_AXIS_TOLERANCE) return { surfaceType: "curved" };

  const radialDistances: number[] = [];
  let axialMinimum = Infinity;
  let axialMaximum = -Infinity;
  for (let triangle = range.first; triangle <= range.last; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const relative = subtract3(trianglePoint(mesh, triangle, corner), centroid);
      const axial = dot3(relative, axis);
      const radial = subtract3(relative, scale3(axis, axial));
      radialDistances.push(Math.hypot(...radial));
      axialMinimum = Math.min(axialMinimum, axial);
      axialMaximum = Math.max(axialMaximum, axial);
    }
  }
  if (!radialDistances.length) return { surfaceType: "curved" };
  const radius = radialDistances.reduce((total, distance) => total + distance, 0) / radialDistances.length;
  const radiusSpread = radialDistances.reduce(
    (maximum, distance) => Math.max(maximum, Math.abs(distance - radius)),
    0
  );
  const length = axialMaximum - axialMinimum;
  if (
    !(radius > GEOMETRY_EPSILON) ||
    !(length > GEOMETRY_EPSILON) ||
    radiusSpread / radius > CYLINDER_RADIUS_RELATIVE_TOLERANCE
  ) {
    return { surfaceType: "curved" };
  }

  let radialNormalAgreement = 0;
  let agreementArea = 0;
  for (let index = 0; index < triangleNormals.length; index += 1) {
    const relative = subtract3(triangleCenters[index]!, centroid);
    const radial = subtract3(relative, scale3(axis, dot3(relative, axis)));
    const radialLength = Math.hypot(...radial);
    if (!(radialLength > GEOMETRY_EPSILON)) continue;
    const triangleArea = triangleAreas[index] ?? 0;
    radialNormalAgreement += dot3(triangleNormals[index]!, scale3(radial, 1 / radialLength)) * triangleArea;
    agreementArea += triangleArea;
  }
  const interior = agreementArea > GEOMETRY_EPSILON && radialNormalAgreement / agreementArea < -0.5;
  return {
    surfaceType: "cylindrical",
    cylinder: { axis, radius, length, interior }
  };
}

function dot3(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function subtract3(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale3(vector: [number, number, number], scale: number): [number, number, number] {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function canonicalDirection(direction: [number, number, number]): [number, number, number] {
  const absolute = direction.map(Math.abs);
  const dominantAxis = absolute[0]! >= absolute[1]! && absolute[0]! >= absolute[2]!
    ? 0
    : absolute[1]! >= absolute[2]!
      ? 1
      : 2;
  return direction[dominantAxis]! < 0 ? scale3(direction, -1) : direction;
}

function displayFaceForRecord(face: StepFaceRecord, scale: number, offset: [number, number, number]): DisplayFace {
  const displayFace: DisplayFace = {
    id: face.faceId,
    label: stepFaceLabel(face),
    color: "#8b949e",
    center: [
      face.centroid[0] * scale + offset[0],
      face.centroid[1] * scale + offset[1],
      face.centroid[2] * scale + offset[2]
    ],
    normal: [...face.avgNormal],
    stressValue: 0,
    area: face.area,
    surfaceType: face.surfaceType
  };
  if (face.cylinder) {
    displayFace.surfaceAxis = [...face.cylinder.axis];
    displayFace.surfaceRadius = face.cylinder.radius * scale;
    displayFace.surfaceLength = face.cylinder.length * scale;
    displayFace.interiorSurface = face.cylinder.interior;
  }
  return displayFace;
}

function stepFaceLabel(face: StepFaceRecord): string {
  const ordinal = face.faceId.slice(STEP_FACE_ID_PREFIX.length);
  if (face.surfaceType === "cylindrical") {
    return `${face.cylinder?.interior ? "Cylindrical hole wall" : "Cylindrical surface"} F${ordinal} (${formatAreaMm2(face.area)})`;
  }
  if (face.surfaceType === "curved") return `Curved surface F${ordinal} (${formatAreaMm2(face.area)})`;
  const [nx, ny, nz] = face.avgNormal;
  const axes: Array<{ label: string; value: number }> = [
    { label: "+X", value: nx },
    { label: "-X", value: -nx },
    { label: "+Y", value: ny },
    { label: "-Y", value: -ny },
    { label: "+Z", value: nz },
    { label: "-Z", value: -nz }
  ];
  const dominant = axes.sort((left, right) => right.value - left.value)[0];
  const orientation = dominant && dominant.value > 0.72 ? `${dominant.label} planar face` : "Planar face";
  return `${orientation} F${ordinal} (${formatAreaMm2(face.area)})`;
}

function formatAreaMm2(area: number): string {
  if (!Number.isFinite(area) || area <= 0) return "unknown area";
  const rounded = area >= 100 ? Math.round(area) : Math.round(area * 10) / 10;
  return `${rounded.toLocaleString()} mm²`;
}

function vertexAt(mesh: StepFaceRegistryMesh, index: number): [number, number, number] {
  return [mesh.positions[index * 3] ?? 0, mesh.positions[index * 3 + 1] ?? 0, mesh.positions[index * 3 + 2] ?? 0];
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
