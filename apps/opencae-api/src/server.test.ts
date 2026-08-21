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

  test("keeps the newest model upload when same-workspace requests arrive out of order", async () => {
    const api = await buildApi();
    const remoteAddress = "203.0.113.27";
    const create = await api.inject({ method: "POST", url: "/api/projects", remoteAddress, payload: {} });
    const project = create.json().project as { id: string; updatedAt: string; geometryFiles: Array<{ id: string }> };
    const baseMutation = {
      clientId: "workspace-session",
      expectedGeometryId: null,
      expectedUpdatedAt: project.updatedAt
    };
    const upload = (filename: string, generation: number, clientId = baseMutation.clientId) => api.inject({
      method: "POST",
      url: `/api/projects/${project.id}/uploads`,
      remoteAddress,
      payload: {
        filename,
        contentType: "model/stl",
        modelMutation: { ...baseMutation, clientId, generation }
      }
    });

    const first = await upload("first.stl", 1);
    const newest = await upload("newest.stl", 3);
    const lateOlder = await upload("late-older.stl", 2);
    const staleOtherWorkspace = await upload("other-workspace.stl", 4, "other-workspace");
    const rename = await api.inject({
      method: "PUT",
      url: `/api/projects/${project.id}`,
      remoteAddress,
      payload: { name: "Renamed after upload" }
    });
    const staleAfterProjectEdit = await upload("stale-after-edit.stl", 5);
    const files = await api.inject({ method: "GET", url: `/api/projects/${project.id}/files` });

    expect(first.statusCode).toBe(200);
    expect(newest.statusCode).toBe(200);
    expect(lateOlder.statusCode).toBe(409);
    expect(staleOtherWorkspace.statusCode).toBe(409);
    expect(rename.statusCode).toBe(200);
    expect(staleAfterProjectEdit.statusCode).toBe(409);
    expect(files.json().files[0]?.filename).toBe("newest.stl");
    expect(files.json().files[0]?.metadata.modelMutation).toMatchObject({ clientId: "workspace-session", generation: 3 });
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

  test("imports project files larger than the general API body limit", async () => {
    const api = await buildApi();
    const sample = await api.inject({ method: "GET", url: "/api/sample-project" });
    const template = sample.json().project as Record<string, unknown>;
    const response = await api.inject({
      method: "POST",
      url: "/api/projects/import",
      remoteAddress: "203.0.113.26",
      payload: {
        project: template,
        // Saved dynamic projects legitimately carry result frames well past
        // Fastify's general 5 MB request ceiling. Keep the larger allowance
        // isolated to the local-project import route.
        padding: "x".repeat(5_100_000)
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().project.id).toBe(template.id);
  });

  test("discards solver models embedded in imported project files", async () => {
    const api = await buildApi();
    const sample = await api.inject({ method: "GET", url: "/api/sample-project" });
    const project = structuredClone(sample.json().project) as {
      studies: Array<{ meshSettings: Record<string, unknown> }>;
    };
    project.studies[0]!.meshSettings = {
      preset: "fine",
      status: "complete",
      meshRef: "attacker-controlled-mesh",
      summary: {
        nodes: 4,
        elements: 1,
        warnings: [],
        artifacts: {
          meshConnectivity: { connectedComponents: 1 },
          actualCoreModel: { model: { meshProvenance: { meshSource: "actual_volume_mesh" } } }
        }
      }
    };

    const response = await api.inject({
      method: "POST",
      url: "/api/projects/import",
      remoteAddress: "203.0.113.27",
      payload: { project }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().project.studies[0].meshSettings).toEqual({ preset: "fine", status: "not_started" });
  });

  test("imported local estimate results are not marked as complete production runs", async () => {
    const api = await buildApi();
    const sample = await api.inject({ method: "GET", url: "/api/sample-project" });
    const template = sample.json().project as Record<string, unknown>;
    const project = structuredClone(template) as {
      studies: Array<{ runs: Array<{ id: string; status: string }> }>;
    };
    const runId = project.studies[0]!.runs[0]!.id;
    project.studies[0]!.runs[0]!.status = "queued";

    const response = await api.inject({
      method: "POST",
      url: "/api/projects/import",
      remoteAddress: "203.0.113.25",
      payload: {
        project,
        results: {
          completedRunId: runId,
          summary: {
            maxStress: 100,
            maxStressUnits: "MPa",
            maxDisplacement: 0.2,
            maxDisplacementUnits: "mm",
            safetyFactor: 2,
            reactionForce: 500,
            reactionForceUnits: "N",
            provenance: {
              kind: "local_estimate",
              solver: "opencae-local-heuristic-surface",
              solverVersion: "0.1.0",
              meshSource: "mock",
              resultSource: "generated",
              units: "mm-N-s-MPa"
            }
          },
          fields: [{
            id: "stress",
            runId,
            type: "stress",
            location: "face",
            values: [100],
            min: 100,
            max: 100,
            units: "MPa",
            provenance: {
              kind: "local_estimate",
              solver: "opencae-local-heuristic-surface",
              solverVersion: "0.1.0",
              meshSource: "mock",
              resultSource: "generated",
              units: "mm-N-s-MPa"
            }
          }]
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const imported = response.json().project as { studies: Array<{ runs: Array<{ id: string; status: string }> }> };
    expect(imported.studies[0]!.runs.find((run) => run.id === runId)?.status).toBe("complete_estimate");
  });

  test("stores imported results under the canonical report key the readers use", async () => {
    const api = await buildApi();
    const sample = await api.inject({ method: "GET", url: "/api/sample-project" });
    const project = structuredClone(sample.json().project) as {
      id: string;
      studies: Array<{ runs: Array<{ id: string; reportRef?: string }> }>;
    };
    const runId = project.studies[0]!.runs[0]!.id;
    // Force the fallback path: with no ref on the run, the import must mint the
    // same key LocalReportProvider produces for real solves.
    delete project.studies[0]!.runs[0]!.reportRef;

    const response = await api.inject({
      method: "POST",
      url: "/api/projects/import",
      remoteAddress: "203.0.113.28",
      payload: { project, results: importedResultBundle(runId) }
    });

    expect(response.statusCode).toBe(200);
    const imported = response.json().project as { id: string; studies: Array<{ runs: Array<{ id: string; reportRef?: string }> }> };
    const run = imported.studies[0]!.runs.find((candidate) => candidate.id === runId);
    expect(run?.reportRef).toBe(`${imported.id}/reports/${runId}/report.html`);
    // The artifact must actually be readable at that key, not just referenced.
    const report = await api.inject({ method: "GET", url: `/api/runs/${runId}/report` });
    expect(report.statusCode).toBe(200);
    expect(report.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  test("rejects loads whose magnitude or geometry is not a finite number", async () => {
    const api = await buildApi();
    const create = await api.inject({
      method: "POST",
      url: "/api/projects",
      remoteAddress: "203.0.113.29",
      payload: { mode: "sample", sample: "cantilever" }
    });
    const studyId = (create.json().project as { studies: Array<{ id: string }> }).studies[0]!.id;
    const addLoad = (payload: Record<string, unknown>) => api.inject({
      method: "POST",
      url: `/api/studies/${studyId}/loads`,
      remoteAddress: "203.0.113.29",
      payload
    });

    // JSON has no NaN/Infinity literal, so those arrive as strings or nulls.
    for (const value of ["500", null, {}]) {
      const response = await addLoad({ type: "force", value });
      expect(response.statusCode, `value ${JSON.stringify(value)} was accepted`).toBe(400);
      expect(response.json().error).toBe("Load value must be a finite number.");
    }
    const shortVector = await addLoad({ type: "force", value: 500, direction: [0, -1] });
    expect(shortVector.statusCode).toBe(400);
    expect(shortVector.json().error).toBe("Load direction must be three finite numbers.");

    const zeroVector = await addLoad({ type: "force", value: 500, direction: [0, 0, 0] });
    expect(zeroVector.statusCode).toBe(400);
    expect(zeroVector.json().error).toBe("Load direction must not be a zero vector.");

    const negativeVolume = await addLoad({ type: "gravity", value: 5, payloadVolumeM3: -1 });
    expect(negativeVolume.statusCode).toBe(400);
    expect(negativeVolume.json().error).toBe("Payload volume must be a positive finite number.");

    const accepted = await addLoad({ type: "force", value: 500, direction: [0, 0, -1] });
    expect(accepted.statusCode).toBe(200);
  });

  test("rate limits project renaming", async () => {
    const api = await buildApi();
    const create = await api.inject({ method: "POST", url: "/api/projects", remoteAddress: "203.0.113.30", payload: {} });
    const projectId = (create.json().project as { id: string }).id;
    const responses = [];
    // Rate-limit buckets are per route, so the create above does not count here.
    for (let index = 0; index < 31; index += 1) {
      responses.push(await api.inject({
        method: "PUT",
        url: `/api/projects/${projectId}`,
        remoteAddress: "203.0.113.30",
        payload: { name: `Renamed ${index}` }
      }));
    }

    expect(responses.slice(0, 30).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[30]?.statusCode).toBe(429);
  });

  // The browser/local backend now runs the full production Core pipeline
  // (B2: cloud-parity solve, provenance kind opencae_core_fea / computed with
  // a browser runner stamp), so eligible local runs finish as production FEA.
  test("local Core runs finish as complete production FEA solves", async () => {
    const api = await buildApi();
    const create = await api.inject({
      method: "POST",
      url: "/api/projects",
      remoteAddress: "203.0.113.26",
      payload: { mode: "sample", sample: "cantilever" }
    });
    const studyId = (create.json().project as { studies: Array<{ id: string }> }).studies[0]!.id;
    const mesh = await api.inject({
      method: "POST",
      url: `/api/studies/${studyId}/mesh`,
      remoteAddress: "203.0.113.26",
      payload: { preset: "medium" }
    });
    expect(mesh.statusCode).toBe(200);

    const start = await api.inject({
      method: "POST",
      url: `/api/studies/${studyId}/runs`,
      remoteAddress: "203.0.113.26"
    });

    expect(start.statusCode).toBe(200);
    const runId = (start.json().run as { id: string }).id;
    const run = await waitForTerminalRun(api, runId);
    expect(run.status).toBe("complete_preview");
  });
});

function importedResultBundle(runId: string) {
  const provenance = {
    kind: "local_estimate",
    solver: "opencae-local-heuristic-surface",
    solverVersion: "0.1.0",
    meshSource: "mock",
    resultSource: "generated",
    units: "mm-N-s-MPa"
  };
  return {
    completedRunId: runId,
    summary: {
      maxStress: 100,
      maxStressUnits: "MPa",
      maxDisplacement: 0.2,
      maxDisplacementUnits: "mm",
      safetyFactor: 2,
      reactionForce: 500,
      reactionForceUnits: "N",
      provenance
    },
    fields: [{
      id: "stress",
      runId,
      type: "stress",
      location: "face",
      values: [100],
      min: 100,
      max: 100,
      units: "MPa",
      provenance
    }]
  };
}

async function waitForTerminalRun(api: Awaited<ReturnType<typeof buildApi>>, runId: string): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await api.inject({ method: "GET", url: `/api/runs/${runId}` });
    const run = response.json().run as { status: string };
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const response = await api.inject({ method: "GET", url: `/api/runs/${runId}` });
  return response.json().run as { status: string };
}
