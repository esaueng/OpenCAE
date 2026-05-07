import { solveStaticLinearTet4Cpu } from "@opencae/solver-cpu";
import type { OpenCAEModelJson } from "@opencae/core";
import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import { assessResultFailure, type DisplayModel, type ResultField, type ResultProvenance, type ResultSummary, type Study } from "@opencae/schema";
import { inferCriticalPrintAxis } from "@opencae/study-core";
import type { LocalSolveResult } from "./performanceProtocol";

type Vec3 = [number, number, number];

export type NormalizedBrowserSolverBackend = "local_detailed" | "opencae_core";

export type OpenCaeCoreEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export type OpenCaeCoreSolveOutcome =
  | { ok: true; result: LocalSolveResult }
  | { ok: false; reason: string };

const OPENCAE_CORE_PROVENANCE: ResultProvenance = {
  kind: "opencae_core_fea",
  solver: "opencae-core-cpu-tet4",
  solverVersion: "0.1.0",
  meshSource: "opencae_core_tet4",
  resultSource: "computed",
  units: "m-N-s-Pa"
};

export function normalizeSolverBackend(value: { solverSettings?: { backend?: unknown } } | Study | undefined): NormalizedBrowserSolverBackend {
  const backend = value?.solverSettings?.backend;
  return backend === "local_detailed" ? "local_detailed" : "opencae_core";
}

export function openCaeCoreEligibility(study: Study, displayModel?: DisplayModel): OpenCaeCoreEligibility {
  if (study.type !== "static_stress") return { ok: false, reason: "OpenCAE Core browser solve currently supports static stress studies only." };
  if (study.meshSettings.status !== "complete") return { ok: false, reason: "OpenCAE Core requires a completed mesh step." };
  if (!displayModel?.dimensions || !positiveDimensions(displayModel.dimensions)) {
    return { ok: false, reason: "OpenCAE Core requires usable block-like display dimensions." };
  }
  if (!study.materialAssignments.length) return { ok: false, reason: "OpenCAE Core requires an assigned material." };
  if (!study.constraints.some((constraint) => constraint.type === "fixed")) {
    return { ok: false, reason: "OpenCAE Core requires at least one fixed support." };
  }
  const unsupportedLoad = study.loads.find((load) => load.type !== "force");
  if (unsupportedLoad) return { ok: false, reason: `OpenCAE Core supports force loads only; ${unsupportedLoad.type} loads use Detailed local.` };
  if (!study.loads.length) return { ok: false, reason: "OpenCAE Core requires at least one force load." };
  if (!study.loads.some((load) => vector3(load.parameters.direction) && finitePositive(load.parameters.value))) {
    return { ok: false, reason: "OpenCAE Core requires a force load with a finite positive value and direction." };
  }
  return { ok: true };
}

export function trySolveOpenCaeCoreStudy({ study, runId, displayModel }: {
  study: Study;
  runId: string;
  displayModel?: DisplayModel;
}): OpenCaeCoreSolveOutcome {
  const eligibility = openCaeCoreEligibility(study, displayModel);
  if (!eligibility.ok) return eligibility;

  try {
    const model = openCaeCoreModelForStudy(study, displayModel);
    const solved = solveStaticLinearTet4Cpu(model, { maxDofs: 300 });
    if (!solved.ok) return { ok: false, reason: `OpenCAE Core solve failed: ${solved.error.message}` };
    return {
      ok: true,
      result: resultBundleForOpenCaeCore(runId, model, solved.result, study)
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "OpenCAE Core solve failed." };
  }
}

