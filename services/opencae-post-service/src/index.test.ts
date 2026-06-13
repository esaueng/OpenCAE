import { describe, expect, test } from "vitest";
import type { ResultSummary } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";
import { buildHtmlReport, buildPdfReport, LocalReportProvider } from "./index";

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

  test("uses a CAD-like model preview instead of the old block heatmap", () => {
    const html = buildHtmlReport("run-a", summary(500));

    expect(html).toContain("class=\"visual result-model\"");
    expect(html).toContain("Schematic stress contour illustration, not model geometry");
    expect(html).toContain("Schematic illustration - not model geometry");
    expect(html).not.toContain("feGaussianBlur");
  });

  test("prints result provenance and marks local estimates as not analysis", () => {
    const estimateSummary: ResultSummary = {
      ...summary(500),
      provenance: {
        kind: "local_estimate",
        solver: "opencae-local-heuristic-surface",
        solverVersion: "0.1.0",
        meshSource: "mock",
        resultSource: "generated",
        units: "mm-N-s-MPa"
      }
    };

    const html = buildHtmlReport("run-estimate", estimateSummary);
    const pdf = buildPdfReport("run-estimate", estimateSummary).toString("latin1");

    expect(html).toContain("Estimate (not FEA)");
    expect(html).toContain("NOT ANALYSIS");
    expect(html).toContain("opencae-local-heuristic-surface");
    expect(html).toContain("mock");
    expect(html).toContain("generated");
    expect(pdf).toContain("NOT ANALYSIS");
    expect(pdf).toContain("Estimate \\(not FEA\\)");
  });

  test("includes a failure assessment for low safety-factor results", () => {
    const html = buildHtmlReport("run-a", summary(500, 0.82));

    expect(html).toContain("Likely to fail");
    expect(html).toContain("exceeds the assigned material yield limit");
  });

  test("escapes and whitelists the assessment status against script injection", () => {
    const html = buildHtmlReport("run-a", {
      ...summary(500),
      failureAssessment: {
        status: '"><script>alert(1)</script>' as never,
        title: "Injected <title>",
        message: "Injected <message>"
      }
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('class="assessment "><script>');
    expect(html).toContain('class="assessment unknown"');
    expect(html).toContain("Injected &lt;title&gt;");
  });

  test("positions the stress marker by safety-factor utilization", () => {
    const comfortable = buildHtmlReport("run-a", summary(500, 2));
    const failing = buildHtmlReport("run-a", summary(500, 0.5));
    const unknown = buildHtmlReport("run-a", summary(500, 0));

    expect(comfortable).toContain("margin-left: 50%");
    expect(failing).toContain("margin-left: 100%");
    expect(unknown).toContain("margin-left: 100%");
  });

  test("labels the PDF header with the dynamic analysis type for transient runs", () => {
    const dynamicSummary: ResultSummary = {
      ...summary(500),
      transient: {
        analysisType: "dynamic_structural",
        integrationMethod: "newmark_average_acceleration",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        frameCount: 21,
        peakDisplacementTimeSeconds: 0.05,
        peakDisplacement: 0.4
      }
    };

    expect(buildPdfReport("run-a", dynamicSummary).toString("latin1")).toContain("OpenCAE DYNAMIC STRUCTURAL SIMULATION");
    expect(buildPdfReport("run-a", summary(500)).toString("latin1")).toContain("OpenCAE STATIC STRESS SIMULATION");
  });
});

function summary(reactionForce: number, safetyFactor = 2): ResultSummary {
  return {
    maxStress: reactionForce / 10,
    maxStressUnits: "MPa",
    maxDisplacement: reactionForce / 1000,
    maxDisplacementUnits: "mm",
    safetyFactor,
    reactionForce,
    reactionForceUnits: "N",
    diagnostics: []
  };
}
