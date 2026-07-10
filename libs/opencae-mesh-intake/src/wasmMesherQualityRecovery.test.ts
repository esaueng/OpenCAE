import { beforeEach, describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Scenario = "algorithm_fallback" | "coarser_size" | "quality_repair" | "complex_seams" | "complex_seams_completed" | "complex_seams_repair_loses_volume" | "surface_only" | "dof_fallback";
  const state = {
    scenario: "algorithm_fallback" as Scenario,
    attempts: [] as Array<{ algorithm: "delaunay" | "frontal"; sizeMm: number }>,
    qualityRepairAttempts: [] as number[],
    moduleCount: 0
  };

  const qualityFor = (algorithm: "delaunay" | "frontal", sizeMm: number, qualityRepair: boolean, optimized: boolean): number => {
    if (state.scenario === "algorithm_fallback") return algorithm === "frontal" ? 0.2 : 0.0075;
    if (state.scenario === "quality_repair" || state.scenario === "complex_seams" || state.scenario === "complex_seams_completed" || state.scenario === "complex_seams_repair_loses_volume" || state.scenario === "surface_only") {
      return qualityRepair && optimized && sizeMm <= 6 ? 0.08 : (algorithm === "frontal" ? 0.02 : 0.01);
    }
    if (state.scenario === "dof_fallback") return 0.2;
    if (sizeMm >= 12) return 0.2;
    return algorithm === "frontal" ? 0.02 : 0.01;
  };

  const createGmsh = () => {
    state.moduleCount += 1;
    let algorithm: "delaunay" | "frontal" = "delaunay";
    let sizeMm = 8;
    let elementOrder: 1 | 2 = 1;
    let healed = false;
    let meshAdapt = false;
    let optimized = false;

    const isQualityRepair = () => healed && meshAdapt;
    const hasComplexSeams = () => state.scenario === "complex_seams" || state.scenario === "complex_seams_completed" || state.scenario === "complex_seams_repair_loses_volume";
    const hasVolumeElements = () => state.scenario !== "surface_only" || isQualityRepair();

    return {
      initialize() {},
      finalize() {},
      write() {},
      FS: {
        writeFile() {},
        readFile() {
          if (!hasVolumeElements()) {
            return "$PhysicalNames\n2\n2 4 \"surface_4\"\n2 11 \"surface_11\"\n$EndPhysicalNames\n$Elements\n1\n1 9 0 1 2 3 4 5 6\n$EndElements\n";
          }
          const typeCode = elementOrder === 2 ? 11 : 4;
          const nodeTags = elementOrder === 2 ? "1 2 3 4 5 6 7 8 9 10" : "1 2 3 4";
          return `$Elements\n1\n1 ${typeCode} 0 ${nodeTags}\n$EndElements\n`;
        }
      },
      option: {
        setNumber(name: string, value: number) {
          if (name === "Mesh.Algorithm3D" && value === 4) algorithm = "frontal";
          if (name === "Mesh.Algorithm" && value === 1) meshAdapt = true;
          if (name === "Mesh.CharacteristicLengthMax") sizeMm = value;
        }
      },
      model: {
        getEntities(dimension: number) {
          if (dimension === 3) {
            if (state.scenario === "complex_seams_repair_loses_volume" && healed) return { dimTags: [] };
            return { dimTags: [3, 1] };
          }
          if (dimension === 2) {
            const surfaceCount = hasComplexSeams() ? 160 : 1;
            return { dimTags: Array.from({ length: surfaceCount }, (_, index) => [2, index + 1]).flat() };
          }
          return { dimTags: [] };
        },
        getBoundary() {
          if (!hasComplexSeams() || healed) return { outDimTags: [] };
          return { outDimTags: Array.from({ length: 32 }, (_, index) => [1, index + 1]).flat() };
        },
        getBoundingBox() {
          return { xmin: 0, ymin: 0, zmin: 0, xmax: 10, ymax: 10, zmax: 10 };
        },
        addPhysicalGroup() {
          return 1;
        },
        setPhysicalName() {},
        occ: {
          importShapes() {},
          synchronize() {},
          healShapes() {
            healed = true;
            return { outDimTags: [3, 1] };
          },
          getMass() {
            return { mass: 1_000 };
          },
          getSurfaceLoops() {
            const surfaceCount = hasComplexSeams() ? 160 : 1;
            return {
              surfaceLoopTags: [1],
              surfaceTags: [Array.from({ length: surfaceCount }, (_, index) => index + 1)]
            };
          }
        },
        mesh: {
          generate(dimension: number) {
            if (dimension === 3) {
              state.attempts.push({ algorithm, sizeMm });
              if (isQualityRepair()) state.qualityRepairAttempts.push(sizeMm);
              if (hasComplexSeams() && state.scenario !== "complex_seams_completed" && !isQualityRepair()) {
                throw new Error("boundary recovery failed");
              }
            }
          },
          optimize() {
            if (state.scenario === "algorithm_fallback" && algorithm === "delaunay") {
              throw new Error("memory access out of bounds");
            }
            optimized = true;
          },
          setOrder(order: 1 | 2) {
            elementOrder = order;
          },
          getNodes() {
            const nodeCount = state.scenario === "dof_fallback" && elementOrder === 2 ? 40_000 : 4;
            return { nodeTags: new Array(nodeCount), coord: [], parametricCoord: [] };
          },
          getElementsByType(typeCode: number) {
            if (!hasVolumeElements()) return { elementTags: [], nodeTags: [] };
            const activeType = elementOrder === 2 ? 11 : 4;
            return { elementTags: typeCode === activeType ? [1] : [], nodeTags: [] };
          },
          getElementQualities() {
            return { elementsQuality: [qualityFor(algorithm, sizeMm, isQualityRepair(), optimized)] };
          }
        }
      }
    };
  };

  return { state, createGmsh };
});

