import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { geometryFromOcctMesh, normalizedStepGroupFromMeshes } from "./stepPreview";

const importedMesh = {
  attributes: {
    position: { array: [0, 0, 0, 10, 0, 0, 0, 4, 0] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] }
  },
  index: { array: [0, 1, 2] }
};

describe("STEP preview helpers", () => {
  test("builds three geometry from imported STEP mesh data", () => {
    const geometry = geometryFromOcctMesh(importedMesh);

    expect(geometry.getAttribute("position").count).toBe(3);
    expect(Array.from(geometry.getIndex()?.array ?? [])).toEqual([0, 1, 2]);
  });

  test("normalizes imported STEP meshes instead of substituting a placeholder box", () => {
    const group = normalizedStepGroupFromMeshes([importedMesh], "#9aa7b4");
    const mesh = group.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh | undefined;

    expect(mesh).toBeDefined();
    expect((mesh?.geometry as THREE.BufferGeometry).getAttribute("position").count).toBe(3);
    expect(group.scale.x).toBeCloseTo(0.24);
    expect(group.position.x).toBeCloseTo(-5);
  });
});
