import { describe, expect, test } from "vitest";
import type { DisplayModel, Study } from "@opencae/schema";
import { trySolveOpenCaeCoreStudy } from "./opencaeCoreSolve";

// Local (in-browser) solve of the steel cantilever demo: 180 x 24 x 24 mm, 500 N tip
// load, clamped at x = 0. Compared against Timoshenko beam theory.
const FORCE_N = 500;
const YOUNG = 200e9;
const POISSON = 0.29;
const LENGTH = 0.18;
const SIDE = 0.024;
const INERTIA = (SIDE * SIDE ** 3) / 12;
const SHEAR = YOUNG / (2 * (1 + POISSON));
const TIP_DEFLECTION_MM =
  ((FORCE_N * LENGTH ** 3) / (3 * YOUNG * INERTIA) + (6 * FORCE_N * LENGTH) / (5 * SHEAR * SIDE * SIDE)) * 1000;
const ROOT_BENDING_STRESS_MPA = ((FORCE_N * LENGTH * (SIDE / 2)) / INERTIA) / 1e6;

const displayModel = {
  id: "display-cantilever",
  name: "Cantilever",
  bodyCount: 1,
  dimensions: { x: 180, y: 24, z: 24, units: "mm" },
  faces: [
    { id: "face-fixed", label: "Fixed", color: "#94a3b8", center: [0, 12, 12], normal: [-1, 0, 0], stressValue: 0 },
    { id: "face-load", label: "Load", color: "#94a3b8", center: [180, 12, 12], normal: [1, 0, 0], stressValue: 0 }
  ]
} satisfies DisplayModel;

function cantileverStudy(type: "static_stress" | "dynamic_structural"): Study {
  return {
    id: `study-${type}`,
    projectId: "project-1",
    name: "Cantilever accuracy",
    type,
    geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
    materialAssignments: [{ id: "mat-assignment", materialId: "mat-steel", selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      {
        id: "selection-body",
        name: "Body",
        entityType: "body",
        geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
        fingerprint: "body"
      },
      {
        id: "selection-fixed",
        name: "Fixed face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-fixed", label: "Fixed" }],
        fingerprint: "face-fixed"
      },
      {
        id: "selection-load",
        name: "Load face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load", label: "Load" }],
        fingerprint: "face-load"
      }
    ],
    contacts: [],
    constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
    loads: [{ id: "load-force", type: "force", selectionRef: "selection-load", parameters: { value: FORCE_N, units: "N", direction: [0, 0, -1] }, status: "complete" }],
    meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
    solverSettings: { backend: "opencae_core_local", fidelity: "standard" },
    validation: [],
    runs: []
  } as Study;
}

describe("local cantilever accuracy", () => {
  test("static local solve matches Timoshenko beam theory", () => {
    const outcome = trySolveOpenCaeCoreStudy({ study: cantileverStudy("static_stress"), runId: "run-bench", displayModel });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The local backend must preserve its CPU solver identity, browser runner
    // stamp, and solver-surface render mesh rather than the retired preview tier.
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-sparse-tet",
      meshSource: "structured_block_core",
      resultSource: "computed",
      runnerVersion: "browser-0.1.0"
    });
    expect((outcome.result as { surfaceMesh?: { id?: string } }).surfaceMesh?.id).toBe("solver-surface");
    const summary = (outcome.result as { summary?: { maxDisplacement?: number; maxStress?: number; reactionForce?: number } }).summary;
    // eslint-disable-next-line no-console
    console.log(
      `local static [${outcome.solverBackend}]: tip=${summary?.maxDisplacement?.toFixed(4)}mm ` +
      `(theory ${TIP_DEFLECTION_MM.toFixed(4)}, ratio ${((summary?.maxDisplacement ?? 0) / TIP_DEFLECTION_MM).toFixed(3)}) | ` +
      `vm=${summary?.maxStress?.toFixed(2)}MPa (theory ${ROOT_BENDING_STRESS_MPA.toFixed(2)}, ratio ${((summary?.maxStress ?? 0) / ROOT_BENDING_STRESS_MPA).toFixed(3)}) | ` +
      `reaction=${summary?.reactionForce?.toFixed(2)}N`
    );
    // Tip deflection within 3% of Timoshenko theory.
    expect(summary?.maxDisplacement ?? 0).toBeGreaterThan(TIP_DEFLECTION_MM * 0.97);
    expect(summary?.maxDisplacement ?? 0).toBeLessThan(TIP_DEFLECTION_MM * 1.03);
    // Peak von Mises at or above the outer-fiber value (clamped-face concentration), bounded.
    expect(summary?.maxStress ?? 0).toBeGreaterThan(ROOT_BENDING_STRESS_MPA * 0.9);
    expect(summary?.maxStress ?? 0).toBeLessThan(ROOT_BENDING_STRESS_MPA * 1.35);
    // Net reaction balances the applied load (not the sum of per-node magnitudes).
    expect(summary?.reactionForce ?? 0).toBeGreaterThan(FORCE_N - 1);
    expect(summary?.reactionForce ?? 0).toBeLessThan(FORCE_N + 1);
  });

  test("dynamic local ramp lands on the static answer", { timeout: 120000 }, () => {
    const outcome = trySolveOpenCaeCoreStudy({ study: cantileverStudy("dynamic_structural"), runId: "run-bench-dyn", displayModel });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-mdof-tet");
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-mdof-tet",
      resultSource: "computed",
      runnerVersion: "browser-0.1.0"
    });
    const summary = (outcome.result as { summary?: { maxDisplacement?: number; maxStress?: number } }).summary;
    // eslint-disable-next-line no-console
    console.log(
      `local dynamic [${outcome.solverBackend}]: peak=${summary?.maxDisplacement?.toFixed(4)}mm ` +
      `vm=${summary?.maxStress?.toFixed(2)}MPa`
    );
    expect(summary?.maxDisplacement ?? 0).toBeGreaterThan(TIP_DEFLECTION_MM * 0.95);
    expect(summary?.maxDisplacement ?? 0).toBeLessThan(TIP_DEFLECTION_MM * 1.1);
    expect(summary?.maxStress ?? 0).toBeGreaterThan(ROOT_BENDING_STRESS_MPA * 0.9);
    expect(summary?.maxStress ?? 0).toBeLessThan(ROOT_BENDING_STRESS_MPA * 1.35);
  });
});
