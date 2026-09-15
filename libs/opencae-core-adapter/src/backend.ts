import type { DisplayModel, ResultField, ResultSummary, RunVariantRef, RunVariantResult, Study } from "@opencae/schema";

/**
 * Solver-backend routing, extracted from index.ts (file move only, no
 * behavior change). With the client cloud path retired every run executes
 * locally; the explicit/auto distinction still drives UI labels and the
 * solve worker's explicit-local guard. The trio is intentionally kept as
 * three functions so a future backend touches one place.
 */

export type NormalizedBrowserSolverBackend = "opencae_core_local";

export const STANDARD_GRAVITY = 9.80665;
export const DEFAULT_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;
export const MIN_DYNAMIC_OUTPUT_INTERVAL_SECONDS = 0.005;

export type OpenCaeCoreEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export type OpenCaeCoreSolveOutcome =
  | { ok: true; result: BackendLocalSolveResult; solverBackend: "opencae-core-sparse-tet" | "opencae-core-mdof-tet" | "opencae-core-modal-tet" | "opencae-core-steady-thermal" | "opencae-core-webgpu-matrix-free-tet4" }
  | { ok: false; reason: string; code?: string };

/** Structural mirror of LocalSolveResult (defined in index.ts); kept in sync by the typecheck. */
export type BackendLocalSolveResult = {
  summary: ResultSummary;
  fields: ResultField[];
  variants?: RunVariantResult[];
  variantRefs?: RunVariantRef[];
  activeVariantId?: string;
  surfaceMesh?: unknown;
  diagnostics?: unknown[];
  artifacts?: Record<string, unknown>;
};

export const COMPLEX_CORE_MESH_REQUIRED_REASON =
  "This geometry needs a volume mesh before it can solve, and in-browser meshing is unavailable here " +
  "(opt-out build, unsupported browser, or no meshable geometry source). Generate a mesh on the Mesh step, " +
  "or rebuild with in-browser meshing enabled. Results are never estimated.";
export const OPENCAE_CORE_MESH_REQUIRED_REASON = "OpenCAE Core requires a procedural or uploaded geometry source to generate a volume mesh for this study.";

export function normalizeSolverBackend(value: { solverSettings?: { backend?: unknown } } | Study | undefined): NormalizedBrowserSolverBackend {
  void value;
  return "opencae_core_local";
}

export type ResolvedSolverBackend = {
  backend: NormalizedBrowserSolverBackend;
  /** "explicit" = the user chose this backend; "auto" = per-model routing chose it. */
  source: "explicit" | "auto";
};

/**
 * Explicit user backend choice, or null when the study carries no explicit
 * choice ("auto", unset, legacy, retired "opencae_core_cloud", or unknown
 * values all mean "never chose" — the schema aliases the retired cloud
 * choice to "auto" at parse time, and this treats any straggler the same).
 */
export function explicitSolverBackend(value: { solverSettings?: { backend?: unknown } } | Study | undefined): NormalizedBrowserSolverBackend | null {
  const backend = value?.solverSettings?.backend;
  return backend === "opencae_core_local" ? backend : null;
}

/**
 * Environment capabilities that affect run eligibility and routing. The web
 * app reports whether it can mesh the study's geometry on demand (in-browser
 * wasm meshing, production default since A-M4); the dev API server cannot.
 */
export type CoreSolveCapabilities = {
  /** True when the caller can generate a real volume mesh before solving (wasm mesh worker + meshable geometry source). */
  canMeshOnDemand?: boolean;
};

/**
 * Backend that auto routing picks for this study. With the client cloud path
 * retired (B4a) every run executes locally; ineligible studies fail the run
 * honestly with openCaeCoreEligibility's actionable reason instead of being
 * routed elsewhere or estimated.
 */
export function autoSolverBackend(study: Study, displayModel?: DisplayModel, capabilities?: CoreSolveCapabilities): NormalizedBrowserSolverBackend {
  void study;
  void displayModel;
  void capabilities;
  return "opencae_core_local";
}

/**
 * Concrete backend for a run plus whether the user chose it explicitly.
 * Local either way since B4a; the explicit/auto distinction still drives UI
 * labels and the solve worker's explicit-local guard.
 */
export function resolveSolverBackend(study: Study, displayModel?: DisplayModel, capabilities?: CoreSolveCapabilities): ResolvedSolverBackend {
  const explicit = explicitSolverBackend(study);
  if (explicit) return { backend: explicit, source: "explicit" };
  return { backend: autoSolverBackend(study, displayModel, capabilities), source: "auto" };
}
