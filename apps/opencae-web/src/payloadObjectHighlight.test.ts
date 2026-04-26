import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { highlightPayloadObjectMeshes } from "./payloadObjectHighlight";

describe("payload object highlighting", () => {
  test("highlights only the mesh carrying the active payload object id", () => {
    const root = new THREE.Group();
    const first = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#9aa7b4" }));
    first.userData.opencaeObjectId = "rod-1";
    const second = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#9aa7b4" }));
    second.userData.opencaeObjectId = "rod-2";
    root.add(first, second);

    highlightPayloadObjectMeshes(root, "rod-2", { baseColor: "#9aa7b4", highlightColor: "#7cc7ff" });

    expect((first.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("9aa7b4");
    expect((second.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("7cc7ff");
    expect((second.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("1f6fb8");
  });
});