vi.mock("@loumalouomega/gmsh-wasm", () => ({
  default: async () => fake.createGmsh()
}));

import { meshStepToMshV2 } from "./wasmMesher";

describe("STEP quality recovery orchestration", () => {
  beforeEach(() => {
    fake.state.attempts.length = 0;
    fake.state.qualityRepairAttempts.length = 0;
    fake.state.moduleCount = 0;
  });

  test("tries Frontal when a post-crash Delaunay retry completes below the quality floor", async () => {
    fake.state.scenario = "algorithm_fallback";

    const result = await meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 8 });

    expect(result.algorithm3D).toBe("frontal");
    expect(result.qualityMinSICN).toBe(0.2);
    expect(result.qualityRefinement).toBeUndefined();
    expect(fake.state.attempts.map(({ algorithm }) => algorithm)).toEqual([
      "delaunay",
      "delaunay",
      "frontal"
    ]);
    expect(fake.state.moduleCount).toBe(3);
  });

  test("tries the adjacent coarser size before the finer ladder", async () => {
    fake.state.scenario = "coarser_size";

    const result = await meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 8 });

    expect(result.qualityMinSICN).toBe(0.2);
    expect(result.qualityRefinement).toEqual({
      requestedMeshSizeMm: 8,
      usedMeshSizeMm: 12,
      triedMeshSizesMm: [8, 12],
      direction: "coarser"
    });
    expect(fake.state.attempts).toEqual([
      { algorithm: "delaunay", sizeMm: 8 },
      { algorithm: "frontal", sizeMm: 8 },
      { algorithm: "delaunay", sizeMm: 12 }
    ]);
  });

  test("heals sliver features and uses MeshAdapt without lowering the quality floor", async () => {
    fake.state.scenario = "quality_repair";

    const result = await meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 8 });

    expect(result.qualityMinSICN).toBe(0.08);
    expect(result.optimizer).toBe("netgen");
    expect(result.geometryRepair).toMatchObject({ profile: "quality" });
    expect(result.geometryRepair?.toleranceMm).toBeGreaterThan(0.01);
    expect(result.qualityRepair).toEqual({
      method: "occ_heal_meshadapt",
      requestedMeshSizeMm: 8,
      usedMeshSizeMm: 6,
      triedMeshSizesMm: [6]
    });
    expect(result.qualityRefinement).toMatchObject({
      requestedMeshSizeMm: 8,
      usedMeshSizeMm: 6,
      direction: "finer"
    });
    expect(fake.state.qualityRepairAttempts).toEqual([6]);
  });

  test("stamps ladder phase events with their attempt so progress consumers can show retries", async () => {
    fake.state.scenario = "coarser_size";
    const events: Array<{ phase: string; attempt?: { attempt: number; stage: string; sizeMm?: number } }> = [];

    await meshStepToMshV2(new Uint8Array([1]), {
      elementOrder: 2,
      meshSizeMm: 8,
      onPhase: (event) => events.push({ phase: event.phase, attempt: event.attempt })
    });

    // Every ladder session's phases carry the rung's attempt context; the
    // second rung (coarser retry at 12 mm) must be visibly attempt 2.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.attempt !== undefined)).toBe(true);
    const attempts = [...new Set(events.map((event) => event.attempt!.attempt))];
    expect(attempts).toEqual([1, 2]);
    const retryEvents = events.filter((event) => event.attempt!.attempt === 2);
    expect(retryEvents[0]?.attempt).toMatchObject({ stage: "size", sizeMm: 12 });
  });

  test("stamps quality-repair phase events with the repair stage", async () => {
    fake.state.scenario = "quality_repair";
    const events: Array<{ attempt?: { stage: string; sizeMm?: number } }> = [];

    await meshStepToMshV2(new Uint8Array([1]), {
      elementOrder: 2,
      meshSizeMm: 8,
      onPhase: (event) => events.push({ attempt: event.attempt })
    });

    expect(events.some((event) => event.attempt?.stage === "repair" && event.attempt.sizeMm === 6)).toBe(true);
  });

  test("tries Frontal before routing a thrown complex-seam failure to bounded repair", async () => {
    fake.state.scenario = "complex_seams";

    const result = await meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 12 });

    expect(result.qualityMinSICN).toBe(0.08);
    expect(result.qualityRepair).toEqual({
      method: "occ_heal_meshadapt",
      requestedMeshSizeMm: 12,
      usedMeshSizeMm: 6,
      triedMeshSizesMm: [6]
    });
    expect(result.qualityRefinement).toMatchObject({
      requestedMeshSizeMm: 12,
      usedMeshSizeMm: 6,
      triedMeshSizesMm: [12, 6],
      direction: "finer"
    });
    expect(fake.state.attempts).toEqual([
      { algorithm: "delaunay", sizeMm: 12 },
      { algorithm: "frontal", sizeMm: 12 },
      { algorithm: "delaunay", sizeMm: 6 }
    ]);
    expect(fake.state.moduleCount).toBe(3);
  });

  test("reports both thrown standard algorithms before a lost-volume repair failure", async () => {
    fake.state.scenario = "complex_seams_repair_loses_volume";

    await expect(meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 12 })).rejects.toMatchObject({
      name: "StepGeometryError",
      message: expect.stringMatching(/Delaunay: boundary recovery failed; Frontal: boundary recovery failed/)
    });
    expect(fake.state.attempts).toEqual([
      { algorithm: "delaunay", sizeMm: 12 },
      { algorithm: "frontal", sizeMm: 12 }
    ]);
    expect(fake.state.moduleCount).toBe(4);
  });

  test("keeps the early quality-repair bail for a completed complex-seam mesh", async () => {
    fake.state.scenario = "complex_seams_completed";

    const result = await meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 12 });

    expect(result.qualityRepair?.method).toBe("occ_heal_meshadapt");
    expect(fake.state.attempts).toEqual([
      { algorithm: "delaunay", sizeMm: 12 },
      { algorithm: "delaunay", sizeMm: 6 }
    ]);
    expect(fake.state.moduleCount).toBe(2);
  });

  test("rejects surface-only output even when physical tags look like Tet4/Tet10 records", async () => {
    fake.state.scenario = "surface_only";

    const result = await meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 8 });

    expect(result.qualityRepair?.method).toBe("occ_heal_meshadapt");
    expect(result.qualityMinSICN).toBe(0.08);
    expect(fake.state.qualityRepairAttempts).toEqual([6]);
  });

  test("retains Tet4 when the safe quadratic mesh would exceed 100,000 DOFs", async () => {
    fake.state.scenario = "dof_fallback";

    const result = await meshStepToMshV2(new Uint8Array([1]), { elementOrder: 2, meshSizeMm: 8 });

    expect(result.elementOrderFallback).toEqual({
      requested: 2,
      used: 1,
      reason: "browser_dof_limit",
      quadraticNodeCount: 40_000
    });
    expect(result.elevation).toBeUndefined();
    expect(result.msh).toContain("1 4 0 1 2 3 4");
  });
});
