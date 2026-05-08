import type { OpenCAEModelJson } from "@opencae/core";
import {
  solveDynamicTet4Cpu,
  solveStaticLinearTet4Cpu,
  type DynamicLoadProfile,
  type DynamicTet4CpuFrame,
  type StaticLinearTet4CpuResult
} from "@opencae/solver-cpu";
import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import {
  assessResultFailure,
  type DisplayModel,
  type DynamicSolverSettings,
  type ResultField,
  type ResultProvenance,
  type ResultSample,
  type ResultSummary,
  type Study
} from "@opencae/schema";
import { inferCriticalPrintAxis } from "@opencae/study-core";

type Vec3 = [number, number, number];

export type LocalSolveResult = {
  summary: ResultSummary;
  fields: ResultField[];
};

export type NormalizedBrowserSolverBackend = "local_detailed" | "opencae_core";

export type OpenCaeCoreEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export type OpenCaeCoreSolveOutcome =
  | { ok: true; result: LocalSolveResult; solverBackend: "opencae-core-cpu-tet4" | "opencae-core-dynamic-tet4" }
  | { ok: false; reason: string };

const STANDARD_GRAVITY = 9.80665;
const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;

const OPENCAE_CORE_STATIC_PROVENANCE: ResultProvenance = {
  kind: "opencae_core_fea",
  solver: "opencae-core-cpu-tet4",
  solverVersion: "0.1.0",
  meshSource: "opencae_core_tet4",
  resultSource: "computed",
  units: "m-N-s-Pa"
};

