import { extractBoundarySurfaceFacets } from "./mesh";
import type {
  ElementBlockJson,
  NormalizedOpenCAEModel,
  OpenCAEModelJson,
  SurfaceFacetJson
} from "./model-json";

export type SolverSurfaceMesh = {
  id: string;
  nodes: [number, number, number][];
  triangles: [number, number, number][];
  coordinateSpace: "solver" | "display_model";
  source: "opencae_core_volume_mesh";
  nodeMap: number[];
  volumeNodeCount?: number;
};

export type CoreResultField = {
  id: string;
  type: "stress" | "displacement" | "velocity" | "acceleration" | "safety_factor";
  component?: "von_mises" | "principal_max" | "principal_min" | "max_shear";
  location: "node" | "element" | "integration_point";
  values: number[];
  min: number;
  max: number;
  units: string;
  samples?: unknown[];
  vectors?: [number, number, number][];
  meshRef?: string;
  surfaceMeshRef?: string;
  frameIndex?: number;
  timeSeconds?: number;
  visualizationSource?: string;
  engineeringSource?: string;
};

export type CoreTransientSummary = {
  analysisType: "dynamic_structural";
  integrationMethod?: "newmark_average_acceleration";
  dampingRatio?: number;
  frameCount: number;
  startTime: number;
  endTime: number;
  timeStep: number;
  outputInterval: number;
  loadProfile?: string;
  peakDisplacement: number;
  peakDisplacementTimeSeconds: number;
  peakVelocity?: number;
  peakAcceleration?: number;
};

export type CoreSolveSummary = {
  maxStress: number;
  maxStressUnits: "MPa";
  maxDisplacement: number;
  maxDisplacementUnits: "mm";
  safetyFactor?: number;
  reactionForce: number;
  reactionForceUnits: "N";
  provenance: CoreSolveProvenance;
  transient?: CoreTransientSummary;
};

export type CoreSolveProvenance = {
  kind: "opencae_core_fea";
  solver: "opencae-core-cloud" | "opencae-core-sparse-tet" | "opencae-core-mdof-tet";
  resultSource: "computed";
  meshSource: "actual_volume_mesh" | "structured_block_core";
  units: "mm-N-s-MPa";
  coreVersion?: string;
  solverCpuVersion?: string;
  runnerVersion?: string;
};

export type CoreSolveDiagnostics = {
  id: "core-solve-diagnostics";
  coreModelSchemaVersion: string;
  coreVersion?: string;
  solverCpuVersion?: string;
  solverMethod: string;
  meshSource: CoreSolveProvenance["meshSource"];
  nodeCount: number;
  elementCount: number;
  surfaceNodeCount: number;
  surfaceTriangleCount: number;
  connectedComponentCount: number;
  fixedNodeCount: number;
  loadNodeCount: number;
  fixedCentroid: [number, number, number];
  loadCentroid: [number, number, number];
  effectiveLeverArmMm: number;
  totalLoadVectorN: [number, number, number];
  reactionVectorN: [number, number, number];
  reactionMagnitudeN: number;
  rawMaxStressPa: number;
  displayMaxStressMpa: number;
  rawMaxDisplacementM: number;
  displayMaxDisplacementMm: number;
  engineeringStressMaxMpa: number;
  plotStressMinMpa: number;
  plotStressMaxMpa: number;
  stressRecoveryMethod: string;
  fieldSurfaceAlignment: "ok" | "invalid";
  stressFieldValueCount: number;
  displacementFieldValueCount: number;
  warnings: string[];
  stressByBeamAxisBin: Array<{
    bin: number;
    axisCenter: number;
    meanStressMpa: number;
    maxStressMpa: number;
    nodeCount: number;
  }>;
};

export type CoreSolveResult = {
  summary: CoreSolveSummary;
  fields: CoreResultField[];
  surfaceMesh?: SolverSurfaceMesh;
  diagnostics: unknown[];
  provenance: CoreSolveProvenance;
  artifacts?: {
    rawUnits?: "m-N-s-Pa" | "mm-N-s-MPa";
    [key: string]: unknown;
  };
};

