import * as THREE from "three";
import { closestPointOnSegment, midpoint, projectPointToPlane } from "./math";
import { SNAP_PRIORITIES, type CursorRay, type HoveredEntity, type SnapCandidate } from "./types";

export function generateSnapCandidates(entity: HoveredEntity, cursorRay: CursorRay): SnapCandidate[] {
  if (entity.type === "vertex") {
    return [{ kind: "vertex", point: entity.position, priority: SNAP_PRIORITIES.vertex }];
  }

  if (entity.type === "edge" && entity.endpoints) {
    const [start, end] = entity.endpoints;
    return [
      { kind: "edge-endpoint", point: start, priority: SNAP_PRIORITIES["edge-endpoint"] },
      { kind: "edge-endpoint", point: end, priority: SNAP_PRIORITIES["edge-endpoint"] },
      { kind: "edge-midpoint", point: midpoint(start, end), priority: SNAP_PRIORITIES["edge-midpoint"] },
      { kind: "edge-closest", point: closestPointOnSegment(cursorRay.cursorPoint, start, end), priority: SNAP_PRIORITIES["edge-closest"] }
    ];
  }

  const normal = entity.normal ?? [0, 0, 1];
  const projected = projectPointToPlane(cursorRay.cursorPoint, entity.position, normal);
  const [firstAxis, secondAxis] = faceCenterlineAxes(normal);
  return [
    { kind: "face-centroid", point: entity.position, priority: SNAP_PRIORITIES["face-centroid"] },
    { kind: "face-centerline", point: closestPointOnLine(projected, entity.position, firstAxis), priority: SNAP_PRIORITIES["face-centerline"] },
    { kind: "face-centerline", point: closestPointOnLine(projected, entity.position, secondAxis), priority: SNAP_PRIORITIES["face-centerline"] },
    { kind: "face-projected", point: projected, priority: SNAP_PRIORITIES["face-projected"], fallback: true },
    { kind: "face-closest", point: projected, priority: SNAP_PRIORITIES["face-closest"], fallback: true }
  ];
}

function closestPointOnLine(point: [number, number, number], linePoint: [number, number, number], lineDirection: THREE.Vector3): [number, number, number] {
  const target = new THREE.Vector3(...point);
  const origin = new THREE.Vector3(...linePoint);
  const direction = lineDirection.clone().normalize();
  return origin.add(direction.multiplyScalar(target.sub(origin).dot(direction))).toArray().map((value) => Number(value.toFixed(6))) as [number, number, number];
}

function faceCenterlineAxes(normalValue: [number, number, number]): [THREE.Vector3, THREE.Vector3] {
  const normal = new THREE.Vector3(...normalValue).normalize();
  const reference = Math.abs(normal.z) > 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const firstAxis = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const secondAxis = new THREE.Vector3().crossVectors(normal, firstAxis).normalize();
  return [firstAxis, secondAxis];
}
