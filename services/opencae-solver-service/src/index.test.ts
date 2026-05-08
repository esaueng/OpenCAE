import { describe, expect, test, vi } from "vitest";
import type { ObjectStorageProvider } from "@opencae/storage";
import type { AnalysisMesh, Load, ResultField, ResultSample, Study } from "@opencae/schema";
import { benchmarkDynamicStudy, LocalMockComputeBackend, solveDynamicStudy, solveStudy } from "./index";

class MemoryStorage implements ObjectStorageProvider {
  objects = new Map<string, Buffer>();

  async putObject(key: string, data: string | Buffer | Uint8Array): Promise<string> {
    this.objects.set(key, Buffer.from(data));
    return key;
  }

  async getObject(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error(`missing ${key}`);
    return value;
  }

  async listObjects(prefix = ""): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  getLocalPath(key: string): string {
    return key;
  }
}

describe("LocalMockComputeBackend", () => {
  test("uses all loads to produce run-scoped, load-sensitive results", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);

      const firstRun = backend.runStaticSolve({
        study: studyWithLoads([{ id: "load-a", type: "force", value: 500, direction: [0, -1, 0] }]),
        runId: "run-a",
        meshRef: "mesh-a",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const first = await firstRun;

      const secondRun = backend.runStaticSolve({
        study: studyWithLoads([
          { id: "load-a", type: "force", value: 500, direction: [0, -1, 0] },
          { id: "load-b", type: "force", value: 1500, direction: [1, 0, 0] }
        ]),
        runId: "run-b",
        meshRef: "mesh-b",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const second = await secondRun;

      expect(first.resultRef).toBe("project-test/results/run-a/results.json");
      expect(second.resultRef).toBe("project-test/results/run-b/results.json");
      expect(second.summary.reactionForce).toBeGreaterThan(first.summary.reactionForce);
      expect(second.summary.maxStress).toBeGreaterThan(first.summary.maxStress);
      expect(second.fields.every((field) => field.runId === "run-b")).toBe(true);
      expect(await storage.getObject("project-test/solver/run-b/solver.inp").then((buffer) => buffer.toString("utf8"))).toContain("load-b");
    } finally {
      vi.useRealTimers();
    }
  });

  test("converts payload mass gravity loads to equivalent reaction force", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);

      const run = backend.runStaticSolve({
        study: studyWithLoads([{ id: "payload-mass", type: "gravity", value: 10, direction: [0, 0, -1] }]),
        runId: "run-payload",
        meshRef: "mesh-payload",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const solved = await run;

      expect(solved.summary.reactionForce).toBe(98.1);
      expect(solved.summary.reactionForceUnits).toBe("N");
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses requested force load direction for displacement vectors", () => {
    const zSolved = solveStudy(studyWithLoads([{ id: "load-z", type: "force", value: 500, direction: [0, 0, -1] }]), "run-force-z");
    const ySolved = solveStudy(studyWithLoads([{ id: "load-y", type: "force", value: 500, direction: [0, -1, 0] }]), "run-force-y");

    expect(dominantDisplacementAxis(zSolved.fields)).toEqual({ axis: "z", sign: -1 });
    expect(dominantDisplacementAxis(ySolved.fields)).toEqual({ axis: "y", sign: -1 });
  });

  test("marks heuristic surface results as local estimates", () => {
    const solved = solveStudy(studyWithLoads([{ id: "load-y", type: "force", value: 500, direction: [0, -1, 0] }]), "run-local-estimate");

    expect(solved.summary.provenance).toMatchObject({
      kind: "local_estimate",
      solver: "opencae-local-heuristic-surface",
      resultSource: "generated"
    });
    expect(solved.fields.every((field) => field.provenance?.kind === "local_estimate")).toBe(true);
  });

  test("uses requested gravity direction for payload displacement vectors", () => {
    const study = beamPayloadStudy("mat-aluminum-6061");
    const solved = solveStudy({
      ...study,
      loads: study.loads.map((load) => ({
        ...load,
        parameters: { ...load.parameters, direction: [0, 0, -1] }
      }))
    }, "run-gravity-z");

    expect(dominantDisplacementAxis(solved.fields)).toEqual({ axis: "z", sign: -1 });
  });

  test("superposes displacement vectors and reports sample magnitude", () => {
    const solved = solveStudy(studyWithLoads([
      { id: "load-y", type: "force", value: 500, direction: [0, -1, 0] },
      { id: "load-z", type: "force", value: 500, direction: [0, 0, -1] }
    ]), "run-superposed");
    const sample = displacementSamples(solved.fields).find((candidate) => (candidate.vector?.[1] ?? 0) < 0 && (candidate.vector?.[2] ?? 0) < 0);

    expect(sample?.vector?.[1]).toBeLessThan(0);
    expect(sample?.vector?.[2]).toBeLessThan(0);
    expect(sample?.value).toBeCloseTo(Math.hypot(...sample!.vector!), 4);
  });

  test("changes the solved stress field when the same total force is moved to a different face", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);

      const topRun = backend.runStaticSolve({
        study: studyWithLoads([{ id: "top-load", type: "force", value: 500, direction: [0, -1, 0], selectionRef: "selection-load-face" }]),
        runId: "run-top",
        meshRef: "mesh-top",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const top = await topRun;

      const endRun = backend.runStaticSolve({
        study: studyWithLoads([{ id: "end-load", type: "force", value: 500, direction: [1, 0, 0], selectionRef: "selection-end-face" }]),
        runId: "run-end",
        meshRef: "mesh-end",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const end = await endRun;

      const topStress = top.fields.find((field) => field.type === "stress")?.values;
      const endStress = end.fields.find((field) => field.type === "stress")?.values;
      const topDisplacement = top.fields.find((field) => field.type === "displacement")?.values;
      const endDisplacement = end.fields.find((field) => field.type === "displacement")?.values;

      expect(top.summary.reactionForce).toBe(end.summary.reactionForce);
      expect(topStress).not.toEqual(endStress);
      expect(topDisplacement).not.toEqual(endDisplacement);
      expect(topStress?.length).toBe(3);
      expect(endStress?.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses assigned material stiffness and yield strength in result fields", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);
      const load = { id: "load-a", type: "force" as const, value: 500, direction: [0, -1, 0] as [number, number, number] };

      const aluminumRun = backend.runStaticSolve({
        study: studyWithLoads([load], "mat-aluminum-6061"),
        runId: "run-aluminum",
        meshRef: "mesh-aluminum",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const aluminum = await aluminumRun;

      const absRun = backend.runStaticSolve({
        study: studyWithLoads([load], "mat-abs", { printed: false }),
        runId: "run-abs",
        meshRef: "mesh-abs",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const abs = await absRun;

      expect(abs.summary.maxStress).toBe(aluminum.summary.maxStress);
      expect(abs.summary.maxDisplacement).toBeGreaterThan(aluminum.summary.maxDisplacement);
      expect(abs.summary.safetyFactor).toBeLessThan(aluminum.summary.safetyFactor);
      expect(abs.fields.find((field) => field.type === "stress")?.values).toEqual(
        aluminum.fields.find((field) => field.type === "stress")?.values
      );
      expect(abs.fields.find((field) => field.type === "displacement")?.values).not.toEqual(
        aluminum.fields.find((field) => field.type === "displacement")?.values
      );
      expect(abs.fields.find((field) => field.type === "safety_factor")?.values).not.toEqual(
        aluminum.fields.find((field) => field.type === "safety_factor")?.values
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("solves cantilever plastic displacement at the loaded free end", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);

      const run = backend.runStaticSolve({
        study: cantileverStudy("mat-abs"),
        runId: "run-cantilever-abs",
        meshRef: "mesh-cantilever",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const result = await run;

      const displacementValues = result.fields.find((field) => field.type === "displacement")?.values ?? [];
      const fixedEndDisplacement = displacementValues[0] ?? 0;
      const freeEndDisplacement = displacementValues.at(-1) ?? 0;

      expect(displacementValues.indexOf(Math.max(...displacementValues))).toBe(displacementValues.length - 1);
      expect(freeEndDisplacement).toBeGreaterThan(fixedEndDisplacement * 2);
      expect(freeEndDisplacement).toBeGreaterThan(10);
      expect(result.summary.failureAssessment).toMatchObject({
        status: "fail",
        title: "Likely to fail"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("locks cantilever fixed support displacement to zero", () => {
    const result = solveStudy(cantileverStudy("mat-aluminum-6061"), "run-cantilever-fixed-displacement", rectangularBeamAnalysisMesh());
    const displacementField = result.fields.find((field) => field.type === "displacement");
    const displacementValues = displacementField?.values ?? [];
    const fixedEndFaceDisplacement = displacementValues[0] ?? Number.NaN;
    const freeEndFaceDisplacement = displacementValues[1] ?? 0;
    const fixedEndSampleDisplacement = nearestSampleValue(displacementField?.samples ?? [], [-1.9, 0.18, 0]);
    const freeEndSampleDisplacement = nearestSampleValue(displacementField?.samples ?? [], [1.9, 0.18, 0]);
    const freeEndSample = nearestSample(displacementField?.samples ?? [], [1.9, 0.18, 0]);

    expect(fixedEndFaceDisplacement).toBeCloseTo(0, 6);
    expect(fixedEndSampleDisplacement).toBeCloseTo(0, 6);
    expect(freeEndFaceDisplacement).toBeGreaterThan(fixedEndFaceDisplacement);
    expect(freeEndSampleDisplacement).toBeGreaterThan(fixedEndSampleDisplacement);
    expect(freeEndSample?.vector).toBeTruthy();
    expect(freeEndSample?.vector?.[2]).toBeLessThan(0);
    expect(Math.hypot(...freeEndSample!.vector!)).toBeCloseTo(freeEndSample.value, 4);
  });

  test("solves cantilever transverse bending with max stress at the fixed support", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);

      const run = backend.runStaticSolve({
        study: cantileverStudy("mat-abs"),
        runId: "run-cantilever-stress",
        meshRef: "mesh-cantilever",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const result = await run;

      const stressValues = result.fields.find((field) => field.type === "stress")?.values ?? [];
      const displacementValues = result.fields.find((field) => field.type === "displacement")?.values ?? [];
      const fixedEndStress = stressValues[0] ?? 0;
      const freeEndStress = stressValues.at(-1) ?? 0;

      expect(stressValues.indexOf(Math.max(...stressValues))).toBe(0);
      expect(fixedEndStress).toBeGreaterThan(freeEndStress * 1.25);
      expect(displacementValues.indexOf(Math.max(...displacementValues))).toBe(displacementValues.length - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("creates sampled cantilever stress with lower center stress than outer fibers", () => {
    const result = solveStudy(cantileverStudy("mat-aluminum-6061"), "run-sampled-cantilever", rectangularBeamAnalysisMesh());
    const stressField = result.fields.find((field) => field.type === "stress");

    const center = nearestSampleValue(stressField?.samples ?? [], [0, 0.18, 0]);
    const topOuter = nearestSampleValue(stressField?.samples ?? [], [0, 0.43, 0]);
    const bottomOuter = nearestSampleValue(stressField?.samples ?? [], [0, -0.07, 0]);
    const fixedOuter = nearestSampleValue(stressField?.samples ?? [], [-1.85, 0.43, 0]);
    const freeOuter = nearestSampleValue(stressField?.samples ?? [], [1.85, 0.43, 0]);

    expect(stressField?.samples?.length).toBeGreaterThan(20);
    expect(center).toBeLessThan(topOuter * 0.7);
    expect(center).toBeLessThan(bottomOuter * 0.7);
    expect(fixedOuter).toBeGreaterThan(freeOuter * 1.8);
    expect(stressField?.max).toBeGreaterThanOrEqual(Math.max(...(stressField?.samples ?? []).map((sample) => sample.value)));
  });

  test("keeps beam demo detailed stress samples aligned with high face stresses", () => {
    const result = solveStudy(beamPayloadStudy("mat-aluminum-6061"), "run-sampled-beam");
    const stressField = result.fields.find((field) => field.type === "stress");
    const sampleMax = Math.max(...(stressField?.samples ?? []).map((sample) => sample.value));
    const faceMax = Math.max(...(stressField?.values ?? []));

    expect(stressField?.samples?.length).toBeGreaterThan(100);
    expect(sampleMax).toBeGreaterThan(faceMax * 0.75);
  });

  test("emits beam demo payload displacement vectors in the visible bending direction", () => {
    const result = solveStudy(beamPayloadStudy("mat-aluminum-6061"), "run-beam-visible-vector");
    const displacementField = result.fields.find((field) => field.type === "displacement");
    const peakSample = [...(displacementField?.samples ?? [])].sort((left, right) => right.value - left.value)[0];

    expect(peakSample?.vector).toBeTruthy();
    expect(peakSample?.vector?.[1]).toBeLessThan(0);
    expect(Math.abs(peakSample?.vector?.[1] ?? 0)).toBeGreaterThan(Math.abs(peakSample?.vector?.[2] ?? 0) * 5);
    expect(Math.hypot(...peakSample!.vector!)).toBeCloseTo(peakSample.value, 4);
  });

  test("keeps beam demo displacement vectors smooth across each cross-section", () => {
    const result = solveStudy(beamPayloadStudy("mat-aluminum-6061"), "run-beam-smooth-vector", rectangularBeamAnalysisMesh());
    const displacementField = result.fields.find((field) => field.type === "displacement");
    const sameStationSamples = (displacementField?.samples ?? []).filter((sample) => Math.abs(sample.point[0]) < 1e-9);
    const magnitudes = sameStationSamples.map((sample) => sample.vector ? Math.hypot(...sample.vector) : 0);

    expect(sameStationSamples.length).toBeGreaterThan(3);
    expect(Math.max(...magnitudes) - Math.min(...magnitudes)).toBeLessThan(Math.max(...magnitudes) * 0.05);
  });

  test("ultra local solve produces denser surface samples with rich stress metadata", () => {
    const fine = solveStudy({ ...cantileverStudy("mat-aluminum-6061"), meshSettings: { preset: "fine", status: "complete", meshRef: "mesh", summary: { nodes: 1, elements: 1, warnings: [] } } }, "run-fine");
    const ultra = solveStudy({ ...cantileverStudy("mat-aluminum-6061"), meshSettings: { preset: "ultra", status: "complete", meshRef: "mesh", summary: { nodes: 1, elements: 1, warnings: [] } } }, "run-ultra");
    const ultraStressSample = ultra.fields.find((field) => field.type === "stress")?.samples?.[0];

    expect(ultra.analysisSampleCount).toBeGreaterThan(fine.analysisSampleCount);
    expect(ultraStressSample?.source).toMatch(/^beam-demo-/);
    expect(ultraStressSample?.vonMisesStressPa).toBeGreaterThan(0);
  });

  test("makes X build direction much weaker for cantilever bending across layer lines", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);

      const xRun = backend.runStaticSolve({
        study: cantileverStudy("mat-petg", { printed: true, infillDensity: 100, wallCount: 3, layerOrientation: "x" }),
        runId: "run-cantilever-petg-x",
        meshRef: "mesh-cantilever",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const x = await xRun;

      const yRun = backend.runStaticSolve({
        study: cantileverStudy("mat-petg", { printed: true, infillDensity: 100, wallCount: 3, layerOrientation: "y" }),
        runId: "run-cantilever-petg-y",
        meshRef: "mesh-cantilever",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const y = await yRun;

      const zRun = backend.runStaticSolve({
        study: cantileverStudy("mat-petg", { printed: true, infillDensity: 100, wallCount: 3, layerOrientation: "z" }),
        runId: "run-cantilever-petg-z",
        meshRef: "mesh-cantilever",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const z = await zRun;

      expect(x.summary.safetyFactor).toBeLessThan(y.summary.safetyFactor * 0.7);
      expect(x.summary.safetyFactor).toBeLessThan(z.summary.safetyFactor * 0.5);
      expect(await storage.getObject("project-cantilever/solver/run-cantilever-petg-x/solver.inp").then((buffer) => buffer.toString("utf8"))).toContain("layerOrientation=x");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not cap the material safety factor at the seed summary value", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);
      const load = { id: "load-a", type: "force" as const, value: 500, direction: [0, -1, 0] as [number, number, number] };

      const aluminumRun = backend.runStaticSolve({
        study: studyWithLoads([load], "mat-aluminum-6061"),
        runId: "run-aluminum-safety",
        meshRef: "mesh-aluminum",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const aluminum = await aluminumRun;

      const titaniumRun = backend.runStaticSolve({
        study: studyWithLoads([load], "mat-titanium-grade-5"),
        runId: "run-titanium",
        meshRef: "mesh-titanium",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const titanium = await titaniumRun;

      expect(titanium.summary.maxStress).toBe(aluminum.summary.maxStress);
      expect(titanium.summary.safetyFactor).toBeGreaterThan(aluminum.summary.safetyFactor);
      expect(titanium.fields.find((field) => field.type === "safety_factor")?.values).not.toEqual(
        aluminum.fields.find((field) => field.type === "safety_factor")?.values
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses 3D print infill settings to reduce stiffness and strength", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);
      const load = { id: "load-a", type: "force" as const, value: 500, direction: [0, -1, 0] as [number, number, number] };

      const solidRun = backend.runStaticSolve({
        study: studyWithLoads([load], "mat-petg", { printed: false }),
        runId: "run-petg-solid",
        meshRef: "mesh-petg-solid",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const solid = await solidRun;

      const printedRun = backend.runStaticSolve({
        study: studyWithLoads([load], "mat-petg", { printed: true, infillDensity: 35, wallCount: 3, layerOrientation: "z" }),
        runId: "run-petg-printed",
        meshRef: "mesh-petg-printed",
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const printed = await printedRun;

      expect(printed.summary.maxStress).toBeGreaterThan(solid.summary.maxStress);
      expect(printed.summary.maxDisplacement).toBeGreaterThan(solid.summary.maxDisplacement);
      expect(printed.summary.safetyFactor).toBeLessThan(solid.summary.safetyFactor);
      expect(printed.fields.find((field) => field.type === "stress")?.values).not.toEqual(
        solid.fields.find((field) => field.type === "stress")?.values
      );
      expect(await storage.getObject("project-test/solver/run-petg-printed/solver.inp").then((buffer) => buffer.toString("utf8"))).toContain("infillDensity=35");
    } finally {
      vi.useRealTimers();
    }
  });

  test("dynamic solve emits deterministic ordered transient result frames", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);
      const study = dynamicCantileverStudy("mat-aluminum-6061", { dampingRatio: 0.02 });

      const firstRun = backend.runDynamicSolve({
        study,
        runId: "run-dynamic-a",
        meshRef: "mesh-dynamic",
        analysisMesh: rectangularBeamAnalysisMesh(),
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const first = await firstRun;

      const secondRun = backend.runDynamicSolve({
        study,
        runId: "run-dynamic-b",
        meshRef: "mesh-dynamic",
        analysisMesh: rectangularBeamAnalysisMesh(),
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const second = await secondRun;

      const displacementFrames = first.fields.filter((field) => field.type === "displacement");
      const velocityFrames = first.fields.filter((field) => field.type === "velocity");
      const accelerationFrames = first.fields.filter((field) => field.type === "acceleration");
      const dynamicFieldTypes = new Set(first.fields.map((field) => field.type));

      expect(displacementFrames.length).toBeGreaterThan(3);
      expect(velocityFrames.length).toBe(displacementFrames.length);
      expect(accelerationFrames.length).toBe(displacementFrames.length);
      expect(dynamicFieldTypes).toEqual(new Set(["acceleration", "displacement", "safety_factor", "stress", "velocity"]));
      expect(displacementFrames.map((field) => field.frameIndex)).toEqual(displacementFrames.map((_, index) => index));
      expect(displacementFrames.map((field) => field.timeSeconds)).toEqual([...displacementFrames.map((field) => field.timeSeconds)].sort((a, b) => Number(a) - Number(b)));
      expect(new Set(displacementFrames.map((field) => field.values.join(","))).size).toBeGreaterThan(1);
      expect(second.fields.map(({ runId: _runId, id: _id, ...field }) => field)).toEqual(first.fields.map(({ runId: _runId, id: _id, ...field }) => field));
      expect(first.summary.transient).toMatchObject({
        integrationMethod: "newmark_average_acceleration",
        frameCount: displacementFrames.length
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("dynamic solve writes output frames by output interval and includes the final end time", () => {
    const solved = solveDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.025,
        timeStep: 0.005,
        outputInterval: 0.01
      }),
      "run-dynamic-time-step",
      rectangularBeamAnalysisMesh()
    );

    const fieldsByFrame = new Map<number, Set<string>>();
    for (const field of solved.fields) {
      fieldsByFrame.set(field.frameIndex ?? 0, (fieldsByFrame.get(field.frameIndex ?? 0) ?? new Set()).add(field.type));
    }
    const displacementFrames = solved.fields.filter((field) => field.type === "displacement");

    expect(displacementFrames.map((field) => field.timeSeconds)).toEqual([0, 0.01, 0.02, 0.025]);
    expect(displacementFrames.map((field) => field.frameIndex)).toEqual([0, 1, 2, 3]);
    expect(solved.summary.transient?.frameCount).toBe(4);
    expect([...fieldsByFrame.values()].map((types) => [...types].sort())).toEqual([
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"]
    ]);
  });

  test("benchmarks dynamic frame generation cost and serialized size", () => {
    const benchmark = benchmarkDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.025,
        timeStep: 0.005,
        outputInterval: 0.01
      }),
      "run-dynamic-benchmark",
      rectangularBeamAnalysisMesh()
    );

    expect(benchmark.frameCount).toBe(4);
    expect(benchmark.fieldCount).toBe(20);
    expect(benchmark.jsonBytes).toBeGreaterThan(0);
    expect(benchmark.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("dynamic solve normalizes legacy dense output intervals to bounded local frames", () => {
    const solved = solveDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.02,
        timeStep: 0.001,
        outputInterval: 0.001
      }),
      "run-dynamic-normalized-output",
      rectangularBeamAnalysisMesh()
    );

    const displacementFrames = solved.fields.filter((field) => field.type === "displacement");

    expect(displacementFrames.map((field) => field.timeSeconds)).toEqual([0, 0.005, 0.01, 0.015, 0.02]);
    expect(solved.summary.transient?.outputInterval).toBe(0.005);
    expect(solved.summary.transient?.frameCount).toBe(5);
  });

  test("dynamic solve keeps field ranges stable across animation frames", () => {
    const solved = solveDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.02,
        timeStep: 0.005
      }),
      "run-dynamic-stable-ranges",
      rectangularBeamAnalysisMesh()
    );

    const stressFrames = solved.fields.filter((field) => field.type === "stress");
    const firstStressFrame = stressFrames[0]!;
    const globalMaxima = new Set(stressFrames.map((field) => field.max));

    expect(globalMaxima.size).toBe(1);
    expect(firstStressFrame.max).toBeGreaterThan(Math.max(...firstStressFrame.values));
  });

  test("dynamic beam stress frames share a global stress range for playback colors", () => {
    const solved = solveDynamicStudy(
      {
        ...beamPayloadStudy("mat-aluminum-6061"),
        type: "dynamic_structural",
        solverSettings: { endTime: 0.02, timeStep: 0.005, outputInterval: 0.005 }
      },
      "run-dynamic-beam-gradient"
    );

    const stressFrames = solved.fields.filter((field) => field.type === "stress");

    expect(new Set(stressFrames.map((field) => field.max)).size).toBe(1);
    expect(new Set(stressFrames.map((field) => field.min)).size).toBe(1);
    expect(stressFrames[0]?.min).toBe(0);
  });

  test("dynamic solve emits signed displacement frames while stress remains magnitude based", () => {
    const solved = solveDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.08,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0,
        loadProfile: "sinusoidal"
      }),
      "run-dynamic-signed-displacement",
      rectangularBeamAnalysisMesh()
    );

    const displacementValues = solved.fields
      .filter((field) => field.type === "displacement")
      .flatMap((field) => field.values);
    const displacementVectors = solved.fields
      .filter((field) => field.type === "displacement")
      .flatMap((field) => field.samples ?? [])
      .map((sample) => sample.vector)
      .filter((vector): vector is [number, number, number] => Boolean(vector));
    const stressValues = solved.fields
      .filter((field) => field.type === "stress")
      .flatMap((field) => field.values);

    expect(displacementValues.some((value) => value < 0)).toBe(true);
    expect(displacementValues.some((value) => value > 0)).toBe(true);
    expect(displacementVectors.some((vector) => vector[2] < 0)).toBe(true);
    expect(displacementVectors.some((vector) => vector[2] > 0)).toBe(true);
    expect(stressValues.every((value) => value >= 0)).toBe(true);
    expect(solved.summary.maxDisplacement).toBeGreaterThan(0);
  });

  test("dynamic vector frames preserve static displacement direction", () => {
    const solved = solveDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.02,
        timeStep: 0.005,
        outputInterval: 0.005
      }),
      "run-dynamic-vector-direction",
      rectangularBeamAnalysisMesh()
    );

    for (const type of ["displacement", "velocity", "acceleration"] as const) {
      const field = solved.fields.find((candidate) => candidate.type === type && dominantDisplacementAxis([candidate]).axis === "z");
      expect(field, `${type} frame should have a Z-dominant vector`).toBeDefined();
      expect(dominantDisplacementAxis([field!]).sign).not.toBe(0);
    }
  });

  test("dynamic vector frames preserve cubic cantilever shape ratios", () => {
    const solved = solveDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.02,
        timeStep: 0.005,
        outputInterval: 0.005
      }),
      "run-dynamic-cubic-shape",
      rectangularBeamAnalysisMesh()
    );

    for (const type of ["displacement", "velocity", "acceleration"] as const) {
      const field = solved.fields
        .filter((candidate) => candidate.type === type)
        .find((candidate) => Math.abs(nearestSampleValue(candidate.samples ?? [], [1.9, 0.14, 0])) > 1e-9);
      const midValue = Math.abs(nearestSampleValue(field?.samples ?? [], [0, 0.14, 0]));
      const tipValue = Math.abs(nearestSampleValue(field?.samples ?? [], [1.9, 0.14, 0]));

      expect(field, `${type} frame should have a nonzero free-end response`).toBeDefined();
      expect(midValue / tipValue).toBeCloseTo(0.3125, 4);
      expect(midValue / tipValue).not.toBeCloseTo(0.5, 1);
    }
  });

  test("dynamic response changes with density and damping", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const backend = new LocalMockComputeBackend(storage);

      const aluminumRun = backend.runDynamicSolve({
        study: dynamicCantileverStudy("mat-aluminum-6061", { dampingRatio: 0 }),
        runId: "run-dynamic-aluminum",
        meshRef: "mesh-dynamic",
        analysisMesh: rectangularBeamAnalysisMesh(),
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const aluminum = await aluminumRun;

      const titaniumRun = backend.runDynamicSolve({
        study: dynamicCantileverStudy("mat-titanium-grade-5", { dampingRatio: 0 }),
        runId: "run-dynamic-titanium",
        meshRef: "mesh-dynamic",
        analysisMesh: rectangularBeamAnalysisMesh(),
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const titanium = await titaniumRun;

      const dampedRun = backend.runDynamicSolve({
        study: dynamicCantileverStudy("mat-aluminum-6061", { dampingRatio: 0.25 }),
        runId: "run-dynamic-damped",
        meshRef: "mesh-dynamic",
        analysisMesh: rectangularBeamAnalysisMesh(),
        publish: vi.fn()
      });
      await vi.runAllTimersAsync();
      const damped = await dampedRun;

      expect(titanium.summary.maxDisplacement).not.toBe(aluminum.summary.maxDisplacement);
      expect(damped.summary.maxDisplacement).toBeLessThan(aluminum.summary.maxDisplacement);
    } finally {
      vi.useRealTimers();
    }
  });
});

function rectangularBeamAnalysisMesh(): AnalysisMesh {
  const samples: AnalysisMesh["samples"] = [];
  for (let ix = 0; ix <= 24; ix += 1) {
    const x = -1.9 + (3.8 * ix) / 24;
    for (const y of [-0.07, 0.18, 0.43]) {
      samples.push({ point: [x, y, 0], normal: [0, y >= 0.18 ? 1 : -1, 0], weight: 1, sourceId: "beam-y" });
    }
    for (const z of [-0.36, 0.36]) {
      samples.push({ point: [x, 0.18, z], normal: [0, 0, z > 0 ? 1 : -1], weight: 1, sourceId: "beam-z" });
    }
  }
  return {
    quality: "fine",
    bounds: { min: [-1.9, -0.07, -0.36], max: [1.9, 0.43, 0.36] },
    samples
  };
}

function nearestSampleValue(samples: NonNullable<ReturnType<typeof solveStudy>["fields"][number]["samples"]>, point: [number, number, number]) {
  return nearestSample(samples, point)?.value ?? 0;
}

function nearestSample(samples: NonNullable<ReturnType<typeof solveStudy>["fields"][number]["samples"]>, point: [number, number, number]) {
  return samples.reduce<(NonNullable<ReturnType<typeof solveStudy>["fields"][number]["samples"]>[number] & { distance: number }) | undefined>((best, sample) => {
    const distance = Math.hypot(sample.point[0] - point[0], sample.point[1] - point[1], sample.point[2] - point[2]);
    return !best || distance < best.distance ? { ...sample, distance } : best;
  }, undefined);
}

function studyWithLoads(loads: Array<{ id: string; type: Load["type"]; value: number; direction: [number, number, number]; selectionRef?: string }>, materialId = "mat-aluminum-6061", materialParameters: Record<string, unknown> = {}): Study {
  return {
    id: "study-test",
    projectId: "project-test",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId, selectionRef: "selection-body", parameters: materialParameters, status: "complete" }],
    namedSelections: [
      {
        id: "selection-load-face",
        name: "Load face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load", label: "Load face" }],
        fingerprint: "face-load"
      },
      {
        id: "selection-end-face",
        name: "End face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-end", label: "Base end face" }],
        fingerprint: "face-end"
      },
      {
        id: "selection-web-face",
        name: "Web face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-web", label: "Brace face" }],
        fingerprint: "face-web"
      }
    ],
    contacts: [],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-load-face", parameters: {}, status: "complete" }],
    loads: loads.map((load) => ({
      id: load.id,
      type: load.type,
      selectionRef: load.selectionRef ?? "selection-load-face",
      parameters: { value: load.value, units: load.type === "pressure" ? "kPa" : "N", direction: load.direction },
      status: "complete"
    })),
    meshSettings: { preset: "medium", status: "complete", meshRef: "mesh", summary: { nodes: 10, elements: 4, warnings: [] } },
    solverSettings: {},
    validation: [],
    runs: []
  };
}

function cantileverStudy(materialId: string, materialParameters: Record<string, unknown> = {}): Study {
  return {
    id: "study-cantilever",
    projectId: "project-cantilever",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId, selectionRef: "selection-body", parameters: materialParameters, status: "complete" }],
    namedSelections: [
      {
        id: "selection-fixed-face",
        name: "Fixed end face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-left", label: "Fixed end face" }],
        fingerprint: "face-base-left-cantilever"
      },
      {
        id: "selection-load-face",
        name: "Free end load face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load-top", label: "Free end load face" }],
        fingerprint: "face-load-top-cantilever"
      },
      {
        id: "selection-web-face",
        name: "Top beam face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-web-front", label: "Top beam face" }],
        fingerprint: "face-web-front-cantilever"
      },
      {
        id: "selection-base-face",
        name: "Beam bottom face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-bottom", label: "Beam bottom face" }],
        fingerprint: "face-base-bottom-cantilever"
      }
    ],
    contacts: [],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
    loads: [{
      id: "load-free-end",
      type: "force",
      selectionRef: "selection-load-face",
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    }],
    meshSettings: { preset: "medium", status: "complete", meshRef: "mesh", summary: { nodes: 10, elements: 4, warnings: [] } },
    solverSettings: {},
    validation: [],
    runs: []
  };
}

function beamPayloadStudy(materialId: string, materialParameters: Record<string, unknown> = {}): Study {
  return {
    id: "study-beam",
    projectId: "project-beam",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId, selectionRef: "selection-body", parameters: materialParameters, status: "complete" }],
    namedSelections: [
      {
        id: "selection-fixed-face",
        name: "Fixed end face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-left", label: "Fixed end face" }],
        fingerprint: "face-base-left-beam"
      },
      {
        id: "selection-load-face",
        name: "End payload mass",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load-top", label: "End payload mass" }],
        fingerprint: "face-load-top-beam"
      },
      {
        id: "selection-web-face",
        name: "Beam top face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-web-front", label: "Beam top face" }],
        fingerprint: "face-web-front-beam"
      },
      {
        id: "selection-base-face",
        name: "Beam body",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-bottom", label: "Beam body" }],
        fingerprint: "face-base-bottom-beam"
      }
    ],
    contacts: [],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
    loads: [{
      id: "load-payload",
      type: "gravity",
      selectionRef: "selection-load-face",
      parameters: {
        value: 4.9,
        units: "kg",
        direction: [0, -1, 0],
        applicationPoint: [1.48, 0.49, 0]
      },
      status: "complete"
    }],
    meshSettings: { preset: "medium", status: "complete", meshRef: "mesh", summary: { nodes: 10, elements: 4, warnings: [] } },
    solverSettings: {},
    validation: [],
    runs: []
  };
}

