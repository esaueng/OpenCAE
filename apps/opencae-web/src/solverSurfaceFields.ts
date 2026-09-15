import type { ResultField } from "@opencae/schema";
import { selectActiveResultField, stressComponentForField, interpolateScalarFromSamples } from "./resultSelection";
import { transientDisplacementPeakMagnitude } from "./resultDeformation";
import type { SolverSurfaceMesh } from "./projectFile";
import type { ResultMode, StressComponent } from "./workspaceViewTypes";

export interface SolverSurfaceResultFields {
  scalarField: ResultField;
  displacementField?: ResultField;
  displacementPeakMagnitude: number;
}

/**
 * Pure result-math helpers for the solver-surface render path, extracted from
 * CadViewer.tsx (which re-exports them). Deliberately free of three.js and
 * React so tests and report code can import them without the viewer chunk.
 */
export function solverSurfaceResultFields(
  surfaceMesh: SolverSurfaceMesh | undefined,
  fields: ResultField[],
  resultMode: ResultMode,
  stressComponent: StressComponent = "von_mises"
): SolverSurfaceResultFields | null {
  if (!surfaceMesh || !surfaceMesh.nodes.length || !surfaceMesh.triangles.length) return null;
  const deformationMode = resultMode === "mode_shape" ? "mode_shape" : "displacement";
  const displacementFields = fields.filter((field) => isSolverSurfaceNodeField(field, surfaceMesh, deformationMode));
  const selected = selectActiveResultField({ fields, resultMode, stressComponent, surfaceMesh });
  const scalarField = selected.scalarField && isSolverSurfaceNodeField(selected.scalarField, surfaceMesh, resultMode)
    ? selected.scalarField
    // The solver emits stress/safety_factor per element (no node field), so those modes fall to
    // the procedural IDW render and show streaks instead of a smooth contour. Recover them onto
    // the surface nodes so they render through this same smooth nodal path. Gate on a node
    // displacement field existing, which confirms the result is already surface-renderable — so
    // we never downgrade a procedural-tier result's deformation to an undeformed surface.
    : (displacementFields.length ? recoverSurfaceNodeScalarField(surfaceMesh, fields, resultMode, stressComponent) : null);
  if (!scalarField) return null;
  const displacementField = displacementFields[0];
  // Run-wide peak across every transient frame so the deformation scale stays constant and a
  // near-zero opening frame is not self-normalized into a torn shape (see procedural path).
  const displacementPeakMagnitude = transientDisplacementPeakMagnitude(displacementFields, displacementField);
  return { scalarField, ...(displacementField ? { displacementField } : {}), displacementPeakMagnitude };
}

// Recovers an element-located scalar contour (stress / safety_factor) onto the solver surface
// mesh nodes via inverse-distance interpolation from the field's samples, returning a node field
// aligned to surfaceMesh so the smooth SolverSurfaceResultMesh path can render it. Sample points
// and surface nodes are both in solver space (the cloud emits sample.point = surface-node point),
// so no coordinate reconciliation is needed here. Returns null when nothing is recoverable, so
// callers fall back to the procedural render unchanged.
export function recoverSurfaceNodeScalarField(
  surfaceMesh: SolverSurfaceMesh,
  fields: ResultField[],
  resultMode: ResultMode,
  stressComponent: StressComponent = "von_mises"
): ResultField | null {
  // Only the scalar contour modes the solver emits per element. displacement/velocity/
  // acceleration already arrive as smooth node fields carrying their own vectors.
  if (resultMode !== "stress" && resultMode !== "safety_factor") return null;
  if (!surfaceMesh.nodes.length) return null;
  if (fields.some((field) => isSolverSurfaceNodeField(field, surfaceMesh, resultMode))) return null;
  const source = fields.find(
    (field) =>
      field.type === resultMode &&
      (resultMode !== "stress" || stressComponentForField(field) === stressComponent) &&
      (field.samples?.some((sample) => Number.isFinite(sample.value) && sample.point.length === 3 && sample.point.every(Number.isFinite)) ?? false)
  );
  const samples = source?.samples?.filter(
    (sample) => Number.isFinite(sample.value) && sample.point.length === 3 && sample.point.every(Number.isFinite)
  );
  if (!source || !samples || !samples.length) return null;
  if (surfaceMesh.nodes.length * samples.length > 5_000_000) return null;

  const values = surfaceMesh.nodes.map((node) =>
    interpolateScalarFromSamples(node, samples)
  );
  if (!values.some(Number.isFinite)) return null;
  // Loop instead of Math.min(...spread): surface-node arrays can exceed the V8 argument limit.
  let finiteMin = Number.POSITIVE_INFINITY;
  let finiteMax = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < finiteMin) finiteMin = value;
    if (value > finiteMax) finiteMax = value;
  }
  return {
    ...source,
    id: `${source.id}-surface-node`,
    location: "node",
    surfaceMeshRef: surfaceMesh.id,
    values,
    // Reuse the source field's range so the legend and color scale stay consistent with the
    // element field's reported peak; interpolated node values fall within that range anyway.
    min: Number.isFinite(source.min) ? source.min : finiteMin,
    max: Number.isFinite(source.max) ? source.max : finiteMax,
    samples: undefined,
    vectors: undefined
  };
}

export function isSolverSurfaceNodeField(
  field: ResultField,
  surfaceMesh: SolverSurfaceMesh,
  resultMode: ResultMode
): boolean {
  return (
    field.type === resultMode &&
    field.location === "node" &&
    field.surfaceMeshRef === surfaceMesh.id &&
    field.values.length === surfaceMesh.nodes.length
  );
}

// A field's values array may only be indexed by procedural vertex index when it is actually
// aligned to that geometry. Surface-node fields (surfaceMeshRef) are aligned to the solver
// surface mesh, never to procedural geometry — indexing them by vertex index painted
// meaningless near-uniform colors with vertex-order streaks.
export function resultFieldValuesAlignedToGeometry(field: ResultField, vertexCount: number): boolean {
  return !field.surfaceMeshRef && field.values.length === vertexCount;
}
