import { type NormalizedOpenCAEModel } from "@opencae/core";
import { dynamicCoreResultFromSolve } from "./results";
import { boundedStructuralMaxDofs, structuralDofCount, structuralDofLimitError } from "./limits";
import {
  assembleNodalForcesWithDiagnostics,
  elementNodeCountForBlock,
  getNormalizedModel,
  maxAbs,
  recoverElementResults
} from "./solver";
import { addSparseEntry, conjugateGradient, createSparseMatrixBuilder, csrMatVec, reduceCsrRhs, toCsrMatrix, type CsrMatrix } from "./sparse";
import { expandFreeVector, hasAdvancedLoadPrimitives, prepareStructuralSystem, type PreparedStructuralSystem } from "./structural-system";
import { solveModalSubspace } from "./modal";
import type {
  CpuSolverError,
  CpuSolverInput,
  DynamicLoadProfile,
  DynamicResultField,
  DynamicTet4CpuResult,
  DynamicTet4CpuDiagnostics,
  DynamicTet4CpuFrame,
  DynamicTet4CpuOptions,
  DynamicTet4CpuSolveResult
} from "./types";

const DEFAULT_END_TIME_SECONDS = 0.1;
const DEFAULT_TIME_STEP_SECONDS = 0.005;
const DEFAULT_OUTPUT_INTERVAL_SECONDS = 0.005;
const DEFAULT_DAMPING_RATIO = 0.02;
const DEFAULT_MAX_FRAMES = 10000;

type DynamicSettings = {
  startTime: number;
  endTime: number;
  timeStep: number;
  outputInterval: number;
  dampingRatio: number;
  rayleighAlpha?: number;
  rayleighBeta?: number;
  loadProfile: Exclude<DynamicLoadProfile, "quasiStatic" | "sinusoidal">;
  maxFrames: number;
};

type ReducedSystem = PreparedStructuralSystem;

export type DynamicLoadCaseInput = { id: string; stepIndex: number };
export type DynamicLoadCaseSolve = { id: string; result: DynamicTet4CpuResult; diagnostics: DynamicTet4CpuDiagnostics };
export type DynamicLoadCaseBatchSolveResult =
  | { ok: true; cases: DynamicLoadCaseSolve[] }
  | { ok: false; error: CpuSolverError; caseId?: string; diagnostics?: Partial<DynamicTet4CpuDiagnostics> };

export function solveDynamicLinearTetMDOF(
  input: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): DynamicTet4CpuSolveResult {
  return solveDynamicMdofTet4Cpu(input, options);
}

export function solveDynamicMdofTet4Cpu(
  input: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): DynamicTet4CpuSolveResult {
  const modelResult = getNormalizedModel(input);
  if (!modelResult.ok) return { ok: false, error: modelResult.error };
  const model = modelResult.model;
  const dofs = structuralDofCount(model);
  const maxDofs = boundedStructuralMaxDofs(options.maxDofs);
  const limitError = structuralDofLimitError(dofs, maxDofs);
  if (limitError) return { ok: false, error: limitError, diagnostics: { dofs } };
  const settings = dynamicSettings(model, options);
  if (settings.endTime <= settings.startTime) {
    return failure("invalid-time-range", "Dynamic solve endTime must be greater than startTime.");
  }
  const expectedFrameCount = estimateFrameCount(settings);
  if (expectedFrameCount > settings.maxFrames) {
    return failure("too-many-frames", `Dynamic solve would produce ${expectedFrameCount} frames, exceeding maxFrames ${settings.maxFrames}.`);
  }

  const step = model.steps[options.stepIndex ?? 0];
  if (!step || (step.type !== "staticLinear" && step.type !== "dynamicLinear")) {
    return failure("invalid-step", "Selected dynamic step must be staticLinear or dynamicLinear.");
  }

  const hooks = options.hooks;
  const prepared = prepareStructuralSystem(model, step.boundaryConditions, step.loads, hooks);
  if (!prepared.ok) return prepared;
  return solveDynamicPreparedSystem(model, prepared.system, settings, options);
}

