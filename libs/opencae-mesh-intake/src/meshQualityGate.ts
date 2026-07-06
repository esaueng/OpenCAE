// First-class mesh quality gate for in-browser (wasm) gmsh sessions (plan
// A-M4). The minSICN probe graduated from a best-effort diagnostic (A-M3) to
// an enforced intake gate: wasm-produced meshes without a measurable quality
// are rejected rather than silently accepted, badly distorted meshes are
// rejected with an actionable error, and marginal meshes carry a recorded
// warning through metadata.meshQuality into the mesh-step warnings.
import type { CoreVolumeMeshArtifact } from "./types";

/** Below this min signed inverse condition number the mesh is rejected. */
export const MESH_QUALITY_REJECT_MIN_SICN = 0.05;
/** Below this min SICN the mesh is accepted with a recorded quality warning. */
export const MESH_QUALITY_WARN_MIN_SICN = 0.2;

/**
 * Thrown when a wasm-meshed model fails the quality gate. Carries a stable
 * name so the rejection survives the worker message boundary and is never
 * mistaken for a transient meshing failure (which may fall back to other
 * paths — a quality rejection must surface to the user instead).
 */
export class MeshQualityError extends Error {
  static NAME = "MeshQualityError" as const;
  constructor(message: string) {
    super(message);
    this.name = MeshQualityError.NAME;
  }
}

export function isMeshQualityErrorLike(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { name?: unknown }).name === MeshQualityError.NAME;
}

export type MeshQualityGateResult = {
  minSICN: number;
  /** Human-readable quality warnings (empty when the mesh passes cleanly). */
  warnings: string[];
};

/**
 * Enforce the wasm-session quality gate and stamp the outcome onto the
 * artifact's metadata (metadata.meshQuality.minSICN + warnings).
 *
 * - minSICN undefined: reject. A wasm session that cannot measure element
 *   quality cannot certify the mesh; accepting it silently would defeat the
 *   gate ("first-class, not best-effort").
 * - minSICN < 0.05: reject with an actionable error.
 * - minSICN < 0.2: accept with a recorded warning.
 */
export function enforceWasmMeshQualityGate(
  artifact: CoreVolumeMeshArtifact,
  qualityMinSICN: number | undefined,
  context: string
): MeshQualityGateResult {
  if (qualityMinSICN === undefined || !Number.isFinite(qualityMinSICN)) {
    throw new MeshQualityError(
      `${context}: gmsh did not report element quality (minSICN), so the mesh cannot pass the quality gate. ` +
        "Re-run meshing; if this persists, adjust the mesh size or simplify the geometry."
    );
  }
  if (qualityMinSICN < MESH_QUALITY_REJECT_MIN_SICN) {
    throw new MeshQualityError(
      `${context}: mesh rejected — worst element quality minSICN=${qualityMinSICN.toFixed(4)} is below the ` +
        `${MESH_QUALITY_REJECT_MIN_SICN} floor (near-degenerate elements would corrupt stress results). ` +
        "Try a finer or coarser mesh preset, or simplify thin/sliver features in the geometry near the failure."
    );
  }
  const warnings: string[] = [];
  if (qualityMinSICN < MESH_QUALITY_WARN_MIN_SICN) {
    warnings.push(
      `Mesh quality warning: worst element minSICN=${qualityMinSICN.toFixed(3)} is below ${MESH_QUALITY_WARN_MIN_SICN}. ` +
        "Results near the worst elements may be less accurate; consider a different mesh preset."
    );
  }
  artifact.metadata.meshQuality = {
    ...artifact.metadata.meshQuality,
    minSICN: qualityMinSICN,
    ...(warnings.length ? { warnings } : {})
  };
  return { minSICN: qualityMinSICN, warnings };
}
