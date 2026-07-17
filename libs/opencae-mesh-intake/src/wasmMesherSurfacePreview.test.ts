import { describe, expect, test } from "vitest";
import { stepSurfacePreviewFromGmsh, type GmshApi } from "./wasmMesher";

describe("STEP Gmsh surface preview", () => {
  test("compacts non-contiguous node tags and preserves per-surface triangle ranges", () => {
    const gmsh = {
      model: {
        getEntities(dimension: number) {
          if (dimension === 3) return { dimTags: [3, 7] };
          if (dimension === 2) return { dimTags: [2, 2, 2, 1] };
          return { dimTags: [] };
        },
        getBoundary() {
          return { outDimTags: [2, -2, 2, 1] };
        },
        mesh: {
          getNodes() {
            return {
              nodeTags: [10, 20, 30, 40],
              coord: [0, 0, 0, 10, 0, 0, 0, 4, 0, 10, 4, 0],
              parametricCoord: []
            };
          },
          getElementsByType(_type: number, surfaceTag: number) {
            return {
              elementTags: [surfaceTag],
              nodeTags: surfaceTag === 1 ? [10, 20, 30] : [20, 40, 30]
            };
          }
        }
      }
    } as unknown as GmshApi;

    const preview = stepSurfacePreviewFromGmsh(gmsh);

    expect(preview.meshes).toHaveLength(1);
    expect(Array.from(preview.meshes[0]!.positions)).toEqual([0, 0, 0, 10, 0, 0, 0, 4, 0, 10, 4, 0]);
    expect(Array.from(preview.meshes[0]!.indices)).toEqual([0, 1, 2, 1, 2, 3]);
    expect(preview.meshes[0]!.faceRanges).toEqual([{ first: 0, last: 0 }, { first: 1, last: 1 }]);
  });
});