/** Batch dynamic cases share K/M and supports while every case starts from rest. */
export function solveDynamicLinearTetLoadCases(
  input: CpuSolverInput,
  cases: DynamicLoadCaseInput[],
  options: DynamicTet4CpuOptions = {},
  onCaseComplete?: (solved: DynamicLoadCaseSolve) => void,
  retainCompletedCases = true
): DynamicLoadCaseBatchSolveResult {
  const modelResult = getNormalizedModel(input);
  if (!modelResult.ok) return { ok: false, error: modelResult.error };
  const model = modelResult.model;
  const dofs = structuralDofCount(model);
  const maxDofs = boundedStructuralMaxDofs(options.maxDofs);
  const limitError = structuralDofLimitError(dofs, maxDofs);
  if (limitError) return { ok: false, error: limitError, diagnostics: { dofs } };
  if (!cases.length) return { ok: false, error: { code: "missing-load-cases", message: "At least one enabled dynamic load case is required." } };
  const steps = cases.map((loadCase) => ({ loadCase, step: model.steps[loadCase.stepIndex] }));
  if (steps.some(({ step }) => step?.type !== "dynamicLinear")) {
    return { ok: false, error: { code: "invalid-step", message: "Every dynamic load case must reference a dynamicLinear step." } };
  }
  const dynamicSteps = steps as Array<{ loadCase: DynamicLoadCaseInput; step: Extract<NormalizedOpenCAEModel["steps"][number], { type: "dynamicLinear" }> }>;
  const firstStep = dynamicSteps[0]!.step;
  if (dynamicSteps.some(({ step }) => !sameStrings(step.boundaryConditions, firstStep.boundaryConditions))) {
    return { ok: false, error: { code: "case-support-mismatch", message: "Dynamic load cases must share identical supports." } };
  }
  if (dynamicSteps.some(({ step }) => !sameDynamicStepSettings(step, firstStep))) {
    return { ok: false, error: { code: "case-solver-settings-mismatch", message: "Dynamic load cases must share identical time integration and damping settings." } };
  }
  const prepared = prepareStructuralSystem(model, firstStep.boundaryConditions, firstStep.loads, options.hooks);
  if (!prepared.ok) return prepared;
  const sharedSettings = dynamicSettings(model, { ...options, stepIndex: cases[0]!.stepIndex });
  const sharedDamping = resolveRayleighDamping(prepared.system, sharedSettings, options);
  const solvedCases: DynamicLoadCaseSolve[] = [];
  for (const { loadCase, step } of dynamicSteps) {
    const loadAssembly = assembleNodalForcesWithDiagnostics(model, step.loads);
    if (!loadAssembly.ok) return { ok: false, error: loadAssembly.error, caseId: loadCase.id };
    const fullLoad = loadAssembly.forces;
    const system: PreparedStructuralSystem = {
      ...prepared.system,
      fullLoad,
      load: reduceCsrRhs(prepared.system.fullStiffness, fullLoad, prepared.system.free, prepared.system.constraints),
      loadAssembly: hasAdvancedLoadPrimitives(model, step.loads) ? loadAssembly.diagnostics : undefined
    };
    const settings = dynamicSettings(model, { ...options, stepIndex: loadCase.stepIndex });
    const solved = solveDynamicPreparedSystem(model, system, settings, { ...options, stepIndex: loadCase.stepIndex }, sharedDamping);
    if (!solved.ok) return { ...solved, caseId: loadCase.id };
    const entry = { id: loadCase.id, result: solved.result, diagnostics: solved.diagnostics };
    onCaseComplete?.(entry);
    if (retainCompletedCases) solvedCases.push(entry);
  }
  return { ok: true, cases: solvedCases };
}

