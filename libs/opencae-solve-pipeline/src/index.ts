/**
 * Browser-local OpenCAE Core solve pipeline.
 *
 * Mirrors the retired OpenCAE Core Cloud runner's /solve pipeline (Core Cloud
 * RUNNER_VERSION 0.1.6; the cloud service itself was retired in 2026-07 —
 * see docs/cloud-retirement.md) step for step from model validation onward:
 *
 *   validateModelJson -> boundedSolverSettings -> solveCoreStatic/solveCoreDynamic
 *     -> stampProvenance -> validateCoreResult -> postprocess diagnostics
 *
 * The golden fixtures in apps/opencae-web/src/testdata/core-cloud-golden are the
 * parity oracle: running this pipeline with CLOUD_SOLVER_LIMITS over a fixture's
 * solved model must reproduce the recorded response numerically (runnerVersion
 * differs by design: the browser stamps "browser-<web app version>").
 */
import {
  OPENCAE_CORE_VERSION,
  validateCoreResult,
  validateModelJson,
  type CoreResultValidationReport,
  type CoreStructuralSolveResult,
  type CoreSolveResult,
  type OpenCAEModelJson
} from "@opencae/core";
import {
  combineStaticLinearTetResults,
  solveDynamicLinearTetLoadCases,
  solveCoreDynamic,
  solveCoreModal,
  solveCoreStatic,
  solveStaticLinearTetLoadCases,
  type SolverHooks
} from "@opencae/solver-cpu";
import { BROWSER_SOLVE_LIMITS, CLOUD_SOLVER_LIMITS, type SolveLimits } from "./limits";

export type { SolveProgressEvent, SolverHooks } from "@opencae/solver-cpu";
export { BROWSER_SOLVE_LIMITS, CLOUD_SOLVER_LIMITS, type SolveLimits } from "./limits";

/** Mirror of the deployed runner's SOLVER_CPU_VERSION stamp (server.ts). */
export const SOLVER_CPU_VERSION = "0.1.5";
/**
 * Browser runner stamp. Same solver ids as the deployed runner, but the
 * runnerVersion identifies the in-browser pipeline and the web app release it
 * shipped with. Keep the suffix in sync with apps/opencae-web/package.json.
 */
export const BROWSER_RUNNER_VERSION = "browser-0.1.0";

export type CorePipelineAnalysisType = "static_stress" | "dynamic_structural" | "modal_analysis";

export type CorePipelineSolverSettings = Record<string, unknown> & {
  stepIndex?: number;
  maxDofs?: number;
  maxIterations?: number;
  tolerance?: number;
  maxFrames?: number;
  startTime?: number;
  endTime?: number;
  timeStep?: number;
  outputInterval?: number;
  allowPreview?: boolean;
  modeCount?: number;
};

/**
 * Rough per-implicit-step wall-clock calibration (ms) for browser dynamic solves
 * at the local structured-block density (~24k DOFs, warm-started CG). Callers
 * should replace it with a measured value when they have one; this default only
 * feeds planning estimates, never result values.
 */
export const DEFAULT_DYNAMIC_MS_PER_STEP = 15;

export function estimateDynamicRuntime({ steps, calibratedMsPerStep = DEFAULT_DYNAMIC_MS_PER_STEP }: {
  steps: number;
  calibratedMsPerStep?: number;
}): { steps: number; calibratedMsPerStep: number; estimatedMs: number } {
  const safeSteps = Number.isFinite(steps) && steps > 0 ? Math.ceil(steps) : 0;
  const perStep = Number.isFinite(calibratedMsPerStep) && calibratedMsPerStep > 0
    ? calibratedMsPerStep
    : DEFAULT_DYNAMIC_MS_PER_STEP;
  return { steps: safeSteps, calibratedMsPerStep: perStep, estimatedMs: Math.round(safeSteps * perStep) };
}

