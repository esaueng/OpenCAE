import * as THREE from "three";
import type { OcctImporter, OcctMesh } from "occt-import-js";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

let occtPromise: Promise<OcctImporter> | null = null;

export interface StepPreview {
  object: THREE.Group;
  dimensions: {
    x: number;
    y: number;
    z: number;
    units: "mm";
  };
  normalizedBounds: THREE.Box3;
}

export function geometryFromOcctMesh(mesh: OcctMesh): THREE.BufferGeometry {
  const positions = mesh.attributes?.position?.array;
  if (!positions?.length) {
    throw new Error("STEP mesh does not contain positions.");
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(Array.from(positions), 3));

  const normals = mesh.attributes?.normal?.array;
  if (normals?.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(Array.from(normals), 3));
  } else {
    geometry.computeVertexNormals();
  }

  const indices = mesh.index?.array;
  if (indices?.length) {
    geometry.setIndex(Array.from(indices));
  }

  geometry.computeBoundingBox();
  return geometry;
}

export function normalizedStepPreviewFromMeshes(meshes: OcctMesh[], color: string): StepPreview {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, metalness: 0.18, roughness: 0.54 });

  for (const [index, importedMesh] of meshes.entries()) {
    const geometry = geometryFromOcctMesh(importedMesh);
    const mesh = new THREE.Mesh(geometry, material.clone());
    const importedName = (importedMesh as { name?: unknown }).name;
    const label = typeof importedName === "string" && importedName.trim() ? importedName.trim() : `Part ${index + 1}`;
    mesh.name = label;
    mesh.userData.opencaeObjectId = `step-object-${index + 1}`;
    mesh.userData.opencaeObjectLabel = label;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 15),
        new THREE.LineBasicMaterial({ color: "#c8d3df", transparent: true, opacity: 0.72 })
      )
    );
    group.add(mesh);
  }

  if (group.children.length === 0) {
    throw new Error("STEP file did not produce renderable meshes.");
  }

  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
  const scale = 2.4 / maxDimension;
  group.scale.setScalar(scale);
  group.position.copy(center.multiplyScalar(-scale));
  return {
    object: group,
    dimensions: {
      x: size.x,
      y: size.y,
      z: size.z,
      units: "mm"
    },
    normalizedBounds: new THREE.Box3().setFromObject(group)
  };
}

export async function stepPreviewFromBase64(contentBase64: string, color: string): Promise<StepPreview> {
  const importer = await getOcctImporter();
  const bytes = base64ToUint8Array(contentBase64);
  const result = importer.ReadStepFile(bytes, null);

  if (!result.success) {
    throw new Error(`STEP import failed${result.errorCode ? ` (${result.errorCode})` : ""}.`);
  }

  return normalizedStepPreviewFromMeshes(result.meshes ?? [], color);
}

function getOcctImporter(): Promise<OcctImporter> {
  occtPromise ??= import("occt-import-js").then(({ default: occtimportjs }) => {
    return occtimportjs({
      locateFile: (path: string) => (path.endsWith(".wasm") ? occtWasmUrl : path)
    });
  });
  return occtPromise;
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