function solveDynamicPreparedSystem(
  model: NormalizedOpenCAEModel,
  system: PreparedStructuralSystem,
  settings: DynamicSettings,
  options: DynamicTet4CpuOptions,
  sharedDamping?: RayleighResolution
): DynamicTet4CpuSolveResult {
  if (settings.endTime <= settings.startTime) return failure("invalid-time-range", "Dynamic solve endTime must be greater than startTime.");
  const expectedFrameCount = estimateFrameCount(settings);
  if (expectedFrameCount > settings.maxFrames) {
    return failure("too-many-frames", `Dynamic solve would produce ${expectedFrameCount} frames, exceeding maxFrames ${settings.maxFrames}.`);
  }
  const hooks = options.hooks;
  const free = system.free;
  const damping = sharedDamping ?? resolveRayleighDamping(system, settings, options);
  const rayleighAlpha = damping.alpha;
  const rayleighBeta = damping.beta;

  const frames: DynamicTet4CpuFrame[] = [];
  const convergence: DynamicTet4CpuDiagnostics["convergence"] = [];
  const u = new Float64Array(free.length);
  const v = new Float64Array(free.length);
  let a = initialAcceleration(system, settings, rayleighAlpha, rayleighBeta);
  let time = settings.startTime;
  let frameIndex = 0;
  let nextOutputTime = settings.startTime + settings.outputInterval;
  const pushFrame = (loadScale: number): CpuSolverError | undefined => {
    const created = createFrame(model, system, free, u, v, a, frameIndex, round(time, 9), loadScale);
    if (!created.ok) return created.error;
    frames.push(created.frame);
    if (convergence.length < frameIndex + 1) {
      convergence.push({ frameIndex, timeSeconds: round(time, 9), iterations: 0, residualNorm: 0, relativeResidual: 0 });
    }
    frameIndex += 1;
    hooks?.onProgress?.({ phase: "frames", completed: frameIndex, total: expectedFrameCount });
    return undefined;
  };
  const initialFrameError = pushFrame(loadScaleAt(time, settings));
  if (initialFrameError) return { ok: false, error: initialFrameError };

  const maxSteps = Math.ceil((settings.endTime - settings.startTime) / settings.timeStep) + 2;
  let effectiveCache: { dt: number; matrix: CsrMatrix } | undefined;
  for (let stepIndex = 0; stepIndex < maxSteps && time < settings.endTime - 1e-12; stepIndex += 1) {
    if (hooks?.shouldCancel?.()) {
      return failure("cancelled", "Solve cancelled.");
    }
    const nextTime = Math.min(time + settings.timeStep, settings.endTime);
    const dt = nextTime - time;
    if (!effectiveCache || effectiveCache.dt !== dt) {
      // The effective Newmark matrix only depends on dt, so it is factor-free reusable across steps.
      const a0 = 1 / (0.25 * dt * dt);
      const a1 = 0.5 / (0.25 * dt);
      effectiveCache = {
        dt,
        matrix: effectiveMatrix(system.stiffness, system.mass, a0 + a1 * rayleighAlpha, 1 + a1 * rayleighBeta)
      };
    }
    const next = newmarkStep(system, effectiveCache.matrix, u, v, a, loadScaleAt(nextTime, settings), dt, rayleighAlpha, rayleighBeta, options);
    if (!next.ok) return { ok: false, error: next.error };
    u.set(next.u);
    v.set(next.v);
    a = next.a;
    time = nextTime;
    if (time >= nextOutputTime - 1e-12 || time >= settings.endTime - 1e-12) {
      convergence.push({
        frameIndex,
        timeSeconds: round(time, 9),
        iterations: next.iterations,
        residualNorm: next.residualNorm,
        relativeResidual: next.relativeResidual
      });
      const frameError = pushFrame(loadScaleAt(time, settings));
      if (frameError) return { ok: false, error: frameError };
      while (nextOutputTime <= time + 1e-12) nextOutputTime += settings.outputInterval;
    }
  }

  const peakDisplacement = Math.max(...frames.map((frame) => maxNodeVectorNorm(frame.displacement.values)), 0);
  const peakVelocity = Math.max(...frames.map((frame) => maxAbs(frame.velocity.values)), 0);
  const peakAcceleration = Math.max(...frames.map((frame) => maxAbs(frame.acceleration.values)), 0);
  const peakStress = Math.max(...frames.map((frame) => maxAbs(frame.stress.values)), 0);
  const minSafetyFactor = minimumPositiveFinite(frames.map((frame) => frame.safety_factor.values));
  const equivalentMass = system.totalMass;
  const equivalentStiffness = estimateEquivalentStiffness(system);

  const diagnostics: DynamicTet4CpuDiagnostics = {
    dofs: structuralDofCount(model),
    freeDofs: free.length,
    constrainedDofs: system.constraints.size,
    relativeResidual: 0,
    maxDisplacement: peakDisplacement,
    maxVonMisesStress: Math.max(...frames.map((frame) => maxAbs((frame.vonMisesPeak ?? frame.vonMises).values)), 0),
    solverMode: "sparse",
    converged: true,
    ...(system.loadAssembly ? { loadAssembly: system.loadAssembly } : {}),
    frameCount: frames.length,
    visualizationSmoothing: options.visualizationSmoothing,
    startTime: settings.startTime,
    endTime: settings.endTime,
    timeStep: settings.timeStep,
    outputInterval: settings.outputInterval,
    dampingRatio: settings.dampingRatio,
    rayleighAlpha,
    rayleighBeta,
    rayleighCalibration: damping.calibration,
    newmarkGamma: 0.5,
    newmarkBeta: 0.25,
    loadProfile: settings.loadProfile,
    equivalentMass,
    equivalentStiffness,
    peakDisplacement,
    peakStress,
    peakVelocity,
    peakAcceleration,
    minSafetyFactor,
    convergence,
    totalMass: system.totalMass,
    reactionBalance: convergence.map((entry) => ({
      frameIndex: entry.frameIndex,
      timeSeconds: entry.timeSeconds,
      loadScale: loadScaleAt(entry.timeSeconds, settings),
      relativeImbalance: entry.relativeResidual
    })),
    solver: "opencae-core-mdof-newmark"
  };

  const dynamicResult: DynamicTet4CpuResult = {
    staticResult: {
      displacement: frames.at(-1)?.displacement.values ?? new Float64Array(model.counts.nodes * 3),
      reactionForce: frames.at(-1)?.reactionForce ?? new Float64Array(model.counts.nodes * 3),
      strain: frames.at(-1)?.strain.values ?? new Float64Array(model.counts.elements * 6),
      stress: frames.at(-1)?.stress.values ?? new Float64Array(model.counts.elements * 6),
      vonMises: frames.at(-1)?.vonMises.values ?? new Float64Array(model.counts.elements),
      nodalVonMises: frames.at(-1)?.nodalVonMises?.values,
      nodalStress: frames.at(-1)?.nodalStress?.values,
      vonMisesPeak: frames.at(-1)?.vonMisesPeak?.values,
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: model.meshProvenance?.meshSource === "actual_volume_mesh" ? "actual_volume_mesh" : "structured_block_core"
      }
    },
    frames
  };
  dynamicResult.coreResult = dynamicCoreResultFromSolve(model, dynamicResult, diagnostics);
  dynamicResult.staticResult.coreResult = dynamicResult.coreResult;

  return {
    ok: true,
    result: dynamicResult,
    diagnostics
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDynamicStepSettings(
  left: Extract<NormalizedOpenCAEModel["steps"][number], { type: "dynamicLinear" }>,
  right: Extract<NormalizedOpenCAEModel["steps"][number], { type: "dynamicLinear" }>
): boolean {
  return left.startTime === right.startTime
    && left.endTime === right.endTime
    && left.timeStep === right.timeStep
    && left.outputInterval === right.outputInterval
    && left.loadProfile === right.loadProfile
    && left.dampingRatio === right.dampingRatio
    && left.rayleighAlpha === right.rayleighAlpha
    && left.rayleighBeta === right.rayleighBeta;
}

/**
 * Find the minimum valid value without flattening fields or spreading them into
 * Math.min. Production dynamic runs can contain millions of element values
 * across their frames, which exceeds browser function-argument limits.
 */
export function minimumPositiveFinite(fields: Iterable<ArrayLike<number>>): number | undefined {
  let minimum: number | undefined;
  for (const values of fields) {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value > 0 && Number.isFinite(value) && (minimum === undefined || value < minimum)) {
        minimum = value;
      }
    }
  }
  return minimum;
}