/** Integration steps a bounded dynamic solve will run (before output decimation). */
export function dynamicIntegrationSteps(settings: { startTime?: number; endTime?: number; timeStep?: number }): number {
  const startTime = finiteNumber(settings.startTime) ?? 0;
  const endTime = finiteNumber(settings.endTime) ?? 0;
  const timeStep = finiteNumber(settings.timeStep) ?? 0;
  if (timeStep <= 0 || endTime <= startTime) return 0;
  return Math.ceil((endTime - startTime) / timeStep);
}

export type CorePipelineError = {
  code: string;
  message: string;
  report?: unknown;
};

export type CorePipelineOutcome =
  | { ok: true; result: CoreSolveResult }
  | {
      ok: false;
      /** HTTP status the deployed runner would have answered with. */
      status: number;
      error: CorePipelineError;
      diagnostics?: unknown[];
      artifacts?: Record<string, unknown>;
    };

export type StaticPipelineCase = { id: string; stepIndex: number };
export type StaticPipelineCombination = {
  id: string;
  factors: Array<{ caseId: string; factor: number }>;
};
export type StaticVariantPipelineOutcome =
  | {
      ok: true;
      cases: Array<{ id: string; result: CoreStructuralSolveResult }>;
      combinations: Array<{ id: string; result: CoreStructuralSolveResult }>;
    }
  | {
      ok: false;
      status: number;
      error: CorePipelineError;
      diagnostics?: unknown[];
      caseId?: string;
      combinationId?: string;
    };

export type DynamicPipelineCase = { id: string; stepIndex: number };
export type DynamicVariantPipelineOutcome =
  | { ok: true; cases: Array<{ id: string; result: CoreStructuralSolveResult }> }
  | { ok: false; status: number; error: CorePipelineError; diagnostics?: unknown[]; caseId?: string };

export type SolveStudyModelWithCorePipelineInput = {
  model: OpenCAEModelJson;
  analysisType: CorePipelineAnalysisType;
  solverSettings?: CorePipelineSolverSettings;
  /** Resource limits; defaults to BROWSER_SOLVE_LIMITS. Parity tests pass CLOUD_SOLVER_LIMITS. */
  limits?: SolveLimits;
  hooks?: SolverHooks;
  /** Provenance runnerVersion stamp; defaults to BROWSER_RUNNER_VERSION. */
  runnerVersion?: string;
  /**
   * Diagnostics/artifacts produced by an upstream geometry->model step (the
   * runner's prepareSolveInput). The parity harness feeds the fixture's
   * recorded mesh diagnostics through here; the browser adapter has no
   * geometry step yet and passes nothing.
   */
  preparedDiagnostics?: unknown[];
  preparedArtifacts?: Record<string, unknown>;
};

