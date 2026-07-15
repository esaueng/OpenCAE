import type { NormalizedOpenCAEModel } from "@opencae/core";
import { addSparseEntry, type SparseMatrixBuilder } from "./sparse";
import type { CpuSolverError } from "./types";

export type ConnectionAssemblyDiagnostics = {
  connectionCount: number;
  equationCount: number;
  unmatchedSourceNodes: number;
  formulation: "node-to-surface-penalty-mpc";
  kinematics: "small_sliding";
};

type Triangle = {
  nodes: number[];
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
  centroid: Vec3;
};
type Vec3 = [number, number, number];

export function assembleMeshConnectionStiffness(
  builder: SparseMatrixBuilder,
  model: NormalizedOpenCAEModel
): { ok: true; diagnostics: ConnectionAssemblyDiagnostics } | { ok: false; error: CpuSolverError } {
  const connections = model.meshConnections.filter((connection) => connection.type === "tie" || connection.type === "contact");
  const diagnostics: ConnectionAssemblyDiagnostics = {
    connectionCount: connections.length,
    equationCount: 0,
    unmatchedSourceNodes: 0,
    formulation: "node-to-surface-penalty-mpc",
    kinematics: "small_sliding"
  };
  if (!connections.length) return { ok: true, diagnostics };
  const facets = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
  const surfaceSets = new Map(model.surfaceSets.map((surface) => [surface.name, surface]));
  const characteristicLength = meshCharacteristicLength(model);
  const maxYoung = Math.max(...model.materials.map((material) => material.youngModulus));

  for (const connection of connections) {
    const sourceSet = surfaceSets.get(connection.source);
    const targetSet = surfaceSets.get(connection.target);
    if (!sourceSet || !targetSet) return failure("missing-connection-surface", `Connection ${connection.source} -> ${connection.target} references a missing surface set.`);
    const sourceNodes = new Set<number>();
    for (const facetId of sourceSet.facets) for (const node of facets.get(facetId)?.nodes ?? []) sourceNodes.add(node);
    const targetTriangles: Triangle[] = [];
    for (const facetId of targetSet.facets) {
      const facet = facets.get(facetId);
      if (!facet || facet.nodes.length < 3) continue;
      const a = point(model, facet.nodes[0]), b = point(model, facet.nodes[1]), c = point(model, facet.nodes[2]);
      const normal = normalized(cross(subtract(b, a), subtract(c, a)));
      if (norm(normal) <= Number.EPSILON) continue;
      targetTriangles.push({ nodes: Array.from(facet.nodes), a, b, c, normal, centroid: scale(add(add(a, b), c), 1 / 3) });
    }
    if (!sourceNodes.size || !targetTriangles.length) return failure("empty-connection-surface", `Connection ${connection.source} -> ${connection.target} has an empty source or target surface.`);
    const tolerance = connection.searchTolerance ?? Math.max(characteristicLength * 0.2, Number.EPSILON);
    const spatial = triangleSpatialIndex(targetTriangles, Math.max(characteristicLength * 2, tolerance * 2));
    const penalty = maxYoung * characteristicLength * (connection.penaltyScale ?? (connection.type === "tie" ? 100 : 20));
    let matched = 0;
    let unmatched = 0;
    for (const sourceNode of sourceNodes) {
      const sourcePoint = point(model, sourceNode);
      const projection = nearestProjection(sourcePoint, targetTriangles, spatial, tolerance);
      if (!projection) {
        diagnostics.unmatchedSourceNodes += 1;
        unmatched += 1;
        continue;
      }
      matched += 1;
      const surfaceWeights = targetShapeWeights(projection.triangle.nodes.length, projection.barycentric);
      const scalarTerms = [{ node: sourceNode, coefficient: 1 }];
      for (let local = 0; local < surfaceWeights.length; local += 1) {
        if (Math.abs(surfaceWeights[local]) <= Number.EPSILON) continue;
        scalarTerms.push({ node: projection.triangle.nodes[local], coefficient: -surfaceWeights[local] });
      }
      if (connection.type === "tie") {
        for (let axis = 0; axis < 3; axis += 1) {
          addPenaltyEquation(builder, scalarTerms.map((term) => ({ dof: term.node * 3 + axis, coefficient: term.coefficient })), penalty);
          diagnostics.equationCount += 1;
        }
      } else {
        const normalTerms = scalarTerms.flatMap((term) => projection.triangle.normal.map((component, axis) => ({
          dof: term.node * 3 + axis,
          coefficient: term.coefficient * component
        }))).filter((term) => Math.abs(term.coefficient) > Number.EPSILON);
        addPenaltyEquation(builder, normalTerms, penalty);
        diagnostics.equationCount += 1;
      }
    }
    if (matched === 0 || (connection.type === "tie" && unmatched > 0)) {
      return failure("connection-search-failed", `Connection ${connection.source} -> ${connection.target} could not map every source node within ${tolerance} solver units.`);
    }
  }
  return { ok: true, diagnostics };
}

