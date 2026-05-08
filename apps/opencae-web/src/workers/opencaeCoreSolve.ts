import {
  normalizeSolverBackend,
  openCaeCoreEligibility,
  solveOpenCaeCoreStudy,
  type OpenCaeCoreEligibility,
  type OpenCaeCoreStudySolveOutcome
} from "@opencae/solver-cpu";
import type { DisplayModel, Study } from "@opencae/schema";
import type { LocalSolveResult } from "./performanceProtocol";

export type NormalizedBrowserSolverBackend = "opencae_core";

export type { OpenCaeCoreEligibility };

export type OpenCaeCoreSolveOutcome =
  | { ok: true; result: LocalSolveResult; solverBackend: "opencae-core-cpu-tet4" | "opencae-core-dynamic-tet4" }
  | { ok: false; reason: string };

export { normalizeSolverBackend, openCaeCoreEligibility };

export function trySolveOpenCaeCoreStudy({ study, runId, displayModel }: {
  study: Study;
  runId: string;
  displayModel?: DisplayModel;
}): OpenCaeCoreSolveOutcome {
  const outcome: OpenCaeCoreStudySolveOutcome = solveOpenCaeCoreStudy({ study, runId, displayModel });
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    solverBackend: outcome.solverBackend,
    result: outcome.result
  };
}
