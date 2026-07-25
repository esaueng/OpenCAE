import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { volumeMeshToModelJson, type OpenCAEModelJson, type VolumeMeshToModelInput } from "@opencae/core";
import { SPARSE_ALGEBRA_POLICY } from "@opencae/solver-cpu";
import { CLOUD_SOLVER_LIMITS, solveStudyModelWithCorePipeline } from "./index";

/**
 * Numeric parity gate against historical OpenCAE Core Cloud fixtures.
 *
 * Each fixture in apps/opencae-web/src/testdata/core-cloud-golden freezes a
 * request/response pair recorded from the production runner (runnerVersion
 * 0.1.6, pinned opencae-core ref). This test replays the SOLVE stage of every
 * fixture through the browser pipeline and requires the response to match:
 *  - numeric field arrays and summary numbers within RELATIVE_TOLERANCE,
 *  - field ids/units/locations and surfaceMesh structure exactly,
 *  - diagnostics and artifacts structurally,
 *  - provenance structurally except for the intentionally local solver and
 *    runner identities,
 *  - solver convergence/equilibrium telemetry under its own policy (see
 *    SOLVER_TELEMETRY_PATH below) rather than as a physical value.
 *
 * Model extraction mirrors the runner's modelForRequest: coreModel, then
 * coreVolumeMesh (volumeMeshToModelJson), then geometry. All five recorded
 * fixtures are geometry dispatches (the production request builder always
 * dispatches sample geometry), so for the geometry case we solve the exact
 * Core model the runner generated and embedded in the recorded response at
 * artifacts.generatedCoreModel. That keeps every fixture — including the
 * gmsh-meshed bracket — a full numeric parity check of the solve pipeline.
 * What is NOT covered here is the geometry->mesh stage itself (structured
 * block + gmsh meshing); browser-side parity for that stage lands with the
 * A-M2 wasm mesher.
 *
 * Parity runs use CLOUD_SOLVER_LIMITS because the fixtures were recorded
 * under the cloud limits; BROWSER_SOLVE_LIMITS is the runtime default only.
 */

const FIXTURE_DIR = resolve(__dirname, "../../../apps/opencae-web/src/testdata/core-cloud-golden");
const EXPECTED_CLOUD_RUNNER_VERSION = "0.1.6";
/**
 * Physical-value parity tolerance, derived from the solver's own stopping
 * criterion rather than picked by hand.
 *
 * Every displacement, stress, and reaction in these fixtures descends from a
 * conjugate-gradient solution that is only determined to
 * `defaultRelativeResidualTolerance` (1e-10) *relative residual*. Two iterates
 * inside that tolerance ball can differ in the solution by that residual times
 * the system's condition number, so a residual bound is not a solution bound.
 * Demanding tighter agreement than the algorithm guarantees is not a physics
 * gate — it measures floating-point summation order and iterate choice.
 *
 * This gate was 1e-12 and went red on `main` because two intentional changes
 * moved which iterate the solver stops on: 63daf73 ("Fix relative CG
 * convergence") replaced the `max(norm(rhs), 1)` residual reference with a
 * scale-safe one, and the SSOR preconditioner changed the iteration path
 * (bracket-static now converges in 84 iterations where runner 0.1.6 recorded
 * 209). Observed divergence across the five fixtures is 1.3e-11 to 2.3e-9
 * relative, worst on bracket-static — the largest and worst-conditioned system,
 * whose equilibrium check is nonetheless exact to 1.2e-15.
 *
 * The allowance below is that residual tolerance times a documented
 * amplification factor standing in for the condition number of these models. It
 * leaves the gate at a part in 1e7 — any real solve-pipeline regression moves
 * results by far more — while no longer asserting precision the solver never
 * promised. Convergence speed and equilibrium quality are gated separately and
 * tightly (see SOLVER_TELEMETRY_PATH), so a numerically worse solve still fails
 * here even though its last digits are no longer pinned.
 */
const RESIDUAL_TO_SOLUTION_AMPLIFICATION = 1e3;
const RELATIVE_TOLERANCE = RESIDUAL_TO_SOLUTION_AMPLIFICATION * SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance;

