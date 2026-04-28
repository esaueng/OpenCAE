import * as THREE from "three";
import { closestPointOnSegment, midpoint, projectPointToPlane } from "./math";
import { SNAP_PRIORITIES, type CursorRay, type FaceSnapAxis, type HoveredEntity, type SnapCandidate, type SnapMeasurement, type Vec3 } from "./types";

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
  const axes = entity.snapAxes ?? faceCenterlineAxes(normal).map((direction) => ({ direction: direction.toArray() as Vec3 }));
  const centerlineCandidates = axes.flatMap((axis) => centerlineCandidatesForAxis(projected, entity.position, axis));
  return [
    { kind: "face-centroid", point: entity.position, priority: SNAP_PRIORITIES["face-centroid"] },
    ...centerlineCandidates,
    { kind: "face-projected", point: projected, priority: SNAP_PRIORITIES["face-projected"], fallback: true },
    { kind: "face-closest", point: projected, priority: SNAP_PRIORITIES["face-closest"], fallback: true }
  ];
}

function centerlineCandidatesForAxis(projected: Vec3, faceCenter: Vec3, axis: Partial<FaceSnapAxis>): SnapCandidate[] {
  const direction = new THREE.Vector3(...(axis.direction ?? [1, 0, 0])).normalize();
  const centerlinePoint = closestPointOnLine(projected, faceCenter, direction);
  const centerlineCandidate: SnapCandidate = { kind: "face-centerline", point: centerlinePoint, priority: SNAP_PRIORITIES["face-centerline"] };
  if (!isCompleteSnapAxis(axis)) return [centerlineCandidate];

  const unitCandidate = wholeUnitCandidate(centerlinePoint, axis);
  return unitCandidate ? [unitCandidate, centerlineCandidate] : [centerlineCandidate];
}

function closestPointOnLine(point: Vec3, linePoint: Vec3, lineDirection: THREE.Vector3): Vec3 {
  const target = new THREE.Vector3(...point);
  const origin = new THREE.Vector3(...linePoint);
  const direction = lineDirection.clone().normalize();
  return roundedVec3(origin.add(direction.multiplyScalar(target.sub(origin).dot(direction))));
}

function wholeUnitCandidate(centerlinePoint: Vec3, axis: FaceSnapAxis): SnapCandidate | null {
  const direction = new THREE.Vector3(...axis.direction).normalize();
  const minPoint = new THREE.Vector3(...axis.minPoint);
  const maxPoint = new THREE.Vector3(...axis.maxPoint);
  const point = new THREE.Vector3(...centerlinePoint);
  const spanUnits = Math.max(0, minPoint.distanceTo(maxPoint) * axis.unitsPerWorld);
  if (!Number.isFinite(spanUnits) || spanUnits <= 0 || axis.unitsPerWorld <= 0) return null;
  const unitStep = axis.unitStep && axis.unitStep > 0 ? axis.unitStep : 1;
  const unitsFromMin = THREE.MathUtils.clamp(point.clone().sub(minPoint).dot(direction) * axis.unitsPerWorld, 0, spanUnits);
  const snappedFromMin = THREE.MathUtils.clamp(Math.round(unitsFromMin / unitStep) * unitStep, 0, spanUnits);
  const snappedPoint = roundedVec3(minPoint.add(direction.multiplyScalar(snappedFromMin / axis.unitsPerWorld)));
  const measurement = edgeDistanceMeasurement(axis, snappedPoint, snappedFromMin, spanUnits);
  return {
    kind: "face-unit",
    point: snappedPoint,
    priority: SNAP_PRIORITIES["face-unit"],
    measurements: [measurement]
  };
}

function edgeDistanceMeasurement(axis: FaceSnapAxis, point: Vec3, fromMin: number, spanUnits: number): SnapMeasurement {
  const fromMax = Math.max(0, spanUnits - fromMin);
  const useMin = fromMin <= fromMax;
  const edgePoint = useMin ? axis.minPoint : axis.maxPoint;
  const value = useMin ? fromMin : fromMax;
  return {
    kind: "edge-distance",
    start: edgePoint,
    end: point,
    label: `${formatMeasurementValue(value)} ${axis.units} from edge`,
    value: Number(value.toFixed(3)),
    units: axis.units
  };
}

function isCompleteSnapAxis(axis: Partial<FaceSnapAxis>): axis is FaceSnapAxis {
  const unitsPerWorld = axis.unitsPerWorld;
  return Boolean(axis.direction && axis.minPoint && axis.maxPoint && Number.isFinite(unitsPerWorld) && unitsPerWorld !== undefined && unitsPerWorld > 0 && axis.units);
}

function formatMeasurementValue(value: number) {
  if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value));
  return String(Number(value.toFixed(3)));
}

function roundedVec3(vector: THREE.Vector3): Vec3 {
  return vector.toArray().map((value) => Number(value.toFixed(6))) as Vec3;
}

function faceCenterlineAxes(normalValue: Vec3): [THREE.Vector3, THREE.Vector3] {
  const normal = new THREE.Vector3(...normalValue).normalize();
  const reference = Math.abs(normal.z) > 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const firstAxis = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const secondAxis = new THREE.Vector3().crossVectors(normal, firstAxis).normalize();
  return [firstAxis, secondAxis];
}
