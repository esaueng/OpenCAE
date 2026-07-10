import { beforeEach, describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Scenario = "algorithm_fallback" | "coarser_size";
  const state = {
    scenario: "algorithm_fallback" as Scenario,
    attempts: [] as Array<{ algorithm: "delaunay" | "frontal"; sizeMm: number }>,
    moduleCount: 0
  };

  const qualityFor = (algorithm: "delaunay" | "frontal", sizeMm: number): number => {
    if (state.scenario === "algorithm_fallback") return algorithm === "frontal" ? 0.2 : 0.0075;
    if (sizeMm >= 12) return 0.2;
    return algorithm === "frontal" ? 0.02 : 0.01;
  };

  const createGmsh = () => {
    state.moduleCount += 1;
    let algorithm: "delaunay" | "frontal" = "delaunay";
    let sizeMm = 8;
    let elementOrder: 1 | 2 = 1;

    return {
      initialize() {},
      finalize() {},
      write() {},
      FS: {
        writeFile() {},
        readFile() {
          return "$Elements\n1\n1 11 0 1 2 3 4 5 6 7 8 9 10\n$EndElements\n";
        }
      },
      option: {
        setNumber(name: string, value: number) {
          if (name === "Mesh.Algorithm3D" && value === 4) algorithm = "frontal";
          if (name === "Mesh.CharacteristicLengthMax") sizeMm = value;
        }
      },
      model: {
        getEntities(dimension: number) {
          if (dimension === 3) return { dimTags: [3, 1] };
          if (dimension === 2) return { dimTags: [2, 1] };
          return { dimTags: [] };
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
          getMass() {
            return { mass: 1_000 };
          },
          getSurfaceLoops() {
            return { surfaceLoopTags: [1], surfaceTags: [[1]] };
          }
        },
        mesh: {
          generate(dimension: number) {
            if (dimension === 3) state.attempts.push({ algorithm, sizeMm });
          },
          optimize() {
            if (state.scenario === "algorithm_fallback" && algorithm === "delaunay") {
              throw new Error("memory access out of bounds");
            }
          },
          setOrder(order: 1 | 2) {
            elementOrder = order;
          },
          getElementsByType(typeCode: number) {
            const activeType = elementOrder === 2 ? 11 : 4;
            return { elementTags: typeCode === activeType ? [1] : [], nodeTags: [] };
          },
          getElementQualities() {
            return { elementsQuality: [qualityFor(algorithm, sizeMm)] };
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
});
