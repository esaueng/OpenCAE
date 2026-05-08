import {
  normalizeModelJson,
  type NormalizedOpenCAEModel,
  type OpenCAEModelJson
} from "@opencae/core";
import { computeTet4Geometry } from "./geometry";
import { solveStaticLinearTet4Cpu } from "./solver";
import type {
  CpuSolverError,
  CpuSolverInput,
  DynamicLoadProfile,
  DynamicTet4CpuDiagnostics,
  DynamicTet4CpuFrame,
  DynamicTet4CpuOptions,
  DynamicTet4CpuSolveResult,
  StaticLinearTet4CpuResult
} from "./types";

const DEFAULT_END_TIME_SECONDS = 0.1;
const DEFAULT_TIME_STEP_SECONDS = 0.005;
const DEFAULT_OUTPUT_INTERVAL_SECONDS = 0.005;
const DEFAULT_DAMPING_RATIO = 0.02;
const DEFAULT_MASS_DENSITY_KG_PER_M3 = 2700;

type DynamicSettings = Required<Pick<
  DynamicTet4CpuOptions,
  "startTime" | "endTime" | "timeStep" | "outputInterval" | "dampingRatio" | "loadProfile" | "massDensity"
>>;

type IntegratedFrame = {
  index: number;
  time: number;
  loadScale: number;
  displacement: number;
  velocity: number;
  acceleration: number;
};

export function solveDynamicTet4Cpu(
  input: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): DynamicTet4CpuSolveResult {
  const settings = dynamicSettings(options);
  if (settings.endTime <= settings.startTime) {
    return failure("invalid-time-range", "Dynamic solve endTime must be greater than startTime.");
  }

  const staticSolve = solveStaticLinearTet4Cpu(input, options);
  if (!staticSolve.ok) return staticSolve;

  const modelResult = getNormalizedModel(input);
  if (!modelResult.ok) return { ok: false, error: modelResult.error };

  const equivalentMass = computeEquivalentMass(modelResult.model, settings.massDensity);
  if (!Number.isFinite(equivalentMass) || equivalentMass <= 0) {
    return failure("invalid-mass", "Dynamic solve requires positive equivalent mass.");
  }

  const staticDisplacement = Math.max(staticSolve.diagnostics.maxDisplacement, 1e-12);
  const equivalentForce = Math.max(totalReactionMagnitude(staticSolve.result.reactionForce), 1e-9);
  const equivalentStiffness = Math.max(equivalentForce / staticDisplacement, 1e-9);
  const damping = 2 * settings.dampingRatio * Math.sqrt(equivalentStiffness * equivalentMass);
  const integratedFrames = integrateDynamicFrames(settings, equivalentForce, equivalentMass, equivalentStiffness, damping);
  const frames = integratedFrames.map((frame) => dynamicResultFrame(frame, staticSolve.result, staticDisplacement));

  const diagnostics: DynamicTet4CpuDiagnostics = {
    ...staticSolve.diagnostics,
    frameCount: frames.length,
    startTime: settings.startTime,
    endTime: settings.endTime,
    timeStep: settings.timeStep,
    outputInterval: settings.outputInterval,
    dampingRatio: settings.dampingRatio,
    loadProfile: settings.loadProfile,
    equivalentMass,
    equivalentStiffness,
    peakDisplacement: Math.max(...integratedFrames.map((frame) => Math.abs(frame.displacement)), 0),
    peakVelocity: Math.max(...integratedFrames.map((frame) => Math.abs(frame.velocity)), 0),
    peakAcceleration: Math.max(...integratedFrames.map((frame) => Math.abs(frame.acceleration)), 0)
  };

  return {
    ok: true,
    result: {
      staticResult: staticSolve.result,
      frames
    },
    diagnostics
  };
}

function dynamicSettings(options: DynamicTet4CpuOptions): DynamicSettings {
  const timeStep = Math.max(finiteOr(options.timeStep, DEFAULT_TIME_STEP_SECONDS), 1e-6);
  return {
    startTime: finiteOr(options.startTime, 0),
    endTime: finiteOr(options.endTime, DEFAULT_END_TIME_SECONDS),
    timeStep,
    outputInterval: Math.max(finiteOr(options.outputInterval, DEFAULT_OUTPUT_INTERVAL_SECONDS), timeStep),
    dampingRatio: Math.max(finiteOr(options.dampingRatio, DEFAULT_DAMPING_RATIO), 0),
    loadProfile: isDynamicLoadProfile(options.loadProfile) ? options.loadProfile : "ramp",
    massDensity: Math.max(finiteOr(options.massDensity, DEFAULT_MASS_DENSITY_KG_PER_M3), 1e-9)
  };
}