/**
 * Solver convergence and equilibrium telemetry — how the solve went, not what
 * the structure does. These values are properties of the stopping criterion and
 * the preconditioner, so improving either is *expected* to move them:
 *  - `iterations` is a discrete count. Static solves now converge in 382/224/84
 *    iterations where runner 0.1.6 recorded 944/611/209 — a large improvement
 *    from the SSOR preconditioner and the 63daf73 criterion fix, not a
 *    regression.
 *  - `residualNorm`/`relativeResidual` and the `reactionBalance` error terms
 *    (`imbalance`, `relativeError` on the static path, `relativeImbalance` on
 *    the dynamic one) are quantities that are zero up to solver tolerance. Two
 *    different roundings of a value near zero differ by O(1) relative, which
 *    says nothing about parity.
 *
 * `reactionBalance.appliedLoad` and `.reaction` are NOT telemetry: they are
 * physical forces and stay under the full-value comparison.
 *
 * They stay gated, on the invariants that survive a criterion change:
 * convergence must not get slower and equilibrium must not get worse.
 */
const SOLVER_TELEMETRY_PATH =
  /(\.iterations|\.residualNorm|\.relativeResidual|reactionBalance.*\.(imbalance(\[\d+\])?|relativeImbalance|relativeError))$/u;
/** Iteration counts may improve freely; worsening is bounded. */
const ITERATION_WORSENING_FRACTION = 0.25;
const ITERATION_WORSENING_FLOOR = 5;
/** A solve may end on a better residual or imbalance, never a materially worse one. */
const RESIDUAL_WORSENING_FACTOR = 100;
const PRINCIPAL_FIELD_SUFFIXES = [
  "stress-principal-max-surface",
  "stress-principal-min-surface",
  "stress-max-shear-surface"
] as const;

const ALL_CASES = [
  "cantilever-static",
  "beam-static",
  "bracket-static",
  "cantilever-dynamic",
  "beam-dynamic"
] as const;

type GoldenFixture = {
  meta: { case: string; runnerVersion: string };
  request: {
    analysisType: "static_stress" | "dynamic_structural";
    coreModel?: unknown;
    coreVolumeMesh?: unknown;
    geometry?: unknown;
    solverSettings?: Record<string, unknown>;
  };
  response: {
    summary: Record<string, unknown>;
    fields: unknown[];
    surfaceMesh: Record<string, unknown>;
    diagnostics: unknown[];
    provenance: Record<string, unknown>;
    artifacts: Record<string, unknown> & { generatedCoreModel?: OpenCAEModelJson; meshSummary?: Record<string, unknown> };
  };
};

function loadFixture(name: string): GoldenFixture {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as GoldenFixture;
}

/** Mirror of the runner's modelForRequest extraction (server.ts). */
function modelForFixture(fixture: GoldenFixture): { model: OpenCAEModelJson; source: "coreModel" | "coreVolumeMesh" | "geometry" } {
  if (fixture.request.coreModel && typeof fixture.request.coreModel === "object") {
    return { model: fixture.request.coreModel as OpenCAEModelJson, source: "coreModel" };
  }
  if (fixture.request.coreVolumeMesh && typeof fixture.request.coreVolumeMesh === "object") {
    return { model: volumeMeshToModelJson(fixture.request.coreVolumeMesh as VolumeMeshToModelInput), source: "coreVolumeMesh" };
  }
  if (fixture.request.geometry) {
    const generated = fixture.response.artifacts.generatedCoreModel;
    if (!generated) {
      throw new Error(
        `${fixture.meta.case}: geometry dispatch fixture carries no generatedCoreModel artifact; ` +
        "geometry->mesh parity requires the A-M2 wasm mesher."
      );
    }
    return { model: structuredClone(generated), source: "geometry" };
  }
  throw new Error(`${fixture.meta.case}: request carries no solvable model.`);
}

/**
 * The runner's prepareSolveInput seeded diagnostics/artifacts from the
 * geometry step before the pipeline ran. Reconstruct that seed from the
 * recorded response: everything before the first pipeline phase diagnostic is
 * geometry-step output, and meshSummary.phaseDiagnostics likewise.
 */
function preparedStateForFixture(fixture: GoldenFixture): { diagnostics: unknown[]; artifacts: Record<string, unknown> } {
  const isPipelinePhase = (entry: unknown): boolean =>
    Boolean(entry && typeof entry === "object" && (entry as { id?: unknown }).id === "core-cloud-phase");
  const firstPhaseIndex = fixture.response.diagnostics.findIndex(isPipelinePhase);
  const diagnostics = structuredClone(fixture.response.diagnostics.slice(0, firstPhaseIndex < 0 ? 0 : firstPhaseIndex));
  const meshSummary = structuredClone(fixture.response.artifacts.meshSummary) as { phaseDiagnostics?: unknown[] } | undefined;
  if (meshSummary?.phaseDiagnostics) {
    const firstSummaryPhase = meshSummary.phaseDiagnostics.findIndex(isPipelinePhase);
    meshSummary.phaseDiagnostics = meshSummary.phaseDiagnostics.slice(0, firstSummaryPhase < 0 ? undefined : firstSummaryPhase);
  }
  const generated = fixture.response.artifacts.generatedCoreModel;
  return {
    diagnostics,
    artifacts: {
      ...(generated ? { generatedCoreModel: structuredClone(generated) } : {}),
      ...(meshSummary ? { meshSummary } : {})
    }
  };
}

