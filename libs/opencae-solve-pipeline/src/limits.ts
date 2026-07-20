import { DEFAULT_STRUCTURAL_MAX_DOFS } from "@opencae/solver-cpu";

/**
 * Resource limits applied by the browser pipeline's bounded solver settings.
 * The first seven entries mirror the retired deployed runner; transient bytes
 * and integration steps provide explicit memory/runtime ceilings.
 */
export type SolveLimits = {
  maxDofs: number;
  maxIterations: number;
  tolerance: number;
  maxFrames: number;
  endTimeSeconds: number;
  minTimeStepSeconds: number;
  minOutputIntervalSeconds: number;
  transientFieldBytes: number;
  maxTimeSteps: number;
};

/**
 * Retired runner limits retained for golden-fixture parity. maxTimeSteps is
 * endTimeSeconds / minTimeStepSeconds; the former service also had a 300 s
 * wall-clock supervisor timeout.
 */
export const CLOUD_SOLVER_LIMITS: SolveLimits = {
  maxDofs: 100000,
  maxIterations: 50000,
  tolerance: 1e-10,
  maxFrames: 2000,
  endTimeSeconds: 10,
  minTimeStepSeconds: 0.0001,
  minOutputIntervalSeconds: 0.0005,
  transientFieldBytes: 1.5e9,
  maxTimeSteps: 100000
};

/**
 * Active CPU browser limits. maxDofs is the guarded 150k product cap, verified by
 * the scale benchmark through the real solve worker in Chromium and
 * WebKit. Memory and integration-step ceilings remain tighter than the retired
 * runner because the browser has no external wall-clock supervisor.
 *
 * Keeping this in a lightweight subpath lets preflight/UI orchestration share
 * the authoritative cap without pulling solver implementations into the main
 * browser bundle. Every accepted-request deviation still appears in result
 * diagnostics through the browser pipeline.
 */
export const BROWSER_SOLVE_LIMITS: SolveLimits = {
  ...CLOUD_SOLVER_LIMITS,
  maxDofs: DEFAULT_STRUCTURAL_MAX_DOFS,
  transientFieldBytes: 256e6,
  maxTimeSteps: 20000
};