export type CoreResultValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export type CoreResultValidationReport = {
  ok: boolean;
  errors: CoreResultValidationIssue[];
  warnings: CoreResultValidationIssue[];
};

export type ProductionSurfaceFieldInvariantInput = Pick<CoreSolveResult, "surfaceMesh" | "fields">;

export type ProductionSurfaceFieldInvariantOptions = {
  stressFieldId?: string;
  displacementFieldId?: string;
  requireDisplacementVectors?: boolean;
};

type ResultModel = Pick<OpenCAEModelJson, "nodes" | "elementBlocks" | "coordinateSystem"> & {
  surfaceFacets?: Array<SurfaceFacetJson | { id: number; nodes: ArrayLike<number> }>;
};

export function solverSurfaceMeshFromModel(
  model: OpenCAEModelJson | NormalizedOpenCAEModel,
  id = "solver-surface"
): SolverSurfaceMesh {
  const coordinates = model.nodes.coordinates;
  const volumeNodeCount = Math.floor(coordinates.length / 3);
  const facets = collectSurfaceFacets(model);
  const surfaceNodeByVolumeNode = new Map<number, number>();
  const nodes: [number, number, number][] = [];
  const nodeMap: number[] = [];
  const triangles: [number, number, number][] = [];

  for (const facet of facets) {
    if (facet.nodes.length < 3) continue;
    for (const facetTriangle of facetTriangles(facet.nodes)) {
      const triangle = facetTriangle.map((volumeNode) => {
        const existing = surfaceNodeByVolumeNode.get(volumeNode);
        if (existing !== undefined) return existing;
        const surfaceNode = nodes.length;
        surfaceNodeByVolumeNode.set(volumeNode, surfaceNode);
        nodeMap.push(volumeNode);
        nodes.push(surfaceNodeCoordinates(coordinates, volumeNode, volumeNodeCount));
        return surfaceNode;
      });
      triangles.push(triangle as [number, number, number]);
    }
  }

  const surfaceMesh: SolverSurfaceMesh = {
    id,
    nodes,
    triangles,
    coordinateSpace: model.coordinateSystem?.renderCoordinateSpace ?? "solver",
    source: "opencae_core_volume_mesh",
    nodeMap,
    volumeNodeCount
  };
  assertValidSurfaceMesh(surfaceMesh);
  return surfaceMesh;
}

function facetTriangles(nodes: ArrayLike<number>): [number, number, number][] {
  if (nodes.length >= 6) {
    return [
      [nodes[0], nodes[3], nodes[5]],
      [nodes[3], nodes[1], nodes[4]],
      [nodes[5], nodes[4], nodes[2]],
      [nodes[3], nodes[4], nodes[5]]
    ];
  }
  return [[nodes[0], nodes[1], nodes[2]]];
}

export function createCoreResultField(
  field: Omit<CoreResultField, "values" | "min" | "max"> & { values: ArrayLike<number> }
): CoreResultField {
  const values = Array.from(field.values);
  const finiteValues = values.filter(Number.isFinite);
  return {
    ...field,
    values,
    min: finiteValues.length > 0 ? Math.min(...finiteValues) : 0,
    max: finiteValues.length > 0 ? Math.max(...finiteValues) : 0
  };
}

export function validateCoreResult(result: CoreSolveResult): CoreResultValidationReport {
  const errors: CoreResultValidationIssue[] = [];
  validateSummary(result.summary, errors);
  validateProvenance(result.provenance, errors);

  if (!result.surfaceMesh) {
    errors.push(issue("missing-surface-mesh", "Production Core results must include the solver surface mesh.", "surfaceMesh"));
  }

  if (!Array.isArray(result.fields) || result.fields.length === 0) {
    errors.push(issue("empty-fields", "Core result must contain at least one field.", "fields"));
  } else {
    result.fields.forEach((field, index) => validateField(field, index, result.surfaceMesh, errors));
    validateRequiredProductionFields(result, errors);
  }

  if (result.surfaceMesh) validateSurfaceMesh(result.surfaceMesh, errors);
  if (!result.summary.transient) {
    errors.push(...validateProductionSurfaceFieldInvariant(result).errors);
  } else {
    validateTransientProductionSurfaceFields(result, errors);
  }
  validateRequiredDiagnostics(result, errors);

  return {
    ok: errors.length === 0,
    errors,
    warnings: []
  };
}