export function solveStudyModelWithCorePipeline(input: SolveStudyModelWithCorePipelineInput): CorePipelineOutcome {
  const limits = input.limits ?? BROWSER_SOLVE_LIMITS;
  const runnerVersion = input.runnerVersion ?? BROWSER_RUNNER_VERSION;
  const prepared: PreparedState = {
    diagnostics: [...(input.preparedDiagnostics ?? [])],
    artifacts: input.preparedArtifacts ? { ...input.preparedArtifacts } : undefined
  };

  if (input.solverSettings?.allowPreview) {
    return failure(400, { code: "preview-disabled", message: "OpenCAE Core browser pipeline does not allow preview solvers." });
  }

  const model = input.model;
  const validation = validateModelJson(model);
  if (!validation.ok) {
    appendPreparedPhase(prepared, phaseDiagnostic("validation", "failed", "OpenCAE Core model validation failed.", {
      code: "validation-failed",
      errorCount: validation.errors.length
    }));
    return {
      ok: false,
      status: model.meshProvenance?.meshSource === "display_bounds_proxy" ? 400 : 422,
      error: {
        code: "validation-failed",
        message: "Input model failed OpenCAE Core validation.",
        report: validation
      },
      diagnostics: prepared.diagnostics,
      artifacts: prepared.artifacts
    };
  }
  appendPreparedPhase(prepared, phaseDiagnostic("validation", "complete", "OpenCAE Core model validated.", {
    code: "core-model-validated"
  }));
  appendPreparedPhase(prepared, phaseDiagnostic("solve", "started", "OpenCAE Core solve started.", {
    code: "core-solve-started"
  }));
  const solverSettings = boundedSolverSettings(input.analysisType, input.solverSettings, model, limits);
  prepared.diagnostics.push(resourceLimitsDiagnostic(input.analysisType, solverSettings));
  const limitsDeviation = browserLimitsDeviationDiagnostic(limits);
  if (limitsDeviation) prepared.diagnostics.push(limitsDeviation);

  if (input.analysisType === "dynamic_structural") {
    const guard = dynamicBudgetGuard(model, solverSettings, limits);
    if (guard) {
      appendPreparedPhase(prepared, phaseDiagnostic("solve", "failed", guard.message, { code: guard.code }));
      return {
        ok: false,
        status: 422,
        error: guard,
        diagnostics: prepared.diagnostics,
        artifacts: prepared.artifacts
      };
    }
  }

  const result = input.analysisType === "static_stress"
    ? solveCoreStatic(model, { ...solverSettings, method: "sparse", solverMode: "sparse", hooks: input.hooks })
    : input.analysisType === "dynamic_structural"
      ? solveCoreDynamic(model, { ...solverSettings, hooks: input.hooks })
      : solveCoreModal(model, { ...solverSettings, hooks: input.hooks });

  if (!result.ok) {
    appendPreparedPhase(prepared, phaseDiagnostic("solve", "failed", result.error.message, {
      code: result.error.code
    }));
    return {
      ok: false,
      status: result.error.code === "actual-volume-mesh-required" || result.error.code === "insufficient-modal-constraints" ? 422 : 500,
      error: result.error,
      diagnostics: [...prepared.diagnostics, ...(result.diagnostics ? [result.diagnostics] : [])],
      artifacts: prepared.artifacts
    };
  }
  appendPreparedPhase(prepared, phaseDiagnostic("solve", "complete", "OpenCAE Core solve completed.", {
    code: "core-solve-complete"
  }));

  const stamped = stampBrowserProvenance(result.result, runnerVersion, prepared.diagnostics, prepared.artifacts ?? {});
  const resultValidation = validateCoreResult(stamped);
  if (!resultValidation.ok) {
    return {
      ok: false,
      status: 500,
      error: {
        code: "result-validation-failed",
        message: coreResultValidationFailureMessage(resultValidation),
        report: resultValidation
      },
      diagnostics: stamped.diagnostics,
      artifacts: stamped.artifacts as Record<string, unknown> | undefined
    };
  }
  stamped.diagnostics.push(phaseDiagnostic("postprocess", "complete", "OpenCAE Core result postprocessed.", {
    code: "result-postprocessed"
  }));
  if (stamped.artifacts?.meshSummary && typeof stamped.artifacts.meshSummary === "object") {
    const meshSummary = stamped.artifacts.meshSummary as { phaseDiagnostics?: unknown[] };
    meshSummary.phaseDiagnostics = [
      ...((meshSummary.phaseDiagnostics ?? []) as unknown[]),
      phaseDiagnostic("postprocess", "complete", "OpenCAE Core result postprocessed.", {
        code: "result-postprocessed"
      })
    ];
  }

  return { ok: true, result: stamped };
}

/**
 * Static multi-case pipeline. The solver owns one prepared Kff and reuses the
 * previous case displacement as the next CG initial guess; combinations are
 * formed from raw vectors/tensors before any derived stress scalar is rebuilt.
 */
