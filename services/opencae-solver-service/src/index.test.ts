import { describe, expect, test, vi } from "vitest";
import type { ObjectStorageProvider } from "@opencae/storage";
import type { Load, Study } from "@opencae/schema";
import { LocalMockComputeBackend } from "./index";

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
        study: studyWithLoads([load], "mat-abs"),
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
});

function studyWithLoads(loads: Array<{ id: string; type: Load["type"]; value: number; direction: [number, number, number]; selectionRef?: string }>, materialId = "mat-aluminum-6061"): Study {
  return {
    id: "study-test",
    projectId: "project-test",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId, selectionRef: "selection-body", status: "complete" }],
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

function cantileverStudy(materialId: string): Study {
  return {
    id: "study-cantilever",
    projectId: "project-cantilever",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId, selectionRef: "selection-body", status: "complete" }],
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
