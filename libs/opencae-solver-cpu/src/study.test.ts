import { describe, expect, test } from "vitest";
import type { DisplayModel, Study } from "@opencae/schema";
import { normalizeSolverBackend, openCaeCoreEligibility, solveOpenCaeCoreStudy } from "./study";

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

describe("OpenCAE Core study solver", () => {
  test("normalizes omitted and legacy backend selections to OpenCAE Core", () => {
    expect(normalizeSolverBackend({ solverSettings: { backend: "cloudflare_fea" } })).toBe("opencae_core");
    expect(normalizeSolverBackend({ solverSettings: { backend: "local_detailed" } })).toBe("opencae_core");
    expect(normalizeSolverBackend({ solverSettings: {} })).toBe("opencae_core");
    expect(normalizeSolverBackend(undefined)).toBe("opencae_core");
  });

  test("solves static studies with OpenCAE Core provenance", () => {
    expect(openCaeCoreEligibility(staticStudy, displayModel)).toEqual({ ok: true });

    const solved = solveOpenCaeCoreStudy({ study: staticStudy, runId: "run-core-static", displayModel });

    expect(solved.ok).toBe(true);
    if (!solved.ok) throw new Error(solved.reason);
    expect(solved.solverBackend).toBe("opencae-core-cpu-tet4");
    expect(solved.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cpu-tet4",
      meshSource: "opencae_core_tet4",
      resultSource: "computed"
    });
    expect(solved.result.summary.maxStress).toBeGreaterThan(0);
    expect(solved.result.summary.maxDisplacement).toBeGreaterThan(0);
    expect(solved.result.fields.map((field) => field.type)).toEqual(["stress", "displacement", "safety_factor"]);
    expect(solved.result.fields.every((field) => field.provenance?.kind === "opencae_core_fea")).toBe(true);
  });

  test("solves dynamic studies with timed OpenCAE Core frames", () => {
    const solved = solveOpenCaeCoreStudy({
      study: dynamicStudy({ endTime: 0.025, timeStep: 0.005, outputInterval: 0.01 }),
      runId: "run-core-dynamic",
      displayModel
    });

    expect(solved.ok).toBe(true);
    if (!solved.ok) throw new Error(solved.reason);
    const displacementFrames = solved.result.fields.filter((field) => field.type === "displacement");
    const fieldsByFrame = new Map<number, Set<string>>();
    for (const field of solved.result.fields) {
      fieldsByFrame.set(field.frameIndex ?? 0, (fieldsByFrame.get(field.frameIndex ?? 0) ?? new Set()).add(field.type));
    }

    expect(solved.solverBackend).toBe("opencae-core-dynamic-tet4");
    expect(solved.result.summary.provenance?.solver).toBe("opencae-core-dynamic-tet4");
    expect(displacementFrames.map((field) => field.timeSeconds)).toEqual([0, 0.01, 0.02, 0.025]);
    expect(displacementFrames.map((field) => field.frameIndex)).toEqual([0, 1, 2, 3]);
    expect(solved.result.summary.transient?.frameCount).toBe(4);
    expect([...fieldsByFrame.values()].map((types) => [...types].sort())).toEqual([
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"]
    ]);
    expect(solved.result.fields.every((field) => field.provenance?.kind === "opencae_core_fea")).toBe(true);
  });

  test("dynamic response preserves signed vectors and global frame ranges", () => {
    const solved = solveOpenCaeCoreStudy({
      study: dynamicStudy({ endTime: 0.08, timeStep: 0.005, outputInterval: 0.005, dampingRatio: 0, loadProfile: "sinusoidal" }),
      runId: "run-core-dynamic-signed",
      displayModel
    });

    expect(solved.ok).toBe(true);
    if (!solved.ok) throw new Error(solved.reason);
    const stressFrames = solved.result.fields.filter((field) => field.type === "stress");
    const displacementVectors = solved.result.fields
      .filter((field) => field.type === "displacement")
      .flatMap((field) => field.samples ?? [])
      .map((sample) => sample.vector)
      .filter((vector): vector is [number, number, number] => Boolean(vector));

    expect(new Set(stressFrames.map((field) => field.max)).size).toBe(1);
    expect(displacementVectors.some((vector) => vector.some((component) => component < 0))).toBe(true);
    expect(displacementVectors.some((vector) => vector.some((component) => component > 0))).toBe(true);
  });

  test("dynamic response changes with density and damping", () => {
    const sensitivitySettings = { endTime: 0.08, timeStep: 0.005, outputInterval: 0.005, loadProfile: "sinusoidal" as const };
    const aluminum = solveOpenCaeCoreStudy({ study: dynamicStudy({ ...sensitivitySettings, dampingRatio: 0 }, "mat-aluminum-6061"), runId: "run-aluminum", displayModel });
    const titanium = solveOpenCaeCoreStudy({ study: dynamicStudy({ ...sensitivitySettings, dampingRatio: 0 }, "mat-titanium-grade-5"), runId: "run-titanium", displayModel });
    const damped = solveOpenCaeCoreStudy({ study: dynamicStudy({ ...sensitivitySettings, dampingRatio: 0.25 }, "mat-aluminum-6061"), runId: "run-damped", displayModel });

    expect(aluminum.ok && titanium.ok && damped.ok).toBe(true);
    if (!aluminum.ok || !titanium.ok || !damped.ok) throw new Error("Expected dynamic solves to pass.");
    expect(titanium.result.summary.maxDisplacement).not.toBe(aluminum.result.summary.maxDisplacement);
    expect(damped.result.summary.maxDisplacement).not.toBe(aluminum.result.summary.maxDisplacement);
  });
});

function dynamicStudy(settings: Partial<NonNullable<Extract<Study, { type: "dynamic_structural" }>["solverSettings"]>>, materialId = "mat-aluminum-6061"): Study {
  return {
    ...staticStudy,
    type: "dynamic_structural",
    materialAssignments: [{ ...staticStudy.materialAssignments[0]!, materialId }],
    solverSettings: {
      backend: "opencae_core",
      fidelity: "standard",
      startTime: 0,
      endTime: 0.1,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0.02,
      integrationMethod: "newmark_average_acceleration",
      loadProfile: "ramp",
      ...settings
    }
  } satisfies Study;
}