function displacementSamples(fields: ResultField[]): ResultSample[] {
  return fields.find((field) => field.type === "displacement")?.samples ?? [];
}

function dominantDisplacementAxis(fields: ResultField[]): { axis: "x" | "y" | "z"; sign: -1 | 0 | 1 } {
  const samples = fields.length === 1
    ? fields[0]?.samples ?? []
    : displacementSamples(fields);
  const totals = samples.reduce((sum, sample) => {
    const vector = sample.vector ?? [0, 0, 0];
    sum.components[0] += Math.abs(vector[0]);
    sum.components[1] += Math.abs(vector[1]);
    sum.components[2] += Math.abs(vector[2]);
    sum.signed[0] += vector[0];
    sum.signed[1] += vector[1];
    sum.signed[2] += vector[2];
    return sum;
  }, { components: [0, 0, 0], signed: [0, 0, 0] } as { components: [number, number, number]; signed: [number, number, number] });
  const axisIndex = totals.components[0] >= totals.components[1] && totals.components[0] >= totals.components[2]
    ? 0
    : totals.components[1] >= totals.components[2] ? 1 : 2;
  return {
    axis: (["x", "y", "z"] as const)[axisIndex],
    sign: totals.signed[axisIndex] > 1e-9 ? 1 : totals.signed[axisIndex] < -1e-9 ? -1 : 0
  };
}

function dynamicCantileverStudy(materialId: string, solverSettings: Record<string, unknown> = {}): Study {
  return {
    ...cantileverStudy(materialId),
    name: "Dynamic",
    type: "dynamic_structural",
    solverSettings: {
      startTime: 0,
      endTime: 0.05,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0.02,
      integrationMethod: "newmark_average_acceleration",
      ...solverSettings
    }
  };
}