function dynamicSettings(model: NormalizedOpenCAEModel, options: DynamicTet4CpuOptions): DynamicSettings {
  const selectedStep = model.steps[options.stepIndex ?? 0];
  const dynamicStep = selectedStep?.type === "dynamicLinear" ? selectedStep : undefined;
  const timeStep = Math.max(finiteOr(options.timeStep, dynamicStep?.timeStep ?? DEFAULT_TIME_STEP_SECONDS), 1e-6);
  const profile = options.loadProfile ?? dynamicStep?.loadProfile ?? "ramp";
  return {
    startTime: finiteOr(options.startTime, dynamicStep?.startTime ?? 0),
    endTime: finiteOr(options.endTime, dynamicStep?.endTime ?? DEFAULT_END_TIME_SECONDS),
    timeStep,
    outputInterval: Math.max(finiteOr(options.outputInterval, dynamicStep?.outputInterval ?? DEFAULT_OUTPUT_INTERVAL_SECONDS), timeStep),
    dampingRatio: Math.max(finiteOr(options.dampingRatio, dynamicStep?.dampingRatio ?? DEFAULT_DAMPING_RATIO), 0),
    rayleighAlpha: options.rayleighAlpha ?? dynamicStep?.rayleighAlpha,
    rayleighBeta: options.rayleighBeta ?? dynamicStep?.rayleighBeta,
    loadProfile: canonicalDynamicLoadProfile(profile),
    maxFrames: Math.max(Math.floor(finiteOr(options.maxFrames, DEFAULT_MAX_FRAMES)), 1)
  };
}

