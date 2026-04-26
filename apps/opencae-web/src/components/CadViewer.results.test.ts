import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { VIEWER_GIZMO_ALIGNMENT, colorizeResultObject, payloadHighlightObjectId, shouldShowModelHitLabel } from "./CadViewer";
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
  test("positions the viewer XYZ axes in the bottom-right corner", () => {
    expect(VIEWER_GIZMO_ALIGNMENT).toBe("bottom-right");
  });

  test("hides face selection callouts in result view", () => {
    expect(shouldShowModelHitLabel("results", true)).toBe(false);
    expect(shouldShowModelHitLabel("model", true)).toBe(true);
    expect(shouldShowModelHitLabel("mesh", false)).toBe(false);
  });

  test("uses only hovered payload hits for setup-view object highlighting", () => {
    expect(payloadHighlightObjectId(true, null)).toBeUndefined();
    expect(payloadHighlightObjectId(true, { id: "payload-part", label: "Payload part", center: [0, 0, 0] })).toBe("payload-part");
    expect(payloadHighlightObjectId(false, { id: "payload-part", label: "Payload part", center: [0, 0, 0] })).toBeUndefined();
  });

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

  test("excludes payload mass meshes and stretches simulated vertices across the full stress ramp", () => {
    const simulatedGeometry = new THREE.BufferGeometry();
    simulatedGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.2, 0, 0, 0, 0, 0, 0.2, 0, 0], 3));
    const simulatedMesh = new THREE.Mesh(simulatedGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    simulatedMesh.userData.opencaeObjectId = "simulated-part";

    const payloadGeometry = new THREE.BufferGeometry();
    payloadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0, 0, 1.1, 0, 0, 1.2, 0, 0], 3));
    const payloadMesh = new THREE.Mesh(payloadGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    payloadMesh.userData.opencaeObjectId = "payload-part";

    const group = new THREE.Group();
    group.add(simulatedMesh, payloadMesh);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, [{
      id: "load-payload",
      faceId: "right",
      payloadObject: { id: "payload-part", label: "Payload part", center: [1.1, 0, 0] },
      type: "gravity",
      value: 2,
      units: "kg",
      direction: [0, 0, -1],
      directionLabel: "-Z",
      labelIndex: 0,
      stackIndex: 0
    }]);

    const colors = Array.from(simulatedGeometry.getAttribute("color").array);
    const lowColor = new THREE.Color(colors[0]!, colors[1]!, colors[2]!);
    const highColor = new THREE.Color(colors[6]!, colors[7]!, colors[8]!);

    expect(payloadMesh.visible).toBe(false);
    expect(lowColor.b).toBeGreaterThan(lowColor.r);
    expect(highColor.r).toBeGreaterThan(highColor.b);
  });
});
