import { describe, expect, test, vi } from "vitest";
import type { DisplayModel, MeshConvergenceRung, ResultField, Study } from "@opencae/schema";
import {
  classifyConvergenceRungs,
  convergenceStudyForCase,
  defaultConvergenceProbe,
  mapPointToNearestSurfaceTriangle,
  runStaticMeshConvergence,
  type ConvergenceMeshStatistics
} from "./meshConvergence";

const study: Extract<Study, { type: "static_stress" }> = {
  id: "study-static",
  projectId: "project-1",
  name: "Static",
  type: "static_stress",
  geometryScope: [{ bodyId: "body", entityType: "body", entityId: "body", label: "Body" }],
  materialAssignments: [{ id: "material", materialId: "mat-aluminum-6061", selectionRef: "body-selection", status: "complete" }],
  namedSelections: [
    { id: "body-selection", name: "Body", entityType: "body", geometryRefs: [{ bodyId: "body", entityType: "body", entityId: "body", label: "Body" }], fingerprint: "body" },
    { id: "load-selection", name: "Loaded face", entityType: "face", geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "load-face", label: "Loaded face" }], fingerprint: "load" }
  ],
  contacts: [],
  constraints: [{ id: "fixed", type: "fixed", selectionRef: "body-selection", parameters: {}, status: "complete" }],
  loads: [
    { id: "load-a", type: "force", selectionRef: "load-selection", parameters: { value: 10, units: "N", direction: [0, 0, -1], applicationPoint: [250, 250, 0] }, status: "complete" },
    { id: "load-b", type: "force", selectionRef: "load-selection", parameters: { value: 5, units: "N", direction: [1, 0, 0] }, status: "complete" }
  ],
  loadCases: [
    { id: "case-a", name: "A", enabled: true, loadIds: ["load-a"] },
    { id: "case-b", name: "B", enabled: true, loadIds: ["load-b"] }
  ],
  loadCombinations: [{ id: "combo", name: "Combo", enabled: true, factors: [{ caseId: "case-a", factor: 1 }, { caseId: "case-b", factor: -1 }] }],
  meshSettings: { preset: "ultra", status: "complete", meshRef: "working-mesh", summary: { nodes: 999, elements: 999, warnings: [] } },
  solverSettings: {},
  validation: [],
  runs: [{ id: "old-run", studyId: "study-static", status: "complete", jobId: "job", solverBackend: "local", solverVersion: "1", diagnostics: [] }]
};

const displayModel: DisplayModel = {
  id: "display",
  name: "Display",
  bodyCount: 1,
  dimensions: { x: 1000, y: 1000, z: 10, units: "mm" },
  faces: [{ id: "load-face", label: "Loaded face", color: "#fff", center: [500, 500, 0], normal: [0, 0, -1], stressValue: 0 }]
};

const surfaceMesh = {
  id: "solver-surface",
  nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
  triangles: [[0, 1, 2]] as [number, number, number][]
};

function solveResult(displacement: number, stress: number) {
  const fields: ResultField[] = [
    {
      id: "displacement-surface",
      runId: "convergence",
      type: "displacement",
      location: "node",
      values: [displacement, displacement, displacement],
      vectors: [[0, 0, displacement], [0, 0, displacement], [0, 0, displacement]],
      min: displacement,
      max: displacement,
      units: "mm",
      surfaceMeshRef: surfaceMesh.id
    },
    {
      id: "stress-von-mises-element",
      runId: "convergence",
      type: "stress",
      component: "von_mises",
      location: "element",
      values: [stress, stress * 0.8],
      min: stress * 0.8,
      max: stress,
      units: "MPa"
    }
  ];
  return { fields, surfaceMesh };
}

function statistics(index: number): ConvergenceMeshStatistics {
  return {
    nodes: 100 * (index + 1),
    elements: 300 * (index + 1),
    totalDofs: 300 * (index + 1),
    freeDofs: 270 * (index + 1),
    actualMeshSizeMm: [18, 12, 8][index]!
  };
}

