import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { normalizedStlGeometryFromBuffer } from "./stlPreview";

function asciiStlBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

describe("STL preview helpers", () => {
  test("parses multi-solid ASCII STL files with leading whitespace", () => {
    const stl = asciiStlBuffer(`
solid part_a
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid part_a
solid part_b
  facet normal 0 0 1
    outer loop
      vertex 20 0 0
      vertex 30 0 0
      vertex 20 10 0
    endloop
  endfacet
endsolid part_b
`);

    const geometry = normalizedStlGeometryFromBuffer(stl);

    expect(geometry.getAttribute("position").count).toBe(6);
    expect(geometry.groups).toHaveLength(2);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.getSize(new THREE.Vector3()).x).toBeCloseTo(2.4);
  });
});
