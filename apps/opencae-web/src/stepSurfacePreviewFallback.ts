import type { StepGeometryInspection, StepSurfacePreview } from "@opencae/mesh-intake";
import type { OcctMesh } from "occt-import-js";

type CachedStepSurfacePreview = {
  inspection: StepGeometryInspection;
  surfacePreview: StepSurfacePreview;
  preferred: boolean;
};

// A STEP payload can exceed 100 MB. Keep only the active model's fallback so
// replacing a model does not retain another large surface mesh and base64 key.
const MAX_CACHED_STEP_SURFACES = 1;
const resolved = new Map<string, CachedStepSurfacePreview>();
const pending = new Map<string, Promise<CachedStepSurfacePreview>>();

export function rememberStepSurfacePreview(
  contentBase64: string,
  inspection: StepGeometryInspection,
  surfacePreview: StepSurfacePreview,
  options: { preferred?: boolean } = {}
): CachedStepSurfacePreview {
  const current = resolved.get(contentBase64);
  const cached = {
    inspection,
    surfacePreview,
    preferred: options.preferred === true || current?.preferred === true
  };
  resolved.delete(contentBase64);
  resolved.set(contentBase64, cached);
  while (resolved.size > MAX_CACHED_STEP_SURFACES) {
    const oldest = resolved.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    resolved.delete(oldest);
  }
  return cached;
}

export function peekStepSurfacePreview(contentBase64: string): CachedStepSurfacePreview | null {
  return resolved.get(contentBase64) ?? null;
}

export function preferStepSurfacePreview(contentBase64: string): CachedStepSurfacePreview | null {
  const cached = resolved.get(contentBase64);
  if (!cached) return null;
  cached.preferred = true;
  return cached;
}

/**
 * Generate the fallback off the main thread. The mesh worker already performs
 * the necessary Gmsh surface meshing for topology inspection, so retaining its
 * typed arrays avoids a second heavyweight CAD import.
 */
export async function loadStepSurfacePreviewFallback(contentBase64: string): Promise<CachedStepSurfacePreview> {
  const cached = resolved.get(contentBase64);
  if (cached) return cached;
  const inFlight = pending.get(contentBase64);
  if (inFlight) return inFlight;
  if (typeof Worker === "undefined") {
    throw new Error("Gmsh STEP preview fallback requires browser workers.");
  }

  const next = import("./workers/meshWorkerClient")
    .then(async (client) => {
      const bytes = base64ToUint8Array(contentBase64);
      const result = await client.inspectStepFileInWorker({
        stepContent: bytes.buffer as ArrayBuffer,
        includeSurfacePreview: true
      });
      if (!result.surfacePreview?.meshes.length) {
        throw new Error("Gmsh STEP inspection did not return a surface preview.");
      }
      return rememberStepSurfacePreview(contentBase64, result.inspection, result.surfacePreview);
    })
    .finally(() => pending.delete(contentBase64));
  pending.set(contentBase64, next);
  return next;
}

export function occtMeshesFromStepSurfacePreview(surfacePreview: StepSurfacePreview): OcctMesh[] {
  return surfacePreview.meshes.map((mesh) => ({
    name: mesh.name,
    attributes: { position: { array: mesh.positions } },
    index: { array: mesh.indices },
    brep_faces: mesh.faceRanges.map((range) => ({ ...range, color: null }))
  }));
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
