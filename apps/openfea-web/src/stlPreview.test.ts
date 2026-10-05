import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { normalizedStlGeometryFromBuffer, tryNormalizedStlGeometryFromBuffer } from "./stlPreview";

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

  test("throws on STL input without renderable triangles", () => {
    const stl = asciiStlBuffer(`solid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
endsolid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
`);

    expect(() => normalizedStlGeometryFromBuffer(stl)).toThrow("STL file did not contain renderable triangles.");
  });

  test("tryNormalizedStlGeometryFromBuffer returns null instead of throwing on invalid input", () => {
    const emptySolid = asciiStlBuffer(`solid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
endsolid empty_model_without_any_facets_padded_past_the_binary_stl_header_size
`);
    const garbage = new Uint8Array([1, 2, 3, 4, 5]).buffer;

    expect(tryNormalizedStlGeometryFromBuffer(emptySolid)).toBeNull();
    expect(tryNormalizedStlGeometryFromBuffer(garbage)).toBeNull();
  });

  test("tryNormalizedStlGeometryFromBuffer returns parsed geometry for valid STL input", () => {
    const stl = asciiStlBuffer(`
solid part
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid part
`);

    const geometry = tryNormalizedStlGeometryFromBuffer(stl);

    expect(geometry).not.toBeNull();
    expect(geometry?.getAttribute("position").count).toBe(3);
  });

  test("rejects binary STL input whose declared face count exceeds its size", () => {
    // three's binary parser sizes its typed arrays from the declared face
    // count before any bounds check, so an inflated declaration in a small
    // file forces a giant allocation. The preview must reject it up front.
    const stl = new ArrayBuffer(84);
    new DataView(stl).setUint32(80, 100_000_000, true);

    expect(() => normalizedStlGeometryFromBuffer(stl)).toThrow("STL file declares more faces than its size allows.");
    expect(tryNormalizedStlGeometryFromBuffer(stl)).toBeNull();
  });

  test("still accepts binary STL input with extra trailing bytes beyond the declared faces", () => {
    const triangle = new ArrayBuffer(84 + 50);
    const view = new DataView(triangle);
    view.setUint32(80, 1, true);
    // One triangle in the z=0 plane.
    view.setFloat32(84 + 12, 10, true);
    view.setFloat32(84 + 24, 10, true);
    view.setFloat32(84 + 34, 10, true);
    const padded = new Uint8Array(84 + 50 + 16);
    padded.set(new Uint8Array(triangle), 0);

    const geometry = tryNormalizedStlGeometryFromBuffer(padded.buffer);

    expect(geometry).not.toBeNull();
    expect(geometry?.getAttribute("position").count).toBe(3);
  });
});
