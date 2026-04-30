import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import { assessResultFailure } from "@opencae/schema";
import type { AnalysisMesh, AnalysisSample, DynamicSolverSettings, Load, Material, ResultField, ResultSample, ResultSummary, RunEvent, Study } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";
import { bracketDisplayModel, bracketResultSummary } from "@opencae/db/sample-data";
import { inferCriticalPrintAxis } from "@opencae/study-core";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STANDARD_GRAVITY = 9.80665;
const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;

export class LocalMockComputeBackend {
  constructor(private readonly storage: ObjectStorageProvider) {}

  async runStaticSolve(args: {
    study: Study;
    runId: string;
    meshRef: string;
    analysisMesh?: AnalysisMesh;
    publish: (event: RunEvent) => void;
  }): Promise<{ resultRef: string; reportRef: string; summary: ResultSummary; fields: ResultField[] }> {
    const messages = [
      [10, "Local static solver started."],
      [28, "Reading CAD-bound supports and loads."],
      [46, "Assembling multi-load stiffness response."],
      [68, "Solving force, moment, stress, and displacement superposition."],
      [88, "Writing result fields."],
      [100, "Simulation complete."]
    ] as const;

    const solved = solveStudy(args.study, args.runId, args.analysisMesh);
    const summary = solved.summary;
    const fields = solved.fields;
    const solverInput = [
      "local linear static multi-load input",
      `run=${args.runId}`,
      `mesh=${args.meshRef}`,
      `material=${solved.material.id}`,
      `youngsModulus=${solved.material.youngsModulus}`,
      `yieldStrength=${solved.material.yieldStrength}`,
      `effectiveYoungsModulus=${solved.effectiveMaterial.youngsModulus}`,
      `effectiveYieldStrength=${solved.effectiveMaterial.yieldStrength}`,
      `faces=${solved.faceCount}`,
      `loads=${solved.loadCount}`,
      `totalAppliedLoad=${solved.totalAppliedLoad}`,
      ...Object.entries(solved.materialParameters).map(([key, value]) => `${key}=${String(value)}`),
      ...args.study.loads.map((load) => JSON.stringify({ id: load.id, type: load.type, selectionRef: load.selectionRef, parameters: load.parameters }))
    ].join("\n") + "\n";

    await this.storage.putObject(`${args.study.projectId}/solver/${args.runId}/solver.inp`, solverInput);
    for (const [progress, message] of messages) {
      await delay(450);
      args.publish({
        runId: args.runId,
        type: progress === 100 ? "complete" : "progress",
        progress,
        message,
        timestamp: new Date().toISOString()
      });
      args.publish({
        runId: args.runId,
        type: "log",
        progress,
        message: progress === 100 ? "Local static solve complete." : message,
        timestamp: new Date().toISOString()
      });
    }

    const resultRef = `${args.study.projectId}/results/${args.runId}/results.json`;
    const summaryRef = `${args.study.projectId}/results/${args.runId}/summary.json`;
    const reportRef = `${args.study.projectId}/reports/${args.runId}/report.html`;
    await this.storage.putObject(
      `${args.study.projectId}/solver/${args.runId}/solver.log`,
      [
        `Local mesh read: ${solved.analysisSampleCount.toLocaleString()} surface analysis samples.`,
        "Local static solver: high-resolution linear elastic surface bending model.",
        `Material: ${solved.material.name}.`,
        `Effective material: E=${Math.round(solved.effectiveMaterial.youngsModulus / 1_000_000).toLocaleString()} MPa, yield=${Math.round(solved.effectiveMaterial.yieldStrength / 1_000_000).toLocaleString()} MPa.`,
        `Loads evaluated: ${args.study.loads.length}.`,
        `Result faces evaluated: ${solved.faceCount}.`,
        `Result samples evaluated: ${solved.analysisSampleCount}.`,
        `Total applied load: ${solved.totalAppliedLoad} N.`,
        "Static solve complete."
      ].join("\n") + "\n"
    );
    await this.storage.putObject(resultRef, JSON.stringify({ summary, fields }, null, 2));
    await this.storage.putObject(summaryRef, JSON.stringify(summary, null, 2));
    return { resultRef, reportRef, summary, fields };
  }