type DeltaStats = {
  comparisons: number;
  maxAbsDelta: number;
  maxRelDelta: number;
  maxAbsPath: string;
  maxRelPath: string;
  /** Solver telemetry pairs held out of the physical-value comparison. */
  telemetry: Array<{ path: string; actual: number; expected: number; containerScale: number }>;
};

/**
 * Keys the current pipeline reports that runner 0.1.6 did not. They are
 * additive metadata only — never a replacement for a recorded value — so their
 * presence is allowed while every recorded key still has to match. Anything not
 * listed here is a contract change and must fail.
 */
function additiveKeysAfterRecordedRunner(path: string): string[] {
  // Principal/max-shear identity metadata on result fields.
  if (/^response\.fields\[\d+\]$/u.test(path)) return ["component", "tensorValues"];
  // Solver memory budgeting (bb06839) and preconditioner identity (SSOR).
  if (/^response\.diagnostics\[\d+\]$/u.test(path)) return ["estimatedMatrixBytes", "preconditioner"];
  return [];
}

/**
 * Largest finite magnitude anywhere in an array, descending into nested arrays
 * so a vector field normalizes against the whole field rather than against one
 * node's own triple. Object members are not scanned: they are independent
 * quantities, possibly in different units.
 */
function arrayMagnitudeScale(...arrays: unknown[][]): number {
  let scale = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return;
      const magnitude = Math.abs(value);
      if (magnitude > scale) scale = magnitude;
      return;
    }
    if (Array.isArray(value)) for (const item of value) visit(item);
  };
  for (const array of arrays) visit(array);
  return scale;
}

function compareStructures(
  actual: unknown,
  expected: unknown,
  path: string,
  stats: DeltaStats,
  mismatches: string[],
  /**
   * Magnitude of the numeric array this value belongs to, so components that
   * are zero only by cancellation are compared against the quantity's own
   * scale instead of against themselves. A 500 N load leaves transverse
   * reactions around 1e-10 N; two roundings of that zero differ by O(1)
   * relative, which says nothing about parity.
   */
  containerScale = 0
): void {
  if (mismatches.length > 25) return;
  if (typeof expected === "number" && typeof actual === "number") {
    if (SOLVER_TELEMETRY_PATH.test(path)) {
      stats.telemetry.push({ path, actual, expected, containerScale });
      return;
    }
    stats.comparisons += 1;
    if (Object.is(actual, expected)) return;
    const absDelta = Math.abs(actual - expected);
    const scale = Math.max(Math.abs(actual), Math.abs(expected), containerScale);
    const relDelta = scale > 0 ? absDelta / scale : 0;
    if (absDelta > stats.maxAbsDelta) {
      stats.maxAbsDelta = absDelta;
      stats.maxAbsPath = path;
    }
    if (relDelta > stats.maxRelDelta) {
      stats.maxRelDelta = relDelta;
      stats.maxRelPath = path;
    }
    if (relDelta > RELATIVE_TOLERANCE) {
      mismatches.push(`${path}: ${actual} != ${expected} (rel ${relDelta.toExponential(3)})`);
    }
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      mismatches.push(`${path}: array/non-array mismatch`);
      return;
    }
    if (actual.length !== expected.length) {
      mismatches.push(`${path}: length ${actual.length} != ${expected.length}`);
      return;
    }
    const scale = Math.max(containerScale, arrayMagnitudeScale(actual, expected));
    for (let index = 0; index < expected.length; index += 1) {
      compareStructures(actual[index], expected[index], `${path}[${index}]`, stats, mismatches, scale);
    }
    return;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") {
      mismatches.push(`${path}: object/non-object mismatch (${typeof actual})`);
      return;
    }
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord).sort();
    const actualKeys = Object.keys(actualRecord).sort();
    const additiveKeys = additiveKeysAfterRecordedRunner(path)
      .filter((key) => actualKeys.includes(key) && !expectedKeys.includes(key));
    const comparableActualKeys = actualKeys.filter((key) => !additiveKeys.includes(key));
    if (expectedKeys.join(",") !== comparableActualKeys.join(",")) {
      mismatches.push(`${path}: keys [${actualKeys}] != [${expectedKeys}]`);
      return;
    }
    for (const key of expectedKeys) {
      if (key === "runnerVersion") continue; // differs by design; asserted separately
      // No scale inheritance across an object boundary: sibling properties are
      // independent quantities, unlike the components of one numeric array.
      compareStructures(actualRecord[key], expectedRecord[key], `${path}.${key}`, stats, mismatches);
    }
    return;
  }
  // The fixtures remain an honest record of runner 0.1.6. The current reader
  // upgrades those embedded v0.2 models before solving, so only this diagnostic
  // version stamp is expected to advance.
  if (path.endsWith(".coreModelSchemaVersion") && actual === "0.4.0" && (expected === "0.2.0" || expected === "0.3.0")) return;
  if (
    path.endsWith(".id") &&
    ((expected === "core-cloud-phase" && actual === "core-local-phase") ||
      (expected === "core-cloud-resource-limits" && actual === "core-local-resource-limits"))
  ) return;
  if (
    path.endsWith(".provenance.solver") &&
    expected === "opencae-core-cloud" &&
    (actual === "opencae-core-sparse-tet" || actual === "opencae-core-mdof-tet" || actual === "opencae-core-modal-tet")
  ) return;
  if (!Object.is(actual, expected)) {
    mismatches.push(`${path}: ${String(actual)} != ${String(expected)}`);
  }
}