export function solveStaticVariantsWithCorePipeline(input: {
  model: OpenCAEModelJson;
  cases: StaticPipelineCase[];
  combinations?: StaticPipelineCombination[];
  solverSettings?: CorePipelineSolverSettings;
  limits?: SolveLimits;
  hooks?: SolverHooks;
  runnerVersion?: string;
}): StaticVariantPipelineOutcome {
  const validation = validateModelJson(input.model);
  if (!validation.ok) {
    return { ok: false, status: 422, error: { code: "validation-failed", message: "Input model failed OpenCAE Core validation.", report: validation } };
  }
  if (!input.cases.length) {
    return { ok: false, status: 422, error: { code: "missing-load-cases", message: "At least one enabled static load case is required." } };
  }
  const steps = input.cases.map((loadCase) => ({ loadCase, step: input.model.steps[loadCase.stepIndex] }));
  if (steps.some(({ step }) => step?.type !== "staticLinear")) {
    return { ok: false, status: 422, error: { code: "invalid-step", message: "Every static load case must reference a staticLinear step." } };
  }
  const staticSteps = steps.map(({ loadCase, step }) => ({ loadCase, step: step! as Extract<typeof step, { type: "staticLinear" }> }));
  const boundaryConditions = staticSteps[0]!.step.boundaryConditions;
  if (staticSteps.some(({ step }) => !sameStrings(step.boundaryConditions, boundaryConditions))) {
    return { ok: false, status: 422, error: { code: "case-support-mismatch", message: "Static load cases must share identical supports." } };
  }
  const limits = input.limits ?? BROWSER_SOLVE_LIMITS;
  const settings = boundedSolverSettings("static_stress", input.solverSettings, input.model, limits);
  const limitsDeviation = browserLimitsDeviationDiagnostic(limits);
  const diagnostics: unknown[] = [
    resourceLimitsDiagnostic("static_stress", settings),
    ...(limitsDeviation ? [limitsDeviation] : [])
  ];
  const batch = solveStaticLinearTetLoadCases(
    input.model,
    boundaryConditions,
    staticSteps.map(({ loadCase, step }) => ({ id: loadCase.id, loadNames: step.loads })),
    {
      method: "sparse",
      solverMode: "sparse",
      maxDofs: settings.maxDofs,
      maxIterations: settings.maxIterations,
      tolerance: settings.tolerance,
      hooks: input.hooks
    }
  );
  if (!batch.ok) {
    return {
      ok: false,
      status: batch.error.code === "max-dofs-exceeded" ? 422 : 500,
      error: batch.error,
      diagnostics: [...diagnostics, ...(batch.diagnostics ? [batch.diagnostics] : [])],
      ...(batch.caseId ? { caseId: batch.caseId } : {})
    };
  }
  const runnerVersion = input.runnerVersion ?? BROWSER_RUNNER_VERSION;
  const cases = batch.cases.map((solvedCase) => ({
    id: solvedCase.id,
    result: stampAndValidateStaticVariant(solvedCase.result.coreResult!, runnerVersion, diagnostics)
  }));
  const rawByCaseId = new Map(batch.cases.map((solvedCase) => [solvedCase.id, solvedCase.result]));
  const combinations: Array<{ id: string; result: CoreStructuralSolveResult }> = [];
  for (const combination of input.combinations ?? []) {
    const terms = combination.factors.flatMap((factor) => {
      const result = rawByCaseId.get(factor.caseId);
      return result ? [{ factor: factor.factor, result }] : [];
    });
    if (terms.length !== combination.factors.length) {
      return { ok: false, status: 422, combinationId: combination.id, error: { code: "unknown-combination-case", message: `Load combination ${combination.id} references an unsolved or disabled case.` } };
    }
    const combined = combineStaticLinearTetResults(batch.prepared, terms, { visualizationSmoothing: settings.visualizationSmoothing as { iterations?: number; alpha?: number } | undefined });
    if (!combined.ok) {
      return { ok: false, status: 500, combinationId: combination.id, error: combined.error, diagnostics: combined.diagnostics ? [combined.diagnostics] : undefined };
    }
    combinations.push({
      id: combination.id,
      result: stampAndValidateStaticVariant(combined.result.coreResult!, runnerVersion, diagnostics)
    });
  }
  return { ok: true, cases, combinations };
}