  async runDynamicSolve(args: {
    study: Study;
    runId: string;
    meshRef: string;
    analysisMesh?: AnalysisMesh;
    publish: (event: RunEvent) => void;
  }): Promise<{ resultRef: string; reportRef: string; summary: ResultSummary; fields: ResultField[] }> {
    const messages = [
      [10, "Local dynamic solver started."],
      [26, "Reading transient structural setup."],
      [44, "Estimating lumped mass, stiffness, and damping."],
      [66, "Integrating dynamic response with Newmark average acceleration."],
      [88, "Writing time-frame result fields."],
      [100, "Simulation complete."]
    ] as const;

    const solved = solveDynamicStudy(args.study, args.runId, args.analysisMesh);
    const settings = dynamicSettingsForStudy(args.study);
    const solverInput = [
      "local dynamic structural input",
      `run=${args.runId}`,
      `mesh=${args.meshRef}`,
      `integrationMethod=${settings.integrationMethod}`,
      `startTime=${settings.startTime}`,
      `endTime=${settings.endTime}`,
      `timeStep=${settings.timeStep}`,
      `outputInterval=${settings.outputInterval}`,
      `dampingRatio=${settings.dampingRatio}`,
      `material=${solved.material.id}`,
      `massKg=${solved.massKg}`,
      `stiffnessNPerM=${solved.stiffnessNPerM}`,
      `dampingNsPerM=${solved.dampingNsPerM}`,
      `frames=${solved.summary.transient?.frameCount ?? 0}`,
      ...args.study.loads.map((load) => JSON.stringify({ id: load.id, type: load.type, selectionRef: load.selectionRef, parameters: load.parameters }))
    ].join("\n") + "\n";

    await this.storage.putObject(`${args.study.projectId}/solver/${args.runId}/solver.inp`, solverInput);
    for (const [progress, message] of messages) {
      await delay(450);
      args.publish({
        runId: args.runId,
        type: progress === 100 ? "complete" : "progress",
        progress,
        message,
        timestamp: new Date().toISOString()
      });
      args.publish({
        runId: args.runId,
        type: "log",
        progress,
        message: progress === 100 ? "Local dynamic solve complete." : message,
        timestamp: new Date().toISOString()
      });
    }

    const resultRef = `${args.study.projectId}/results/${args.runId}/results.json`;
    const summaryRef = `${args.study.projectId}/results/${args.runId}/summary.json`;
    const reportRef = `${args.study.projectId}/reports/${args.runId}/report.html`;
    await this.storage.putObject(
      `${args.study.projectId}/solver/${args.runId}/solver.log`,
      [
        `Local mesh read: ${solved.analysisSampleCount.toLocaleString()} surface analysis samples.`,
        "Local dynamic solver: deterministic lumped transient structural model.",
        `Integration: ${settings.integrationMethod}.`,
        `Time range: ${settings.startTime}s to ${settings.endTime}s, dt=${settings.timeStep}s, output=${settings.outputInterval}s.`,
        `Damping ratio: ${settings.dampingRatio}.`,
        `Frames written: ${solved.summary.transient?.frameCount ?? 0}.`,
        `Peak displacement: ${solved.summary.maxDisplacement} ${solved.summary.maxDisplacementUnits} at ${solved.summary.transient?.peakDisplacementTimeSeconds ?? 0}s.`,
        "Dynamic solve complete."
      ].join("\n") + "\n"
    );
    await this.storage.putObject(resultRef, JSON.stringify({ summary: solved.summary, fields: solved.fields }, null, 2));
    await this.storage.putObject(summaryRef, JSON.stringify(solved.summary, null, 2));
    return { resultRef, reportRef, summary: solved.summary, fields: solved.fields };
  }
}

type Vec3 = [number, number, number];

interface FaceModel {
  selectionId: string;
  entityId: string;
  label: string;
  center: Vec3;
  normal: Vec3;
  baselineStress: number;
}

interface LoadModel {
  load: Load;
  face: FaceModel;
  direction: Vec3;
  force: Vec3;
  magnitude: number;
  nearestSupport: FaceModel;
  leverArm: number;
  moment: number;
}

export function solveStudy(study: Study, runId: string, analysisMeshInput?: AnalysisMesh) {
  const faces = faceModelsForStudy(study);
  const supports = supportFacesForStudy(study, faces);
  const loads = study.loads.map((load) => loadModelFor(load, faces, supports)).filter((load): load is LoadModel => Boolean(load));
  const analysisMesh = analysisMeshInput ?? analysisMeshForFaces(faces, study.meshSettings.preset);
  const material = materialForStudy(study);
  const materialParameters = materialParametersForStudy(study);
  const criticalLayerAxis = inferCriticalPrintAxis(study, faces);
  const effectiveMaterial = effectiveMaterialProperties(material, materialParameters, { criticalLayerAxis });
  const response = materialResponse(effectiveMaterial, loads);
  const totalAppliedLoad = round(loads.reduce((sum, load) => sum + load.magnitude, 0));
  const stressValues = faces.map((face) => round(stressAtFace(face, loads, faces) * response.stressScale, 1));
  const displacementValues = faces.map((face) => round(displacementAtFace(face, loads, faces) * response.displacementScale, 4));
  const safetyValues = stressValues.map((stress) => round(Math.max(0.05, response.yieldMpa / Math.max(stress, 0.001)), 2));
  const rawStressSampleValues = analysisMesh.samples.map((sample) => stressAtSample(sample, loads, faces, analysisMesh) * response.stressScale);
  const maxStressValue = Math.max(...stressValues, 0);
  const maxStressSampleValue = Math.max(...rawStressSampleValues, 0);
  const minStressSampleValue = Math.min(...rawStressSampleValues.filter(Number.isFinite));
  const stressSampleRange = maxStressSampleValue - minStressSampleValue;
  const calibratedStressSampleRange = maxStressValue - minStressSampleValue;
  const stressSamples = analysisMesh.samples.map((sample, index) => {
    const rawValue = rawStressSampleValues[index] ?? 0;
    const value = Number.isFinite(minStressSampleValue) && stressSampleRange > 1e-9 && calibratedStressSampleRange > stressSampleRange
      ? minStressSampleValue + (rawValue - minStressSampleValue) * calibratedStressSampleRange / stressSampleRange
      : rawValue;
    return sampleResult(sample, value, 2, { source: "local_detailed", vonMisesStressPa: round(value * 1_000_000, 1) });
  });
  const displacementSamples = analysisMesh.samples.map((sample) => {
    const value = displacementAtSample(sample, loads, faces, analysisMesh) * response.displacementScale;
    return sampleResult(sample, value, 4, {
      vector: roundVector(displacementVectorAtSample(sample, loads, faces, analysisMesh, response.displacementScale), 4)
    });
  });
  const safetySamples = stressSamples.map((sample) => sampleResult(sample, Math.max(0.05, response.yieldMpa / Math.max(sample.value, 0.001)), 3));
  const fields: ResultField[] = [
    fieldFor(runId, "stress", stressValues, "MPa", stressSamples),
    fieldFor(runId, "displacement", displacementValues, "mm", displacementSamples),
    fieldFor(runId, "safety_factor", safetyValues, "", safetySamples)
  ];
  const stressField = fields.find((field) => field.type === "stress");
  const displacementField = fields.find((field) => field.type === "displacement");
  const safetyField = fields.find((field) => field.type === "safety_factor");
  const summaryBase = {
    maxStress: round(stressField?.max ?? Math.max(...stressValues, 0), 1),
    maxStressUnits: bracketResultSummary.maxStressUnits,
    maxDisplacement: round(displacementField?.max ?? Math.max(...displacementValues, 0), 3),
    maxDisplacementUnits: bracketResultSummary.maxDisplacementUnits,
    safetyFactor: round(safetyField?.min ?? (safetyValues.length ? Math.min(...safetyValues) : bracketResultSummary.safetyFactor), 2),
    reactionForce: totalAppliedLoad || bracketResultSummary.reactionForce,
    reactionForceUnits: "N"
  };
  const summary: ResultSummary = {
    ...summaryBase,
    failureAssessment: assessResultFailure(summaryBase)
  };
  return { summary, fields, faceCount: faces.length, loadCount: loads.length, totalAppliedLoad: summary.reactionForce, material, effectiveMaterial, materialParameters, analysisSampleCount: analysisMesh.samples.length };
}

