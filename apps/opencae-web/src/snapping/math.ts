import * as THREE from "three";
import type { Vec3 } from "./types";

export function vectorFromVec3(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

export function vec3FromVector(value: THREE.Vector3): Vec3 {
  return [roundSnapValue(value.x), roundSnapValue(value.y), roundSnapValue(value.z)];
}

export function distanceVec3(left: Vec3, right: Vec3) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

export function normalizeVec3(value: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
  const vector = vectorFromVec3(value);
  if (vector.lengthSq() < 1e-12) return fallback;
  return vec3FromVector(vector.normalize());
}

export function closestPointOnSegment(point: Vec3, start: Vec3, end: Vec3): Vec3 {
  const target = vectorFromVec3(point);
  const a = vectorFromVec3(start);
  const segment = vectorFromVec3(end).sub(a);
  const lengthSq = segment.lengthSq();
  if (lengthSq < 1e-12) return start;
  const t = THREE.MathUtils.clamp(target.sub(a).dot(segment) / lengthSq, 0, 1);
  return vec3FromVector(a.add(segment.multiplyScalar(t)));
}

export function midpoint(start: Vec3, end: Vec3): Vec3 {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2].map(roundSnapValue) as Vec3;
}

export function projectPointToPlane(point: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 {
  const target = vectorFromVec3(point);
  const origin = vectorFromVec3(planePoint);
  const normal = vectorFromVec3(normalizeVec3(planeNormal));
  const distance = target.clone().sub(origin).dot(normal);
  return vec3FromVector(target.sub(normal.multiplyScalar(distance)));
}

function roundSnapValue(value: number) {
  return Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(6));
}
