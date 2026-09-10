/**
 * Deformation exaggeration: one definition of the factor the viewport actually applied.
 *
 * The slider the user drags is an *emphasis multiplier*, not the exaggeration. The
 * displayed shape is auto-fitted so peak displacement reads as a fixed fraction of the
 * model, and the slider then scales that fit — so a "1.8x" control routinely produces a
 * real exaggeration in the hundreds or thousands. The viewport legend has always reported
 * the resolved number; the PDF report printed the slider value instead and called it the
 * exaggeration.
 *
 * This module exists so both read the same function. It is deliberately free of three.js
 * so the report path can import it without pulling the lazily loaded viewer chunk into the
 * workspace shell.
 */
import type { ResultField } from "@opencae/schema";
import type { SolverSurfaceMesh } from "./projectFile";
import type { ResultMode } from "./workspaceViewTypes";

/** Peak displacement is fitted to this fraction of the model's diagonal before the slider applies. */
export const RESULT_DEFORMATION_TARGET_FRACTION = 0.08;
/** Ceiling on visual displacement, as a fraction of the model's diagonal. */
export const RESULT_DEFORMATION_CAP_FRACTION = 0.25;

export function maxDisplacementMagnitude(field: ResultField | undefined): number {
  if (!field) return 0;
  let max = Number.NEGATIVE_INFINITY;
  const consider = (magnitude: number) => {
    if (Number.isFinite(magnitude) && magnitude > max) max = magnitude;
  };
  consider(Math.abs(Number(field.max)));
  consider(Math.abs(Number(field.min)));
  for (const value of field.values) consider(Math.abs(value));
  for (const vector of field.vectors ?? []) consider(Math.hypot(vector[0], vector[1], vector[2]));
  for (const sample of field.samples ?? []) {
    consider(Math.abs(sample.value));
    consider(sample.vector ? Math.hypot(sample.vector[0], sample.vector[1], sample.vector[2]) : 0);
  }
  return Number.isFinite(max) ? max : 0;
}

/**
 * Run-wide peak so the scale is constant across playback frames rather than reflecting
 * whichever frame happens to be open.
 */
export function transientDisplacementPeakMagnitude(fields: ResultField[], currentField: ResultField | undefined): number {
  let peak = 0;
  for (const field of fields) {
    if (field.type !== "displacement") continue;
    peak = Math.max(peak, maxDisplacementMagnitude(field));
  }
  return peak > 0 ? peak : maxDisplacementMagnitude(currentField);
}

export function finalVisualScaleForDisplacementField(
  modelExtent: number,
  displacementField: ResultField | undefined,
  deformationScale: number,
  capFraction = RESULT_DEFORMATION_CAP_FRACTION,
  displacementPeakMagnitude?: number
) {
  // Prefer an explicit run-wide peak (transient) so the scale is constant across frames;
  // fall back to the field's own max for single-frame (static) results.
  const displacementMax = Number.isFinite(displacementPeakMagnitude) && (displacementPeakMagnitude ?? 0) > 0
    ? (displacementPeakMagnitude as number)
    : maxDisplacementMagnitude(displacementField);
  const requestedScale = Math.max(0, deformationScale);
  const safeExtent = Math.max(0, modelExtent);
  const autoScale = displacementMax > 1e-12
    ? (safeExtent * RESULT_DEFORMATION_TARGET_FRACTION) / displacementMax
    : 0;
  const unclampedFinalScale = autoScale * requestedScale;
  const maxVisualDisplacement = safeExtent * Math.max(0, capFraction);
  const maxFinalScale = displacementMax > 1e-12
    ? maxVisualDisplacement / displacementMax
    : 0;
  const finalVisualScale = Math.min(unclampedFinalScale, maxFinalScale);
  return {
    deformationScale: requestedScale,
    autoScale,
    unclampedFinalScale,
    maxFinalScale,
    finalVisualScale,
    capActive: unclampedFinalScale > maxFinalScale
  };
}

export function isSolverSurfaceNodeField(field: ResultField, surfaceMesh: SolverSurfaceMesh, resultMode: ResultMode): boolean {
  return (
    field.type === resultMode &&
    field.location === "node" &&
    field.surfaceMeshRef === surfaceMesh.id &&
    field.values.length === surfaceMesh.nodes.length
  );
}

export interface ResolvedDeformation {
  /**
   * Mode shapes carry no physical amplitude, so their number is the emphasis multiplier
   * itself and must never be presented as a displacement exaggeration.
   */
  kind: "displacement" | "mode_shape";
  /** For "displacement", the factor actually applied to the rendered shape. */
  factor: number;
}

/**
 * The exaggeration the viewport applied, or null when nothing deformed is on screen.
 *
 * Mirrors what the legend reports, including the unit correction: solver surface meshes are
 * in metres while displacement fields are normalised to mm, so the true exaggeration is
 * 1000x the applied vertex-shift factor in that case.
 */
export function resolvedDeformation(input: {
  surfaceMesh: SolverSurfaceMesh | undefined;
  resultFields: ResultField[];
  resultMode: ResultMode;
  deformationScale: number | undefined;
  showDeformed: boolean | undefined;
  capFraction?: number;
}): ResolvedDeformation | null {
  const { surfaceMesh, resultFields, resultMode, showDeformed } = input;
  const deformationScale = input.deformationScale ?? 1;
  if (!showDeformed || !surfaceMesh) return null;

  // The field lookup runs for mode shapes too, and its guard gates them as well: with no
  // deforming field on this surface there is nothing being exaggerated, so there is no
  // factor to report. Returning the mode-shape emphasis before this point would announce
  // one for a shape that is not deformed.
  const deformationMode = resultMode === "mode_shape" ? "mode_shape" : "displacement";
  const displacementFields = resultFields.filter((candidate) => isSolverSurfaceNodeField(candidate, surfaceMesh, deformationMode));
  const displacementField = displacementFields[0];
  if (!displacementField?.vectors?.length) return null;

  // Modal amplitudes are normalised, so the slider value is the whole story: there is no
  // physical magnitude for an auto-fit to scale against.
  if (resultMode === "mode_shape") return { kind: "mode_shape", factor: deformationScale };

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const node of surfaceMesh.nodes) {
    if (!node.every(Number.isFinite)) continue;
    if (node[0] < minX) minX = node[0];
    if (node[1] < minY) minY = node[1];
    if (node[2] < minZ) minZ = node[2];
    if (node[0] > maxX) maxX = node[0];
    if (node[1] > maxY) maxY = node[1];
    if (node[2] > maxZ) maxZ = node[2];
  }
  const modelExtent = Number.isFinite(minX) && maxX >= minX
    ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
    : 1;

  const displacementPeakMagnitude = transientDisplacementPeakMagnitude(displacementFields, displacementField);
  const appliedScale = finalVisualScaleForDisplacementField(
    modelExtent,
    displacementField,
    deformationScale,
    input.capFraction ?? RESULT_DEFORMATION_CAP_FRACTION,
    displacementPeakMagnitude
  ).finalVisualScale;
  const unitFactor = displacementField.units === "mm" && surfaceMesh.coordinateSpace === "solver" ? 1000 : 1;
  const factor = appliedScale * unitFactor;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return { kind: "displacement", factor };
}

/** Rounded the way both the legend and the report caption present a factor. */
export function formatDeformationFactor(factor: number): string {
  return factor >= 10 ? Math.round(factor).toLocaleString() : factor.toFixed(1);
}
