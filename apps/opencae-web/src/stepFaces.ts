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
import { buildStepAttributionTessellation, type StepAttributionTessellation } from "@opencae/mesh-intake";

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

const STEP_FACE_ID_PREFIX = "step-face-";

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

/** Flattened tessellation for the mesh worker's facet->face attribution. */
export function stepAttributionForRegistry(registry: StepFaceRegistry): StepAttributionTessellation {
  return buildStepAttributionTessellation(
    registry.meshes.map((mesh) => ({
      positions: mesh.positions,
      indices: mesh.indices,
      brepFaces: mesh.faceRanges
    })),
    { faceIds: registry.faces.map((face) => face.faceId), unitScale: 0.001 }
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
  return buildStepFaceRegistry(result.meshes ?? []);
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
  }
  if (area > 0) {
    centroid[0] /= area;
    centroid[1] /= area;
    centroid[2] /= area;
  }
  const normalLength = Math.hypot(...normalSum);
  const avgNormal: [number, number, number] = normalLength > 0
    ? [normalSum[0] / normalLength, normalSum[1] / normalLength, normalSum[2] / normalLength]
    : [0, 0, 1];
  return {
    faceId: `${STEP_FACE_ID_PREFIX}${globalIndex}`,
    meshIndex,
    triangleRange: [range.first, range.last],
    triangleCount: range.last - range.first + 1,
    area,
    centroid,
    avgNormal,
    fingerprint: stepFaceFingerprint(area, centroid, avgNormal)
  };
}

function displayFaceForRecord(face: StepFaceRecord, scale: number, offset: [number, number, number]): DisplayFace {
  return {
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
    area: face.area
  };
}

function stepFaceLabel(face: StepFaceRecord): string {
  const ordinal = face.faceId.slice(STEP_FACE_ID_PREFIX.length);
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
  const orientation = dominant && dominant.value > 0.72 ? `${dominant.label} planar face` : "Curved/skew face";
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
