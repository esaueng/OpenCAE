import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import { validateCoreResult, type OpenCAEModelJson } from "@opencae/core";
import { solveDynamicLinearTetLoadCases, solveDynamicLinearTetMDOF, solvePreviewSdofTet4Cpu, solveStaticLinearTet4Cpu, type SolveProgressEvent } from "../src";
import { minimumPositiveFinite } from "../src/dynamic-mdof";

const densityModel = {
  ...singleTetStaticFixture,
  schemaVersion: "0.2.0",
  materials: [
    {
      ...singleTetStaticFixture.materials[0],
      density: 1200,
      yieldStrength: 250e6
    }
  ]
} satisfies OpenCAEModelJson;

describe("solvePreviewSdofTet4Cpu preview", () => {
  test("remains the preview SDOF dynamic approximation", () => {
    const result = solvePreviewSdofTet4Cpu(singleTetStaticFixture, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.solver).toBe("opencae-core-preview-sdof");
    expect(result.result.staticResult.provenance?.resultSource).toBe("computed_preview");
  });
});

describe("solveDynamicLinearTetMDOF", () => {
  test("assembles volume-force density for dynamic steps and exposes conservation diagnostics", () => {
    const model: OpenCAEModelJson = {
      ...densityModel,
      schemaVersion: "0.3.0",
      loads: [{ name: "body", type: "bodyForceDensity", elementSet: "allElements", forceDensity: [0, 0, -600] }],
      steps: [{
        name: "dynamic",
        type: "dynamicLinear",
        boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
        loads: ["body"],
        startTime: 0,
        endTime: 0.01,
        timeStep: 0.005,
        outputInterval: 0.005,
        loadProfile: "ramp"
      }]
    };

    const result = solveDynamicLinearTetMDOF(model);

    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.loadAssembly?.perLoad[0]).toMatchObject({
      type: "bodyForceDensity",
      volume: 1 / 6,
      totalAppliedForce: [0, 0, -100],
      distribution: "hrz_volume"
    });
  });

  test("shares K/M across dynamic cases while keeping independent zero initial conditions", () => {
    const progress: SolveProgressEvent[] = [];
    const completed: string[] = [];
    const settings = {
      type: "dynamicLinear" as const,
      boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
      startTime: 0,
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01,
      loadProfile: "ramp" as const
    };
    const model: OpenCAEModelJson = {
      ...densityModel,
      loads: [
        { name: "down", type: "nodalForce", nodeSet: "loadNodes", vector: [0, 0, -100] },
        { name: "side", type: "nodalForce", nodeSet: "loadNodes", vector: [80, 0, 0] }
      ],
      steps: [
        { ...settings, name: "down", loads: ["down"] },
        { ...settings, name: "side", loads: ["side"] }
      ]
    };
    const solved = solveDynamicLinearTetLoadCases(
      model,
      [{ id: "down", stepIndex: 0 }, { id: "side", stepIndex: 1 }],
      { hooks: { onProgress: (event) => progress.push(event) } },
      (entry) => completed.push(entry.id)
    );

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(progress.filter((event) => event.phase === "assemble" && event.completed === event.total)).toHaveLength(1);
    expect(completed).toEqual(["down", "side"]);
    expect(solved.cases.every((entry) => maxAbs(entry.result.frames[0]!.displacement.values) === 0)).toBe(true);
    expect(solved.cases[0]!.diagnostics.rayleighCalibration).toEqual(solved.cases[1]!.diagnostics.rayleighCalibration);
    expect(Array.from(solved.cases[0]!.result.frames.at(-1)!.displacement.values)).not.toEqual(
      Array.from(solved.cases[1]!.result.frames.at(-1)!.displacement.values)
    );
  });

  test("rejects dynamic cases with case-local integration settings", () => {
    const firstStep = {
      name: "case-a",
      type: "dynamicLinear" as const,
      boundaryConditions: densityModel.steps[0]!.boundaryConditions,
      loads: densityModel.steps[0]!.loads,
      startTime: 0,
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01,
      loadProfile: "ramp" as const
    };
    const model: OpenCAEModelJson = {
      ...densityModel,
      steps: [
        { ...firstStep, name: "case-a" },
        { ...firstStep, name: "case-b", timeStep: firstStep.timeStep * 2 }
      ]
    };

    const solved = solveDynamicLinearTetLoadCases(model, [{ id: "a", stepIndex: 0 }, { id: "b", stepIndex: 1 }]);

    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.error.code).toBe("case-solver-settings-mismatch");
  });

  test("reduces production-scale safety-factor frames without spreading millions of arguments", () => {
    const fields = Array.from({ length: 22 }, (_, frameIndex) => {
      const values = new Float64Array(50_729);
      values.fill(10 + frameIndex);
      return values;
    });
    fields[21][50_728] = 0.25;
    fields[0][0] = Number.NaN;
    fields[0][1] = 0;

    expect(minimumPositiveFinite(fields)).toBe(0.25);
  });

  test("generates dynamic frames at the requested cadence including the final end time", () => {
    const result = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 0.025,
      timeStep: 0.005,
      outputInterval: 0.01
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frames.map((frame) => frame.timeSeconds)).toEqual([0, 0.01, 0.02, 0.025]);
    expect(result.result.frames.map((frame) => frame.frameIndex)).toEqual([0, 1, 2, 3]);
    expect(result.diagnostics.frameCount).toBe(4);
    expect(result.diagnostics.solver).toBe("opencae-core-mdof-newmark");
    expect(result.diagnostics.totalMass).toBeGreaterThan(0);
  });

  test("returns frame-aware Core result fields and a valid surface mesh", () => {
    const result = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coreResult = result.result.coreResult;
    expect(coreResult?.surfaceMesh?.triangles.length).toBeGreaterThan(0);
    expect(coreResult?.summary.transient?.frameCount).toBe(result.result.frames.length);
    expect(coreResult?.fields.some((field) => field.type === "velocity" && field.frameIndex === 0)).toBe(true);
    expect(coreResult?.fields.some((field) => field.type === "acceleration" && field.timeSeconds === 0.02)).toBe(true);
    expect(coreResult?.fields.some((field) => field.type === "safety_factor" && field.frameIndex === 0)).toBe(true);
    expect(coreResult?.fields.every((field) => field.values.length > 0)).toBe(true);
    // Only von Mises carries the tensor it was recovered from; the principal
    // and max-shear components are derived scalars, so they have none.
    const surfaceStressFields = coreResult?.fields.filter((field) => field.type === "stress" && field.location === "node" && field.component === "von_mises") ?? [];
    expect(surfaceStressFields.length).toBeGreaterThan(0);
    expect(surfaceStressFields.every((field) => field.tensorValues?.length === field.values.length * 6)).toBe(true);
    expect(validateCoreResult(coreResult!).ok).toBe(true);
  });

  test("applies explicit visualization smoothing metadata to dynamic surface stress fields", () => {
    const result = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01,
      visualizationSmoothing: { iterations: 1, alpha: 0.25 }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stressFields = result.result.coreResult?.fields.filter((field) => field.type === "stress" && field.location === "node" && field.component === "von_mises") ?? [];
    expect(stressFields.length).toBeGreaterThan(0);
    expect(stressFields.every((field) => field.visualizationSource === "volume_weighted_nodal_recovery_laplacian_smoothed")).toBe(true);
    expect(result.diagnostics.visualizationSmoothing).toEqual({ iterations: 1, alpha: 0.25 });
  });

  test("keeps frame field arrays compatible with the static Tet4 result", () => {
    const staticResult = solveStaticLinearTet4Cpu(singleTetStaticFixture);
    const dynamicResult = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.005
    });

    expect(staticResult.ok).toBe(true);
    expect(dynamicResult.ok).toBe(true);
    if (!staticResult.ok || !dynamicResult.ok) return;
    for (const frame of dynamicResult.result.frames) {
      expect(frame.displacement.values.length).toBe(staticResult.result.displacement.length);
      expect(frame.velocity.values.length).toBe(staticResult.result.displacement.length);
      expect(frame.acceleration.values.length).toBe(staticResult.result.displacement.length);
      expect(frame.strain.values.length).toBe(staticResult.result.strain.length);
      expect(frame.stress.values.length).toBe(staticResult.result.stress.length);
      expect(frame.vonMises.values.length).toBe(staticResult.result.vonMises.length);
      expect(frame.nodalStress?.values.length).toBe((staticResult.result.nodalStress?.length ?? 0));
      expect(frame.safety_factor.values.length).toBe(staticResult.result.vonMises.length);
      expect(frame.reactionForce?.length).toBe(staticResult.result.reactionForce.length);
      expect(frame.displacement.samples.length).toBeGreaterThan(0);
      expect(frame.displacement.frameIndex).toBe(frame.frameIndex);
      expect(frame.displacement.timeSeconds).toBe(frame.timeSeconds);
    }
  });

  test("starts ramp, quasi-static, and half-sine profiles near zero", () => {
    for (const loadProfile of ["ramp", "quasi_static", "half_sine"] as const) {
      const result = solveDynamicLinearTetMDOF(densityModel, {
        endTime: 0.04,
        timeStep: 0.005,
        outputInterval: 0.01,
        loadProfile
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.diagnostics.loadProfile).toBe(loadProfile);
      expect(result.result.coreResult?.summary.transient?.loadProfile).toBe(loadProfile);
      expect(maxAbs(result.result.frames[0].displacement.values)).toBeLessThan(1e-14);
      if (loadProfile === "half_sine") {
        expect(result.result.frames[0].loadScale).toBeCloseTo(0);
        expect(result.result.frames.at(-1)?.loadScale ?? -1).toBeCloseTo(0);
      } else {
        expect(maxAbs(result.result.frames.at(-1)?.displacement.values ?? new Float64Array())).toBeGreaterThan(0);
      }
    }
  });

  test("accepts sinusoidal as a compatibility alias but reports canonical half_sine", () => {
    const result = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 0.04,
      timeStep: 0.005,
      outputInterval: 0.02,
      loadProfile: "sinusoidal"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.loadProfile).toBe("half_sine");
    expect(result.result.coreResult?.summary.transient?.loadProfile).toBe("half_sine");
    expect(result.result.frames[0].loadScale).toBeCloseTo(0);
    expect(result.result.frames.at(-1)?.loadScale ?? -1).toBeCloseTo(0);
  });

  test("zero load produces zero displacement, velocity, and acceleration", () => {
    const model: OpenCAEModelJson = {
      ...densityModel,
      loads: [],
      steps: [
        {
          name: "loadStep",
          type: "dynamicLinear",
          boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
          loads: [],
          startTime: 0,
          endTime: 0.02,
          timeStep: 0.005,
          outputInterval: 0.01,
          loadProfile: "step"
        }
      ]
    };

    const result = solveDynamicLinearTetMDOF(model);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const frame of result.result.frames) {
      expect(maxAbs(frame.displacement.values)).toBe(0);
      expect(maxAbs(frame.velocity.values)).toBe(0);
      expect(maxAbs(frame.acceleration.values)).toBe(0);
    }
  });

  test("step load produces immediate dynamic acceleration at frame 0", () => {
    const result = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01,
      loadProfile: "step"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frames[0].loadScale).toBe(1);
    expect(maxAbs(result.result.frames[0].acceleration.values)).toBeGreaterThan(0);
  });

  test("computes real MDOF frames instead of reusing a static scale parser", () => {
    const result = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 0.08,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0,
      loadProfile: "step"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frames = result.result.frames.map((frame) => Array.from(frame.displacement.values));
    const uniqueFrames = new Set(frames.map((frame) => frame.map((value) => value.toExponential(6)).join(",")));
    expect(uniqueFrames.size).toBeGreaterThan(2);
    expect(result.diagnostics.freeDofs).toBeGreaterThan(1);
    expect(result.diagnostics.convergence.every((entry) => Number.isFinite(entry.relativeResidual))).toBe(true);
  });

  test("responds to density and damping inputs", () => {
    const heavyModel: OpenCAEModelJson = {
      ...densityModel,
      materials: [{ ...densityModel.materials[0], density: 7800 }]
    };
    const light = solveDynamicLinearTetMDOF(densityModel, { dampingRatio: 0.01 });
    const heavy = solveDynamicLinearTetMDOF(heavyModel, { dampingRatio: 0.01 });
    const damped = solveDynamicLinearTetMDOF(densityModel, { dampingRatio: 0.25 });

    expect(light.ok && heavy.ok && damped.ok).toBe(true);
    if (!light.ok || !heavy.ok || !damped.ok) return;
    expect(heavy.diagnostics.peakDisplacement).not.toBe(light.diagnostics.peakDisplacement);
    expect(damped.diagnostics.peakDisplacement).not.toBe(light.diagnostics.peakDisplacement);
    expect(light.diagnostics.peakVelocity).toBeGreaterThan(0);
    expect(damped.diagnostics.peakAcceleration).toBeGreaterThan(0);
    expect(Number.isFinite(light.diagnostics.minSafetyFactor ?? 0)).toBe(true);
    expect(light.diagnostics.peakStress).toBeGreaterThanOrEqual(0);
  });

  test("fails clearly when material density is missing", () => {
    const result = solveDynamicLinearTetMDOF(singleTetStaticFixture);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.message).toContain("Dynamic solve requires material density.");
  });

  test("fails clearly when requested output would create too many frames", () => {
    const result = solveDynamicLinearTetMDOF(densityModel, {
      endTime: 1,
      timeStep: 0.001,
      outputInterval: 0.001,
      maxFrames: 10
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("too-many-frames");
  });
});

function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}
