import { describe, expect, test, vi } from "vitest";
import type { ObjectStorageProvider } from "@opencae/storage";
import type { AnalysisMesh, Load, Study } from "@opencae/schema";
import { LocalMockComputeBackend, solveDynamicStudy, solveStudy } from "./index";

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
      const freeEndDisplacement = displacementValues[1] ?? 0;

      expect(displacementValues.indexOf(Math.max(...displacementValues))).toBe(1);
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
      const freeEndStress = stressValues[1] ?? 0;

      expect(stressValues.indexOf(Math.max(...stressValues))).toBe(0);
      expect(fixedEndStress).toBeGreaterThan(freeEndStress * 1.25);
      expect(displacementValues.indexOf(Math.max(...displacementValues))).toBe(1);
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

      expect(displacementFrames.length).toBeGreaterThan(3);
      expect(velocityFrames.length).toBe(displacementFrames.length);
      expect(accelerationFrames.length).toBe(displacementFrames.length);
      expect(displacementFrames.map((field) => field.frameIndex)).toEqual(displacementFrames.map((_, index) => index));
      expect(displacementFrames.map((field) => field.timeSeconds)).toEqual([...displacementFrames.map((field) => field.timeSeconds)].sort((a, b) => Number(a) - Number(b)));
      expect(new Set(displacementFrames.map((field) => field.max)).size).toBeGreaterThan(1);
      expect(second.fields.map(({ runId: _runId, id: _id, ...field }) => field)).toEqual(first.fields.map(({ runId: _runId, id: _id, ...field }) => field));
      expect(first.summary.transient).toMatchObject({
        integrationMethod: "newmark_average_acceleration",
        frameCount: displacementFrames.length
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("dynamic solve writes one output frame per time step and includes the final end time", () => {
    const solved = solveDynamicStudy(
      dynamicCantileverStudy("mat-aluminum-6061", {
        endTime: 0.012,
        timeStep: 0.005,
        outputInterval: 0.02
      }),
      "run-dynamic-time-step",
      rectangularBeamAnalysisMesh()
    );

    const fieldsByFrame = new Map<number, Set<string>>();
    for (const field of solved.fields) {
      fieldsByFrame.set(field.frameIndex ?? 0, (fieldsByFrame.get(field.frameIndex ?? 0) ?? new Set()).add(field.type));
    }
    const displacementFrames = solved.fields.filter((field) => field.type === "displacement");

    expect(displacementFrames.map((field) => field.timeSeconds)).toEqual([0, 0.005, 0.01, 0.012]);
    expect(displacementFrames.map((field) => field.frameIndex)).toEqual([0, 1, 2, 3]);
    expect(solved.summary.transient?.frameCount).toBe(4);
    expect([...fieldsByFrame.values()].map((types) => [...types].sort())).toEqual([
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"],
      ["acceleration", "displacement", "safety_factor", "stress", "velocity"]
    ]);
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
  const nearest = samples.reduce<{ value: number; distance: number } | undefined>((best, sample) => {
    const distance = Math.hypot(sample.point[0] - point[0], sample.point[1] - point[1], sample.point[2] - point[2]);
    return !best || distance < best.distance ? { value: sample.value, distance } : best;
  }, undefined);
  return nearest?.value ?? 0;
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
