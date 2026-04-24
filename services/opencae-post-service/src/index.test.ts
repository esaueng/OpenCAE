import { describe, expect, test } from "vitest";
import type { ObjectStorageProvider } from "@opencae/storage";
import { LocalReportProvider } from "./index";

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

describe("LocalReportProvider", () => {
  test("writes reports under the run id", async () => {
    const storage = new MemoryStorage();
    const reports = new LocalReportProvider(storage);

    const first = await reports.generateReport({ projectId: "project-test", runId: "run-a", summary: summary(500) });
    const second = await reports.generateReport({ projectId: "project-test", runId: "run-b", summary: summary(1500) });

    expect(first).toBe("project-test/reports/run-a/report.html");
    expect(second).toBe("project-test/reports/run-b/report.html");
    expect((await storage.getObject(first)).toString("utf8")).toContain("Reaction force</td><td>500 N");
    expect((await storage.getObject(second)).toString("utf8")).toContain("Reaction force</td><td>1,500 N");
    expect((await storage.getObject("project-test/reports/run-a/report.pdf")).subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect((await storage.getObject("project-test/reports/run-b/report.pdf")).subarray(0, 4).toString("utf8")).toBe("%PDF");
  });
});

function summary(reactionForce: number) {
  return {
    maxStress: reactionForce / 10,
    maxStressUnits: "MPa",
    maxDisplacement: reactionForce / 1000,
    maxDisplacementUnits: "mm",
    safetyFactor: 2,
    reactionForce,
    reactionForceUnits: "N"
  };
}
