import * as THREE from "three";
import type { OcctImporter, OcctMesh } from "occt-import-js";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import { meshVolumeM3FromTriangles, type Triangle } from "@opencae/units";

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

export interface StepPreviewOptions {
  includeEdges?: boolean;
  shareMaterials?: boolean;
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

export function normalizedStepPreviewFromMeshes(meshes: OcctMesh[], color: string, options: StepPreviewOptions = {}): StepPreview {
  const includeEdges = options.includeEdges ?? true;
  const shareMaterials = options.shareMaterials === true;
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, metalness: 0.18, roughness: 0.54 });
  const edgeMaterial = includeEdges ? new THREE.LineBasicMaterial({ color: "#c8d3df", transparent: true, opacity: 0.72 }) : null;

  for (const [index, importedMesh] of meshes.entries()) {
    const geometry = geometryFromOcctMesh(importedMesh);
    const mesh = new THREE.Mesh(geometry, shareMaterials ? material : material.clone());
    const importedName = (importedMesh as { name?: unknown }).name;
    const label = typeof importedName === "string" && importedName.trim() ? importedName.trim() : `Part ${index + 1}`;
    mesh.name = label;
    mesh.userData.opencaeObjectId = `step-object-${index + 1}`;
    mesh.userData.opencaeObjectLabel = label;
    const volumeM3 = volumeM3FromGeometry(geometry);
    if (volumeM3) {
      mesh.userData.opencaeVolumeM3 = volumeM3;
      mesh.userData.opencaeVolumeSource = "step";
      mesh.userData.opencaeVolumeStatus = "available";
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (includeEdges) {
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 15), edgeMaterial!));
    }
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

function volumeM3FromGeometry(geometry: THREE.BufferGeometry): number | undefined {
  const positions = geometry.getAttribute("position");
  if (!positions) return undefined;
  const triangles: Triangle[] = [];
  const index = geometry.getIndex();
  if (index) {
    for (let offset = 0; offset + 2 < index.count; offset += 3) {
      triangles.push([
        vertexAt(positions, index.getX(offset)),
        vertexAt(positions, index.getX(offset + 1)),
        vertexAt(positions, index.getX(offset + 2))
      ]);
    }
  } else {
    for (let offset = 0; offset + 2 < positions.count; offset += 3) {
      triangles.push([vertexAt(positions, offset), vertexAt(positions, offset + 1), vertexAt(positions, offset + 2)]);
    }
  }
  return meshVolumeM3FromTriangles(triangles);
}

function vertexAt(positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number): [number, number, number] {
  return [positions.getX(index), positions.getY(index), positions.getZ(index)];
}

export async function stepPreviewFromBase64(contentBase64: string, color: string, options?: StepPreviewOptions): Promise<StepPreview> {
  const importer = await getOcctImporter();
  const bytes = base64ToUint8Array(contentBase64);
  const result = importer.ReadStepFile(bytes, null);

  if (!result.success) {
    throw new Error(`STEP import failed${result.errorCode ? ` (${result.errorCode})` : ""}.`);
  }

  return normalizedStepPreviewFromMeshes(result.meshes ?? [], color, options);
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
