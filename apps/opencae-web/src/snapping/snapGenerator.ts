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
  return [
    { kind: "face-centroid", point: entity.position, priority: SNAP_PRIORITIES["face-centroid"] },
    { kind: "face-projected", point: projected, priority: SNAP_PRIORITIES["face-projected"] },
    { kind: "face-closest", point: projected, priority: SNAP_PRIORITIES["face-closest"] }
  ];
}