type RayleighResolution = {
  alpha: number;
  beta: number;
  calibration: NonNullable<DynamicTet4CpuDiagnostics["rayleighCalibration"]>;
};

// Calibrate Rayleigh damping so the requested damping ratio actually holds at the
// structure's fundamental frequency (and at RAYLEIGH_UPPER_FREQUENCY_RATIO times it),
// instead of applying magic per-coefficient constants.
const RAYLEIGH_UPPER_FREQUENCY_RATIO = 4;
function resolveRayleighDamping(
  system: ReducedSystem,
  settings: DynamicSettings,
  options: DynamicTet4CpuOptions
): RayleighResolution {
  if (settings.rayleighAlpha !== undefined || settings.rayleighBeta !== undefined) {
    return {
      alpha: settings.rayleighAlpha ?? 0,
      beta: settings.rayleighBeta ?? 0,
      calibration: { method: "explicit" }
    };
  }
  if (!(settings.dampingRatio > 0)) {
    return { alpha: 0, beta: 0, calibration: { method: "undamped" } };
  }

  const modal = solveModalSubspace(system, 1, {
    maxCgIterations: options.maxIterations,
    hooks: options.hooks,
    frequencyEstimateSeed: system.load,
    frequencyEstimateIterations: 4
  });
  const omega1 = modal.ok && modal.modes[0]
    ? Math.sqrt(modal.modes[0].eigenvalue)
    : undefined;
  if (omega1 === undefined) {
    // Static SDOF estimate as a fallback: load-shape Rayleigh quotient over lumped mass.
    const equivalentStiffness = estimateEquivalentStiffness(system);
    const equivalentMass = averageMass(system.mass);
    const fallbackOmega = equivalentMass > 0 ? Math.sqrt(Math.max(equivalentStiffness, 0) / equivalentMass) : 0;
    if (!(fallbackOmega > 0)) {
      return { alpha: 0, beta: 0, calibration: { method: "uncalibrated" } };
    }
    return rayleighFromFrequencies(settings.dampingRatio, fallbackOmega, "static_estimate");
  }
  return rayleighFromFrequencies(settings.dampingRatio, omega1, "modal_estimate");
}

