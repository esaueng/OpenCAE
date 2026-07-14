import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { volumeMeshToModelJson, type OpenCAEModelJson, type VolumeMeshToModelInput } from "@opencae/core";
import { CLOUD_SOLVER_LIMITS, solveStudyModelWithCorePipeline } from "./index";

/**
 * B2 gate: golden parity against the deployed OpenCAE Core Cloud runner.
 *
 * Each fixture in apps/opencae-web/src/testdata/core-cloud-golden freezes a
 * request/response pair recorded from the production runner (runnerVersion
 * 0.1.6, pinned opencae-core ref). This test replays the SOLVE stage of every
 * fixture through the browser pipeline and requires the response to match:
 *  - numeric field arrays and summary numbers within 1e-12 relative,
 *  - field ids/units/locations and surfaceMesh structure exactly,
 *  - diagnostics and artifacts structurally,
 *  - provenance structurally (runnerVersion differs by design:
 *    "browser-<web app version>" vs "0.1.6").
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
const RELATIVE_TOLERANCE = 1e-12;
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
};

function compareStructures(
  actual: unknown,
  expected: unknown,
  path: string,
  stats: DeltaStats,
  mismatches: string[]
): void {
  if (mismatches.length > 25) return;
  if (typeof expected === "number" && typeof actual === "number") {
    stats.comparisons += 1;
    if (Object.is(actual, expected)) return;
    const absDelta = Math.abs(actual - expected);
    const scale = Math.max(Math.abs(actual), Math.abs(expected));
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
    for (let index = 0; index < expected.length; index += 1) {
      compareStructures(actual[index], expected[index], `${path}[${index}]`, stats, mismatches);
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
    if (expectedKeys.join(",") !== actualKeys.join(",")) {
      mismatches.push(`${path}: keys [${actualKeys}] != [${expectedKeys}]`);
      return;
    }
    for (const key of expectedKeys) {
      if (key === "runnerVersion") continue; // differs by design; asserted separately
      compareStructures(actualRecord[key], expectedRecord[key], `${path}.${key}`, stats, mismatches);
    }
    return;
  }
  // The fixtures remain an honest record of runner 0.1.6. The current reader
  // upgrades those embedded v0.2 models before solving, so only this diagnostic
  // version stamp is expected to advance.
  if (path.endsWith(".coreModelSchemaVersion") && actual === "0.3.0" && expected === "0.2.0") return;
  if (!Object.is(actual, expected)) {
    mismatches.push(`${path}: ${String(actual)} != ${String(expected)}`);
  }
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

describe("golden parity: browser pipeline vs deployed Core Cloud runner", () => {
  test.each([...ALL_CASES])("%s reproduces the recorded cloud response", { timeout: 120000 }, (name) => {
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

    const stats: DeltaStats = { comparisons: 0, maxAbsDelta: 0, maxRelDelta: 0, maxAbsPath: "-", maxRelPath: "-" };
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
    // eslint-disable-next-line no-console
    console.log(
      `golden parity ${name}: ${stats.comparisons.toLocaleString()} numeric comparisons, ` +
      `max abs delta ${stats.maxAbsDelta.toExponential(3)} @ ${stats.maxAbsPath}, ` +
      `max rel delta ${stats.maxRelDelta.toExponential(3)} @ ${stats.maxRelPath}`
    );
    expect(mismatches, mismatches.slice(0, 10).join("\n")).toEqual([]);
    expect(stats.maxRelDelta).toBeLessThanOrEqual(RELATIVE_TOLERANCE);

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

    // Provenance parity is structural; the runner stamp differs by design.
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