/** Dynamic cases share K/M and stream each completed case without retaining the aggregate transient payload. */
export function solveDynamicVariantsWithCorePipeline(input: {
  model: OpenCAEModelJson;
  cases: DynamicPipelineCase[];
  solverSettings?: CorePipelineSolverSettings;
  limits?: SolveLimits;
  hooks?: SolverHooks;
  runnerVersion?: string;
  onCaseComplete?: (entry: { id: string; result: CoreStructuralSolveResult }) => void;
}): DynamicVariantPipelineOutcome {
  const validation = validateModelJson(input.model);
  if (!validation.ok) {
    return { ok: false, status: 422, error: { code: "validation-failed", message: "Input model failed OpenCAE Core validation.", report: validation } };
  }
  if (!input.cases.length) {
    return { ok: false, status: 422, error: { code: "missing-load-cases", message: "At least one enabled dynamic load case is required." } };
  }
  const limits = input.limits ?? BROWSER_SOLVE_LIMITS;
  const settings = boundedSolverSettings("dynamic_structural", { ...input.solverSettings, stepIndex: input.cases[0]!.stepIndex }, input.model, limits);
  const guard = dynamicBudgetGuard(input.model, settings, limits);
  if (guard) return { ok: false, status: 422, error: guard };
  const limitsDeviation = browserLimitsDeviationDiagnostic(limits);
  const diagnostics: unknown[] = [
    resourceLimitsDiagnostic("dynamic_structural", settings),
    ...(limitsDeviation ? [limitsDeviation] : [])
  ];
  const runnerVersion = input.runnerVersion ?? BROWSER_RUNNER_VERSION;
  const firstCompleted: Array<{ id: string; result: CoreStructuralSolveResult }> = [];
  const solved = solveDynamicLinearTetLoadCases(
    input.model,
    input.cases,
    {
      ...settings,
      hooks: input.hooks,
      maxDofs: settings.maxDofs,
      maxIterations: settings.maxIterations,
      tolerance: settings.tolerance
    },
    (entry) => {
      const result = stampAndValidateStaticVariant(entry.result.coreResult!, runnerVersion, diagnostics);
      if (!firstCompleted.length) firstCompleted.push({ id: entry.id, result });
      input.onCaseComplete?.({ id: entry.id, result });
    },
    false
  );
  if (!solved.ok) {
    return {
      ok: false,
      status: solved.error.code === "max-dofs-exceeded" ? 422 : 500,
      error: solved.error,
      diagnostics: solved.diagnostics ? [...diagnostics, solved.diagnostics] : diagnostics,
      ...(solved.caseId ? { caseId: solved.caseId } : {})
    };
  }
  return { ok: true, cases: firstCompleted };
}

function stampAndValidateStaticVariant(
  result: CoreStructuralSolveResult,
  runnerVersion: string,
  diagnostics: unknown[]
): CoreStructuralSolveResult {
  const stamped = stampBrowserProvenance(result, runnerVersion, diagnostics) as CoreStructuralSolveResult;
  const validation = validateCoreResult(stamped);
  if (!validation.ok) throw new Error(coreResultValidationFailureMessage(validation));
  return stamped;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function coreResultValidationFailureMessage(report: CoreResultValidationReport): string {
  return report.errors.some((error) => error.code === "surface-field-length-mismatch")
    ? "Solver surface field length does not match surface mesh node count."
    : "OpenCAE Core result failed surface field alignment validation.";
}

type PreparedState = {
  diagnostics: unknown[];
  artifacts?: Record<string, unknown>;
};

function failure(status: number, error: CorePipelineError): CorePipelineOutcome {
  return { ok: false, status, error };
}

function appendPreparedPhase(prepared: PreparedState, diagnostic: Record<string, unknown>): void {
  prepared.diagnostics.push(diagnostic);
  const meshSummary = prepared.artifacts?.meshSummary;
  if (meshSummary && typeof meshSummary === "object") {
    const summary = meshSummary as { phaseDiagnostics?: unknown[] };
    summary.phaseDiagnostics = [...(summary.phaseDiagnostics ?? []), diagnostic];
  }
}

function phaseDiagnostic(phase: string, status: "started" | "complete" | "failed", message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "core-cloud-phase",
    phase,
    status,
    message,
    ...extra
  };
}

