import { describe, expect, test } from "vitest";
import { meshVolumeM3FromTriangles, stlDimensionsFromBytes, stlVolumeM3FromBytes } from ".";

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

  test("ignores long malformed ASCII STL content without regex parsing", () => {
    const malformedLines = Array.from({ length: 20_000 }, (_, index) => `not-a-vertex ${index} ${"x".repeat(20)}`).join("\n");
    const bytes = new TextEncoder().encode(`solid malformed\n${malformedLines}\nendsolid malformed`);

    expect(stlDimensionsFromBytes(bytes)).toBeUndefined();
  });

  test("rejects ASCII STL vertices with non-finite coordinates", () => {
    const bytes = new TextEncoder().encode(`
solid invalid
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex Infinity 0 0
vertex 0 1 0
endloop
endfacet
endsolid invalid
`);

    expect(stlDimensionsFromBytes(bytes)).toBeUndefined();
  });
});

describe("mesh volume", () => {
  test("computes closed mesh volume in cubic meters from millimeter vertices", () => {
    const size = 10;
    const p = {
      a: [0, 0, 0] as [number, number, number],
      b: [size, 0, 0] as [number, number, number],
      c: [size, size, 0] as [number, number, number],
      d: [0, size, 0] as [number, number, number],
      e: [0, 0, size] as [number, number, number],
      f: [size, 0, size] as [number, number, number],
      g: [size, size, size] as [number, number, number],
      h: [0, size, size] as [number, number, number]
    };
    const triangles: Array<[[number, number, number], [number, number, number], [number, number, number]]> = [
      [p.a, p.c, p.b], [p.a, p.d, p.c],
      [p.e, p.f, p.g], [p.e, p.g, p.h],
      [p.a, p.b, p.f], [p.a, p.f, p.e],
      [p.d, p.h, p.g], [p.d, p.g, p.c],
      [p.a, p.e, p.h], [p.a, p.h, p.d],
      [p.b, p.c, p.g], [p.b, p.g, p.f]
    ];

    expect(meshVolumeM3FromTriangles(triangles)).toBeCloseTo(0.000001);
  });

  test("computes ASCII STL volume from triangles", () => {
    const bytes = new TextEncoder().encode(`
solid tetra
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 100 0 0
vertex 0 100 0
endloop
endfacet
facet normal 1 0 0
outer loop
vertex 0 0 0
vertex 0 0 100
vertex 100 0 0
endloop
endfacet
facet normal 0 1 0
outer loop
vertex 0 0 0
vertex 0 100 0
vertex 0 0 100
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 100 0 0
vertex 0 0 100
vertex 0 100 0
endloop
endfacet
endsolid tetra
`);

    expect(stlVolumeM3FromBytes(bytes)).toBeCloseTo(1 / 6000);
  });
});
