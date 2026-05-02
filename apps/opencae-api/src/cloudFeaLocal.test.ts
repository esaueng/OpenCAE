import { describe, expect, test, vi } from "vitest";
import type { DisplayModel, ResultField, ResultSummary, Study } from "@opencae/schema";
import { LocalCloudFeaBridge } from "./cloudFeaLocal";

const displayModel = {
  id: "display-1",
  name: "Cantilever",
  bodyCount: 1,
  dimensions: { x: 100, y: 30, z: 10, units: "mm" },
  faces: [
    { id: "face-fixed", label: "Fixed", color: "#94a3b8", center: [0, 15, 5], normal: [-1, 0, 0], stressValue: 0 },
    { id: "face-load", label: "Load", color: "#94a3b8", center: [100, 15, 5], normal: [1, 0, 0], stressValue: 0 }
  ]
} satisfies DisplayModel;

const baseStudy = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
  materialAssignments: [{ id: "assignment-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", parameters: {}, status: "complete" }],
  namedSelections: [
    {
      id: "selection-body-1",
      name: "Beam body",
      entityType: "body",
      geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
      fingerprint: "body-1"
    },
    {
      id: "selection-fixed",
      name: "Fixed face",
      entityType: "face",
      geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-fixed", label: "Fixed" }],
      fingerprint: "face-fixed"
    },
    {
      id: "selection-load",
      name: "Load face",
      entityType: "face",
      geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load", label: "Load" }],
      fingerprint: "face-load"
    }
  ],
  contacts: [],
  constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
  loads: [{ id: "load-1", type: "force", selectionRef: "selection-load", parameters: { value: 1, units: "N", direction: [0, 0, -1] }, status: "complete" }],
  meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
  solverSettings: { backend: "cloudflare_fea", fidelity: "standard" },
  validation: [],
  runs: []
} satisfies Study;