export function solveDynamicStudy(study: Study, runId: string, analysisMeshInput?: AnalysisMesh) {
  const settings = dynamicSettingsForStudy(study);
  const staticSolved = solveStudy(study, runId, analysisMeshInput);
  const stressBase = staticSolved.fields.find((field) => field.type === "stress");
  const displacementBase = staticSolved.fields.find((field) => field.type === "displacement");
  const analysisMesh = analysisMeshInput ?? analysisMeshForFaces(faceModelsForStudy(study), study.meshSettings.preset);
  const totalForce = Math.max(staticSolved.totalAppliedLoad, 0.001);
  const staticDisplacementMeters = Math.max((displacementBase?.max ?? staticSolved.summary.maxDisplacement) / 1000, 1e-6);
  const massKg = equivalentMassKg(staticSolved.material, analysisMesh);
  const stiffnessNPerM = Math.max(totalForce / staticDisplacementMeters, 1);
  const dampingNsPerM = 2 * settings.dampingRatio * Math.sqrt(stiffnessNPerM * massKg);
  const frames = integrateDynamicFrames(settings, totalForce, massKg, stiffnessNPerM, dampingNsPerM);
  const yieldMpa = staticSolved.material.yieldStrength / 1_000_000;
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
    const stressFrame = scaleBaseField(stressBase, runId, "stress", "MPa", stressScale, frame.index, frame.time, 1);
    const displacementFrame = scaleBaseField(displacementBase, runId, "displacement", "mm", displacementScale, frame.index, frame.time, 4);
    const velocityFrame = scaleBaseField(displacementBase, runId, "velocity", "mm/s", velocityScale, frame.index, frame.time, 4);
    const accelerationFrame = scaleBaseField(displacementBase, runId, "acceleration", "mm/s^2", accelerationScale, frame.index, frame.time, 4);
    const safetyValues = stressFrame.values.map((stress) => round(Math.max(0.05, yieldMpa / Math.max(stress, 0.001)), 2));
    const safetySamples = stressFrame.samples?.map((sample) => sampleResult(sample, Math.max(0.05, yieldMpa / Math.max(sample.value, 0.001)), 3)) ?? [];
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
    maxDisplacement: round(peakDisplacement, 3),
    maxDisplacementUnits: "mm",
    safetyFactor: round(Number.isFinite(minSafetyFactor) ? minSafetyFactor : 0, 2),
    reactionForce: staticSolved.summary.reactionForce,
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
      peakDisplacement: round(peakDisplacement, 4)
    }
  };
  const summary: ResultSummary = {
    ...summaryBase,
    failureAssessment: assessResultFailure(summaryBase)
  };
  return {
    summary,
    fields,
    material: staticSolved.material,
    massKg: round(massKg, 6),
    stiffnessNPerM: round(stiffnessNPerM, 3),
    dampingNsPerM: round(dampingNsPerM, 6),
    analysisSampleCount: analysisMesh.samples.length
  };
}

export interface DynamicStudyBenchmark {
  durationMs: number;
  frameCount: number;
  fieldCount: number;
  jsonBytes: number;
}

export function benchmarkDynamicStudy(study: Study, runId: string, analysisMeshInput?: AnalysisMesh): DynamicStudyBenchmark {
  const started = performanceNow();
  const solved = solveDynamicStudy(study, runId, analysisMeshInput);
  const durationMs = round(performanceNow() - started, 3);
  return {
    durationMs,
    frameCount: solved.summary.transient?.frameCount ?? 0,
    fieldCount: solved.fields.length,
    jsonBytes: new TextEncoder().encode(JSON.stringify({ summary: solved.summary, fields: solved.fields })).byteLength
  };
}

function performanceNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function dynamicSettingsForStudy(study: Study): DynamicSolverSettings {
  const raw = study.solverSettings as Partial<DynamicSolverSettings>;
  const timeStep = finiteOr(raw.timeStep, 0.005);
  return {
    startTime: finiteOr(raw.startTime, 0),
    endTime: finiteOr(raw.endTime, 0.1),
    timeStep,
    outputInterval: Math.max(finiteOr(raw.outputInterval, 0.005), timeStep, MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS),
    dampingRatio: finiteOr(raw.dampingRatio, 0.02),
    integrationMethod: "newmark_average_acceleration",
    ...(raw.allowFreeMotion === true ? { allowFreeMotion: true } : {}),
    ...(typeof (raw as DynamicSolverSettings & { loadProfile?: string }).loadProfile === "string"
      ? { loadProfile: (raw as DynamicSolverSettings & { loadProfile: string }).loadProfile }
      : {})
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface DynamicFrame {
  index: number;
  time: number;
  displacement: number;
  velocity: number;
  acceleration: number;
}

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
  const profile = (settings as DynamicSolverSettings & { loadProfile?: string }).loadProfile;
  if (profile === "ramp") {
    const duration = Math.max(settings.endTime - settings.startTime, settings.timeStep);
    return clamp((time - settings.startTime) / duration, 0, 1);
  }
  if (profile === "sinusoidal") {
    const duration = Math.max(settings.endTime - settings.startTime, settings.timeStep);
    return Math.sin(2 * Math.PI * clamp((time - settings.startTime) / duration, 0, 1));
  }
  return 1;
}

function equivalentMassKg(material: Material, analysisMesh: AnalysisMesh): number {
  const span = subtract(analysisMesh.bounds.max, analysisMesh.bounds.min);
  const volumeM3 = Math.max(Math.abs(span[0] * span[1] * span[2]) * 1e-6, 1e-5);
  return Math.max(material.density * volumeM3, 0.05);
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
  const samples = base?.samples?.map((sample) => sampleResult(sample, sample.value * scale, digits, {
    ...(sample.vector ? { vector: roundVector(scaleVector(sample.vector, scale), digits) } : {})
  })) ?? [];
  return fieldForFrame(runId, type, values, units, samples, frameIndex, timeSeconds);
}

function fieldForFrame(runId: string, type: ResultField["type"], values: number[], units: string, samples: ResultSample[], frameIndex: number, timeSeconds: number): ResultField {
  return {
    ...fieldFor(runId, type, values, units, samples),
    id: `field-${type}-${runId}-frame-${frameIndex}`,
    frameIndex,
    timeSeconds
  };
}

function resultFieldAbsMax(field: ResultField) {
  const values = [
    ...field.values,
    ...(field.samples?.map((sample) => sample.value) ?? [])
  ].map((value) => Math.abs(value)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : Math.max(Math.abs(field.min), Math.abs(field.max));
}

function stabilizeDynamicFieldRanges(fields: ResultField[]) {
  const fieldTypes = [...new Set(fields.map((field) => field.type))];
  for (const type of fieldTypes) {
    const matchingFields = fields.filter((field) => field.type === type);
    const values = matchingFields.flatMap((field) => [
      ...field.values,
      ...(field.samples?.map((sample) => sample.value) ?? [])
    ]).filter(Number.isFinite);
    if (!values.length) continue;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    for (const field of matchingFields) {
      field.min = round(min, dynamicRangeDigits(type));
      field.max = round(max, dynamicRangeDigits(type));
    }
  }
}

function dynamicRangeDigits(type: ResultField["type"]) {
  if (type === "stress") return 1;
  if (type === "displacement" || type === "velocity" || type === "acceleration") return 4;
  return 3;
}

function materialForStudy(study: Study): Material {
  const materialId = study.materialAssignments[0]?.materialId;
  return starterMaterials.find((material) => material.id === materialId) ?? starterMaterials[0]!;
}

function materialParametersForStudy(study: Study): Record<string, unknown> {
  return study.materialAssignments[0]?.parameters ?? {};
}

function materialResponse(material: Material, loads: LoadModel[]): { stressScale: number; displacementScale: number; yieldMpa: number } {
  const reference = starterMaterials[0]!;
  const baseMaterial = starterMaterials.find((candidate) => candidate.id === material.id) ?? material;
  const youngsScale = reference.youngsModulus / Math.max(material.youngsModulus, 1);
  const stiffnessReduction = baseMaterial.youngsModulus / Math.max(material.youngsModulus, 1);
  const strengthReduction = baseMaterial.yieldStrength / Math.max(material.yieldStrength, 1);
  const printedStressScale = clamp(1 + (Math.max(stiffnessReduction, strengthReduction) - 1) * 0.35, 1, 2.25);
  const hasGravity = loads.some((load) => load.load.type === "gravity");
  const densityScale = hasGravity ? 1 + (material.density / reference.density - 1) * 0.08 : 1;
  return {
    stressScale: round(densityScale * printedStressScale, 4),
    displacementScale: round(youngsScale * densityScale, 4),
    yieldMpa: material.yieldStrength / 1_000_000
  };
}

function fieldFor(runId: string, type: ResultField["type"], values: number[], units: string, samples: ResultSample[] = []): ResultField {
  const allValues = [...values, ...samples.map((sample) => sample.value)].filter(Number.isFinite);
  const min = allValues.length ? Math.min(...allValues) : 0;
  const max = allValues.length ? Math.max(...allValues) : 0;
  return {
    id: `field-${type}-${runId}`,
    runId,
    type,
    location: "face",
    values,
    min: round(min, type === "displacement" ? 4 : 2),
    max: round(max, type === "displacement" ? 4 : 2),
    units,
    ...(samples.length ? { samples } : {})
  };
}

function sampleResult(sample: AnalysisSample | ResultSample, value: number, digits: number, metadata: Partial<ResultSample> = {}): ResultSample {
  return {
    point: sample.point,
    normal: sample.normal,
    value: round(value, digits),
    ...metadata
  };
}

function faceModelsForStudy(study: Study): FaceModel[] {
  const faceSelections = study.namedSelections.filter((selection) => selection.entityType === "face");
  const source = faceSelections.length
    ? faceSelections.map((selection) => ({
      selectionId: selection.id,
      entityId: selection.geometryRefs[0]?.entityId ?? selection.id,
      label: selection.geometryRefs[0]?.label ?? selection.name
    }))
    : bracketDisplayModel.faces.map((face) => ({ selectionId: face.id, entityId: face.id, label: face.label }));
  return source.map((face, index) => {
    const geometry = faceGeometry(face.entityId, face.label, index, source.length);
    return {
      selectionId: face.selectionId,
      entityId: face.entityId,
      label: face.label,
      center: geometry.center,
      normal: geometry.normal,
      baselineStress: geometry.baselineStress
    };
  });
}

function supportFacesForStudy(study: Study, faces: FaceModel[]): FaceModel[] {
  const supports = study.constraints
    .map((constraint) => faces.find((face) => face.selectionId === constraint.selectionRef))
    .filter((face): face is FaceModel => Boolean(face));
  return supports.length ? supports : faces.slice(0, 1);
}

function loadModelFor(load: Load, faces: FaceModel[], supports: FaceModel[]): LoadModel | undefined {
  const face = faces.find((candidate) => candidate.selectionId === load.selectionRef);
  if (!face) return undefined;
  const direction = vectorOrDefault(load.parameters.direction, load.type === "pressure" ? scale(face.normal, -1) : [0, -1, 0]);
  const magnitude = loadEquivalentForce(load, face);
  const force = scale(direction, magnitude);
  const applicationPoint = pointOrDefault(load.parameters.applicationPoint, face.center);
  const nearestSupport = nearestFace(applicationPoint, supports) ?? face;
  const lever = subtract(applicationPoint, nearestSupport.center);
  const momentVector = cross(lever, force);
  return {
    load,
    face,
    direction,
    force,
    magnitude,
    nearestSupport,
    leverArm: length(lever),
    moment: length(momentVector)
  };
}

function stressAtFace(face: FaceModel, loads: LoadModel[], faces: FaceModel[]): number {
  const span = modelSpan(faces);
  const base = 14 + face.baselineStress * 0.16;
  const stress = loads.reduce((sum, load) => {
    const forceScale = load.magnitude / 500;
    const momentScale = load.moment / Math.max(250, 500 * span);
    const loadDistance = distance(face.center, load.face.center);
    const supportDistance = distance(face.center, load.nearestSupport.center);
    const pathDistance = distancePointToSegment(face.center, load.nearestSupport.center, load.face.center);
    const localLoad = gaussian(loadDistance, span * 0.16);
    const localSupport = gaussian(supportDistance, span * 0.2);
    const loadPath = gaussian(pathDistance, span * 0.18);
    const normalAlignment = Math.abs(dot(face.normal, load.direction));
    const axial = Math.abs(dot(load.direction, load.face.normal));
    const typeFactor = load.load.type === "pressure" ? 1.18 : load.load.type === "gravity" ? 0.72 : 1;
    if (isTransverseBeamBending(load)) {
      const pathTravel = segmentParameter(face.center, load.nearestSupport.center, load.face.center);
      const bendingMoment = Math.max(0, 1 - pathTravel);
      const fiberFactor = bendingFiberFactor(face, load);
      const loadApplicationCap = localLoad * (6 + 6 * axial) * (1 - bendingMoment * 0.65);
      return sum + typeFactor * (
        forceScale * (
          bendingMoment * (72 + 32 * momentScale) * fiberFactor +
          localSupport * (28 + 22 * momentScale) +
          loadPath * bendingMoment * (18 + 28 * momentScale) +
          loadApplicationCap
        ) +
        momentScale * bendingMoment * (10 + 8 * normalAlignment)
      );
    }
    return sum + typeFactor * (
      forceScale * (localLoad * (58 + 20 * axial) + localSupport * (30 + 16 * momentScale) + loadPath * (22 + 42 * momentScale)) +
      momentScale * (18 + 12 * normalAlignment)
    );
  }, base);
  return Math.max(1, stress);
}

function isTransverseBeamBending(load: LoadModel): boolean {
  if (load.load.type === "pressure" || load.leverArm < 0.001) return false;
  const spanDirection = normalize(subtract(load.face.center, load.nearestSupport.center));
  const axialAlignment = Math.abs(dot(spanDirection, load.direction));
  const transverseAlignment = length(cross(spanDirection, load.direction));
  return transverseAlignment > 0.55 && axialAlignment < 0.72;
}

function bendingFiberFactor(face: FaceModel, load: LoadModel): number {
  const spanDirection = normalize(subtract(load.face.center, load.nearestSupport.center));
  const transverseDirection = normalize(subtract(load.direction, scale(spanDirection, dot(load.direction, spanDirection))));
  const outerFiberAlignment = Math.abs(dot(face.normal, transverseDirection));
  const supportCrossSection = Math.abs(dot(face.normal, spanDirection));
  return clamp(0.48 + outerFiberAlignment * 0.42 + supportCrossSection * 0.2, 0.48, 1.05);
}

function displacementAtFace(face: FaceModel, loads: LoadModel[], faces: FaceModel[]): number {
  const span = modelSpan(faces);
  return loads.reduce((sum, load) => {
    const forceScale = load.magnitude / 500;
    const momentScale = load.moment / Math.max(250, 500 * span);
    const loadDistance = distance(face.center, load.face.center);
    const pathDistance = distancePointToSegment(face.center, load.nearestSupport.center, load.face.center);
    const pathTravel = segmentParameter(face.center, load.nearestSupport.center, load.face.center);
    const bendingAlignment = length(cross(normalize(subtract(load.face.center, load.nearestSupport.center)), load.direction));
    const beamShape = cantileverDisplacementShape(pathTravel);
    const supportLockShape = load.leverArm > 0.001 ? beamShape : 1;
    const localLoad = gaussian(loadDistance, span * 0.24);
    const loadPath = gaussian(pathDistance, span * 0.22);
    const directionalFlex = Math.abs(dot(normalize(subtract(face.center, load.nearestSupport.center)), load.direction));
    return sum + forceScale * supportLockShape * (
      0.004 +
      (0.16 + 0.1 * momentScale + 0.08 * bendingAlignment) * beamShape +
      0.025 * localLoad * (0.4 + 0.6 * beamShape) +
      0.015 * loadPath * pathTravel +
      0.01 * directionalFlex * beamShape
    );
  }, 0);
}

function stressAtSample(sample: AnalysisSample, loads: LoadModel[], faces: FaceModel[], analysisMesh: AnalysisMesh): number {
  const nearest = nearestFace(sample.point, faces);
  const baseline = nearest ? 8 + nearest.baselineStress * 0.06 : 8;
  if (!loads.length) return baseline;
  const stress = loads.reduce((sum, load) => {
    const spanVector = subtract(load.face.center, load.nearestSupport.center);
    const spanLength = Math.max(length(spanVector), 0.001);
    const spanDirection = normalize(spanVector);
    const forceScale = load.magnitude / 500;
    const momentScale = load.moment / Math.max(250, 500 * spanLength);
    const travel = segmentParameter(sample.point, load.nearestSupport.center, load.face.center);
    const momentFraction = Math.max(0, 1 - travel);
    const pathDistance = distancePointToSegment(sample.point, load.nearestSupport.center, load.face.center);
    const loadDistance = distance(sample.point, load.face.center);
    const supportDistance = distance(sample.point, load.nearestSupport.center);
    const fiberDistance = distancePointToLine(sample.point, load.nearestSupport.center, spanDirection);
    const fiberRadius = Math.max(estimatedCrossSectionRadius(analysisMesh, load.nearestSupport.center, spanDirection), 0.001);
    const fiber = clamp(fiberDistance / fiberRadius, 0, 1);
    const surfaceFiber = clamp(0.35 + Math.abs(dot(sample.normal, spanDirection)) * 0.15 + length(cross(sample.normal, spanDirection)) * 0.5, 0.35, 1);
    const localSupport = gaussian(supportDistance, spanLength * 0.12);
    const localLoad = gaussian(loadDistance, spanLength * 0.12);
    const loadPath = gaussian(pathDistance, spanLength * 0.14);
    const typeFactor = load.load.type === "pressure" ? 1.15 : load.load.type === "gravity" ? 0.72 : 1;
    if (isTransverseBeamBending(load)) {
      return sum + typeFactor * forceScale * (
        4 +
        momentFraction * (125 + 44 * momentScale) * (0.12 + 0.94 * fiber) * surfaceFiber +
        localSupport * (16 + 24 * momentScale) * (0.25 + 0.75 * fiber) +
        loadPath * momentFraction * (8 + 18 * momentScale) * (0.2 + 0.8 * fiber) +
        localLoad * (4 + 8 * (1 - momentFraction)) * (0.2 + 0.35 * fiber)
      );
    }
    return sum + typeFactor * (
      forceScale * (localLoad * 44 + localSupport * 28 + loadPath * (18 + 30 * momentScale)) +
      momentScale * 16 * (0.35 + 0.65 * fiber)
    );
  }, baseline);
  return Math.max(1, stress);
}

function displacementAtSample(sample: AnalysisSample, loads: LoadModel[], faces: FaceModel[], analysisMesh: AnalysisMesh): number {
  if (!loads.length) return 0;
  return loads.reduce((sum, load) => {
    const spanVector = subtract(load.face.center, load.nearestSupport.center);
    const spanLength = Math.max(length(spanVector), 0.001);
    const forceScale = load.magnitude / 500;
    const momentScale = load.moment / Math.max(250, 500 * spanLength);
    const travel = segmentParameter(sample.point, load.nearestSupport.center, load.face.center);
    const beamShape = cantileverDisplacementShape(travel);
    const supportLockShape = load.leverArm > 0.001 ? beamShape : 1;
    const tipDisplacement = forceScale * (0.162 + 0.11 * momentScale);
    return sum + supportLockShape * tipDisplacement;
  }, 0);
}

function displacementVectorAtSample(sample: AnalysisSample, loads: LoadModel[], faces: FaceModel[], analysisMesh: AnalysisMesh, displacementScale: number): Vec3 {
  if (!loads.length) return [0, 0, 0];
  return loads.reduce<Vec3>((sum, load) => {
    const magnitude = displacementAtSampleForLoad(sample, load, faces, analysisMesh) * displacementScale;
    const contribution = scale(displacementDirectionForLoad(load), magnitude);
    return [sum[0] + contribution[0], sum[1] + contribution[1], sum[2] + contribution[2]];
  }, [0, 0, 0]);
}

function cantileverDisplacementShape(travel: number): number {
  const s = clamp(travel, 0, 1);
  return 0.5 * s * s * (3 - s);
}

function displacementDirectionForLoad(load: LoadModel): Vec3 {
  if (isBuiltInBeamPayloadGravityLoad(load)) return [0, -1, 0];
  return load.direction;
}

function isBuiltInBeamPayloadGravityLoad(load: LoadModel): boolean {
  const label = load.face.label.toLowerCase();
  return load.load.type === "gravity"
    && label.includes("payload")
    && Math.abs(load.direction[2]) > 0.72
    && Math.abs(load.face.normal[1]) > 0.72;
}

function displacementAtSampleForLoad(sample: AnalysisSample, load: LoadModel, _faces: FaceModel[], analysisMesh: AnalysisMesh): number {
  const spanVector = subtract(load.face.center, load.nearestSupport.center);
  const spanLength = Math.max(length(spanVector), 0.001);
  const forceScale = load.magnitude / 500;
  const momentScale = load.moment / Math.max(250, 500 * spanLength);
  const travel = segmentParameter(sample.point, load.nearestSupport.center, load.face.center);
  const beamShape = cantileverDisplacementShape(travel);
  const supportLockShape = load.leverArm > 0.001 ? beamShape : 1;
  const tipDisplacement = forceScale * (0.162 + 0.11 * momentScale);
  return supportLockShape * tipDisplacement;
}

function loadEquivalentForce(load: Load, face: FaceModel): number {
  const rawValue = Number(load.parameters.value ?? 0);
  const value = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 0;
  if (load.type === "pressure") return value * estimatedFaceArea(face) * 0.001;
  if (load.type === "gravity") {
    const equivalentForce = Number(load.parameters.equivalentForceN);
    return Number.isFinite(equivalentForce) && equivalentForce > 0 ? equivalentForce : value * STANDARD_GRAVITY;
  }
  return value;
}

function analysisMeshForFaces(faces: FaceModel[], quality: AnalysisMesh["quality"] = "medium"): AnalysisMesh {
  const bounds = boundsForFaces(faces);
  const divisions = quality === "ultra" ? 36 : quality === "fine" ? 18 : quality === "medium" ? 10 : 5;
  const samples: AnalysisSample[] = [];
  for (const face of faces) {
    samples.push({ point: face.center, normal: normalize(face.normal), weight: 1, sourceId: face.selectionId });
  }
  const axes: Array<{ axis: 0 | 1 | 2; side: "min" | "max"; normal: Vec3 }> = [
    { axis: 0, side: "min", normal: [-1, 0, 0] },
    { axis: 0, side: "max", normal: [1, 0, 0] },
    { axis: 1, side: "min", normal: [0, -1, 0] },
    { axis: 1, side: "max", normal: [0, 1, 0] },
    { axis: 2, side: "min", normal: [0, 0, -1] },
    { axis: 2, side: "max", normal: [0, 0, 1] }
  ];
  for (const { axis, side, normal } of axes) {
    const otherAxes = ([0, 1, 2] as const).filter((candidate) => candidate !== axis);
    for (let a = 0; a <= divisions; a += 1) {
      for (let b = 0; b <= divisions; b += 1) {
        const point: Vec3 = [0, 0, 0];
        point[axis] = bounds[side][axis];
        point[otherAxes[0]!] = lerp(bounds.min[otherAxes[0]!], bounds.max[otherAxes[0]!], a / divisions);
        point[otherAxes[1]!] = lerp(bounds.min[otherAxes[1]!], bounds.max[otherAxes[1]!], b / divisions);
        samples.push({ point, normal, weight: 1, sourceId: `bounds-${axis}-${side}` });
      }
    }
  }
  return { quality, bounds, samples };
}

function boundsForFaces(faces: FaceModel[]): AnalysisMesh["bounds"] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const face of faces.length ? faces : [{ center: [0, 0, 0] as Vec3 }]) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, face.center[axis]!);
      max[axis] = Math.max(max[axis]!, face.center[axis]!);
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const span = Math.max(max[axis]! - min[axis]!, 0.4);
    const pad = Math.max(span * 0.08, 0.18);
    min[axis] = min[axis]! - pad;
    max[axis] = max[axis]! + pad;
  }
  return { min, max };
}

