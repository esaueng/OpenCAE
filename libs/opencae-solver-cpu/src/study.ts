import type { OpenCAEModelJson } from "@opencae/core";
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
import { solveStaticLinearTet4Cpu } from "./solver";

type Vec3 = [number, number, number];

export type OpenCaeCoreEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export type OpenCaeCoreStudySolveResult = {
  summary: ResultSummary;
  fields: ResultField[];
};

export type OpenCaeCoreStudySolveOutcome =
  | { ok: true; result: OpenCaeCoreStudySolveResult; solverBackend: "opencae-core-cpu-tet4" | "opencae-core-dynamic-tet4" }
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

export function normalizeSolverBackend(value: { solverSettings?: { backend?: unknown } } | Study | undefined): "opencae_core" {
  void value;
  return "opencae_core";
}

export function openCaeCoreEligibility(study: Study, displayModel?: DisplayModel): OpenCaeCoreEligibility {
  if (study.meshSettings.status !== "complete") return { ok: false, reason: "OpenCAE Core requires a completed mesh step." };
  if (!displayModel?.dimensions || !positiveDimensions(displayModel.dimensions)) {
    return { ok: false, reason: "OpenCAE Core requires usable block-like display dimensions." };
  }
  if (!study.materialAssignments.length) return { ok: false, reason: "OpenCAE Core requires an assigned material." };
  if (!study.constraints.some((constraint) => constraint.type === "fixed")) {
    return { ok: false, reason: "OpenCAE Core requires at least one fixed support." };
  }
  if (!study.loads.length) return { ok: false, reason: "OpenCAE Core requires at least one load." };
  const material = materialForStudy(study).material;
  const force = totalForceVector(study, displayModel, material.density);
  if (Math.hypot(...force) <= 1e-12) {
    return { ok: false, reason: "OpenCAE Core requires a finite nonzero load direction and value." };
  }
  return { ok: true };
}

