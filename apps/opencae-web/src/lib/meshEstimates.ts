import type { AnalysisMesh, MeshQuality, Study } from "@opencae/schema";

/**
 * Preset mesh-size estimates for geometry that cannot be volume-meshed
 * (opt-out builds, preview-only STL/OBJ). Extracted from lib/api.ts so the
 * estimate path is visible as its own quarantined module: callers must pass
 * allowEstimateFallback explicitly, and production STEP meshing never lands
 * here (generateMesh throws for STEP instead of falling back).
 */

export const MESH_PRESET_ESTIMATE_WARNING = "Node and element counts are preset planning estimates, not a generated finite-element mesh. Surface analysis samples are heuristic; the solver reports actual mesh statistics with computed FEA results.";

export const PROCEDURAL_MESH_SIZE_MM: Record<MeshQuality, number> = {
  coarse: 18,
  medium: 12,
  fine: 8,
  ultra: 6
};

/** The target element size a preset asks the browser mesher for (shown in the Mesh panel). */
export function meshTargetSizeMmForPreset(preset: MeshQuality): number {
  return PROCEDURAL_MESH_SIZE_MM[preset] ?? PROCEDURAL_MESH_SIZE_MM.medium;
}

export function meshSummaryForPreset(preset: MeshQuality, analysisMesh?: AnalysisMesh) {
  const sampleCount = analysisMesh?.samples.length;
  const summaryByPreset: Record<MeshQuality, NonNullable<Study["meshSettings"]["summary"]>> = {
    coarse: { nodes: 12840, elements: 7320, warnings: [MESH_PRESET_ESTIMATE_WARNING], analysisSampleCount: sampleCount ?? 1200, quality: "coarse" as const, source: "preset_estimate" },
    medium: { nodes: 42381, elements: 26944, warnings: [MESH_PRESET_ESTIMATE_WARNING, "Medium heuristic surface-sample density selected."], analysisSampleCount: sampleCount ?? 4800, quality: "medium" as const, source: "preset_estimate" },
    fine: { nodes: 88420, elements: 57102, warnings: [MESH_PRESET_ESTIMATE_WARNING, "Fine heuristic surface-sample density selected."], analysisSampleCount: sampleCount ?? 19200, quality: "fine" as const, source: "preset_estimate" },
    ultra: { nodes: 182400, elements: 119808, warnings: [MESH_PRESET_ESTIMATE_WARNING, "Ultra heuristic surface-sample density selected."], analysisSampleCount: sampleCount ?? 45000, quality: "ultra" as const, source: "preset_estimate" }
  };
  return summaryByPreset[preset];
}