export function validateProductionSurfaceFieldInvariant(
  result: ProductionSurfaceFieldInvariantInput,
  options: ProductionSurfaceFieldInvariantOptions = {}
): CoreResultValidationReport {
  const errors: CoreResultValidationIssue[] = [];
  const stressFieldId = options.stressFieldId ?? "stress-surface";
  const displacementFieldId = options.displacementFieldId ?? "displacement-surface";
  const surfaceMesh = result.surfaceMesh;

  if (!surfaceMesh) {
    errors.push(issue("missing-surface-mesh", "Production Core results must include the solver surface mesh.", "surfaceMesh"));
  } else {
    if ((surfaceMesh as { source?: unknown }).source !== "opencae_core_volume_mesh") {
      errors.push(issue("invalid-surface-mesh-source", "Production rendering must use the solver surface mesh, not display geometry.", "surfaceMesh.source"));
    }
    validateSurfaceMesh(surfaceMesh, errors);
  }

  const stressField = result.fields.find((field) => field.id === stressFieldId);
  const displacementField = result.fields.find((field) => field.id === displacementFieldId);
  if (!stressField) {
    errors.push(issue("missing-required-result-field", `Production Core result field ${stressFieldId} is required.`, "fields"));
  } else {
    validateProductionSurfaceField(stressField, "stress", stressFieldId, surfaceMesh, "fields.stress", errors);
  }
  if (!displacementField) {
    errors.push(issue("missing-required-result-field", `Production Core result field ${displacementFieldId} is required.`, "fields"));
  } else {
    validateProductionSurfaceField(displacementField, "displacement", displacementFieldId, surfaceMesh, "fields.displacement", errors);
    if (options.requireDisplacementVectors && displacementField.vectors === undefined) {
      errors.push(issue("missing-surface-displacement-vectors", "Solver surface displacement fields must include vectors for deformation rendering.", "fields.displacement.vectors"));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings: []
  };
}

export function assertProductionSurfaceFieldInvariant(
  result: ProductionSurfaceFieldInvariantInput,
  options: ProductionSurfaceFieldInvariantOptions = {}
): void {
  const report = validateProductionSurfaceFieldInvariant(result, options);
  if (!report.ok) {
    const details = report.errors.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new Error(`Production solver surface invariant failed: ${details}`);
  }
}

function validateRequiredProductionFields(result: CoreSolveResult, errors: CoreResultValidationIssue[]): void {
  const transient = result.summary.transient !== undefined;
  const fields = new Map(result.fields.map((field) => [field.id, field]));
  if (!transient) {
    requireField(fields, "displacement-surface", "displacement", "node", errors);
    requireField(fields, "stress-surface", "stress", "node", errors);
    requireField(fields, "stress-von-mises-element", "stress", "element", errors);
    // When yield strength was available (signalled by the element safety-factor field),
    // the render-ready contract also requires the node-located contour field.
    if (result.fields.some((field) => field.type === "safety_factor" && field.location === "element")) {
      requireField(fields, "safety-factor-surface", "safety_factor", "node", errors);
    }
    return;
  }

  if (!result.fields.some((field) => field.type === "displacement" && field.location === "node" && field.surfaceMeshRef === result.surfaceMesh?.id)) {
    errors.push(issue("missing-required-result-field", "Dynamic Core results must include node displacement fields on the solver surface mesh.", "fields"));
  }
  if (!result.fields.some((field) => field.type === "stress" && field.location === "node" && field.surfaceMeshRef === result.surfaceMesh?.id)) {
    errors.push(issue("missing-required-result-field", "Dynamic Core results must include recovered node stress fields on the solver surface mesh.", "fields"));
  }
  if (!result.fields.some((field) => field.type === "stress" && field.location === "element" && field.surfaceMeshRef === undefined)) {
    errors.push(issue("missing-required-result-field", "Dynamic Core results must include raw element engineering stress fields.", "fields"));
  }
}

function validateTransientProductionSurfaceFields(result: CoreSolveResult, errors: CoreResultValidationIssue[]): void {
  const surfaceMesh = result.surfaceMesh;
  const surfaceNodeFields = result.fields.filter(
    (field) =>
      field.location === "node" &&
      (field.type === "stress" ||
        field.type === "displacement" ||
        field.type === "velocity" ||
        field.type === "acceleration" ||
        field.type === "safety_factor")
  );
  for (const field of surfaceNodeFields) {
    validateTransientSurfaceNodeField(field, surfaceMesh, errors);
  }

  // Render-ready transient contract: every frame that carries a node displacement field
  // must also carry a node stress field on the same surface frame, and — when the result
  // has safety-factor data at all — a node safety_factor field for the same frame.
  // A frame missing these renders as a flat/stale contour in the viewer.
  const hasSafetyFactorFields = result.fields.some((field) => field.type === "safety_factor");
  const displacementSurfaceFields = result.fields.filter(
    (field) => field.type === "displacement" && field.location === "node" && field.surfaceMeshRef === surfaceMesh?.id
  );
  for (const displacementField of displacementSurfaceFields) {
    const hasFrameStress = result.fields.some(
      (field) =>
        field.type === "stress" &&
        field.location === "node" &&
        field.surfaceMeshRef === surfaceMesh?.id &&
        field.frameIndex === displacementField.frameIndex
    );
    if (!hasFrameStress) {
      errors.push(
        issue(
          "missing-required-result-field",
          `Dynamic Core displacement frame ${displacementField.frameIndex} requires a matching node stress field on the solver surface mesh.`,
          "fields"
        )
      );
    }
    if (hasSafetyFactorFields) {
      const hasFrameSafetyFactor = result.fields.some(
        (field) =>
          field.type === "safety_factor" &&
          field.location === "node" &&
          field.surfaceMeshRef === surfaceMesh?.id &&
          field.frameIndex === displacementField.frameIndex
      );
      if (!hasFrameSafetyFactor) {
        errors.push(
          issue(
            "missing-required-result-field",
            `Dynamic Core displacement frame ${displacementField.frameIndex} requires a matching node safety_factor field on the solver surface mesh.`,
            "fields"
          )
        );
      }
    }
  }

  const stressFields = result.fields.filter((field) => field.type === "stress" && field.location === "node" && field.surfaceMeshRef === surfaceMesh?.id);
  for (const stressField of stressFields) {
    const displacementField = result.fields.find(
      (field) =>
        field.type === "displacement" &&
        field.location === "node" &&
        field.surfaceMeshRef === surfaceMesh?.id &&
        field.frameIndex === stressField.frameIndex &&
        field.timeSeconds === stressField.timeSeconds
    );
    if (!displacementField) {
      errors.push(issue("missing-required-result-field", "Dynamic Core stress fields must have a matching displacement field on the same solver surface frame.", "fields"));
      continue;
    }
    errors.push(
      ...validateProductionSurfaceFieldInvariant(
        {
          surfaceMesh,
          fields: [stressField, displacementField]
        },
        {
          stressFieldId: stressField.id,
          displacementFieldId: displacementField.id
        }
      ).errors
    );
  }
}

function validateTransientSurfaceNodeField(
  field: CoreResultField,
  surfaceMesh: SolverSurfaceMesh | undefined,
  errors: CoreResultValidationIssue[]
): void {
  const path = `fields.${field.id}`;
  if (!surfaceMesh) return;
  if (field.surfaceMeshRef !== surfaceMesh.id) {
    errors.push(issue("missing-surface-mesh-reference", "Dynamic solver-surface node fields must reference the solver surface mesh.", `${path}.surfaceMeshRef`));
  }
  if (field.values.length !== surfaceMesh.nodes.length) {
    errors.push(issue("surface-field-length-mismatch", "Dynamic solver-surface node field length must match surface node count.", `${path}.values`));
  }
  if (field.samples !== undefined && field.samples.length !== surfaceMesh.nodes.length) {
    errors.push(issue("surface-field-sample-length-mismatch", "Dynamic solver-surface node field samples must align one-to-one with surface nodes.", `${path}.samples`));
  }
  if (field.vectors !== undefined && field.vectors.length !== surfaceMesh.nodes.length) {
    errors.push(issue("surface-field-vector-length-mismatch", "Dynamic solver-surface node field vectors must align one-to-one with surface nodes.", `${path}.vectors`));
  }
}

function requireField(
  fields: Map<string, CoreResultField>,
  id: string,
  type: CoreResultField["type"],
  location: CoreResultField["location"],
  errors: CoreResultValidationIssue[]
): void {
  const field = fields.get(id);
  if (!field) {
    errors.push(issue("missing-required-result-field", `Production Core result field ${id} is required.`, "fields"));
    return;
  }
  if (field.type !== type || field.location !== location) {
    errors.push(issue("required-result-field-shape-mismatch", `Production Core result field ${id} has the wrong type or location.`, `fields.${id}`));
  }
}

function validateProductionSurfaceField(
  field: CoreResultField,
  expectedType: CoreResultField["type"],
  expectedId: string,
  surfaceMesh: SolverSurfaceMesh | undefined,
  path: string,
  errors: CoreResultValidationIssue[]
): void {
  if (field.id !== expectedId) {
    errors.push(issue("required-result-field-shape-mismatch", `Production Core result field ${expectedId} has the wrong id.`, `${path}.id`));
  }
  if (field.type !== expectedType) {
    errors.push(issue("required-result-field-shape-mismatch", `Production Core result field ${expectedId} has the wrong type.`, `${path}.type`));
  }
  if (field.location !== "node") {
    errors.push(issue("surface-field-location-mismatch", "Surface mesh fields must be node fields.", `${path}.location`));
  }
  if (!surfaceMesh) return;
  if (field.surfaceMeshRef !== surfaceMesh.id) {
    errors.push(issue("missing-surface-mesh-reference", "Core result field surfaceMeshRef must reference the solver surface mesh.", `${path}.surfaceMeshRef`));
  }
  if (field.values.length !== surfaceMesh.nodes.length) {
    errors.push(issue("surface-field-length-mismatch", "Solver surface field length does not match surface node count.", `${path}.values`));
  }
  if (field.samples !== undefined && field.samples.length !== surfaceMesh.nodes.length) {
    errors.push(issue("surface-field-sample-length-mismatch", "Surface mesh field samples must align one-to-one with surface nodes.", `${path}.samples`));
  }
  if (field.vectors !== undefined && field.vectors.length !== surfaceMesh.nodes.length) {
    errors.push(issue("surface-field-vector-length-mismatch", "Surface mesh field vectors must align one-to-one with surface nodes.", `${path}.vectors`));
  }
}

function validateRequiredDiagnostics(result: CoreSolveResult, errors: CoreResultValidationIssue[]): void {
  const diagnostic = result.diagnostics.find(
    (candidate): candidate is { id: "core-solve-diagnostics"; fieldSurfaceAlignment?: unknown; stressFieldValueCount?: unknown; displacementFieldValueCount?: unknown; surfaceNodeCount?: unknown } =>
      !!candidate &&
      typeof candidate === "object" &&
      (candidate as { id?: unknown }).id === "core-solve-diagnostics"
  );
  if (!diagnostic) {
    errors.push(issue("missing-core-solve-diagnostics", "Production Core results must include core-solve-diagnostics.", "diagnostics"));
    return;
  }
  if (diagnostic.fieldSurfaceAlignment !== "ok") {
    errors.push(issue("invalid-field-surface-alignment", "Core solve diagnostics must report ok field surface alignment.", "diagnostics.core-solve-diagnostics.fieldSurfaceAlignment"));
  }
  const surfaceNodeCount = result.surfaceMesh?.nodes.length;
  if (
    surfaceNodeCount !== undefined &&
    (diagnostic.surfaceNodeCount !== surfaceNodeCount ||
      diagnostic.stressFieldValueCount !== surfaceNodeCount ||
      diagnostic.displacementFieldValueCount !== surfaceNodeCount)
  ) {
    errors.push(issue("diagnostic-surface-field-count-mismatch", "Core solve diagnostics must match solver surface field counts.", "diagnostics.core-solve-diagnostics"));
  }
}

function validateProvenance(provenance: CoreSolveProvenance, errors: CoreResultValidationIssue[]): void {
  if (provenance.kind !== "opencae_core_fea") {
    errors.push(issue("invalid-provenance", "Core result provenance kind must be opencae_core_fea.", "provenance.kind"));
  }
  if (provenance.resultSource !== "computed") {
    errors.push(issue("invalid-provenance", "Production Core result provenance must be computed.", "provenance.resultSource"));
  }
  if (
    provenance.solver !== "opencae-core-cloud" &&
    provenance.solver !== "opencae-core-sparse-tet" &&
    provenance.solver !== "opencae-core-mdof-tet"
  ) {
    errors.push(issue("invalid-provenance", "Production Core result solver must be an OpenCAE Core solver.", "provenance.solver"));
  }
  if (provenance.meshSource !== "actual_volume_mesh" && provenance.meshSource !== "structured_block_core") {
    errors.push(issue("invalid-provenance", "Production Core result meshSource must be actual Core mesh data.", "provenance.meshSource"));
  }
  if (provenance.units !== "mm-N-s-MPa") {
    errors.push(issue("invalid-provenance-units", "Production Core result provenance units must be mm-N-s-MPa.", "provenance.units"));
  }
}

function collectSurfaceFacets(model: OpenCAEModelJson | NormalizedOpenCAEModel): SurfaceFacetJson[] {
  // model.surfaceFacets is a boundary-condition selection artifact and may cover only the
  // tagged faces (Gmsh writes 2D elements solely for physical groups), so the render skin
  // must be derived from the volume connectivity: faces owned by exactly one element.
  const boundary = extractBoundarySurfaceFacets({
    nodes: {
      coordinates: Array.from(model.nodes.coordinates)
    },
    elementBlocks: model.elementBlocks.map((block) => ({
      name: block.name,
      type: block.type,
      material: block.material,
      connectivity: Array.from(block.connectivity)
    })) as ElementBlockJson[]
  });
  if (boundary.length > 0) return boundary;

  return (model.surfaceFacets ?? []).map((facet) => ({
    ...facet,
    nodes: Array.from(facet.nodes)
  })) as SurfaceFacetJson[];
}

function validateSummary(summary: CoreSolveSummary, errors: CoreResultValidationIssue[]): void {
  if (!Number.isFinite(summary.maxStress)) {
    errors.push(issue("non-finite-summary", "Summary maxStress must be finite.", "summary.maxStress"));
  }
  if (summary.maxStressUnits !== "MPa") {
    errors.push(issue("missing-summary-units", "Summary maxStressUnits must be MPa.", "summary.maxStressUnits"));
  }
  if (!Number.isFinite(summary.maxDisplacement)) {
    errors.push(issue("non-finite-summary", "Summary maxDisplacement must be finite.", "summary.maxDisplacement"));
  }
  if (summary.maxDisplacementUnits !== "mm") {
    errors.push(issue("missing-summary-units", "Summary maxDisplacementUnits must be mm.", "summary.maxDisplacementUnits"));
  }
  if (summary.safetyFactor !== undefined && !Number.isFinite(summary.safetyFactor)) {
    errors.push(issue("non-finite-summary", "Summary safetyFactor must be finite when present.", "summary.safetyFactor"));
  }
  if (!Number.isFinite(summary.reactionForce)) {
    errors.push(issue("non-finite-summary", "Summary reactionForce must be finite.", "summary.reactionForce"));
  }
  if (summary.reactionForceUnits !== "N") {
    errors.push(issue("missing-summary-units", "Summary reactionForceUnits must be N.", "summary.reactionForceUnits"));
  }
  if (!summary.provenance) {
    errors.push(issue("missing-summary-provenance", "Summary provenance must be present.", "summary.provenance"));
  } else {
    validateProvenance(summary.provenance, errors);
  }
}

function validateField(
  field: CoreResultField,
  index: number,
  surfaceMesh: SolverSurfaceMesh | undefined,
  errors: CoreResultValidationIssue[]
): void {
  const path = `fields[${index}]`;
  if (!Array.isArray(field.values) || field.values.length === 0) {
    errors.push(issue("empty-field-values", "Core result field values must be non-empty.", `${path}.values`));
  }
  field.values.forEach((value, valueIndex) => {
    if (!Number.isFinite(value)) {
      errors.push(issue("non-finite-field-value", "Core result field values must be finite.", `${path}.values[${valueIndex}]`));
    }
  });
  if (field.vectors !== undefined) {
    field.vectors.forEach((vector, vectorIndex) => {
      for (let component = 0; component < 3; component += 1) {
        if (!Number.isFinite(vector[component])) {
          errors.push(issue("non-finite-field-vector", "Core result field vectors must be finite.", `${path}.vectors[${vectorIndex}]`));
        }
      }
    });
  }
  if (!Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min > field.max) {
    errors.push(issue("invalid-field-range", "Core result field min/max must be finite and ordered.", path));
  }
  if (typeof field.units !== "string" || field.units.length === 0) {
    errors.push(issue("missing-field-units", "Core result field units must be present.", `${path}.units`));
  }
  if (field.values.length > 0 && field.values.every(Number.isFinite)) {
    const actualMin = Math.min(...field.values);
    const actualMax = Math.max(...field.values);
    if (field.min > actualMin + 1e-12 || field.max < actualMax - 1e-12) {
      errors.push(issue("invalid-field-range", "Core result field min/max must enclose field values.", path));
    }
  }
  if (requiresFrameMetadata(field) && (!Number.isInteger(field.frameIndex) || !Number.isFinite(field.timeSeconds))) {
    errors.push(issue("missing-frame-metadata", "Dynamic Core result fields must include frameIndex and timeSeconds.", path));
  }
  if (field.surfaceMeshRef !== undefined) {
    if (!surfaceMesh || field.surfaceMeshRef !== surfaceMesh.id) {
      errors.push(issue("missing-surface-mesh-reference", "Core result field surfaceMeshRef must reference the result surface mesh.", `${path}.surfaceMeshRef`));
    } else {
      if (field.location !== "node") {
        errors.push(issue("surface-field-location-mismatch", "Surface mesh fields must be node fields.", `${path}.location`));
      }
      if (field.values.length !== surfaceMesh.nodes.length) {
        errors.push(issue("surface-field-length-mismatch", "Solver surface field length does not match surface mesh node count.", `${path}.values`));
      }
      if (field.samples !== undefined && field.samples.length !== surfaceMesh.nodes.length) {
        errors.push(issue("surface-field-sample-length-mismatch", "Surface mesh field samples must align one-to-one with surface nodes.", `${path}.samples`));
      }
      if (field.vectors !== undefined && field.vectors.length !== surfaceMesh.nodes.length) {
        errors.push(issue("surface-field-vector-length-mismatch", "Surface mesh field vectors must align one-to-one with surface nodes.", `${path}.vectors`));
      }
    }
  }
}

function validateSurfaceMesh(surfaceMesh: SolverSurfaceMesh, errors: CoreResultValidationIssue[]): void {
  if (!Array.isArray(surfaceMesh.nodes) || surfaceMesh.nodes.length === 0) {
    errors.push(issue("empty-surface-mesh-nodes", "Surface mesh must include at least one node.", "surfaceMesh.nodes"));
  }
  if (!Array.isArray(surfaceMesh.triangles) || surfaceMesh.triangles.length === 0) {
    errors.push(issue("empty-surface-mesh-triangles", "Surface mesh must include at least one triangle.", "surfaceMesh.triangles"));
  }
  surfaceMesh.nodes.forEach((node, nodeIndex) => {
    for (let component = 0; component < 3; component += 1) {
      if (!Number.isFinite(node[component])) {
        errors.push(issue("non-finite-surface-node", "Surface mesh node coordinates must be finite.", `surfaceMesh.nodes[${nodeIndex}]`));
      }
    }
  });
  surfaceMesh.triangles.forEach((triangle, triangleIndex) => {
    for (const node of triangle) {
      if (!Number.isInteger(node) || node < 0 || node >= surfaceMesh.nodes.length) {
        errors.push(
          issue(
            "invalid-surface-triangle-node",
            "Surface mesh triangle references a missing surface node.",
            `surfaceMesh.triangles[${triangleIndex}]`
          )
        );
      }
    }
  });
  if (!Array.isArray(surfaceMesh.nodeMap)) {
    errors.push(issue("invalid-surface-node-map", "Surface mesh nodeMap must be present.", "surfaceMesh.nodeMap"));
    return;
  }
  if (surfaceMesh.nodeMap.length !== surfaceMesh.nodes.length) {
    errors.push(issue("invalid-surface-node-map", "Surface mesh nodeMap must align one-to-one with surface nodes.", "surfaceMesh.nodeMap"));
  }
  surfaceMesh.nodeMap.forEach((volumeNode, index) => {
    if (!Number.isInteger(volumeNode) || volumeNode < 0) {
      errors.push(issue("invalid-surface-node-map", "Surface mesh nodeMap entries must be non-negative node ids.", `surfaceMesh.nodeMap[${index}]`));
    } else if (surfaceMesh.volumeNodeCount !== undefined && volumeNode >= surfaceMesh.volumeNodeCount) {
      errors.push(issue("invalid-surface-node-map", "Surface mesh nodeMap entries must reference existing volume nodes.", `surfaceMesh.nodeMap[${index}]`));
    }
  });
}

function surfaceNodeCoordinates(
  coordinates: ArrayLike<number>,
  volumeNode: number,
  volumeNodeCount: number
): [number, number, number] {
  if (!Number.isInteger(volumeNode) || volumeNode < 0 || volumeNode >= volumeNodeCount) {
    throw new Error(`Surface mesh facet references invalid volume node ${volumeNode}.`);
  }
  const offset = volumeNode * 3;
  const point: [number, number, number] = [
    coordinates[offset],
    coordinates[offset + 1],
    coordinates[offset + 2]
  ];
  if (!point.every(Number.isFinite)) {
    throw new Error(`Surface mesh facet references non-finite coordinates for volume node ${volumeNode}.`);
  }
  return point;
}

function assertValidSurfaceMesh(surfaceMesh: SolverSurfaceMesh): void {
  if (surfaceMesh.nodeMap.length !== surfaceMesh.nodes.length) {
    throw new Error("Surface mesh nodeMap must align one-to-one with surface nodes.");
  }
  const volumeNodeCount = surfaceMesh.volumeNodeCount ?? Number.POSITIVE_INFINITY;
  for (let index = 0; index < surfaceMesh.nodeMap.length; index += 1) {
    const volumeNode = surfaceMesh.nodeMap[index];
    if (!Number.isInteger(volumeNode) || volumeNode < 0 || volumeNode >= volumeNodeCount) {
      throw new Error(`Surface mesh nodeMap entry ${index} references invalid volume node ${volumeNode}.`);
    }
  }
  for (let triangleIndex = 0; triangleIndex < surfaceMesh.triangles.length; triangleIndex += 1) {
    for (const surfaceNode of surfaceMesh.triangles[triangleIndex]) {
      if (!Number.isInteger(surfaceNode) || surfaceNode < 0 || surfaceNode >= surfaceMesh.nodes.length) {
        throw new Error(`Surface mesh triangle ${triangleIndex} references invalid surface node ${surfaceNode}.`);
      }
    }
  }
}

function requiresFrameMetadata(field: CoreResultField): boolean {
  return (
    field.type === "velocity" ||
    field.type === "acceleration" ||
    field.frameIndex !== undefined ||
    field.timeSeconds !== undefined
  );
}

function issue(code: string, message: string, path: string): CoreResultValidationIssue {
  return { code, message, path };
}
