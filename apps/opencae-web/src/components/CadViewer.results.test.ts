import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { colorizeResultObject } from "./CadViewer";
import type { FaceResultSample } from "../resultFields";

const samples: FaceResultSample[] = [
  {
    face: { id: "left", label: "Left", color: "#4da3ff", center: [-1, 0, 0], normal: [1, 0, 0], stressValue: 10 },
    value: 10,
    normalized: 0
  },
  {
    face: { id: "right", label: "Right", color: "#f59e0b", center: [1, 0, 0], normal: [-1, 0, 0], stressValue: 100 },
    value: 100,
    normalized: 1
  }
];

describe("CadViewer result coloring", () => {
  test("applies vertex result colors to imported native CAD preview meshes", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.add(mesh);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, []);

    const colors = Array.from((mesh.geometry as THREE.BufferGeometry).getAttribute("color").array);
    expect(colors.slice(0, 3)).not.toEqual(colors.slice(6, 9));
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });

  test("samples transformed native CAD vertices in normalized result coordinates", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([1000, 0, 0, 1050, 0, 0, 1100, 0, 0], 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.scale.setScalar(0.024);
    group.position.set(-25.2, 0, 0);
    group.add(mesh);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, []);

    const colors = Array.from((mesh.geometry as THREE.BufferGeometry).getAttribute("color").array);
    expect(colors.slice(0, 3)).not.toEqual(colors.slice(6, 9));
  });
});