function openCaeCoreModelForStudy(study: Study, displayModel: DisplayModel | undefined): OpenCAEModelJson {
  if (!displayModel?.dimensions) throw new Error("OpenCAE Core requires display dimensions.");
  const material = materialForStudy(study);
  const effective = effectiveMaterialProperties(material.material, material.parameters, {
    criticalLayerAxis: inferCriticalPrintAxis(study, displayModel.faces)
  });
  const nodes = tetNodesForDimensions(displayModel.dimensions);
  const force = totalForceVector(study);

  return {
    schema: "opencae.model",
    schemaVersion: "0.1.0",
    nodes: { coordinates: nodes.flat() },
    materials: [{
      name: effective.id,
      type: "isotropicLinearElastic",
      youngModulus: effective.youngsModulus,
      poissonRatio: effective.poissonRatio
    }],
    elementBlocks: [{
      name: "block-tet4",
      type: "Tet4",
      material: effective.id,
      connectivity: [0, 1, 2, 3]
    }],
    nodeSets: [
      { name: "fixedNodes", nodes: [0] },
      { name: "supportYNodes", nodes: [1] },
      { name: "supportZNodes", nodes: [2] },
      { name: "loadNodes", nodes: [3] }
    ],
    elementSets: [{ name: "allElements", elements: [0] }],
    boundaryConditions: [
      { name: "fixedSupport", type: "fixed", nodeSet: "fixedNodes", components: ["x", "y", "z"] },
      { name: "supportY", type: "fixed", nodeSet: "supportYNodes", components: ["y", "z"] },
      { name: "supportZ", type: "fixed", nodeSet: "supportZNodes", components: ["z"] }
    ],
    loads: [{ name: "appliedForce", type: "nodalForce", nodeSet: "loadNodes", vector: force }],
    steps: [{
      name: "loadStep",
      type: "staticLinear",
      boundaryConditions: ["fixedSupport", "supportY", "supportZ"],
      loads: ["appliedForce"]
    }]
  };
}

function resultBundleForOpenCaeCore(
  runId: string,
  model: OpenCAEModelJson,
  result: {
    displacement: Float64Array;
    reactionForce: Float64Array;
    vonMises: Float64Array;
  },
  study: Study
): LocalSolveResult {
  const nodePoints = pointsFromCoordinates(model.nodes.coordinates);
  const displacementValuesMm = vectorMagnitudes(result.displacement).map((value) => round(value * 1000, 6));
  const stressValuesMpa = Array.from(result.vonMises, (value) => round(Math.abs(value) / 1_000_000, 6));
  const material = materialForStudy(study).material;
  const yieldMpa = Math.max(material.yieldStrength / 1_000_000, 1e-9);
  const safetyValues = stressValuesMpa.map((stress) => round(Math.max(0.05, yieldMpa / Math.max(stress, 1e-9)), 4));
  const displacementSamples = nodePoints.map((point, node) => {
    const vector = displacementVectorMm(result.displacement, node);
    return {
      point,
      normal: [0, 0, 1] as Vec3,
      value: round(Math.hypot(...vector), 6),
      vector,
      nodeId: `N${node}`,
      source: "opencae_core"
    };
  });
  const stressSamples = stressValuesMpa.map((value, element) => ({
    point: elementCentroid(model, element),
    normal: [0, 0, 1] as Vec3,
    value,
    elementId: `E${element}`,
    source: "opencae_core",
    vonMisesStressPa: round(value * 1_000_000, 3)
  }));
  const safetySamples = stressSamples.map((sample, index) => ({
    ...sample,
    value: safetyValues[index] ?? 0,
    vonMisesStressPa: undefined
  }));
  const fields: ResultField[] = [
    fieldFor(runId, "stress", "element", stressValuesMpa, "MPa", stressSamples),
    fieldFor(runId, "displacement", "node", displacementValuesMm, "mm", displacementSamples),
    fieldFor(runId, "safety_factor", "element", safetyValues, "", safetySamples)
  ];
  const maxStress = max(stressValuesMpa);
  const maxDisplacement = max(displacementValuesMm);
  const safetyFactor = Math.min(...safetyValues);
  const reactionForce = round(vectorMagnitudes(result.reactionForce).reduce((sum, value) => sum + value, 0), 6);
  const summaryBase = {
    maxStress,
    maxStressUnits: "MPa",
    maxDisplacement,
    maxDisplacementUnits: "mm",
    safetyFactor,
    reactionForce,
    reactionForceUnits: "N"
  };
  const summary: ResultSummary = {
    ...summaryBase,
    failureAssessment: assessResultFailure(summaryBase),
    provenance: OPENCAE_CORE_PROVENANCE
  };
  return { summary, fields };
}

