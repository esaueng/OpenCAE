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
});

function studyWithLoads(loads: Array<{ id: string; type: Load["type"]; value: number; direction: [number, number, number] }>): Study {
  return {
    id: "study-test",
    projectId: "project-test",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId: "mat", selectionRef: "selection-body", status: "complete" }],
    namedSelections: [
      {
        id: "selection-load-face",
        name: "Load face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load", label: "Load face" }],
        fingerprint: "face-load"
      }
    ],
    contacts: [],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-load-face", parameters: {}, status: "complete" }],
    loads: loads.map((load) => ({
      id: load.id,
      type: load.type,
      selectionRef: "selection-load-face",
      parameters: { value: load.value, units: load.type === "pressure" ? "kPa" : "N", direction: load.direction },
      status: "complete"
    })),
    meshSettings: { preset: "medium", status: "complete", meshRef: "mesh", summary: { nodes: 10, elements: 4, warnings: [] } },
    solverSettings: {},
    validation: [],
    runs: []
  };
}