function addPenaltyEquation(builder: SparseMatrixBuilder, terms: Array<{ dof: number; coefficient: number }>, penalty: number): void {
  for (const row of terms) for (const col of terms) addSparseEntry(builder, row.dof, col.dof, penalty * row.coefficient * col.coefficient);
}

function targetShapeWeights(nodeCount: number, barycentric: Vec3): number[] {
  const [l0, l1, l2] = barycentric;
  if (nodeCount < 6) return [l0, l1, l2];
  return [
    l0 * (2 * l0 - 1),
    l1 * (2 * l1 - 1),
    l2 * (2 * l2 - 1),
    4 * l0 * l1,
    4 * l1 * l2,
    4 * l2 * l0
  ];
}

type SpatialIndex = { cellSize: number; cells: Map<string, number[]> };

function triangleSpatialIndex(triangles: Triangle[], cellSize: number): SpatialIndex {
  const cells = new Map<string, number[]>();
  triangles.forEach((triangle, index) => {
    const key = cellKey(triangle.centroid, cellSize);
    const entries = cells.get(key) ?? [];
    entries.push(index);
    cells.set(key, entries);
  });
  return { cellSize, cells };
}

function nearestProjection(pointValue: Vec3, triangles: Triangle[], spatial: SpatialIndex, tolerance: number): { triangle: Triangle; barycentric: Vec3 } | undefined {
  const [ix, iy, iz] = cellCoordinates(pointValue, spatial.cellSize);
  const candidates = new Set<number>();
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
    for (const index of spatial.cells.get(`${ix + dx},${iy + dy},${iz + dz}`) ?? []) candidates.add(index);
  }
  const search = candidates.size ? [...candidates].map((index) => triangles[index]) : triangles;
  let best: { triangle: Triangle; barycentric: Vec3; distance: number } | undefined;
  for (const triangle of search) {
    const projected = closestPointBarycentric(pointValue, triangle.a, triangle.b, triangle.c);
    const surfacePoint = add(add(scale(triangle.a, projected[0]), scale(triangle.b, projected[1])), scale(triangle.c, projected[2]));
    const distance = norm(subtract(pointValue, surfacePoint));
    if (!best || distance < best.distance) best = { triangle, barycentric: projected, distance };
  }
  return best && best.distance <= tolerance ? best : undefined;
}

/** Closest point barycentrics from Real-Time Collision Detection, Ericson. */
function closestPointBarycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = subtract(b, a), ac = subtract(c, a), ap = subtract(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = subtract(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = subtract(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  return [1 - v - w, v, w];
}

function meshCharacteristicLength(model: NormalizedOpenCAEModel): number {
  const coordinates = model.nodes.coordinates;
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let node = 0; node < model.counts.nodes; node += 1) for (let axis = 0; axis < 3; axis += 1) {
    const value = coordinates[node * 3 + axis];
    min[axis] = Math.min(min[axis], value);
    max[axis] = Math.max(max[axis], value);
  }
  return Math.max(norm(subtract(max, min)) / Math.cbrt(Math.max(model.counts.elements, 1)), 1e-12);
}

function point(model: NormalizedOpenCAEModel, node: number): Vec3 {
  return [model.nodes.coordinates[node * 3], model.nodes.coordinates[node * 3 + 1], model.nodes.coordinates[node * 3 + 2]];
}
function cellCoordinates(value: Vec3, size: number): Vec3 { return [Math.floor(value[0] / size), Math.floor(value[1] / size), Math.floor(value[2] / size)]; }
function cellKey(value: Vec3, size: number): string { return cellCoordinates(value, size).join(","); }
function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3, value: number): Vec3 { return [a[0] * value, a[1] * value, a[2] * value]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
function normalized(a: Vec3): Vec3 { const length = Math.max(norm(a), Number.EPSILON); return scale(a, 1 / length); }
function failure(code: string, message: string): { ok: false; error: CpuSolverError } { return { ok: false, error: { code, message } }; }
