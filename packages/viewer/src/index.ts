import { assertProductionSurfaceFieldInvariant, type CoreResultField, type CoreSolveResult } from "@opencae/core";

export type SolverSurfaceRenderGeometry = {
  source: "solver_surface_mesh";
  surfaceMeshId: string;
  fieldId: string;
  fieldUnits: string;
  positions: Float32Array;
  indices: Uint32Array;
  values: Float32Array;
  min: number;
  max: number;
  nodeMap: Uint32Array;
  displacementFieldId?: string;
  displacementVectors?: Float32Array;
};

export function buildSolverSurfaceRenderGeometry(
  result: CoreSolveResult,
  fieldId = "stress-surface",
  displacementFieldId = "displacement-surface"
): SolverSurfaceRenderGeometry {
  const surfaceMesh = result.surfaceMesh;
  if (!surfaceMesh) {
    throw new Error("Core result does not include a solver surface mesh.");
  }
  if (!Array.isArray(surfaceMesh.nodeMap) || surfaceMesh.nodeMap.length !== surfaceMesh.nodes.length) {
    throw new Error("Core result solver surface mesh nodeMap must align one-to-one with surface nodes.");
  }
  assertProductionSurfaceFieldInvariant(result, {
    stressFieldId: fieldId,
    displacementFieldId,
    requireDisplacementVectors: false
  });

  const field = findSurfaceNodeField(result, fieldId);
  assertSurfaceFieldAlignment(field, surfaceMesh.id, surfaceMesh.nodes.length);
  const displacementField = result.fields.find((candidate) => candidate.id === displacementFieldId);
  if (displacementField) {
    assertSurfaceFieldAlignment(displacementField, surfaceMesh.id, surfaceMesh.nodes.length);
  }

  return {
    source: "solver_surface_mesh",
    surfaceMeshId: surfaceMesh.id,
    fieldId: field.id,
    fieldUnits: field.units,
    positions: new Float32Array(surfaceMesh.nodes.flat()),
    indices: new Uint32Array(surfaceMesh.triangles.flat()),
    values: new Float32Array(field.values),
    min: field.min,
    max: field.max,
    nodeMap: new Uint32Array(surfaceMesh.nodeMap),
    displacementFieldId: displacementField?.id,
    displacementVectors: displacementField?.vectors
      ? new Float32Array(displacementField.vectors.flat())
      : undefined
  };
}

function findSurfaceNodeField(result: CoreSolveResult, fieldId: string): CoreResultField {
  const field = result.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    throw new Error(`Core result field ${fieldId} was not found.`);
  }
  return field;
}

function assertSurfaceFieldAlignment(field: CoreResultField, surfaceMeshId: string, surfaceNodeCount: number): void {
  if (field.location !== "node") {
    throw new Error(`Core result field ${field.id} must be a node field for solver-surface rendering.`);
  }
  if (field.surfaceMeshRef !== surfaceMeshId) {
    throw new Error(`Core result field ${field.id} does not reference solver surface mesh ${surfaceMeshId}.`);
  }
  if (field.values.length !== surfaceNodeCount) {
    throw new Error(`Core result field ${field.id} length does not match solver surface node count.`);
  }
  if (field.vectors && field.vectors.length !== surfaceNodeCount) {
    throw new Error(`Core result field ${field.id} vectors do not match solver surface node count.`);
  }
}
