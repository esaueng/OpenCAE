import { describe, expect, test } from "vitest";
import { starterMaterials } from "@opencae/materials";
import type { DisplayModel, Study } from "@opencae/schema";
import { trySolveOpenCaeCoreStudy } from "./opencaeCoreSolve";

// Same tip-loaded cantilever as localCantileverAccuracy (180 x 24 x 24 mm, 500 N at
// the free end in -Z, clamped at x = 0), solved with several materials to prove the
// assigned material actually drives the result: tip deflection follows 1/E
// (Timoshenko theory per material), von Mises stress is ~material-independent for a
// force-controlled static solve, and the safety factor scales with yield strength.
const FORCE_N = 500;
const LENGTH = 0.18;
const SIDE = 0.024;
const INERTIA = (SIDE * SIDE ** 3) / 12;
const AREA = SIDE * SIDE;

function timoshenkoTipMm(young: number, poisson: number): number {
  const shear = young / (2 * (1 + poisson));
  return ((FORCE_N * LENGTH ** 3) / (3 * young * INERTIA) + (6 * FORCE_N * LENGTH) / (5 * shear * AREA)) * 1000;
}

// Root outer-fiber bending stress is independent of the material.
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

function cantileverStudy(materialId: string): Study {
  return {
    id: `study-${materialId}`,
    projectId: "project-1",
    name: "Material impact",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
    materialAssignments: [{ id: "mat-assignment", materialId, selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      { id: "selection-body", name: "Body", entityType: "body", geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }], fingerprint: "body" },
      { id: "selection-fixed", name: "Fixed face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-fixed", label: "Fixed" }], fingerprint: "face-fixed" },
      { id: "selection-load", name: "Load face", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load", label: "Load" }], fingerprint: "face-load" }
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

interface SolvedSummary {
  maxDisplacement: number;
  maxStress: number;
  safetyFactor: number;
  reactionForce: number;
}

function solve(materialId: string): SolvedSummary {
  const outcome = trySolveOpenCaeCoreStudy({ study: cantileverStudy(materialId), runId: `run-${materialId}`, displayModel });
  expect(outcome.ok, `solve failed for ${materialId}`).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return (outcome.result as { summary: SolvedSummary }).summary;
}

function material(id: string) {
  const found = starterMaterials.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing material ${id}`);
  return found;
}

describe("material impact on static results", () => {
  const cases = ["mat-steel", "mat-aluminum-6061", "mat-titanium-grade-5"] as const;

  test("tip deflection follows each material's Timoshenko prediction (1/E)", () => {
    for (const id of cases) {
      const m = material(id);
      const theory = timoshenkoTipMm(m.youngsModulus, m.poissonRatio);
      const summary = solve(id);
      // eslint-disable-next-line no-console
      console.log(`${id}: E=${(m.youngsModulus / 1e9).toFixed(1)}GPa tip=${summary.maxDisplacement.toFixed(4)}mm (theory ${theory.toFixed(4)}, ratio ${(summary.maxDisplacement / theory).toFixed(3)}) vm=${summary.maxStress.toFixed(2)}MPa SF=${summary.safetyFactor.toFixed(2)}`);
      expect(summary.maxDisplacement).toBeGreaterThan(theory * 0.97);
      expect(summary.maxDisplacement).toBeLessThan(theory * 1.03);
    }
  });

  test("a softer material deflects more, in inverse proportion to Young's modulus", () => {
    const steel = solve("mat-steel");
    const alum = solve("mat-aluminum-6061");
    const eRatio = material("mat-steel").youngsModulus / material("mat-aluminum-6061").youngsModulus; // ~2.90
    const deflectionRatio = alum.maxDisplacement / steel.maxDisplacement;
    expect(deflectionRatio).toBeGreaterThan(1); // aluminum is softer -> deflects more
    // Bending dominates, so the deflection ratio tracks the modulus ratio closely
    // (the small shear term carries each material's own Poisson, hence ~6% band).
    expect(deflectionRatio).toBeGreaterThan(eRatio * 0.94);
    expect(deflectionRatio).toBeLessThan(eRatio * 1.06);
  });

  test("von Mises stress is essentially material-independent for a force-controlled solve", () => {
    const steel = solve("mat-steel");
    const alum = solve("mat-aluminum-6061");
    expect(alum.maxStress).toBeGreaterThan(steel.maxStress * 0.95);
    expect(alum.maxStress).toBeLessThan(steel.maxStress * 1.05);
    // And both stay near the analytical root bending stress (FE concentration aside).
    expect(steel.maxStress).toBeGreaterThan(ROOT_BENDING_STRESS_MPA * 0.9);
    expect(steel.maxStress).toBeLessThan(ROOT_BENDING_STRESS_MPA * 1.35);
  });

  test("safety factor scales with yield strength at constant stress", () => {
    const steel = solve("mat-steel");
    const titanium = solve("mat-titanium-grade-5");
    // Stress is ~equal across materials, so SF ratio tracks the yield-strength ratio.
    const yieldRatio = material("mat-titanium-grade-5").yieldStrength / material("mat-steel").yieldStrength; // 880/250 = 3.52
    const sfRatio = titanium.safetyFactor / steel.safetyFactor;
    expect(sfRatio).toBeGreaterThan(yieldRatio * 0.9);
    expect(sfRatio).toBeLessThan(yieldRatio * 1.1);
    // Safety factor equals yield / peak von Mises for each material.
    expect(steel.safetyFactor).toBeCloseTo(material("mat-steel").yieldStrength / 1e6 / steel.maxStress, 1);
  });
});
