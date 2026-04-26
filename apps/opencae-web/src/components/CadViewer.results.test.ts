import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { VIEWER_GIZMO_ALIGNMENT, axisLabelToViewAxis, cameraViewForAxis, colorizeResultObject, payloadHighlightObjectId, printLayerVisualizationForBounds, rotatedCameraOrbit, shouldShowModelHitLabel } from "./CadViewer";
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

  test("maps gizmo Z clicks to a clockwise square top view", () => {
    const topView = cameraViewForAxis(axisLabelToViewAxis("Z"));

    expect(topView.direction.toArray()).toEqual([0, 0, 1]);
    expect(topView.up.toArray()).toEqual([-1, 0, 0]);
  });

  test("rotates the camera orbit around a requested gizmo axis", () => {
    const rotated = rotatedCameraOrbit(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 1),
      "z",
      Math.PI / 2
    );

    expect(rotated.position.x).toBeCloseTo(0);
    expect(rotated.position.y).toBeCloseTo(1);
    expect(rotated.position.z).toBeCloseTo(0);
    expect(rotated.up.toArray()).toEqual([0, 0, 1]);
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

  test("builds layer visualization planes perpendicular to the selected viewer print direction", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-2, -1, -0.5), new THREE.Vector3(2, 1, 0.5));

    const zBuild = printLayerVisualizationForBounds(bounds, "z");
    const yBuild = printLayerVisualizationForBounds(bounds, "y");
    const xBuild = printLayerVisualizationForBounds(bounds, "x");

    expect(zBuild?.axis.toArray()).toEqual([0, 1, 0]);
    expect(zBuild?.label).toBe("Z build");
    expect(zBuild?.planes).toHaveLength(7);
    expect(zBuild?.planes[0]?.every((point) => point[1] === -1)).toBe(true);
    expect(yBuild?.axis.toArray()).toEqual([0, 0, 1]);
    expect(yBuild?.planes[0]?.every((point) => point[2] === -0.5)).toBe(true);
    expect(xBuild?.axis.toArray()).toEqual([1, 0, 0]);
    expect(xBuild?.planes[0]?.every((point) => point[0] === -2)).toBe(true);
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

  test("shows payload mass meshes as solid parts while stretching simulated vertices across the full stress ramp", () => {
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

    expect(payloadMesh.visible).toBe(true);
    expect((payloadMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    expect((payloadMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("8f9aa5");
    expect(lowColor.b).toBeGreaterThan(lowColor.r);
    expect(highColor.r).toBeGreaterThan(highColor.b);
  });

  test("keeps split meshes for the same payload-loaded object solid grey", () => {
    const simulatedGeometry = new THREE.BufferGeometry();
    simulatedGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.2, 0, 0, 0, 0, 0, 0.2, 0, 0], 3));
    const simulatedMesh = new THREE.Mesh(simulatedGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    simulatedMesh.userData.opencaeObjectId = "simulated-part";

    const payloadGroup = new THREE.Group();
    payloadGroup.userData.opencaeObjectId = "rod-group";
    payloadGroup.userData.opencaeObjectLabel = "Rod 1";

    const selectedPayloadGeometry = new THREE.BufferGeometry();
    selectedPayloadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0, 0, 1.1, 0, 0, 1.2, 0, 0], 3));
    const selectedPayloadMesh = new THREE.Mesh(selectedPayloadGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    selectedPayloadMesh.userData.opencaeObjectId = "rod-segment-a";
    selectedPayloadMesh.userData.opencaeObjectLabel = "Rod 1";

    const siblingPayloadGeometry = new THREE.BufferGeometry();
    siblingPayloadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0.1, 0, 1.1, 0.1, 0, 1.2, 0.1, 0], 3));
    const siblingPayloadMesh = new THREE.Mesh(siblingPayloadGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    siblingPayloadMesh.userData.opencaeObjectId = "rod-segment-b";
    siblingPayloadMesh.userData.opencaeObjectLabel = "Rod 1";

    payloadGroup.add(selectedPayloadMesh, siblingPayloadMesh);

    const group = new THREE.Group();
    group.add(simulatedMesh, payloadGroup);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, [{
      id: "load-payload",
      faceId: "right",
      payloadObject: { id: "rod-segment-a", label: "Rod 1", center: [1.1, 0, 0] },
      type: "gravity",
      value: 2,
      units: "kg",
      direction: [0, 0, -1],
      directionLabel: "-Z",
      labelIndex: 0,
      stackIndex: 0
    }]);

    expect((selectedPayloadMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    expect((selectedPayloadMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("8f9aa5");
    expect((siblingPayloadMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    expect((siblingPayloadMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("8f9aa5");
    expect((simulatedMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });
});