function rayleighFromFrequencies(
  dampingRatio: number,
  omega1: number,
  method: "modal_estimate" | "static_estimate"
): RayleighResolution {
  const omega2 = omega1 * RAYLEIGH_UPPER_FREQUENCY_RATIO;
  return {
    alpha: (2 * dampingRatio * omega1 * omega2) / (omega1 + omega2),
    beta: (2 * dampingRatio) / (omega1 + omega2),
    calibration: {
      method,
      fundamentalFrequencyHz: omega1 / (2 * Math.PI),
      omega1,
      omega2
    }
  };
}

function averageMass(mass: Float64Array): number {
  if (mass.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < mass.length; i += 1) sum += mass[i];
  return sum / mass.length;
}

function newmarkStep(
  system: ReducedSystem,
  effective: CsrMatrix,
  u: Float64Array,
  v: Float64Array,
  a: Float64Array,
  loadScale: number,
  dt: number,
  rayleighAlpha: number,
  rayleighBeta: number,
  options: DynamicTet4CpuOptions
): {
  ok: true;
  u: Float64Array;
  v: Float64Array;
  a: Float64Array;
  iterations: number;
  residualNorm: number;
  relativeResidual: number;
} | { ok: false; error: CpuSolverError } {
  const beta = 0.25;
  const gamma = 0.5;
  const a0 = 1 / (beta * dt * dt);
  const a1 = gamma / (beta * dt);
  const a2 = 1 / (beta * dt);
  const a3 = 1 / (2 * beta) - 1;
  const a4 = gamma / beta - 1;
  const a5 = dt * (gamma / (2 * beta) - 1);
  const historyMass = new Float64Array(u.length);
  for (let i = 0; i < u.length; i += 1) {
    historyMass[i] = system.mass[i] * (a0 * u[i] + a2 * v[i] + a3 * a[i]);
  }
  const dampingHistoryVector = new Float64Array(u.length);
  for (let i = 0; i < u.length; i += 1) {
    dampingHistoryVector[i] = a1 * u[i] + a4 * v[i] + a5 * a[i];
  }
  const dampingHistory = dampingProduct(system, dampingHistoryVector, rayleighAlpha, rayleighBeta);
  const rhs = new Float64Array(u.length);
  for (let i = 0; i < rhs.length; i += 1) {
    rhs[i] = loadScale * system.load[i] + historyMass[i] + dampingHistory[i];
  }
  const solve = conjugateGradient(effective, rhs, {
    tolerance: options.tolerance ?? 1e-10,
    maxIterations: options.maxIterations,
    jacobi: true,
    // The previous displacement is an excellent predictor for the next one, so CG
    // typically converges in a small fraction of the cold-start iteration count.
    initialGuess: u
  });
  if (!solve.ok) return { ok: false, error: solve.error };
  const nextU = solve.solution;
  const nextA = new Float64Array(u.length);
  const nextV = new Float64Array(u.length);
  for (let i = 0; i < u.length; i += 1) {
    nextA[i] = a0 * (nextU[i] - u[i]) - a2 * v[i] - a3 * a[i];
    nextV[i] = v[i] + dt * ((1 - gamma) * a[i] + gamma * nextA[i]);
  }
  return {
    ok: true,
    u: nextU,
    v: nextV,
    a: nextA,
    iterations: solve.iterations,
    residualNorm: solve.residualNorm,
    relativeResidual: solve.relativeResidual
  };
}

