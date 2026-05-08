import { describe, expect, test } from "vitest";
import type { DisplayModel, Study } from "@opencae/schema";
import {
  normalizeSolverBackend,
  openCaeCoreEligibility,
  trySolveOpenCaeCoreStudy
} from "./opencaeCoreSolve";

const displayModel = {
  id: "display-cantilever",
  name: "Cantilever",
  bodyCount: 1,
  dimensions: { x: 100, y: 30, z: 10, units: "mm" },
  faces: [
    { id: "face-fixed", label: "Fixed", color: "#94a3b8", center: [0, 15, 5], normal: [-1, 0, 0], stressValue: 0 },
    { id: "face-load", label: "Load", color: "#94a3b8", center: [100, 15, 5], normal: [1, 0, 0], stressValue: 0 }
  ]
} satisfies DisplayModel;

const staticStudy = {
  id: "study-static",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
  materialAssignments: [{ id: "mat-assignment", materialId: "mat-aluminum-6061", selectionRef: "selection-body", parameters: {}, status: "complete" }],
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
  loads: [{ id: "load-force", type: "force", selectionRef: "selection-load", parameters: { value: 100, units: "N", direction: [0, 0, -1] }, status: "complete" }],
  meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
  solverSettings: { backend: "opencae_core", fidelity: "standard" },
  validation: [],
  runs: []
} satisfies Study;

describe("OpenCAE Core browser solver adapter", () => {
  test("normalizes omitted and legacy cloud FEA backend selections to OpenCAE Core", () => {
    expect(normalizeSolverBackend({ solverSettings: { backend: "cloudflare_fea" } })).toBe("opencae_core");
    expect(normalizeSolverBackend({ solverSettings: { backend: "opencae_core" } })).toBe("opencae_core");
    expect(normalizeSolverBackend({ solverSettings: { backend: "local_detailed" } })).toBe("local_detailed");
    expect(normalizeSolverBackend({ solverSettings: {} })).toBe("opencae_core");
    expect(normalizeSolverBackend(undefined)).toBe("opencae_core");
  });

  test("accepts static force studies with usable block dimensions", () => {
    const eligibility = openCaeCoreEligibility(staticStudy, displayModel);

    expect(eligibility).toEqual({ ok: true });
  });

  test("solves eligible static studies with OpenCAE Core provenance", () => {
    const outcome = trySolveOpenCaeCoreStudy({ study: staticStudy, runId: "run-core-1", displayModel });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cpu-tet4",
      meshSource: "opencae_core_tet4",
      resultSource: "computed"
    });
    expect(outcome.result.summary.maxStress).toBeGreaterThan(0);
    expect(outcome.result.summary.maxDisplacement).toBeGreaterThan(0);
    expect(outcome.result.fields.map((field) => field.type)).toEqual(["stress", "displacement", "safety_factor"]);
    expect(outcome.result.fields.every((field) => field.provenance?.kind === "opencae_core_fea")).toBe(true);
  });

  test("falls back for dynamic studies instead of pretending OpenCAE Core support", () => {
    const dynamicStudy = {
      ...staticStudy,
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core",
        fidelity: "standard",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    } satisfies Study;

    const eligibility = openCaeCoreEligibility(dynamicStudy, displayModel);

    expect(eligibility.ok).toBe(false);
    if (eligibility.ok) throw new Error("dynamic study unexpectedly eligible");
    expect(eligibility.reason).toContain("static stress");
  });
});