function fieldFor(
  runId: string,
  type: ResultField["type"],
  location: ResultField["location"],
  values: number[],
  units: string,
  samples: NonNullable<ResultField["samples"]>
): ResultField {
  return {
    id: `field-${type}`,
    runId,
    type,
    location,
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    units,
    samples,
    provenance: OPENCAE_CORE_PROVENANCE
  };
}

function materialForStudy(study: Study) {
  const assignment = study.materialAssignments[0];
  const material = starterMaterials.find((candidate) => candidate.id === assignment?.materialId);
  if (!material) throw new Error("OpenCAE Core requires an assigned material.");
  return {
    material,
    parameters: assignment?.parameters ?? {}
  };
}

function totalForceVector(study: Study): Vec3 {
  const force: Vec3 = [0, 0, 0];
  for (const load of study.loads) {
    if (load.type !== "force") continue;
    const direction = normalize(vector3(load.parameters.direction));
    const magnitude = Number(load.parameters.value);
    if (!direction || !Number.isFinite(magnitude)) continue;
    force[0] += direction[0] * magnitude;
    force[1] += direction[1] * magnitude;
    force[2] += direction[2] * magnitude;
  }
  return force;
}

function tetNodesForDimensions(dimensions: NonNullable<DisplayModel["dimensions"]>): Vec3[] {
  const scale = dimensions.units === "mm" ? 0.001 : 1;
  const x = dimensions.x * scale;
  const y = dimensions.y * scale;
  const z = dimensions.z * scale;
  return [
    [0, 0, 0],
    [x, 0, 0],
    [0, y, 0],
    [x, y, z]
  ];
}

function pointsFromCoordinates(coordinates: number[]): Vec3[] {
  const points: Vec3[] = [];
  for (let index = 0; index < coordinates.length; index += 3) {
    points.push([coordinates[index] ?? 0, coordinates[index + 1] ?? 0, coordinates[index + 2] ?? 0]);
  }
  return points;
}

function elementCentroid(model: OpenCAEModelJson, elementIndex: number): Vec3 {
  const block = model.elementBlocks[0];
  const connectivity = block?.connectivity.slice(elementIndex * 4, elementIndex * 4 + 4) ?? [];
  const points = pointsFromCoordinates(model.nodes.coordinates);
  const sum: Vec3 = [0, 0, 0];
  for (const node of connectivity) {
    const point = points[node] ?? [0, 0, 0];
    sum[0] += point[0];
    sum[1] += point[1];
    sum[2] += point[2];
  }
  return [round(sum[0] / 4, 6), round(sum[1] / 4, 6), round(sum[2] / 4, 6)];
}

function vectorMagnitudes(values: Float64Array): number[] {
  const magnitudes: number[] = [];
  for (let index = 0; index < values.length; index += 3) {
    magnitudes.push(Math.hypot(values[index] ?? 0, values[index + 1] ?? 0, values[index + 2] ?? 0));
  }
  return magnitudes;
}

function displacementVectorMm(displacement: Float64Array, node: number): Vec3 {
  return [
    round((displacement[node * 3] ?? 0) * 1000, 6),
    round((displacement[node * 3 + 1] ?? 0) * 1000, 6),
    round((displacement[node * 3 + 2] ?? 0) * 1000, 6)
  ];
}

function positiveDimensions(dimensions: DisplayModel["dimensions"]): boolean {
  return Boolean(dimensions && finitePositive(dimensions.x) && finitePositive(dimensions.y) && finitePositive(dimensions.z));
}

function finitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function vector3(value: unknown): Vec3 | null {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0]!, value[1]!, value[2]!]
    : null;
}

function normalize(vector: Vec3 | null): Vec3 | null {
  if (!vector) return null;
  const length = Math.hypot(...vector);
  return length > 1e-12 ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}

function max(values: number[]): number {
  return values.reduce((best, value) => Math.max(best, value), 0);
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