const OPENCAE_CORE_DYNAMIC_PROVENANCE: ResultProvenance = {
  ...OPENCAE_CORE_STATIC_PROVENANCE,
  solver: "opencae-core-dynamic-tet4",
  integrationMethod: "newmark_average_acceleration"
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
  const material = materialForStudy(study).material;
  const force = totalForceVector(study, displayModel, material.density);
  if (Math.hypot(...force) <= 1e-12) {
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
    if (study.type === "dynamic_structural") {
      const material = materialForStudy(study).material;
      const settings = dynamicSettingsForStudy(study);
      const solved = solveDynamicTet4Cpu(model, {
        maxDofs: 300,
        startTime: settings.startTime,
        endTime: settings.endTime,
        timeStep: settings.timeStep,
        outputInterval: settings.outputInterval,
        dampingRatio: settings.dampingRatio,
        loadProfile: dynamicLoadProfileForCore(settings.loadProfile),
        massDensity: material.density
      });
      if (!solved.ok) return { ok: false, reason: `OpenCAE Core solve failed: ${solved.error.message}` };
      return {
        ok: true,
        solverBackend: "opencae-core-dynamic-tet4",
        result: dynamicResultBundleForOpenCaeCore(runId, model, solved.result.frames, study, settings)
      };
    }

    const solved = solveStaticLinearTet4Cpu(model, { maxDofs: 300 });
    if (!solved.ok) return { ok: false, reason: `OpenCAE Core solve failed: ${solved.error.message}` };
    return {
      ok: true,
      solverBackend: "opencae-core-cpu-tet4",
      result: resultBundleForOpenCaeCore(runId, model, solved.result, study, OPENCAE_CORE_STATIC_PROVENANCE)
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
  const force = totalForceVector(study, displayModel, effective.density ?? material.material.density);

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
  result: Pick<StaticLinearTet4CpuResult, "displacement" | "reactionForce" | "vonMises">,
  study: Study,
  provenance: ResultProvenance
): LocalSolveResult {
  const stressFrame = stressFieldForOpenCaeCore(runId, model, result.vonMises, study, provenance);
  const displacementFrame = vectorFieldForOpenCaeCore(runId, "displacement", model, result.displacement, "mm", 1000, 6, provenance);
  const safetyFrame = safetyFieldForOpenCaeCore(runId, stressFrame, study, provenance);
  const summaryBase = {
    maxStress: stressFrame.max,
    maxStressUnits: "MPa",
    maxDisplacement: displacementFrame.max,
    maxDisplacementUnits: "mm",
    safetyFactor: safetyFrame.min,
    reactionForce: round(vectorMagnitudes(result.reactionForce).reduce((sum, value) => sum + value, 0), 6),
    reactionForceUnits: "N"
  };
  return {
    summary: {
      ...summaryBase,
      failureAssessment: assessResultFailure(summaryBase),
      provenance
    },
    fields: [stressFrame, displacementFrame, safetyFrame]
  };
}

function dynamicResultBundleForOpenCaeCore(
  runId: string,
  model: OpenCAEModelJson,
  frames: DynamicTet4CpuFrame[],
  study: Study,
  settings: DynamicSolverSettings
): LocalSolveResult {
  const fields: ResultField[] = [];
  let peakDisplacement = 0;
  let peakDisplacementTimeSeconds = settings.startTime;
  let peakStress = 0;
  let minSafetyFactor = Number.POSITIVE_INFINITY;

  for (const frame of frames) {
    const stressFrame = withFrame(stressFieldForOpenCaeCore(runId, model, frame.vonMises, study, OPENCAE_CORE_DYNAMIC_PROVENANCE), frame.index, frame.time);
    const displacementFrame = withFrame(vectorFieldForOpenCaeCore(runId, "displacement", model, frame.displacement, "mm", 1000, 8, OPENCAE_CORE_DYNAMIC_PROVENANCE), frame.index, frame.time);
    const velocityFrame = withFrame(vectorFieldForOpenCaeCore(runId, "velocity", model, frame.velocity, "mm/s", 1000, 8, OPENCAE_CORE_DYNAMIC_PROVENANCE), frame.index, frame.time);
    const accelerationFrame = withFrame(vectorFieldForOpenCaeCore(runId, "acceleration", model, frame.acceleration, "mm/s^2", 1000, 8, OPENCAE_CORE_DYNAMIC_PROVENANCE), frame.index, frame.time);
    const safetyFrame = withFrame(safetyFieldForOpenCaeCore(runId, stressFrame, study, OPENCAE_CORE_DYNAMIC_PROVENANCE), frame.index, frame.time);
    fields.push(stressFrame, displacementFrame, velocityFrame, accelerationFrame, safetyFrame);

    const framePeakDisplacement = resultFieldAbsMax(displacementFrame);
    if (framePeakDisplacement > peakDisplacement) {
      peakDisplacement = framePeakDisplacement;
      peakDisplacementTimeSeconds = frame.time;
    }
    peakStress = Math.max(peakStress, stressFrame.max);
    minSafetyFactor = Math.min(minSafetyFactor, safetyFrame.min);
  }

  stabilizeDynamicFieldRanges(fields);
  const summaryBase = {
    maxStress: round(peakStress, 1),
    maxStressUnits: "MPa",
    maxDisplacement: round(peakDisplacement, 8),
    maxDisplacementUnits: "mm",
    safetyFactor: round(Number.isFinite(minSafetyFactor) ? minSafetyFactor : 0, 2),
    reactionForce: 0,
    reactionForceUnits: "N",
    transient: {
      analysisType: "dynamic_structural" as const,
      integrationMethod: settings.integrationMethod,
      startTime: settings.startTime,
      endTime: settings.endTime,
      timeStep: settings.timeStep,
      outputInterval: settings.outputInterval,
      dampingRatio: settings.dampingRatio,
      frameCount: frames.length,
      peakDisplacementTimeSeconds: round(peakDisplacementTimeSeconds, 6),
      peakDisplacement: round(peakDisplacement, 8)
    }
  };
  return {
    summary: {
      ...summaryBase,
      failureAssessment: assessResultFailure(summaryBase),
      provenance: OPENCAE_CORE_DYNAMIC_PROVENANCE
    },
    fields
  };
}

function stressFieldForOpenCaeCore(
  runId: string,
  model: OpenCAEModelJson,
  vonMises: Float64Array,
  study: Study,
  provenance: ResultProvenance
): ResultField {
  const values = Array.from(vonMises, (value) => round(Math.abs(value) / 1_000_000, 6));
  const samples = values.map((value, element) => ({
    point: elementCentroid(model, element),
    normal: [0, 0, 1] as Vec3,
    value,
    elementId: `E${element}`,
    source: "opencae_core",
    vonMisesStressPa: round(value * 1_000_000, 3)
  }));
  return fieldFor(runId, "stress", "element", values, "MPa", samples, provenance);
}

function vectorFieldForOpenCaeCore(
  runId: string,
  type: ResultField["type"],
  model: OpenCAEModelJson,
  vectors: Float64Array,
  units: string,
  unitScale: number,
  digits: number,
  provenance: ResultProvenance
): ResultField {
  const nodePoints = pointsFromCoordinates(model.nodes.coordinates);
  const samples = nodePoints.map((point, node) => {
    const vector = vectorForNode(vectors, node, unitScale, digits);
    return {
      point,
      normal: [0, 0, 1] as Vec3,
      value: round(Math.hypot(...vector), digits),
      vector,
      nodeId: `N${node}`,
      source: "opencae_core"
    };
  });
  return fieldFor(runId, type, "node", samples.map((sample) => sample.value), units, samples, provenance);
}

function safetyFieldForOpenCaeCore(runId: string, stressFrame: ResultField, study: Study, provenance: ResultProvenance): ResultField {
  const material = materialForStudy(study).material;
  const yieldMpa = Math.max(material.yieldStrength / 1_000_000, 1e-9);
  const values = stressFrame.values.map((stress) => round(Math.max(0.05, yieldMpa / Math.max(stress, 1e-9)), 4));
  const samples = stressFrame.samples?.map((sample, index) => ({
    ...sample,
    value: values[index] ?? 0,
    vonMisesStressPa: undefined
  })) ?? [];
  return fieldFor(runId, "safety_factor", "element", values, "", samples, provenance);
}

function fieldFor(
  runId: string,
  type: ResultField["type"],
  location: ResultField["location"],
  values: number[],
  units: string,
  samples: NonNullable<ResultField["samples"]>,
  provenance: ResultProvenance
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
    provenance
  };
}

function withFrame(field: ResultField, frameIndex: number, timeSeconds: number): ResultField {
  return {
    ...field,
    id: `field-${field.type}-${field.runId}-frame-${frameIndex}`,
    frameIndex,
    timeSeconds
  };
}

function dynamicSettingsForStudy(study: Study): DynamicSolverSettings {
  const raw = study.solverSettings as Partial<DynamicSolverSettings>;
  const timeStep = finiteOr(raw.timeStep, DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS);
  return {
    backend: "opencae_core",
    fidelity: raw.fidelity ?? "standard",
    startTime: finiteOr(raw.startTime, 0),
    endTime: finiteOr(raw.endTime, 0.1),
    timeStep,
    outputInterval: Math.max(finiteOr(raw.outputInterval, DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS), timeStep, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS),
    dampingRatio: finiteOr(raw.dampingRatio, 0.02),
    integrationMethod: "newmark_average_acceleration",
    loadProfile: isDynamicLoadProfile(raw.loadProfile) ? raw.loadProfile : "ramp",
    ...(raw.allowFreeMotion === true ? { allowFreeMotion: true } : {})
  };
}

function dynamicLoadProfileForCore(value: DynamicSolverSettings["loadProfile"]): DynamicLoadProfile {
  return value === "quasi_static" ? "quasiStatic" : value;
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

function totalForceVector(study: Study, displayModel: DisplayModel, densityKgM3: number): Vec3 {
  const dimensions = displayModel.dimensions;
  if (!dimensions) throw new Error("OpenCAE Core requires display dimensions.");
  const force: Vec3 = [0, 0, 0];
  for (const load of study.loads) {
    const direction = normalize(vector3(load.parameters.direction) ?? [0, 0, -1]);
    const value = Number(load.parameters.value);
    if (!direction || !Number.isFinite(value) || value <= 0) continue;
    const magnitude = load.type === "pressure"
      ? value * 1000 * projectedAreaM2(dimensions, direction)
      : load.type === "gravity"
        ? gravityMassKg(value, displayModel, densityKgM3) * STANDARD_GRAVITY
        : value;
    force[0] += direction[0] * magnitude;
    force[1] += direction[1] * magnitude;
    force[2] += direction[2] * magnitude;
  }
  return force;
}

function projectedAreaM2(dimensions: NonNullable<DisplayModel["dimensions"]>, direction: Vec3): number {
  const [x, y, z] = dimensionMeters(dimensions);
  const ax = Math.abs(direction[0]);
  const ay = Math.abs(direction[1]);
  const az = Math.abs(direction[2]);
  if (ax >= ay && ax >= az) return Math.max(y * z, 1e-8);
  if (ay >= az) return Math.max(x * z, 1e-8);
  return Math.max(x * y, 1e-8);
}

function gravityMassKg(value: number, displayModel: DisplayModel, densityKgM3: number): number {
  if (value > 0) return value;
  return equivalentMassKg(densityKgM3, displayModel);
}

function equivalentMassKg(densityKgM3: number, displayModel: DisplayModel): number {
  const [x, y, z] = dimensionMeters(displayModel.dimensions!);
  return Math.max(densityKgM3 * x * y * z, 0.05);
}

function dimensionMeters(dimensions: NonNullable<DisplayModel["dimensions"]>): Vec3 {
  const scale = dimensions.units === "mm" ? 0.001 : 1;
  return [dimensions.x * scale, dimensions.y * scale, dimensions.z * scale];
}

function tetNodesForDimensions(dimensions: NonNullable<DisplayModel["dimensions"]>): Vec3[] {
  const [x, y, z] = dimensionMeters(dimensions);
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

function vectorForNode(values: Float64Array, node: number, unitScale: number, digits: number): Vec3 {
  return [
    round((values[node * 3] ?? 0) * unitScale, digits),
    round((values[node * 3 + 1] ?? 0) * unitScale, digits),
    round((values[node * 3 + 2] ?? 0) * unitScale, digits)
  ];
}

function resultFieldAbsMax(field: ResultField): number {
  return Math.max(...[
    ...field.values,
    ...(field.samples?.map((sample) => sample.value) ?? [])
  ].map((value) => Math.abs(value)).filter(Number.isFinite), 0);
}

function stabilizeDynamicFieldRanges(fields: ResultField[]): void {
  const fieldTypes = [...new Set(fields.map((field) => field.type))];
  for (const type of fieldTypes) {
    const matchingFields = fields.filter((field) => field.type === type);
    const values = matchingFields.flatMap((field) => [
      ...field.values,
      ...(field.samples?.map((sample) => sample.value) ?? [])
    ]).filter(Number.isFinite);
    if (!values.length) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    for (const field of matchingFields) {
      field.min = round(min, dynamicRangeDigits(type));
      field.max = round(max, dynamicRangeDigits(type));
    }
  }
}

function dynamicRangeDigits(type: ResultField["type"]): number {
  if (type === "stress") return 1;
  if (type === "displacement" || type === "velocity" || type === "acceleration") return 8;
  return 3;
}

function positiveDimensions(dimensions: DisplayModel["dimensions"]): boolean {
  return Boolean(dimensions && finitePositive(dimensions.x) && finitePositive(dimensions.y) && finitePositive(dimensions.z));
}

function finitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function isDynamicLoadProfile(value: unknown): value is DynamicSolverSettings["loadProfile"] {
  return value === "ramp" || value === "step" || value === "quasi_static" || value === "sinusoidal";
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