/**
 * Gate the held-out solver telemetry on what must still hold after a stopping
 * criterion or preconditioner change: convergence no slower than recorded, and
 * residuals/imbalances no worse than recorded by more than
 * RESIDUAL_WORSENING_FACTOR. Improvements in either direction pass.
 */
function solverTelemetryFailures(telemetry: DeltaStats["telemetry"]): string[] {
  const failures: string[] = [];
  for (const { path, actual, expected, containerScale } of telemetry) {
    if (!Number.isFinite(actual) || Math.abs(actual) < 0) {
      failures.push(`${path}: ${actual} is not a finite measure`);
      continue;
    }
    if (path.endsWith(".iterations")) {
      if (!Number.isInteger(actual) || actual < 0) {
        failures.push(`${path}: ${actual} is not a non-negative integer iteration count`);
        continue;
      }
      const ceiling = expected + Math.max(ITERATION_WORSENING_FLOOR, expected * ITERATION_WORSENING_FRACTION);
      if (actual > ceiling) {
        failures.push(`${path}: ${actual} iterations exceeds the ${ceiling.toFixed(0)} allowed against recorded ${expected}`);
      }
      continue;
    }
    // Signed imbalance components are compared on magnitude: the sign of a
    // quantity that is zero to solver tolerance carries no information. The
    // reference includes the containing vector's own scale because a recorded
    // component can be exactly 0 by cancellation, which no multiplicative bound
    // can leave room around. That makes individual components informational; the
    // binding equilibrium gate is the dimensionless relativeError /
    // relativeImbalance in the same block, which is checked by this same rule
    // and would move by orders of magnitude if equilibrium actually degraded.
    const ceiling = Math.max(Math.abs(expected), containerScale) * RESIDUAL_WORSENING_FACTOR;
    if (Math.abs(actual) > ceiling) {
      failures.push(`${path}: |${actual}| exceeds ${RESIDUAL_WORSENING_FACTOR}x the recorded ${expected}`);
    }
  }
  return failures;
}

function collectRunnerVersions(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRunnerVersions(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.runnerVersion === "string") out.add(record.runnerVersion);
  for (const key of Object.keys(record)) collectRunnerVersions(record[key], out);
}