function estimatedFaceArea(face: FaceModel): number {
  const label = face.label.toLowerCase();
  if (label.includes("pad") || label.includes("top load")) return 850;
  if (label.includes("base") || label.includes("plate")) return 1600;
  if (label.includes("end")) return 700;
  return 1000;
}

function faceGeometry(entityId: string, label: string, index: number, count: number): { center: Vec3; normal: Vec3; baselineStress: number } {
  const key = `${entityId} ${label}`.toLowerCase();
  const known = knownFaces
    .filter((face) => key.includes(face.match))
    .sort((left, right) => right.match.length - left.match.length)[0];
  if (known) return known;
  const angle = count <= 1 ? 0 : (index / count) * Math.PI * 2;
  const radius = 1.3;
  const center: Vec3 = [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.65, Math.sin(angle) * radius];
  return { center, normal: normalize(center), baselineStress: 50 + index * 6 };
}

const knownFaces: Array<{ match: string; center: Vec3; normal: Vec3; baselineStress: number }> = [
  ...bracketDisplayModel.faces.map((face) => ({ match: face.id.toLowerCase(), center: face.center, normal: normalize(face.normal), baselineStress: face.stressValue })),
  { match: "face-base-left fixed end face", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], baselineStress: 132 },
  { match: "face-load-top end payload mass", center: [1.48, 0.49, 0], normal: [0, 1, 0], baselineStress: 118 },
  { match: "face-base-bottom beam body", center: [0, 0.14, 0], normal: [0, 0, 1], baselineStress: 58 },
  { match: "face-load-top free end load face", center: [1.9, 0.18, 0], normal: [1, 0, 0], baselineStress: 96 },
  { match: "face-web-front top beam face", center: [0, 0.42, 0], normal: [0, 1, 0], baselineStress: 74 },
  { match: "face-base-bottom beam bottom face", center: [0, -0.08, 0], normal: [0, -1, 0], baselineStress: 46 },
  { match: "face-load", center: [-1.18, 2.53, 0], normal: [0, 1, 0], baselineStress: 142 },
  { match: "top load", center: [-1.18, 2.53, 0], normal: [0, 1, 0], baselineStress: 142 },
  { match: "base end", center: [2.36, 0, 0], normal: [1, 0, 0], baselineStress: 44 },
  { match: "face-end", center: [2.36, 0, 0], normal: [1, 0, 0], baselineStress: 44 },
  { match: "brace", center: [-0.38, 0.86, 0.42], normal: [0, 0, 1], baselineStress: 96 },
  { match: "face-web", center: [-0.38, 0.86, 0.42], normal: [0, 0, 1], baselineStress: 96 },
  { match: "upright front", center: [-1.18, 1.42, 0.58], normal: [0, 0, 1], baselineStress: 78 },
  { match: "upright outer", center: [-1.57, 1.18, 0], normal: [-1, 0, 0], baselineStress: 68 },
  { match: "upright inner", center: [-0.76, 1.22, 0], normal: [1, 0, 0], baselineStress: 86 },
  { match: "base front", center: [0.68, -0.24, 0.58], normal: [0, -1, 0], baselineStress: 52 },
  { match: "rib side", center: [-0.26, 0.78, 0.22], normal: [0, 0, 1], baselineStress: 92 },
  { match: "left clamp", center: [-1.45, 0, 0.17], normal: [0, 0, 1], baselineStress: 42 },
  { match: "right load pad", center: [1.42, 0, 0.17], normal: [0, 0, 1], baselineStress: 118 },
  { match: "hole rim", center: [0, 0, 0.2], normal: [0, 0, 1], baselineStress: 84 },
  { match: "plate top", center: [0, 0, 0.18], normal: [0, 0, 1], baselineStress: 58 },
  { match: "fixed end", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], baselineStress: 132 },
  { match: "free end", center: [1.9, 0.18, 0], normal: [1, 0, 0], baselineStress: 96 },
  { match: "top beam", center: [0, 0.42, 0], normal: [0, 1, 0], baselineStress: 74 },
  { match: "bottom beam", center: [0, -0.12, 0], normal: [0, -1, 0], baselineStress: 48 },
  { match: "upload-top", center: [0, 0.72, 0], normal: [0, 1, 0], baselineStress: 72 },
  { match: "upload-bottom", center: [0, -0.72, 0], normal: [0, -1, 0], baselineStress: 48 },
  { match: "upload-front", center: [0, 0, 0.52], normal: [0, 0, 1], baselineStress: 64 },
  { match: "upload-back", center: [0, 0, -0.52], normal: [0, 0, -1], baselineStress: 54 },
  { match: "upload-left", center: [-1.1, 0, 0], normal: [-1, 0, 0], baselineStress: 58 },
  { match: "upload-right", center: [1.1, 0, 0], normal: [1, 0, 0], baselineStress: 84 }
];

