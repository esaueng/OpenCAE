/**
 * Analytic B-rep solid builders.
 *
 * Each builder emits a watertight MANIFOLD_SOLID_BREP whose faces sit on
 * exact analytic surfaces. Periodic faces (cylinder barrel, torus) carry an
 * explicit seam-edge loop, the same topology Open CASCADE writes for its own
 * primitives, so importers reconstruct smooth closed surfaces instead of
 * facet patches.
 *
 * Orientation conventions used throughout:
 * - face normals point out of the solid (`same_sense` resolves the surface
 *   normal against that), and
 * - boundary loops run counter-clockwise around the outward face normal.
 */

import { formatStepReal, StepWriter, type Vec3 } from "./writer";

const Z_AXIS: Vec3 = [0, 0, 1];
const X_AXIS: Vec3 = [1, 0, 0];

export interface CylinderSolidOptions {
  /** Body name shown by CAD packages. */
  name: string;
  /** Centre of the base disc; the axis runs along +Z. */
  baseCenter: Vec3;
  radius: number;
  height: number;
}

/**
 * Solid cylinder along +Z: two planar caps plus one cylindrical barrel face
 * whose loop traverses bottom circle, seam, reversed top circle, reversed
 * seam (the seam edge is shared by both sides of the parameter range).
 */
export function addCylinderSolid(writer: StepWriter, options: CylinderSolidOptions): number {
  const { radius, height } = options;
  if (!(radius > 0) || !(height > 0)) {
    throw new Error("Cylinder radius and height must be positive.");
  }
  const [cx, cy, cz] = options.baseCenter;
  const baseCenter: Vec3 = [cx, cy, cz];
  const topCenter: Vec3 = [cx, cy, cz + height];
  const baseSeamPoint: Vec3 = [cx + radius, cy, cz];
  const topSeamPoint: Vec3 = [cx + radius, cy, cz + height];

  const baseVertexId = writer.vertexPoint(baseSeamPoint);
  const topVertexId = writer.vertexPoint(topSeamPoint);

  const baseCircleId = writer.circle(writer.axis2Placement3d(baseCenter, Z_AXIS, X_AXIS), radius);
  const baseEdgeId = writer.edgeCurve(baseVertexId, baseVertexId, baseCircleId);
  const topCircleId = writer.circle(writer.axis2Placement3d(topCenter, Z_AXIS, X_AXIS), radius);
  const topEdgeId = writer.edgeCurve(topVertexId, topVertexId, topCircleId);
  const seamLineId = writer.line(baseSeamPoint, Z_AXIS);
  const seamEdgeId = writer.edgeCurve(baseVertexId, topVertexId, seamLineId);

  const barrelSurfaceId = writer.add(
    `CYLINDRICAL_SURFACE('',#${writer.axis2Placement3d(baseCenter, Z_AXIS, X_AXIS)},${formatStepReal(radius)})`
  );
  const barrelLoopId = writer.edgeLoop([
    writer.orientedEdge(baseEdgeId, true),
    writer.orientedEdge(seamEdgeId, true),
    writer.orientedEdge(topEdgeId, false),
    writer.orientedEdge(seamEdgeId, false)
  ]);
  const barrelFaceId = writer.advancedFace([writer.faceOuterBound(barrelLoopId)], barrelSurfaceId, true);

  const basePlaneId = writer.add(`PLANE('',#${writer.axis2Placement3d(baseCenter, [0, 0, -1], X_AXIS)})`);
  const baseLoopId = writer.edgeLoop([writer.orientedEdge(baseEdgeId, false)]);
  const baseFaceId = writer.advancedFace([writer.faceOuterBound(baseLoopId)], basePlaneId, true);

  const topPlaneId = writer.add(`PLANE('',#${writer.axis2Placement3d(topCenter, Z_AXIS, X_AXIS)})`);
  const topLoopId = writer.edgeLoop([writer.orientedEdge(topEdgeId, true)]);
  const topFaceId = writer.advancedFace([writer.faceOuterBound(topLoopId)], topPlaneId, true);

  const shellId = writer.closedShell([barrelFaceId, baseFaceId, topFaceId]);
  return writer.manifoldSolidBrep(options.name, shellId);
}

export interface TorusSolidOptions {
  /** Body name shown by CAD packages. */
  name: string;
  /** Centre of the torus; the revolution axis runs along +Z. */
  center: Vec3;
  /** Distance from the torus centre to the tube centreline. */
  majorRadius: number;
  /** Tube radius; must stay below the major radius. */
  minorRadius: number;
}

/**
 * Full torus as a single toroidal face. The boundary loop walks the
 * fundamental polygon (major seam, minor seam, both reversed) so the doubly
 * periodic surface stays watertight with one vertex and two seam edges.
 */