/** Port of the deployed runner's boundedSolverSettings, parameterized by limits. */
export function boundedSolverSettings(
  analysisType: CorePipelineAnalysisType,
  input: CorePipelineSolverSettings | undefined,
  model: OpenCAEModelJson,
  limits: SolveLimits
): CorePipelineSolverSettings {
  const selectedStep = model.steps?.[positiveInteger(input?.stepIndex) ?? 0];
  const dynamicStep = selectedStep?.type === "dynamicLinear" ? selectedStep : undefined;
  const settings: CorePipelineSolverSettings = {
    ...input,
    maxDofs: Math.min(positiveInteger(input?.maxDofs) ?? limits.maxDofs, limits.maxDofs),
    maxIterations: Math.min(positiveInteger(input?.maxIterations) ?? limits.maxIterations, limits.maxIterations),
    tolerance: Math.max(finiteNumber(input?.tolerance) ?? limits.tolerance, limits.tolerance)
  };
  if (analysisType === "dynamic_structural") {
    settings.maxFrames = Math.min(
      positiveInteger(input?.maxFrames) ?? limits.maxFrames,
      limits.maxFrames,
      transientFrameBudget(model, limits.transientFieldBytes)
    );
    settings.endTime = Math.min(
      finiteNumber(input?.endTime) ?? finiteNumber(dynamicStep?.endTime) ?? limits.endTimeSeconds,
      limits.endTimeSeconds
    );
    settings.timeStep = Math.max(
      finiteNumber(input?.timeStep) ?? finiteNumber(dynamicStep?.timeStep) ?? limits.minTimeStepSeconds,
      limits.minTimeStepSeconds
    );
    settings.outputInterval = Math.max(
      finiteNumber(input?.outputInterval) ?? finiteNumber(dynamicStep?.outputInterval) ?? settings.timeStep,
      limits.minOutputIntervalSeconds,
      settings.timeStep
    );
    const startTime = finiteNumber(input?.startTime) ?? finiteNumber(dynamicStep?.startTime) ?? 0;
    const maxFrameEndTime = startTime + Math.max((settings.maxFrames ?? limits.maxFrames) - 2, 0) * settings.outputInterval;
    settings.startTime = startTime;
    settings.endTime = Math.min(settings.endTime, maxFrameEndTime);
  }
  if (analysisType === "modal_analysis") {
    const modalStep = selectedStep?.type === "modal" ? selectedStep : undefined;
    settings.modeCount = Math.min(
      Math.max(positiveInteger(input?.modeCount) ?? positiveInteger(modalStep?.modeCount) ?? 6, 1),
      10
    );
  }
  return settings;
}

// Each stored frame holds displacement/velocity/acceleration per node plus
// strain/stress/von Mises/safety factor per element, all Float64. Cap the frame
// count so a large mesh cannot exhaust memory through the transient buffer.
// (Port of the runner's transientFrameBudget with a configurable byte budget.)
function transientFrameBudget(model: OpenCAEModelJson, transientFieldBytes: number): number {
  const nodes = Math.max(Math.floor((model.nodes?.coordinates?.length ?? 0) / 3), 1);
  const elements = Math.max(
    (model.elementBlocks ?? []).reduce((count, block) => {
      const nodesPerElement = block.type === "Tet10" ? 10 : 4;
      return count + Math.floor((block.connectivity?.length ?? 0) / nodesPerElement);
    }, 0),
    1
  );
  const bytesPerFrame = (nodes * 9 + elements * 14) * 8;
  return Math.max(Math.floor(transientFieldBytes / bytesPerFrame), 2);
}

function resourceLimitsDiagnostic(
  analysisType: CorePipelineAnalysisType,
  settings: CorePipelineSolverSettings
): Record<string, unknown> {
  return {
    id: "core-cloud-resource-limits",
    maxDofs: settings.maxDofs,
    maxIterations: settings.maxIterations,
    tolerance: settings.tolerance,
    ...(analysisType === "dynamic_structural"
      ? {
          maxFrames: settings.maxFrames,
          endTime: settings.endTime,
          timeStep: settings.timeStep,
          outputInterval: settings.outputInterval
        }
      : analysisType === "modal_analysis"
        ? { modeCount: settings.modeCount }
        : {})
  };
}