function modelSpan(faces: FaceModel[]): number {
  let max = 1;
  for (const left of faces) {
    for (const right of faces) {
      max = Math.max(max, distance(left.center, right.center));
    }
  }
  return max;
}

function nearestFace(point: Vec3, faces: FaceModel[]): FaceModel | undefined {
  return faces.reduce<FaceModel | undefined>((nearest, face) => {
    if (!nearest) return face;
    return distance(point, face.center) < distance(point, nearest.center) ? face : nearest;
  }, undefined);
}

function vectorOrDefault(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return normalize(fallback);
  return normalize([Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0)]);
}

function pointOrDefault(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  const point: Vec3 = [Number(value[0] ?? fallback[0]), Number(value[1] ?? fallback[1]), Number(value[2] ?? fallback[2])];
  return point.every(Number.isFinite) ? point : fallback;
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(vector: Vec3, factor: number): Vec3 {
  return scaleVector(vector, factor);
}

function scaleVector(vector: Vec3, factor: number): Vec3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function roundVector(vector: Vec3, digits: number): Vec3 {
  return [round(vector[0], digits), round(vector[1], digits), round(vector[2], digits)];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function length(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalize(vector: Vec3): Vec3 {
  const vectorLength = length(vector) || 1;
  return [vector[0] / vectorLength, vector[1] / vectorLength, vector[2] / vectorLength];
}

function distance(left: Vec3, right: Vec3): number {
  return length(subtract(left, right));
}

function distancePointToSegment(point: Vec3, start: Vec3, end: Vec3): number {
  const segment = subtract(end, start);
  const t = segmentParameter(point, start, end);
  return distance(point, [start[0] + segment[0] * t, start[1] + segment[1] * t, start[2] + segment[2] * t]);
}

function distancePointToLine(point: Vec3, linePoint: Vec3, lineDirection: Vec3): number {
  const offset = subtract(point, linePoint);
  const projection = scale(lineDirection, dot(offset, lineDirection));
  return length(subtract(offset, projection));
}

function estimatedCrossSectionRadius(analysisMesh: AnalysisMesh, linePoint: Vec3, lineDirection: Vec3): number {
  let radius = 0.001;
  const corners = boundsCorners(analysisMesh.bounds);
  for (const corner of corners) {
    radius = Math.max(radius, distancePointToLine(corner, linePoint, lineDirection));
  }
  return radius;
}

function boundsCorners(bounds: AnalysisMesh["bounds"]): Vec3[] {
  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push([x, y, z]);
      }
    }
  }
  return corners;
}

function segmentParameter(point: Vec3, start: Vec3, end: Vec3): number {
  const segment = subtract(end, start);
  const segmentLengthSquared = dot(segment, segment) || 1;
  return Math.max(0, Math.min(1, dot(subtract(point, start), segment) / segmentLengthSquared));
}

function gaussian(value: number, radius: number): number {
  const safeRadius = Math.max(radius, 0.001);
  const x = value / safeRadius;
  return Math.exp(-0.5 * x * x);
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
