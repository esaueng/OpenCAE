import { describe, expect, test } from "vitest";
import { MockMeshService } from "./index";

class MemoryStorage {
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

describe("MockMeshService", () => {
  test("reports increasing analysis sample counts by mesh quality", async () => {
    const service = new MockMeshService(new MemoryStorage());
    const study = { id: "study-mesh", projectId: "project-mesh" } as Parameters<MockMeshService["generateMesh"]>[0];

    const coarse = await service.generateMesh(study, "coarse");
    const medium = await service.generateMesh(study, "medium");
    const fine = await service.generateMesh(study, "fine");
    const ultra = await service.generateMesh(study, "ultra");

    expect(coarse.summary.analysisSampleCount).toBeLessThan(medium.summary.analysisSampleCount ?? 0);
    expect(medium.summary.analysisSampleCount).toBeLessThan(fine.summary.analysisSampleCount ?? 0);
    expect(fine.summary.analysisSampleCount).toBeLessThan(ultra.summary.analysisSampleCount ?? 0);
    expect(ultra.summary.quality).toBe("ultra");
    expect(fine.summary.warnings.join(" ")).not.toContain("mocked");
  });

  test("writes study-scoped mesh artifacts so studies in a project do not collide", async () => {
    const storage = new MemoryStorage();
    const service = new MockMeshService(storage);
    const studyA = { id: "study-a", projectId: "project-mesh" } as Parameters<MockMeshService["generateMesh"]>[0];
    const studyB = { id: "study-b", projectId: "project-mesh" } as Parameters<MockMeshService["generateMesh"]>[0];

    const coarse = await service.generateMesh(studyA, "coarse");
    const fine = await service.generateMesh(studyB, "fine");

    expect(coarse.artifactKey).toBe("project-mesh/mesh/study-a/mesh-summary.json");
    expect(fine.artifactKey).toBe("project-mesh/mesh/study-b/mesh-summary.json");
    expect(JSON.parse((await storage.getObject(coarse.artifactKey)).toString("utf8")).quality).toBe("coarse");
    expect(JSON.parse((await storage.getObject(fine.artifactKey)).toString("utf8")).quality).toBe("fine");
  });
});
