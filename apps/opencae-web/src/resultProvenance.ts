import type { DisplayModel, ResultField, ResultProvenance, ResultSummary, Study } from "@opencae/schema";
import { isComplexGeometry } from "./workers/opencaeCoreSolve";

export const PREVIEW_GEOMETRY_WARNING = "OpenCAE Core Preview mesh does not match this geometry; deformed shape disabled.";
export const INVALID_REACTION_WARNING = "Reaction force unavailable or invalid for this result.";

export type ResultMeshStats = { nodes: number; elements: number };

// Solver responses carry the true solved-mesh size in their diagnostics
// (e.g. core-solve-diagnostics nodeCount/elementCount). Surface-mesh or
// study-preset numbers are NOT acceptable substitutes: presets are estimates
// and the legend must never present them as the solved mesh.
export function meshStatsFromResultDiagnostics(diagnostics: unknown): ResultMeshStats | undefined {
  if (!Array.isArray(diagnostics)) return undefined;
  for (const entry of diagnostics) {
    const stats = meshStatsFromDiagnosticEntry(entry);
    if (stats) return stats;
  }
  return undefined;
}

function meshStatsFromDiagnosticEntry(entry: unknown): ResultMeshStats | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const direct = meshStatsFromCounts(record.nodeCount, record.elementCount);
  if (direct) return direct;
  if (record.details && typeof record.details === "object") {
    const details = record.details as Record<string, unknown>;
    return meshStatsFromCounts(details.nodeCount, details.elementCount);
  }
  return undefined;
}

function meshStatsFromCounts(nodes: unknown, elements: unknown): ResultMeshStats | undefined {
  const nodeCount = Number(nodes);
  const elementCount = Number(elements);
  if (!Number.isFinite(nodeCount) || !Number.isFinite(elementCount) || nodeCount <= 0 || elementCount <= 0) return undefined;
  return { nodes: nodeCount, elements: elementCount };
}

export function isPreviewResultProvenance(provenance: ResultProvenance | undefined): boolean {
  return provenance?.solver === "opencae-core-preview-sdof" ||
    provenance?.solver === "opencae-core-preview-tet4" ||
    provenance?.meshSource === "structured_block_proxy" ||
    provenance?.meshSource === "display_bounds_proxy" ||
    provenance?.resultSource === "computed_preview";
}

export function hasPreviewResultProvenance(summary: ResultSummary | undefined, fields: ResultField[] = []): boolean {
  return isPreviewResultProvenance(summary?.provenance) || fields.some((field) => isPreviewResultProvenance(field.provenance));
}

export function shouldBlockPreviewResultsForDisplayModel(displayModel: DisplayModel, summary: ResultSummary | undefined, fields: ResultField[] = [], study?: Study): boolean {
  return isComplexGeometry(displayModel, study) && hasPreviewResultProvenance(summary, fields);
}

export function hasNonzeroAppliedLoads(study: Study): boolean {
  return study.loads.some((load) => {
    const value = Number(load.parameters.value);
    return Number.isFinite(value) && value > 0;
  });
}

export function hasInvalidReactionForce(summary: ResultSummary | undefined, study?: Study): boolean {
  const reaction = Number(summary?.reactionForce);
  return Boolean(study && hasNonzeroAppliedLoads(study) && (!Number.isFinite(reaction) || reaction <= 0));
}

export function hasUnavailableReactionDiagnostic(summary: ResultSummary | undefined): boolean {
  return Boolean(summary?.diagnostics?.some((diagnostic) => /reaction force unavailable/i.test(diagnostic.message)));
}

export function canShowReverseLoadCapacity(summary: ResultSummary, displayModel: DisplayModel, fields: ResultField[], study: Study): boolean {
  if (shouldBlockPreviewResultsForDisplayModel(displayModel, summary, fields, study)) return false;
  if (hasInvalidReactionForce(summary, study)) return false;
  if (hasUnavailableReactionDiagnostic(summary)) return false;
  return true;
}