function initialAcceleration(
  system: ReducedSystem,
  settings: DynamicSettings,
  rayleighAlpha: number,
  rayleighBeta: number
): Float64Array {
  const acceleration = new Float64Array(system.free.length);
  const forceScale = loadScaleAt(settings.startTime, settings);
  const damping = dampingProduct(system, new Float64Array(system.free.length), rayleighAlpha, rayleighBeta);
  const stiffness = csrMatVec(system.stiffness, new Float64Array(system.free.length));
  for (let i = 0; i < acceleration.length; i += 1) {
    acceleration[i] = (forceScale * system.load[i] - damping[i] - stiffness[i]) / system.mass[i];
  }
  return acceleration;
}

function effectiveMatrix(stiffness: CsrMatrix, mass: Float64Array, massScale: number, stiffnessScale: number): CsrMatrix {
  const builder = createSparseMatrixBuilder(
    stiffness.rowCount,
    stiffness.colCount,
    stiffness.values.length + mass.length
  );
  for (let row = 0; row < stiffness.rowCount; row += 1) {
    for (let entry = stiffness.rowPtr[row]; entry < stiffness.rowPtr[row + 1]; entry += 1) {
      addSparseEntry(builder, row, stiffness.colInd[entry], stiffness.values[entry] * stiffnessScale);
    }
    addSparseEntry(builder, row, row, mass[row] * massScale);
  }
  return toCsrMatrix(builder);
}

function dampingProduct(system: ReducedSystem, vector: Float64Array, alpha: number, beta: number): Float64Array {
  const result = new Float64Array(vector.length);
  const kv = beta !== 0 ? csrMatVec(system.stiffness, vector) : new Float64Array(vector.length);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = alpha * system.mass[i] * vector[i] + beta * kv[i];
  }
  return result;
}

function createFrame(
  model: NormalizedOpenCAEModel,
  system: ReducedSystem,
  free: Int32Array,
  reducedU: Float64Array,
  reducedV: Float64Array,
  reducedA: Float64Array,
  frameIndex: number,
  timeSeconds: number,
  loadScale: number
): { ok: true; frame: DynamicTet4CpuFrame } | { ok: false; error: CpuSolverError } {
  const displacement = expandFreeVector(model.counts.nodes * 3, free, reducedU, system.constraints);
  const velocity = expandFreeVector(model.counts.nodes * 3, free, reducedV);
  const acceleration = expandFreeVector(model.counts.nodes * 3, free, reducedA);
  const recovery = recoverElementResults(model, displacement);
  if (!recovery.ok) {
    // A silently zero-filled frame renders as a flat contour, which is exactly the class
    // of defect these results exist to prevent. Fail the whole solve, matching the
    // static path's abort-on-recovery-failure policy.
    return {
      ok: false,
      error: {
        code: recovery.error.code,
        message: `Dynamic frame ${frameIndex} (t=${timeSeconds}s) stress recovery failed: ${recovery.error.message}`
      }
    };
  }
  const safetyFactor = computeSafetyFactor(model, recovery.vonMisesPeak);
  const reactionForce = computeReactionForce(system, displacement, loadScale);
  return {
    ok: true,
    frame: {
      frameIndex,
      timeSeconds,
      loadScale,
      displacement: field(displacement, frameIndex, timeSeconds),
      velocity: field(velocity, frameIndex, timeSeconds),
      acceleration: field(acceleration, frameIndex, timeSeconds),
      strain: field(recovery.strain, frameIndex, timeSeconds),
      stress: field(recovery.stress, frameIndex, timeSeconds),
      vonMises: field(recovery.vonMises, frameIndex, timeSeconds),
      nodalVonMises: field(recovery.nodalVonMises, frameIndex, timeSeconds),
      nodalStress: field(recovery.nodalStress, frameIndex, timeSeconds),
      vonMisesPeak: field(recovery.vonMisesPeak, frameIndex, timeSeconds),
      safety_factor: field(safetyFactor, frameIndex, timeSeconds),
      reactionForce
    }
  };
}

