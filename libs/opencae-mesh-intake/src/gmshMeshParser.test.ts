import { describe, expect, it, vi } from "vitest";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";

describe("Gmsh mesh quality parsing", () => {
  it("computes volume extrema without passing the full element array to Math.min or Math.max", () => {
    const originalMin = Math.min;
    const originalMax = Math.max;
    const minSpy = vi.spyOn(Math, "min").mockImplementation((...values: number[]) => {
      if (values.length > 2) throw new RangeError("simulated JavaScript argument limit");
      return originalMin(...values);
    });
    const maxSpy = vi.spyOn(Math, "max").mockImplementation((...values: number[]) => {
      if (values.length > 2) throw new RangeError("simulated JavaScript argument limit");
      return originalMax(...values);
    });

    let artifact: ReturnType<typeof parseGmshMeshToCoreVolumeMesh> | undefined;
    try {
      artifact = parseGmshMeshToCoreVolumeMesh(threeTetMesh(), { units: "m" });
    } finally {
      minSpy.mockRestore();
      maxSpy.mockRestore();
    }

    expect(artifact?.metadata.meshQuality).toEqual({
      minTetVolume: 1 / 6,
      maxTetVolume: 27 / 6,
      invertedElementCount: 0
    });
  });
});

function threeTetMesh(): string {
  return `$MeshFormat
2.2 0 8
$EndMeshFormat
$Nodes
12
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
5 10 0 0
6 12 0 0
7 10 2 0
8 10 0 2
9 20 0 0
10 23 0 0
11 20 3 0
12 20 0 3
$EndNodes
$Elements
3
1 4 0 1 2 3 4
2 4 0 5 6 7 8
3 4 0 9 10 11 12
$EndElements`;
}
