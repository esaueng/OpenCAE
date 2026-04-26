import { describe, expect, test } from "vitest";
import { stlDimensionsFromBytes } from ".";

function binaryStl(vertices: [number, number, number][]): Uint8Array {
  const triangleCount = vertices.length / 3;
  const bytes = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangleCount, true);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const offset = 84 + triangleIndex * 50 + 12;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const vertex = vertices[triangleIndex * 3 + vertexIndex]!;
      for (let axis = 0; axis < 3; axis += 1) {
        view.setFloat32(offset + vertexIndex * 12 + axis * 4, vertex[axis]!, true);
      }
    }
  }
  return bytes;
}

describe("STL dimensions", () => {
  test("reads binary STL extents without normalizing display scale", () => {
    const bytes = binaryStl([
      [14.14, 7.45, -1],
      [282.94, 7.45, -1],
      [14.14, 297.35, 245.05]
    ]);

    expect(stlDimensionsFromBytes(bytes)).toEqual({
      x: 268.8,
      y: 246.1,
      z: 289.9,
      units: "mm"
    });
  });

  test("reads ASCII STL extents", () => {
    const bytes = new TextEncoder().encode(`
solid part
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 25.4 0 0
vertex 0 50.8 76.2
endloop
endfacet
endsolid part
`);

    expect(stlDimensionsFromBytes(bytes)).toEqual({
      x: 25.4,
      y: 76.2,
      z: 50.8,
      units: "mm"
    });
  });
});