function isPrincipalMeasureField(field: unknown): field is Record<string, unknown> & { id: string } {
  if (!field || typeof field !== "object") return false;
  const id = (field as { id?: unknown }).id;
  return typeof id === "string" && PRINCIPAL_FIELD_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

function legacyResultField(field: unknown): unknown {
  if (!field || typeof field !== "object") return field;
  // Field components are additive identity metadata introduced after the
  // recorded runner contract; the legacy payload remains the numeric oracle.
  const { component: _component, ...legacy } = field as Record<string, unknown>;
  return legacy;
}

describe("golden parity: local browser pipeline vs historical fixtures", () => {
  test.each([...ALL_CASES])("%s reproduces the recorded numeric response", { timeout: 120000 }, (name) => {
    const fixture = loadFixture(name);
    expect(fixture.meta.runnerVersion).toBe(EXPECTED_CLOUD_RUNNER_VERSION);
    const { model } = modelForFixture(fixture);
    const prepared = preparedStateForFixture(fixture);

    const outcome = solveStudyModelWithCorePipeline({
      model,
      analysisType: fixture.request.analysisType,
      solverSettings: fixture.request.solverSettings,
      limits: CLOUD_SOLVER_LIMITS,
      preparedDiagnostics: prepared.diagnostics,
      preparedArtifacts: prepared.artifacts
    });

    expect(outcome.ok, outcome.ok ? undefined : JSON.stringify(outcome.error)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.solver).toBe(
      fixture.request.analysisType === "dynamic_structural"
        ? "opencae-core-mdof-tet"
        : "opencae-core-sparse-tet"
    );

    const stats: DeltaStats = { comparisons: 0, maxAbsDelta: 0, maxRelDelta: 0, maxAbsPath: "-", maxRelPath: "-", telemetry: [] };
    const mismatches: string[] = [];
    // The fixtures froze the HTTP wire contract; JSON round-trip the in-process
    // result the same way (drops undefined-valued optional keys).
    const wireResult = JSON.parse(JSON.stringify(outcome.result)) as GoldenFixture["response"];
    const principalFields = wireResult.fields.filter(isPrincipalMeasureField);
    const legacyWireResult = {
      ...wireResult,
      // Runner 0.1.6 predates the additive principal/max-shear fields. Keep its
      // recorded fields as an exact numeric parity oracle while validating the
      // new tensor-derived fields independently below.
      fields: wireResult.fields.filter((field) => !isPrincipalMeasureField(field)).map(legacyResultField)
    };
    compareStructures(legacyWireResult, fixture.response, "response", stats, mismatches);
    const tensorFields = outcome.result.fields.filter((field) => field.type === "stress" && field.location === "node" && field.component === "von_mises");
    expect(tensorFields.every((field) => field.tensorValues?.length === field.values.length * 6)).toBe(true);
    expect(tensorFields.every((field) => field.tensorValues?.every(Number.isFinite))).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `golden parity ${name}: ${stats.comparisons.toLocaleString()} numeric comparisons, ` +
      `max abs delta ${stats.maxAbsDelta.toExponential(3)} @ ${stats.maxAbsPath}, ` +
      `max rel delta ${stats.maxRelDelta.toExponential(3)} @ ${stats.maxRelPath}, ` +
      `${stats.telemetry.length} solver telemetry values gated separately`
    );
    expect(mismatches, mismatches.slice(0, 10).join("\n")).toEqual([]);
    expect(stats.maxRelDelta).toBeLessThanOrEqual(RELATIVE_TOLERANCE);
    const telemetryFailures = solverTelemetryFailures(stats.telemetry);
    expect(telemetryFailures, telemetryFailures.slice(0, 10).join("\n")).toEqual([]);

    const frameIndices = new Set(
      fixture.response.fields.map((field) => (field as { frameIndex?: unknown }).frameIndex ?? "static")
    );
    expect(principalFields).toHaveLength(frameIndices.size * PRINCIPAL_FIELD_SUFFIXES.length);
    for (const frameIndex of frameIndices) {
      const frameFields = principalFields.filter((field) => (field.frameIndex ?? "static") === frameIndex);
      expect(frameFields.map((field) => PRINCIPAL_FIELD_SUFFIXES.find((suffix) => field.id.endsWith(suffix))).sort()).toEqual(
        [...PRINCIPAL_FIELD_SUFFIXES].sort()
      );
      for (const field of frameFields) {
        expect(field.location).toBe("node");
        expect(field.units).toBe("MPa");
        expect(field.values).toHaveLength((wireResult.surfaceMesh.nodes as unknown[]).length);
      }
    }

    // The fixture keeps its historical runner stamp; the replay is explicitly local.
    const actualVersions = new Set<string>();
    collectRunnerVersions(outcome.result, actualVersions);
    expect([...actualVersions]).toEqual(["browser-0.1.0"]);
    const expectedVersions = new Set<string>();
    collectRunnerVersions(fixture.response, expectedVersions);
    expect([...expectedVersions]).toEqual([EXPECTED_CLOUD_RUNNER_VERSION]);
  });

  test("all recorded fixtures are geometry dispatches whose solved model is embedded", () => {
    // Documents why the geometry->model stage is fed from the recorded
    // artifacts: the production request builder never embeds coreModel /
    // coreVolumeMesh for the sample cases. If a future fixture does, the
    // modelForRequest mirror above picks it up first.
    for (const name of ALL_CASES) {
      const fixture = loadFixture(name);
      expect(fixture.request.coreModel ?? null).toBeNull();
      expect(fixture.request.coreVolumeMesh ?? null).toBeNull();
      expect(fixture.request.geometry).toBeTruthy();
      expect(fixture.response.artifacts.generatedCoreModel).toBeTruthy();
    }
  });
});
