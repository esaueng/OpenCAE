import * as THREE from "three";
import type { OcctImporter, OcctMesh } from "occt-import-js";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import { meshVolumeM3FromTriangles, type Triangle } from "@opencae/units";
import {
  loadStepSurfacePreviewFallback,
  occtMeshesFromStepSurfacePreview,
  peekStepSurfacePreview,
  preferStepSurfacePreview
} from "./stepSurfacePreviewFallback";

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
    const importedName = (importedMesh as { name?: unknown }).name;
    const label = typeof importedName === "string" && importedName.trim() ? importedName.trim() : `Part ${index + 1}`;
    if (!hasRenderableOcctMesh(importedMesh)) {
      // Keep child indexes aligned with the B-Rep registry even when an
      // importer emits an empty assembly placeholder before real meshes.
      const placeholder = new THREE.Group();
      placeholder.name = label;
      placeholder.userData.opencaeEmptyStepMesh = true;
      group.add(placeholder);
      continue;
    }
    const geometry = geometryFromOcctMesh(importedMesh);
    const mesh = new THREE.Mesh(geometry, shareMaterials ? material : material.clone());
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

  if (!group.children.some((child) => child instanceof THREE.Mesh)) {
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
  const cached = peekStepSurfacePreview(contentBase64);
  if (cached?.preferred) {
    return normalizedStepPreviewFromMeshes(occtMeshesFromStepSurfacePreview(cached.surfacePreview), color, options);
  }

  const importer = await getOcctImporter();
  const bytes = base64ToUint8Array(contentBase64);
  const result = importer.ReadStepFile(bytes, null);

  if (result.success && (result.meshes ?? []).some(hasRenderableOcctMesh)) {
    return normalizedStepPreviewFromMeshes(result.meshes ?? [], color, options);
  }

  try {
    const fallback = await loadStepSurfacePreviewFallback(contentBase64);
    preferStepSurfacePreview(contentBase64);
    return normalizedStepPreviewFromMeshes(occtMeshesFromStepSurfacePreview(fallback.surfacePreview), color, options);
  } catch (fallbackError) {
    const primary = result.success
      ? "STEP import succeeded but did not produce a surface tessellation."
      : `STEP import failed${result.errorCode ? ` (${result.errorCode})` : ""}.`;
    const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "Gmsh preview fallback failed.";
    throw new Error(`${primary} ${fallbackMessage}`);
  }
}

function hasRenderableOcctMesh(mesh: OcctMesh): boolean {
  const positionCount = mesh.attributes?.position?.array?.length ?? 0;
  const indexCount = mesh.index?.array?.length ?? 0;
  return positionCount >= 9 && (indexCount >= 3 || positionCount % 9 === 0);
}

export function getOcctImporter(): Promise<OcctImporter> {
  occtPromise ??= import("occt-import-js")
    .then(({ default: occtimportjs }) => {
      return occtimportjs({
        locateFile: (path: string) => (path.endsWith(".wasm") ? occtWasmUrl : path)
      });
    })
    .catch((error: unknown) => {
      occtPromise = null;
      throw error;
    });
  return occtPromise;
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