describe("LocalCloudFeaBridge", () => {
  test("health reports local bridge mode and runner probe details", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://runner.test/health");
      return new Response(JSON.stringify({ ok: true, solver: "calculix", ccx: "available", gmsh: "unavailable" }), {
        headers: { "content-type": "application/json" }
      });
    });
    const bridge = new LocalCloudFeaBridge({ runnerUrl: "http://runner.test/solve", fetchImpl: fetchMock });

    const health = await bridge.health();

    expect(health).toMatchObject({
      ok: true,
      mode: "local-cloud-fea-bridge",
      runnerUrl: "http://runner.test/solve",
      runnerHealthUrl: "http://runner.test/health",
      runner: { reachable: true, ccx: "available", gmsh: "unavailable" }
    });
  });

  test("health summarizes unreachable runner without starting a solve", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(new TypeError("Failed to fetch")));
    const bridge = new LocalCloudFeaBridge({ runnerUrl: "http://localhost:8080/solve", fetchImpl: fetchMock });

    const health = await bridge.health();

    expect(health).toMatchObject({
      mode: "local-cloud-fea-bridge",
      runnerUrl: "http://localhost:8080/solve",
      runnerHealthUrl: "http://localhost:8080/health",
      runner: { reachable: false, error: "Failed to fetch" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  test("creates a local Cloud FEA run and stores parsed runner results", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { runId: string };
      return parsedRunnerResponse(body.runId);
    });
    const bridge = new LocalCloudFeaBridge({ runnerUrl: "http://runner.test/solve", fetchImpl: fetchMock });

    const response = await bridge.createRun({
      projectId: "project-1",
      studyId: "study-1",
      fidelity: "standard",
      study: baseStudy,
      displayModel
    });
    await bridge.waitForRun(response.run.id);

    const requestBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    const solverMaterial = requestBody.solverMaterial as Record<string, unknown>;
    const events = bridge.getEvents(response.run.id);
    const results = bridge.getResults(response.run.id);

    expect(response.run.id).toMatch(/^run-cloud-local-/);
    expect(response.streamUrl).toBe(`/api/cloud-fea/runs/${response.run.id}/events`);
    expect(solverMaterial).toMatchObject({
      id: "mat-aluminum-6061",
      name: "Aluminum 6061",
      youngsModulusMpa: 68900,
      yieldMpa: 276
    });
    expect(events.some((event) => event.message.includes("Cloud FEA local bridge queued"))).toBe(true);
    expect(events.some((event) => event.type === "complete")).toBe(true);
    expect(results?.summary.maxStress).toBe(0.18);
  });

  test("records a clear error event when the local runner is unreachable", async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    const bridge = new LocalCloudFeaBridge({ runnerUrl: "http://localhost:8080/solve", fetchImpl: fetchMock });

    const response = await bridge.createRun({ projectId: "project-1", studyId: "study-1", study: baseStudy, displayModel });
    await bridge.waitForRun(response.run.id);

    const events = bridge.getEvents(response.run.id);

    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.message).toContain("local CalculiX runner is unreachable at http://localhost:8080/solve");
    expect(bridge.getResults(response.run.id)).toBeUndefined();
  });

  test("refuses generated fallback runner results", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { runId: string };
      return parsedRunnerResponse(body.runId, {
        summary: {
          ...parsedSummary(),
          provenance: {
            kind: "calculix_fea",
            solver: "calculix-ccx",
            solverVersion: "test",
            meshSource: "structured_block",
            resultSource: "generated",
            units: "mm-N-s-MPa"
          }
        },
        artifacts: { solverResultParser: "generated-fallback-test", resultSource: "generated-cantilever-fallback" }
      });
    });
    const bridge = new LocalCloudFeaBridge({ runnerUrl: "http://runner.test/solve", fetchImpl: fetchMock });

    const response = await bridge.createRun({ projectId: "project-1", studyId: "study-1", study: baseStudy, displayModel });
    await bridge.waitForRun(response.run.id);

    const lastEvent = bridge.getEvents(response.run.id).at(-1);
    expect(lastEvent?.type).toBe("error");
    expect(lastEvent?.message).toContain("generated fallback data instead of parsed CalculiX results");
    expect(lastEvent?.message).not.toContain("unreachable");
    expect(bridge.getResults(response.run.id)).toBeUndefined();
  });

  test("resolves PETG solver material for local Cloud FEA requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { runId: string };
      return parsedRunnerResponse(body.runId);
    });
    const bridge = new LocalCloudFeaBridge({ runnerUrl: "http://runner.test/solve", fetchImpl: fetchMock });
    const petgStudy = {
      ...baseStudy,
      materialAssignments: [{ id: "assignment-1", materialId: "mat-petg", selectionRef: "selection-body-1", parameters: { printed: false }, status: "complete" }]
    } satisfies Study;

    const response = await bridge.createRun({ projectId: "project-1", studyId: "study-1", study: petgStudy, displayModel });
    await bridge.waitForRun(response.run.id);

    const requestBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(requestBody.solverMaterial).toMatchObject({
      id: "mat-petg",
      name: "PETG",
      youngsModulusMpa: 2100,
      yieldMpa: 50
    });
  });
});

function parsedRunnerResponse(runId: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    summary: parsedSummary(),
    fields: parsedFields(runId),
    artifacts: { solverResultParser: "parsed-calculix-dat" },
    ...overrides
  }), { headers: { "content-type": "application/json" } });
}

function parsedSummary(): ResultSummary {
  return {
    maxStress: 0.18,
    maxStressUnits: "MPa",
    maxDisplacement: 0.0019,
    maxDisplacementUnits: "mm",
    safetyFactor: 1533,
    reactionForce: 1,
    reactionForceUnits: "N",
    provenance: {
      kind: "calculix_fea",
      solver: "calculix-ccx",
      solverVersion: "test",
      meshSource: "structured_block",
      resultSource: "parsed_dat",
      units: "mm-N-s-MPa"
    }
  };
}

function parsedFields(runId: string): ResultField[] {
  return [{
    id: "stress",
    runId,
    type: "stress",
    location: "element",
    values: [0.18],
    min: 0.18,
    max: 0.18,
    units: "MPa",
    samples: [{ point: [50, 15, 5], normal: [1, 0, 0], value: 0.18, source: "calculix-dat", elementId: "1" }]
  }];
}