export function solveOpenCaeCoreStudy({ study, runId, displayModel }: {
  study: Study;
  runId: string;
  displayModel?: DisplayModel;
}): OpenCaeCoreStudySolveOutcome {
  const eligibility = openCaeCoreEligibility(study, displayModel);
  if (!eligibility.ok) return eligibility;

  try {
    const model = openCaeCoreModelForStudy(study, displayModel);
    const solved = solveStaticLinearTet4Cpu(model, { maxDofs: 300 });
    if (!solved.ok) return { ok: false, reason: `OpenCAE Core solve failed: ${solved.error.message}` };
    const staticResult = resultBundleForOpenCaeCore(runId, model, solved.result, study, OPENCAE_CORE_STATIC_PROVENANCE);
    if (study.type === "dynamic_structural") {
      return {
        ok: true,
        solverBackend: "opencae-core-dynamic-tet4",
        result: dynamicResultBundleForOpenCaeCore(runId, study, displayModel!, staticResult)
      };
    }
    return {
      ok: true,
      solverBackend: "opencae-core-cpu-tet4",
      result: staticResult
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
  result: {
    displacement: Float64Array;
    reactionForce: Float64Array;
    vonMises: Float64Array;
  },
  study: Study,
  provenance: ResultProvenance
): OpenCaeCoreStudySolveResult {
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
    fieldFor(runId, "stress", "element", stressValuesMpa, "MPa", stressSamples, provenance),
    fieldFor(runId, "displacement", "node", displacementValuesMm, "mm", displacementSamples, provenance),
    fieldFor(runId, "safety_factor", "element", safetyValues, "", safetySamples, provenance)
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
    provenance
  };
  return { summary, fields };
}

function dynamicResultBundleForOpenCaeCore(
  runId: string,
  study: Study,
  displayModel: DisplayModel,
  staticResult: OpenCaeCoreStudySolveResult
): OpenCaeCoreStudySolveResult {
  const settings = dynamicSettingsForStudy(study);
  const staticStress = staticResult.fields.find((field) => field.type === "stress");
  const staticDisplacement = staticResult.fields.find((field) => field.type === "displacement");
  const material = materialForStudy(study).material;
  const force = Math.max(staticResult.summary.reactionForce, 0.001);
  const staticDisplacementMeters = Math.max(staticResult.summary.maxDisplacement / 1000, 1e-6);
  const massKg = equivalentMassKg(material.density, displayModel);
  const stiffnessNPerM = Math.max(force / staticDisplacementMeters, 1);
  const dampingNsPerM = 2 * settings.dampingRatio * Math.sqrt(stiffnessNPerM * massKg);
  const frames = integrateDynamicFrames(settings, force, massKg, stiffnessNPerM, dampingNsPerM);
  const yieldMpa = Math.max(material.yieldStrength / 1_000_000, 1e-9);
  const fields: ResultField[] = [];
  let peakDisplacement = 0;
  let peakDisplacementTimeSeconds = settings.startTime;
  let peakStress = 0;
  let minSafetyFactor = Number.POSITIVE_INFINITY;

  for (const frame of frames) {
    const displacementScale = frame.displacement / staticDisplacementMeters;
    const velocityScale = frame.velocity / staticDisplacementMeters;
    const accelerationScale = frame.acceleration / staticDisplacementMeters;
    const stressScale = Math.abs(displacementScale);
    const stressFrame = scaleBaseField(staticStress, runId, "stress", "MPa", stressScale, frame.index, frame.time, 1);
    const displacementFrame = scaleBaseField(staticDisplacement, runId, "displacement", "mm", displacementScale, frame.index, frame.time, 8);
    const velocityFrame = scaleBaseField(staticDisplacement, runId, "velocity", "mm/s", velocityScale, frame.index, frame.time, 8);
    const accelerationFrame = scaleBaseField(staticDisplacement, runId, "acceleration", "mm/s^2", accelerationScale, frame.index, frame.time, 8);
    const safetyValues = stressFrame.values.map((stress) => round(Math.max(0.05, yieldMpa / Math.max(stress, 0.001)), 2));
    const safetySamples = stressFrame.samples?.map((sample) => ({
      ...sample,
      value: round(Math.max(0.05, yieldMpa / Math.max(sample.value, 0.001)), 3),
      vonMisesStressPa: undefined
    })) ?? [];
    const safetyFrame = fieldForFrame(runId, "safety_factor", safetyValues, "", safetySamples, frame.index, frame.time);
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
    reactionForce: staticResult.summary.reactionForce,
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

function fieldForFrame(runId: string, type: ResultField["type"], values: number[], units: string, samples: ResultSample[], frameIndex: number, timeSeconds: number): ResultField {
  return {
    id: `field-${type}-${runId}-frame-${frameIndex}`,
    runId,
    type,
    location: type === "stress" || type === "safety_factor" ? "element" : "node",
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    units,
    samples,
    frameIndex,
    timeSeconds,
    provenance: OPENCAE_CORE_DYNAMIC_PROVENANCE
  };
}

function scaleBaseField(
  base: ResultField | undefined,
  runId: string,
  type: ResultField["type"],
  units: string,
  scale: number,
  frameIndex: number,
  timeSeconds: number,
  digits: number
): ResultField {
  const values = (base?.values.length ? base.values : [0]).map((value) => round(value * scale, digits));
  const samples = base?.samples?.map((sample) => ({
    ...sample,
    value: round(sample.value * scale, digits),
    ...(sample.vector ? { vector: roundVector(scaleVector(sample.vector, scale), digits) } : {})
  })) ?? [];
  return fieldForFrame(runId, type, values, units, samples, frameIndex, timeSeconds);
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

type DynamicFrame = {
  index: number;
  time: number;
  displacement: number;
  velocity: number;
  acceleration: number;
};

function integrateDynamicFrames(settings: DynamicSolverSettings, force: number, mass: number, stiffness: number, damping: number): DynamicFrame[] {
  const beta = 0.25;
  const gamma = 0.5;
  const dt = Math.max(settings.timeStep, 1e-6);
  const outputInterval = Math.max(settings.outputInterval, dt);
  const frames: DynamicFrame[] = [];
  let time = settings.startTime;
  let u = 0;
  let v = 0;
  let a = (loadScaleAt(time, settings) * force - damping * v - stiffness * u) / mass;
  let frameIndex = 0;
  let nextOutputTime = settings.startTime + outputInterval;
  const maxSteps = Math.ceil((settings.endTime - settings.startTime) / dt) + 2;
  const pushFrame = () => {
    frames.push({ index: frameIndex, time: round(time, 6), displacement: u, velocity: v, acceleration: a });
    frameIndex += 1;
  };
  pushFrame();
  for (let step = 0; step < maxSteps && time < settings.endTime - 1e-12; step += 1) {
    const nextTime = Math.min(time + dt, settings.endTime);
    const stepDt = nextTime - time;
    const a0 = 1 / (beta * stepDt * stepDt);
    const a1 = gamma / (beta * stepDt);
    const a2 = 1 / (beta * stepDt);
    const a3 = 1 / (2 * beta) - 1;
    const a4 = gamma / beta - 1;
    const a5 = stepDt * (gamma / (2 * beta) - 1);
    const effectiveStiffness = stiffness + a0 * mass + a1 * damping;
    const nextForce = loadScaleAt(nextTime, settings) * force;
    const effectiveForce = nextForce + mass * (a0 * u + a2 * v + a3 * a) + damping * (a1 * u + a4 * v + a5 * a);
    const nextU = effectiveForce / effectiveStiffness;
    const nextA = a0 * (nextU - u) - a2 * v - a3 * a;
    const nextV = v + stepDt * ((1 - gamma) * a + gamma * nextA);
    time = nextTime;
    u = nextU;
    v = nextV;
    a = nextA;
    if (time >= nextOutputTime - 1e-12 || time >= settings.endTime - 1e-12) {
      pushFrame();
      while (nextOutputTime <= time + 1e-12) nextOutputTime += outputInterval;
    }
  }
  return frames;
}

function loadScaleAt(time: number, settings: DynamicSolverSettings): number {
  if (settings.loadProfile === "ramp") {
    const duration = Math.max(settings.endTime - settings.startTime, settings.timeStep);
    return clamp((time - settings.startTime) / duration, 0, 1);
  }
  if (settings.loadProfile === "sinusoidal") {
    const duration = Math.max(settings.endTime - settings.startTime, settings.timeStep);
    return Math.sin(2 * Math.PI * clamp((time - settings.startTime) / duration, 0, 1));
  }
  return 1;
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

function displacementVectorMm(displacement: Float64Array, node: number): Vec3 {
  return [
    round((displacement[node * 3] ?? 0) * 1000, 6),
    round((displacement[node * 3 + 1] ?? 0) * 1000, 6),
    round((displacement[node * 3 + 2] ?? 0) * 1000, 6)
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

function scaleVector(vector: Vec3, scale: number): Vec3 {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function roundVector(vector: Vec3, decimals: number): Vec3 {
  return [round(vector[0], decimals), round(vector[1], decimals), round(vector[2], decimals)];
}

function isDynamicLoadProfile(value: unknown): value is DynamicSolverSettings["loadProfile"] {
  return value === "ramp" || value === "step" || value === "quasi_static" || value === "sinusoidal";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function max(values: number[]): number {
  return values.reduce((best, value) => Math.max(best, value), 0);
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