export function addTorusSolid(writer: StepWriter, options: TorusSolidOptions): number {
  const { majorRadius, minorRadius } = options;
  if (!(minorRadius > 0) || !(majorRadius > minorRadius)) {
    throw new Error("Torus needs 0 < minor radius < major radius.");
  }
  const [cx, cy, cz] = options.center;
  const center: Vec3 = [cx, cy, cz];
  const seamVertexId = writer.vertexPoint([cx + majorRadius + minorRadius, cy, cz]);

  const majorCircleId = writer.circle(writer.axis2Placement3d(center, Z_AXIS, X_AXIS), majorRadius + minorRadius);
  const majorEdgeId = writer.edgeCurve(seamVertexId, seamVertexId, majorCircleId);
  // Tube cross-section at the seam: centre offset along +X, swept from +X towards +Z.
  const minorCircleId = writer.circle(writer.axis2Placement3d([cx + majorRadius, cy, cz], [0, -1, 0], X_AXIS), minorRadius);
  const minorEdgeId = writer.edgeCurve(seamVertexId, seamVertexId, minorCircleId);

  const surfaceId = writer.add(
    `TOROIDAL_SURFACE('',#${writer.axis2Placement3d(center, Z_AXIS, X_AXIS)},${formatStepReal(majorRadius)},${formatStepReal(minorRadius)})`
  );
  const loopId = writer.edgeLoop([
    writer.orientedEdge(majorEdgeId, true),
    writer.orientedEdge(minorEdgeId, true),
    writer.orientedEdge(majorEdgeId, false),
    writer.orientedEdge(minorEdgeId, false)
  ]);
  const faceId = writer.advancedFace([writer.faceBound(loopId)], surfaceId, true);

  const shellId = writer.closedShell([faceId]);
  return writer.manifoldSolidBrep(options.name, shellId);
}

export interface BoxSolidOptions {
  /** Body name shown by CAD packages. */
  name: string;
  /** Minimum-coordinate corner of the box. */
  corner: Vec3;
  /** Edge lengths along X, Y, Z. */
  size: Vec3;
}

type Quad = readonly [Vec3, Vec3, Vec3, Vec3];

/** Axis-aligned solid box from six planar faces with shared vertices and edges. */
export function addBoxSolid(writer: StepWriter, options: BoxSolidOptions): number {
  const [sx, sy, sz] = options.size;
  if (!(sx > 0) || !(sy > 0) || !(sz > 0)) {
    throw new Error("Box dimensions must be positive.");
  }
  const [ox, oy, oz] = options.corner;
  const corner = (mx: number, my: number, mz: number): Vec3 => [ox + mx * sx, oy + my * sy, oz + mz * sz];

  // Outward-facing quads, each wound counter-clockwise around its outward normal.
  const faceQuads: readonly Quad[] = [
    [corner(0, 0, 0), corner(0, 1, 0), corner(1, 1, 0), corner(1, 0, 0)], // bottom (-Z)
    [corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)], // top (+Z)
    [corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)], // front (-Y)
    [corner(0, 1, 0), corner(0, 1, 1), corner(1, 1, 1), corner(1, 1, 0)], // back (+Y)
    [corner(0, 0, 0), corner(0, 0, 1), corner(0, 1, 1), corner(0, 1, 0)], // left (-X)
    [corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)] // right (+X)
  ];

  const vertexIds = new Map<string, number>();
  const vertexIdFor = (point: Vec3): number => {
    const key = point.join("|");
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = writer.vertexPoint(point);
      vertexIds.set(key, id);
    }
    return id;
  };

  // Shared straight edges, keyed independent of direction; loops re-orient them.
  const edges = new Map<string, { edgeId: number; startKey: string }>();
  const orientedEdgeFor = (start: Vec3, end: Vec3): number => {
    const startKey = start.join("|");
    const endKey = end.join("|");
    const key = [startKey, endKey].sort().join("->");
    let entry = edges.get(key);
    if (!entry) {
      const lineId = writer.line(start, subtract(end, start));
      entry = { edgeId: writer.edgeCurve(vertexIdFor(start), vertexIdFor(end), lineId), startKey };
      edges.set(key, entry);
    }
    return writer.orientedEdge(entry.edgeId, entry.startKey === startKey);
  };

  const faceIds = faceQuads.map((quad) => {
    const [p0, p1, p2, p3] = quad;
    const orientedEdgeIds = [
      orientedEdgeFor(p0, p1),
      orientedEdgeFor(p1, p2),
      orientedEdgeFor(p2, p3),
      orientedEdgeFor(p3, p0)
    ];
    const planeId = writer.add(`PLANE('',#${writer.axis2Placement3d(p0, quadNormal(quad), normalize(subtract(p1, p0)))})`);
    return writer.advancedFace([writer.faceOuterBound(writer.edgeLoop(orientedEdgeIds))], planeId, true);
  });

  const shellId = writer.closedShell(faceIds);
  return writer.manifoldSolidBrep(options.name, shellId);
}

function quadNormal(quad: Quad): Vec3 {
  const [p0, p1, p2] = quad;
  const a = subtract(p1, p0);
  const b = subtract(p2, p1);
  return normalize([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
}

function subtract(end: Vec3, start: Vec3): Vec3 {
  return [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!(length > 0)) {
    throw new Error("Cannot normalize a zero-length vector.");
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