/**
 * Honest-results: whenever this pipeline runs with tighter limits than the
 * deployed cloud runner, say so in the result diagnostics instead of silently
 * behaving differently. Absent when running at full cloud limits (parity mode).
 */
function browserLimitsDeviationDiagnostic(limits: SolveLimits): Record<string, unknown> | undefined {
  const deviations: Record<string, { applied: number; cloud: number }> = {};
  for (const key of Object.keys(CLOUD_SOLVER_LIMITS) as Array<keyof SolveLimits>) {
    if (limits[key] !== CLOUD_SOLVER_LIMITS[key]) {
      deviations[key] = { applied: limits[key], cloud: CLOUD_SOLVER_LIMITS[key] };
    }
  }
  if (!Object.keys(deviations).length) return undefined;
  return {
    id: "browser-solve-limits",
    message: "In-browser solve limits are tighter than the OpenCAE Core Cloud runner limits.",
    deviations
  };
}

function dynamicBudgetGuard(
  model: OpenCAEModelJson,
  settings: CorePipelineSolverSettings,
  limits: SolveLimits
): CorePipelineError | undefined {
  // The dynamic MDOF solver does not enforce maxDofs itself (the cloud runner
  // relied on its 300 s Worker timeout); fail fast in the browser instead of
  // blocking the solve worker on an oversized model.
  const modelDofs = model.nodes?.coordinates?.length ?? 0;
  const maxDofs = positiveInteger(settings.maxDofs) ?? limits.maxDofs;
  if (modelDofs > maxDofs) {
    return {
      code: "max-dofs-exceeded",
      message: `Dynamic solve requires ${modelDofs} DOFs, above the in-browser limit of ${maxDofs}. ` +
        "Choose a coarser mesh preset (or a larger characteristic mesh size) to stay within the browser budget."
    };
  }
  const steps = dynamicIntegrationSteps(settings);
  if (steps > limits.maxTimeSteps) {
    const estimate = estimateDynamicRuntime({ steps });
    return {
      code: "dynamic-step-budget-exceeded",
      message: `Dynamic solve requires ${steps} integration steps, above the in-browser limit of ${limits.maxTimeSteps} ` +
        `(~${Math.round(estimate.estimatedMs / 1000)} s at ${estimate.calibratedMsPerStep} ms/step). ` +
        "Increase the time step or shorten the end time."
    };
  }
  return undefined;
}

/**
 * Port of the runner's stampCloudProvenance: identical solver/core/solver-cpu
 * ids, with the runnerVersion identifying the browser pipeline.
 */
export function stampBrowserProvenance(
  result: CoreSolveResult,
  runnerVersion: string,
  diagnostics: unknown[] = [],
  artifacts: Record<string, unknown> = {}
): CoreSolveResult {
  const provenance = {
    ...result.provenance,
    solver: "opencae-core-cloud" as const,
    coreVersion: OPENCAE_CORE_VERSION,
    solverCpuVersion: SOLVER_CPU_VERSION,
    runnerVersion
  };
  const stampedArtifacts = {
    ...(result.artifacts ?? {}),
    ...artifacts
  };
  const stampedDiagnostics = [...diagnostics, ...result.diagnostics.map((diagnostic) => {
      if (!diagnostic || typeof diagnostic !== "object" || !("id" in diagnostic)) return diagnostic;
      if ((diagnostic as { id?: unknown }).id !== "core-solve-diagnostics") return diagnostic;
      return {
        ...diagnostic,
        coreVersion: OPENCAE_CORE_VERSION,
        solverCpuVersion: SOLVER_CPU_VERSION,
        runnerVersion
      };
    })];
  if (result.analysisType === "modal_analysis") {
    return {
      ...result,
      analysisType: "modal_analysis",
      summary: {
        ...result.summary,
        provenance
      },
      provenance,
      artifacts: stampedArtifacts,
      diagnostics: stampedDiagnostics
    };
  }
  return {
    ...result,
    summary: {
      ...result.summary,
      provenance
    },
    provenance,
    artifacts: stampedArtifacts,
    diagnostics: stampedDiagnostics
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
