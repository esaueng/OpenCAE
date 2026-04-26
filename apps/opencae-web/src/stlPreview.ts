import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { stlVolumeM3FromBytes } from "@opencae/units";

const NORMALIZED_MODEL_SIZE = 2.4;

export function normalizedStlGeometryFromBuffer(buffer: ArrayBuffer): THREE.BufferGeometry {
  const volumeM3 = stlVolumeM3FromBytes(new Uint8Array(buffer));
  const geometry = new STLLoader().parse(stlLoaderInputFor(buffer));
  if (volumeM3) {
    geometry.userData.opencaeVolumeM3 = volumeM3;
    geometry.userData.opencaeVolumeSource = "mesh";
    geometry.userData.opencaeVolumeStatus = "available";
  }
  normalizeStlGeometry(geometry);
  geometry.computeVertexNormals();
  return geometry;
}

export function normalizeStlGeometry(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) {
    throw new Error("STL file did not contain renderable triangles.");
  }

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    throw new Error("STL file did not contain valid bounds.");
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error("STL file did not contain valid geometry extents.");
  }

  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(NORMALIZED_MODEL_SIZE / maxDimension, NORMALIZED_MODEL_SIZE / maxDimension, NORMALIZED_MODEL_SIZE / maxDimension);
  geometry.computeBoundingBox();
}

function stlLoaderInputFor(buffer: ArrayBuffer): ArrayBuffer | string {
  if (isExactBinaryStl(buffer)) return buffer;

  const header = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 512)));
  if (header.replace(/^\uFEFF/, "").trimStart().startsWith("solid")) {
    return new TextDecoder().decode(buffer).replace(/^\uFEFF/, "").trimStart();
  }

  return buffer;
}

function isExactBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const reader = new DataView(buffer);
  const faces = reader.getUint32(80, true);
  return 84 + faces * 50 === buffer.byteLength;
}