describe("static mesh convergence", () => {
  test("runs coarse to medium to fine on an isolated case and classifies apparent convergence", async () => {
    const original = structuredClone(study);
    const presetIndex = new Map(["coarse", "medium", "fine"].map((preset, index) => [preset, index]));
    const preparedStudies: Array<Extract<Study, { type: "static_stress" }>> = [];
    const solve = vi.fn(async (_isolated: Study, preset: "coarse" | "medium" | "fine") => {
      const index = presetIndex.get(preset)!;
      return solveResult([1, 1.04, 1.05][index]!, [10, 11, 11.5][index]!);
    });

    const record = await runStaticMeshConvergence({
      study,
      caseId: "case-a",
      probe: { point: [250, 250, 0], source: "primary_load" },
      recordId: "convergence-test",
      now: () => "2026-07-14T12:00:00.000Z",
      prepareMesh: async (preset, isolatedStudy) => {
        preparedStudies.push(isolatedStudy);
        const index = presetIndex.get(preset)!;
        return { study: { ...isolatedStudy, meshSettings: { preset, status: "complete" } }, statistics: statistics(index) };
      },
      solve
    });

    expect(record.rungs.map((rung) => rung.requestedPreset)).toEqual(["coarse", "medium", "fine"]);
    expect(record.rungs.map((rung) => rung.status)).toEqual(["complete", "complete", "complete"]);
    expect(record.rungs[2]?.probeDisplacement).toBeCloseTo(1.05, 12);
    expect(record.classification).toBe("apparent_convergence");
    expect(record.lastStepChanges).toMatchObject({ displacement: expect.any(Number), stress: expect.any(Number) });
    expect(preparedStudies.every((candidate) => candidate.loads.map((load) => load.id).join() === "load-a")).toBe(true);
    expect(preparedStudies.every((candidate) => candidate.runs.length === 0 && candidate.loadCombinations?.length === 0)).toBe(true);
    expect(study).toEqual(original);
    expect(solve).toHaveBeenCalledTimes(3);
  });

  test("skips a generated rung above the 100k pipeline limit before solving", async () => {
    const solve = vi.fn(async () => solveResult(1, 10));
    const record = await runStaticMeshConvergence({
      study,
      caseId: "case-a",
      probe: { point: [250, 250, 0], source: "explicit" },
      prepareMesh: async (preset, isolatedStudy) => ({
        study: isolatedStudy,
        statistics: { ...statistics(preset === "coarse" ? 0 : preset === "medium" ? 1 : 2), ...(preset === "fine" ? { nodes: 40_000, totalDofs: 120_000, freeDofs: 119_970 } : {}) }
      }),
      solve
    });

    expect(record.rungs[2]).toMatchObject({ status: "skipped", totalDofs: 120_000, skipReason: expect.stringContaining("100,000") });
    expect(solve).toHaveBeenCalledTimes(2);
    expect(record.classification).toBe("inconclusive");
  });

  test("continues after a rung failure and reports an inconclusive record", async () => {
    const solved: string[] = [];
    const record = await runStaticMeshConvergence({
      study,
      caseId: "case-a",
      probe: { point: [250, 250, 0], source: "explicit" },
      prepareMesh: async (preset, isolatedStudy) => {
        if (preset === "medium") throw new Error("gmsh failed");
        return { study: isolatedStudy, statistics: statistics(preset === "coarse" ? 0 : 2) };
      },
      solve: async (_isolated, preset) => {
        solved.push(preset);
        return solveResult(1, 10);
      }
    });

    expect(solved).toEqual(["coarse", "fine"]);
    expect(record.rungs[1]).toMatchObject({ status: "failed", skipReason: "gmsh failed" });
    expect(record.classification).toBe("inconclusive");
  });

  test("treats non-monotonic DOF as inconclusive and threshold misses as unconverged", () => {
    const rung = (totalDofs: number, probeDisplacement: number, rawElementPeakVonMises: number): MeshConvergenceRung => ({
      requestedPreset: "coarse",
      status: "complete",
      actualNodeCount: totalDofs / 3,
      actualElementCount: totalDofs,
      totalDofs,
      freeDofs: totalDofs - 3,
      actualMeshSizeMm: 1,
      probeDisplacement,
      displacementUnits: "mm",
      rawElementPeakVonMises,
      stressUnits: "MPa"
    });
    expect(classifyConvergenceRungs([rung(300, 1, 10), rung(900, 1, 10), rung(600, 1, 10)]).classification).toBe("inconclusive");
    expect(classifyConvergenceRungs([rung(300, 1, 10), rung(600, 1, 10), rung(900, 1.2, 12)]).classification).toBe("unconverged");
  });

  test("maps millimeter probes to a meter solver surface and rejects distant points", () => {
    const mapped = mapPointToNearestSurfaceTriangle([250, 250, 0], surfaceMesh);
    expect(mapped).toMatchObject({ coordinateScale: 0.001, triangle: [0, 1, 2] });
    expect(mapped?.barycentric).toEqual([0.5, 0.25, 0.25]);
    expect(mapPointToNearestSurfaceTriangle([250, 250, 500], surfaceMesh)).toBeNull();
  });

  test("defaults the probe to the primary load application point and falls back to its face center", () => {
    expect(defaultConvergenceProbe(study, "case-a", displayModel)).toMatchObject({ point: [250, 250, 0], source: "primary_load" });
    expect(defaultConvergenceProbe(study, "case-b", displayModel)).toMatchObject({ point: [500, 500, 0], label: "Loaded face" });
    expect(convergenceStudyForCase(study, "case-b").loads.map((load) => load.id)).toEqual(["load-b"]);
  });
});