function computeSafetyFactor(model: NormalizedOpenCAEModel, vonMises: Float64Array): Float64Array {
  const values = new Float64Array(vonMises.length);
  let element = 0;
  for (const block of model.elementBlocks) {
    const yieldStrength = model.materials[block.materialIndex]?.yieldStrength ?? 0;
    const count = Math.floor(block.connectivity.length / (elementNodeCountForBlock(block) ?? 4));
    for (let i = 0; i < count; i += 1) {
      values[element] = yieldStrength > 0 && vonMises[element] > 0 ? yieldStrength / vonMises[element] : 0;
      element += 1;
    }
  }
  return values;
}

function computeReactionForce(system: ReducedSystem, displacement: Float64Array, loadScale: number): Float64Array {
  const internalForce = csrMatVec(system.fullStiffness, displacement);
  const reactionForce = new Float64Array(internalForce.length);
  for (let i = 0; i < reactionForce.length; i += 1) {
    reactionForce[i] = internalForce[i] - loadScale * system.fullLoad[i];
  }
  return reactionForce;
}

function field(values: Float64Array, frameIndex: number, timeSeconds: number): DynamicResultField {
  return {
    values,
    samples: sampleIndices(values.length),
    frameIndex,
    timeSeconds
  };
}

function sampleIndices(length: number): number[] {
  if (length === 0) return [];
  const result = new Set<number>([0, length - 1]);
  if (length > 2) result.add(Math.floor(length / 2));
  return [...result].sort((a, b) => a - b);
}

function maxNodeVectorNorm(values: Float64Array): number {
  let max = 0;
  for (let node = 0; node < values.length / 3; node += 1) {
    max = Math.max(max, Math.hypot(values[node * 3] ?? 0, values[node * 3 + 1] ?? 0, values[node * 3 + 2] ?? 0));
  }
  return max;
}

function estimateEquivalentStiffness(system: ReducedSystem): number {
  const ku = csrMatVec(system.stiffness, system.load);
  const numerator = dot(system.load, ku);
  const denominator = Math.max(dot(system.load, system.load), 1e-30);
  return Math.max(numerator / denominator, 0);
}

function estimateFrameCount(settings: DynamicSettings): number {
  const duration = settings.endTime - settings.startTime;
  return Math.floor(duration / settings.outputInterval) + 2;
}


function loadScaleAt(time: number, settings: DynamicSettings): number {
  const s = clamp((time - settings.startTime) / Math.max(settings.endTime - settings.startTime, settings.timeStep), 0, 1);
  if (settings.loadProfile === "ramp") return s;
  if (settings.loadProfile === "quasi_static") return 3 * s * s - 2 * s * s * s;
  if (settings.loadProfile === "half_sine") return Math.sin(Math.PI * s);
  return 1;
}

function canonicalDynamicLoadProfile(value: unknown): Exclude<DynamicLoadProfile, "quasiStatic" | "sinusoidal"> {
  if (value === "step" || value === "ramp" || value === "quasi_static" || value === "half_sine") return value;
  if (value === "quasiStatic") return "quasi_static";
  if (value === "sinusoidal") return "half_sine";
  return "ramp";
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

function dot(a: Float64Array, b: Float64Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result += a[i] * b[i];
  return result;
}

function failure(code: string, message: string): DynamicTet4CpuSolveResult {
  return {
    ok: false,
    error: { code, message }
  };
}
