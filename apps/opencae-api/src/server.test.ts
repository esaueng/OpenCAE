import { describe, expect, test } from "vitest";
import { API_LISTEN_HOST, buildApi } from "./server";

describe("OpenCAE API server", () => {
  test("only allows local development origins through CORS", async () => {
    const api = await buildApi();

    const allowed = await api.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:5173" } });
    const blocked = await api.inject({ method: "GET", url: "/health", headers: { origin: "https://attacker.example" } });

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("listens on loopback by default", () => {
    expect(API_LISTEN_HOST).toBe("127.0.0.1");
  });

  test("rate limits project creation", async () => {
    const api = await buildApi();
    const responses = [];
    for (let index = 0; index < 31; index += 1) {
      responses.push(await api.inject({ method: "POST", url: "/api/projects", remoteAddress: "203.0.113.10", payload: {} }));
    }

    expect(responses.slice(0, 30).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[30]?.statusCode).toBe(429);
    expect(responses[30]?.json()).toMatchObject({ error: "Too many API requests. Please try again later." });
  });

  test("rate limits project listing", async () => {
    const api = await buildApi();
    const responses = [];
    for (let index = 0; index < 61; index += 1) {
      responses.push(await api.inject({ method: "GET", url: "/api/projects", remoteAddress: "203.0.113.11" }));
    }

    expect(responses.slice(0, 60).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[60]?.statusCode).toBe(429);
    expect(responses[60]?.json()).toMatchObject({ error: "Too many API requests. Please try again later." });
  });

  test("sanitizes report download filenames without regex replacement", async () => {
    const api = await buildApi();
    const create = await api.inject({
      method: "POST",
      url: "/api/projects",
      remoteAddress: "203.0.113.20",
      payload: { mode: "sample", sample: "bracket", analysisType: "dynamic_structural", name: "../../My Unsafe Project!!" }
    });
    const project = create.json().project as { id: string };

    const response = await api.inject({ method: "GET", url: `/api/projects/${project.id}/report.pdf` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="my-unsafe-project-report.pdf"');
  });

  test("returns 404 when creating a study for a missing project", async () => {
    const api = await buildApi();
    const response = await api.inject({
      method: "POST",
      url: "/api/projects/project-does-not-exist/studies",
      remoteAddress: "203.0.113.21",
      payload: {}
    });
    expect(response.statusCode).toBe(404);
  });

  test("rejects study updates that fail schema validation", async () => {
    const api = await buildApi();
    const create = await api.inject({
      method: "POST",
      url: "/api/projects",
      remoteAddress: "203.0.113.22",
      payload: { mode: "sample", sample: "bracket" }
    });
    const project = create.json().project as { id: string; studies: Array<{ id: string }> };
    const studyId = project.studies[0]!.id;

    const invalid = await api.inject({
      method: "PUT",
      url: `/api/studies/${studyId}`,
      remoteAddress: "203.0.113.22",
      payload: { loads: "not-an-array" }
    });
    expect(invalid.statusCode).toBe(400);

    const renamed = await api.inject({
      method: "PUT",
      url: `/api/studies/${studyId}`,
      remoteAddress: "203.0.113.22",
      payload: { name: "Renamed Study" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().study.name).toBe("Renamed Study");
  });

  test("study updates cannot reassign id or projectId", async () => {
    const api = await buildApi();
    const create = await api.inject({
      method: "POST",
      url: "/api/projects",
      remoteAddress: "203.0.113.23",
      payload: { mode: "sample", sample: "bracket" }
    });
    const project = create.json().project as { id: string; studies: Array<{ id: string }> };
    const studyId = project.studies[0]!.id;

    const response = await api.inject({
      method: "PUT",
      url: `/api/studies/${studyId}`,
      remoteAddress: "203.0.113.23",
      payload: { id: "study-hijacked", projectId: "project-other" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().study.id).toBe(studyId);
    expect(response.json().study.projectId).toBe(project.id);
  });

  test("does not serve the bracket demo report for unrelated runs without a report", async () => {
    const api = await buildApi();
    const response = await api.inject({ method: "GET", url: "/api/runs/run-unrelated-missing/report" });
    expect(response.statusCode).toBe(404);
  });

  test("import strips artifact refs that point outside the imported project", async () => {
    const api = await buildApi();
    const sample = await api.inject({ method: "GET", url: "/api/sample-project" });
    const template = sample.json().project as Record<string, unknown>;
    const hostile = structuredClone(template) as {
      id: string;
      geometryFiles: Array<{ artifactKey: string; metadata: Record<string, unknown> }>;
      studies: Array<{ runs: Array<Record<string, unknown>> }>;
    };
    hostile.id = "project-hostile-import";
    hostile.geometryFiles.forEach((geometry) => {
      geometry.artifactKey = "project-bracket-demo/reports/report.html";
      geometry.metadata = { ...geometry.metadata, displayModelRef: "project-bracket-demo/results/results.json" };
    });
    hostile.studies.forEach((study) => {
      study.runs.forEach((run) => {
        run.resultRef = "project-bracket-demo/results/results.json";
        run.reportRef = "project-bracket-demo/reports/report.html";
      });
    });

    const response = await api.inject({
      method: "POST",
      url: "/api/projects/import",
      remoteAddress: "203.0.113.24",
      payload: { project: hostile }
    });
    expect(response.statusCode).toBe(200);
    const imported = response.json().project as {
      id: string;
      geometryFiles: Array<{ artifactKey: string }>;
      studies: Array<{ runs: Array<{ resultRef?: string; reportRef?: string }> }>;
    };
    for (const geometry of imported.geometryFiles) {
      expect(geometry.artifactKey.startsWith("project-hostile-import/")).toBe(true);
    }
    for (const run of imported.studies.flatMap((study) => study.runs)) {
      if (run.resultRef) expect(run.resultRef.startsWith("project-hostile-import/")).toBe(true);
      if (run.reportRef) expect(run.reportRef.startsWith("project-hostile-import/")).toBe(true);
    }
  });

  test("import rejects project ids that could steer storage keys", async () => {
    const api = await buildApi();
    const sample = await api.inject({ method: "GET", url: "/api/sample-project" });
    const template = sample.json().project as { id: string };

    for (const hostileId of ["../project-bracket-demo", "nested/escape", "..", ".hidden", "a\\b"]) {
      const hostile = structuredClone(template) as Record<string, unknown>;
      hostile.id = hostileId;
      const response = await api.inject({
        method: "POST",
        url: "/api/projects/import",
        remoteAddress: "203.0.113.25",
        payload: { project: hostile }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/project id/i);
    }
  });

  test("import drops result bundles whose run id could steer storage keys", async () => {
    const api = await buildApi();
    const sample = await api.inject({ method: "GET", url: "/api/sample-project" });
    const template = sample.json().project as { id: string };
    const hostile = structuredClone(template) as Record<string, unknown>;
    hostile.id = "project-runid-traversal";

    const summary = {
      maxStress: 1,
      maxStressUnits: "MPa",
      maxDisplacement: 0.1,
      maxDisplacementUnits: "mm",
      safetyFactor: 10,
      reactionForce: 500,
      reactionForceUnits: "N"
    };
    const response = await api.inject({
      method: "POST",
      url: "/api/projects/import",
      remoteAddress: "203.0.113.26",
      payload: {
        project: hostile,
        results: {
          completedRunId: "../../project-bracket-demo/reports/run",
          summary,
          fields: [{
            id: "stress",
            runId: "../../project-bracket-demo/reports/run",
            type: "stress",
            location: "node",
            values: [1],
            min: 1,
            max: 1,
            units: "MPa"
          }]
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toBeUndefined();
    const refs = (response.json().project as { studies: Array<{ runs: Array<{ resultRef?: string; reportRef?: string }> }> })
      .studies.flatMap((study) => study.runs).flatMap((run) => [run.resultRef, run.reportRef]).filter(Boolean) as string[];
    for (const ref of refs) {
      expect(ref.includes("..")).toBe(false);
      expect(ref.startsWith("project-runid-traversal/")).toBe(true);
    }
  });
});
