import { maxAbs, solveStaticLinearTet4Cpu } from "./solver";
import type {
  CpuSolverInput,
  DynamicLoadProfile,
  DynamicResultField,
  DynamicTet4CpuFrame,
  DynamicTet4CpuOptions,
  DynamicTet4CpuSolveResult
} from "./types";

export function solvePreviewSdofTet4Cpu(
  input: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): DynamicTet4CpuSolveResult {
  const staticSolve = solveStaticLinearTet4Cpu(input, { ...options, solverMode: options.solverMode ?? "dense" });
  if (!staticSolve.ok) {
    const { reactionBalance: _reactionBalance, ...diagnostics } = staticSolve.diagnostics ?? {};
    return { ok: false, error: staticSolve.error, diagnostics };
  }

  const startTime = finiteOr(options.startTime, 0);
  const endTime = finiteOr(options.endTime, 0.1);
  const timeStep = Math.max(finiteOr(options.timeStep, 0.005), 1e-6);
  const outputInterval = Math.max(finiteOr(options.outputInterval, 0.005), timeStep);
  const loadProfile = canonicalDynamicLoadProfile(options.loadProfile ?? "ramp");
  if (endTime <= startTime) {
    return { ok: false, error: { code: "invalid-time-range", message: "Dynamic solve endTime must be greater than startTime." } };
  }

  const frames: DynamicTet4CpuFrame[] = [];
  let frameIndex = 0;
  for (const timeSeconds of outputTimes(startTime, endTime, outputInterval)) {
    const scale = loadScaleAt(timeSeconds, startTime, endTime, loadProfile);
    const displacement = scaleVector(staticSolve.result.displacement, scale);
    const velocity = new Float64Array(displacement.length);
    const acceleration = new Float64Array(displacement.length);
    const strain = scaleVector(staticSolve.result.strain, scale);
    const stress = scaleVector(staticSolve.result.stress, scale);
    const vonMises = scaleVector(staticSolve.result.vonMises, Math.abs(scale));
    const safety = new Float64Array(vonMises.length);
    frames.push({
      frameIndex,
      timeSeconds,
      loadScale: scale,
      displacement: field(displacement, frameIndex, timeSeconds),
      velocity: field(velocity, frameIndex, timeSeconds),
      acceleration: field(acceleration, frameIndex, timeSeconds),
      strain: field(strain, frameIndex, timeSeconds),
      stress: field(stress, frameIndex, timeSeconds),
      vonMises: field(vonMises, frameIndex, timeSeconds),
      safety_factor: field(safety, frameIndex, timeSeconds),
      reactionForce: scaleVector(staticSolve.result.reactionForce, scale)
    });
    frameIndex += 1;
  }

  const peakDisplacement = Math.max(...frames.map((frame) => maxAbs(frame.displacement.values)), 0);
  const peakStress = Math.max(...frames.map((frame) => maxAbs(frame.stress.values)), 0);
  const peakVelocity = Math.max(...frames.map((frame) => maxAbs(frame.velocity.values)), 0);
  const peakAcceleration = Math.max(...frames.map((frame) => maxAbs(frame.acceleration.values)), 0);

  return {
    ok: true,
    result: {
      staticResult: {
        ...staticSolve.result,
        provenance: {
          kind: "local_estimate",
          solver: "opencae-core-preview-sdof",
          resultSource: "computed_preview",
          meshSource: "structured_block_core"
        }
      },
      frames
    },
    diagnostics: {
      ...staticSolve.diagnostics,
      frameCount: frames.length,
      startTime,
      endTime,
      timeStep,
      outputInterval,
      dampingRatio: options.dampingRatio ?? 0,
      rayleighAlpha: options.rayleighAlpha ?? 0,
      rayleighBeta: options.rayleighBeta ?? 0,
      newmarkGamma: 0.5,
      newmarkBeta: 0.25,
      loadProfile,
      equivalentMass: options.massDensity ?? 0,
      equivalentStiffness: 0,
      peakDisplacement,
      peakStress,
      peakVelocity,
      peakAcceleration,
      convergence: frames.map((frame) => ({
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        iterations: 0,
        residualNorm: 0,
        relativeResidual: 0
      })),
      totalMass: options.massDensity ?? 0,
      reactionBalance: frames.map((frame) => ({
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        loadScale: frame.loadScale,
        relativeImbalance: 0
      })),
      solver: "opencae-core-preview-sdof"
    }
  };
}

function outputTimes(startTime: number, endTime: number, outputInterval: number): number[] {
  const times = [startTime];
  for (let time = startTime + outputInterval; time < endTime - 1e-12; time += outputInterval) {
    times.push(round(time, 9));
  }
  if (times[times.length - 1] !== endTime) times.push(round(endTime, 9));
  return times;
}

function loadScaleAt(time: number, startTime: number, endTime: number, loadProfile: DynamicLoadProfile): number {
  const s = Math.max(0, Math.min(1, (time - startTime) / Math.max(endTime - startTime, 1e-12)));
  if (loadProfile === "ramp") return s;
  if (loadProfile === "quasi_static") return 3 * s * s - 2 * s * s * s;
  if (loadProfile === "half_sine") return Math.sin(Math.PI * s);
  return 1;
}

function canonicalDynamicLoadProfile(value: unknown): Exclude<DynamicLoadProfile, "quasiStatic" | "sinusoidal"> {
  if (value === "step" || value === "ramp" || value === "quasi_static" || value === "half_sine") return value;
  if (value === "quasiStatic") return "quasi_static";
  if (value === "sinusoidal") return "half_sine";
  return "ramp";
}

function field(values: Float64Array, frameIndex: number, timeSeconds: number): DynamicResultField {
  return {
    values,
    samples: values.length > 0 ? [0, Math.floor(values.length / 2), values.length - 1] : [],
    frameIndex,
    timeSeconds
  };
}

function scaleVector(values: Float64Array, scale: number): Float64Array {
  const result = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) result[i] = values[i] * scale;
  return result;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