function integrateDynamicFrames(
  settings: DynamicSettings,
  force: number,
  mass: number,
  stiffness: number,
  damping: number
): IntegratedFrame[] {
  const beta = 0.25;
  const gamma = 0.5;
  const frames: IntegratedFrame[] = [];
  let time = settings.startTime;
  let displacement = 0;
  let velocity = 0;
  let acceleration = (loadScaleAt(time, settings) * force - damping * velocity - stiffness * displacement) / mass;
  let frameIndex = 0;
  let nextOutputTime = settings.startTime + settings.outputInterval;
  const maxSteps = Math.ceil((settings.endTime - settings.startTime) / settings.timeStep) + 2;
  const pushFrame = () => {
    frames.push({
      index: frameIndex,
      time: round(time, 9),
      loadScale: loadScaleAt(time, settings),
      displacement,
      velocity,
      acceleration
    });
    frameIndex += 1;
  };

  pushFrame();
  for (let step = 0; step < maxSteps && time < settings.endTime - 1e-12; step += 1) {
    const nextTime = Math.min(time + settings.timeStep, settings.endTime);
    const dt = nextTime - time;
    const a0 = 1 / (beta * dt * dt);
    const a1 = gamma / (beta * dt);
    const a2 = 1 / (beta * dt);
    const a3 = 1 / (2 * beta) - 1;
    const a4 = gamma / beta - 1;
    const a5 = dt * (gamma / (2 * beta) - 1);
    const effectiveStiffness = stiffness + a0 * mass + a1 * damping;
    const nextForce = loadScaleAt(nextTime, settings) * force;
    const effectiveForce = nextForce
      + mass * (a0 * displacement + a2 * velocity + a3 * acceleration)
      + damping * (a1 * displacement + a4 * velocity + a5 * acceleration);
    const nextDisplacement = effectiveForce / effectiveStiffness;
    const nextAcceleration = a0 * (nextDisplacement - displacement) - a2 * velocity - a3 * acceleration;
    const nextVelocity = velocity + dt * ((1 - gamma) * acceleration + gamma * nextAcceleration);

    time = nextTime;
    displacement = nextDisplacement;
    velocity = nextVelocity;
    acceleration = nextAcceleration;

    if (time >= nextOutputTime - 1e-12 || time >= settings.endTime - 1e-12) {
      pushFrame();
      while (nextOutputTime <= time + 1e-12) nextOutputTime += settings.outputInterval;
    }
  }
  return frames;
}

function dynamicResultFrame(frame: IntegratedFrame, staticResult: StaticLinearTet4CpuResult, staticDisplacement: number): DynamicTet4CpuFrame {
  const displacementScale = frame.displacement / staticDisplacement;
  const velocityScale = frame.velocity / staticDisplacement;
  const accelerationScale = frame.acceleration / staticDisplacement;
  return {
    index: frame.index,
    time: frame.time,
    loadScale: frame.loadScale,
    displacement: scaleArray(staticResult.displacement, displacementScale),
    velocity: scaleArray(staticResult.displacement, velocityScale),
    acceleration: scaleArray(staticResult.displacement, accelerationScale),
    strain: scaleArray(staticResult.strain, displacementScale),
    stress: scaleArray(staticResult.stress, displacementScale),
    vonMises: scaleArray(staticResult.vonMises, Math.abs(displacementScale))
  };
}

function getNormalizedModel(input: CpuSolverInput): { ok: true; model: NormalizedOpenCAEModel } | { ok: false; error: CpuSolverError } {
  if (isNormalizedModel(input)) return { ok: true, model: input };
  const result = normalizeModelJson(input);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: "validation-failed",
        message: "Input model failed OpenCAE Core validation.",
        report: result.report
      }
    };
  }
  return { ok: true, model: result.model };
}

function isNormalizedModel(input: CpuSolverInput): input is NormalizedOpenCAEModel {
  return input.nodes.coordinates instanceof Float64Array;
}

function computeEquivalentMass(model: NormalizedOpenCAEModel, density: number): number {
  let volume = 0;
  for (const block of model.elementBlocks) {
    for (let offset = 0; offset < block.connectivity.length; offset += 4) {
      const geometry = computeTet4Geometry(tetCoordinates(model.nodes.coordinates, block.connectivity, offset));
      if (geometry.ok) volume += geometry.volume;
    }
  }
  return Math.max(volume * density, 1e-9);
}

function tetCoordinates(coordinates: Float64Array, connectivity: Uint32Array, offset: number): Float64Array {
  const result = new Float64Array(12);
  for (let localNode = 0; localNode < 4; localNode += 1) {
    const node = connectivity[offset + localNode] ?? 0;
    result[localNode * 3] = coordinates[node * 3] ?? 0;
    result[localNode * 3 + 1] = coordinates[node * 3 + 1] ?? 0;
    result[localNode * 3 + 2] = coordinates[node * 3 + 2] ?? 0;
  }
  return result;
}

function totalReactionMagnitude(reactionForce: Float64Array): number {
  let total = 0;
  for (let index = 0; index < reactionForce.length; index += 3) {
    total += Math.hypot(reactionForce[index] ?? 0, reactionForce[index + 1] ?? 0, reactionForce[index + 2] ?? 0);
  }
  return total;
}

function scaleArray(values: Float64Array, scale: number): Float64Array {
  return Float64Array.from(values, (value) => value * scale);
}

function loadScaleAt(time: number, settings: DynamicSettings): number {
  if (settings.loadProfile === "ramp" || settings.loadProfile === "quasiStatic") {
    return clamp((time - settings.startTime) / Math.max(settings.endTime - settings.startTime, settings.timeStep), 0, 1);
  }
  if (settings.loadProfile === "sinusoidal") {
    return Math.sin(2 * Math.PI * clamp((time - settings.startTime) / Math.max(settings.endTime - settings.startTime, settings.timeStep), 0, 1));
  }
  return 1;
}

function isDynamicLoadProfile(value: unknown): value is DynamicLoadProfile {
  return value === "step" || value === "ramp" || value === "quasiStatic" || value === "sinusoidal";
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function failure(code: string, message: string): DynamicTet4CpuSolveResult {
  return {
    ok: false,
    error: { code, message }
  };
}
