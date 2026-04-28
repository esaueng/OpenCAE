import * as THREE from "three";
import { closestPointOnSegment, distanceVec3, normalizeVec3, vec3FromVector, vectorFromVec3 } from "./math";
import { DEFAULT_SNAP_CONFIG, type CursorRay, type HoveredEntity, type SnapQueryContext, type Vec3 } from "./types";

interface TriangleHit {
  hitPoint: Vec3;
  normal: Vec3;
  vertices: [Vec3, Vec3, Vec3];
  object: THREE.Object3D;
}

export function queryHoveredEntity(cursorRay: CursorRay, context: SnapQueryContext): HoveredEntity | null {
  const raycaster = new THREE.Raycaster(vectorFromVec3(cursorRay.origin), vectorFromVec3(cursorRay.direction).normalize());
  const hit = raycaster.intersectObjects(context.objects, true)[0];
  if (!hit) return null;

  const triangleHit = triangleHitFromIntersection(hit);
  const hitPoint = vec3FromVector(hit.point);
  const thresholdWorld = context.thresholdWorld ?? DEFAULT_SNAP_CONFIG.thresholdWorld;
  const faceId = context.ownerFace?.id ?? faceIdForHit(triangleHit);
  const normal = context.ownerFace?.normal ?? triangleHit?.normal ?? [0, 0, 1];

  if (triangleHit) {
    const nearestVertex = triangleHit.vertices
      .map((vertex) => ({ vertex, distance: distanceVec3(hitPoint, vertex) }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearestVertex && nearestVertex.distance <= thresholdWorld) {
      return {
        type: "vertex",
        id: `${faceId}:vertex:${nearestVertex.vertex.map((value) => value.toFixed(3)).join(",")}`,
        position: nearestVertex.vertex,
        normal,
        faceId
      };
    }

    const edges = triangleEdges(triangleHit.vertices)
      .map((endpoints) => {
        const point = closestPointOnSegment(hitPoint, endpoints[0], endpoints[1]);
        return { endpoints, point, distance: distanceVec3(hitPoint, point) };
      })
      .sort((left, right) => left.distance - right.distance);
    const nearestEdge = edges[0];
    if (nearestEdge && nearestEdge.distance <= thresholdWorld) {
      return {
        type: "edge",
        id: `${faceId}:edge:${nearestEdge.endpoints.flat().map((value) => value.toFixed(3)).join(",")}`,
        position: nearestEdge.point,
        normal,
        faceId,
        endpoints: nearestEdge.endpoints
      };
    }
  }

  return {
    type: "face",
    id: faceId,
    position: context.ownerFace?.position ?? hitPoint,
    normal: normalizeVec3(normal),
    faceId
  };
}

function triangleHitFromIntersection(hit: THREE.Intersection): TriangleHit | null {
  if (!hit.face || !(hit.object instanceof THREE.Mesh) || !(hit.object.geometry instanceof THREE.BufferGeometry)) return null;
  const positions = hit.object.geometry.getAttribute("position");
  if (!positions) return null;
  const matrix = hit.object.matrixWorld;
  const vertices = [hit.face.a, hit.face.b, hit.face.c].map((index) => {
    const vertex = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(matrix);
    return vec3FromVector(vertex);
  }) as [Vec3, Vec3, Vec3];
  const normal = hit.face.normal.clone().transformDirection(matrix).normalize();
  return {
    hitPoint: vec3FromVector(hit.point),
    normal: vec3FromVector(normal),
    vertices,
    object: hit.object
  };
}

function triangleEdges(vertices: [Vec3, Vec3, Vec3]): Array<[Vec3, Vec3]> {
  const edges: Array<[Vec3, Vec3]> = [
    [vertices[0], vertices[1]],
    [vertices[1], vertices[2]],
    [vertices[2], vertices[0]]
  ];
  const lengths = edges.map(([start, end]) => distanceVec3(start, end));
  const longest = Math.max(...lengths);
  const shortest = Math.min(...lengths);
  if (longest > shortest * 1.1) {
    return edges.filter((_, index) => (lengths[index] ?? Number.POSITIVE_INFINITY) < longest);
  }
  return edges;
}

function faceIdForHit(hit: TriangleHit | null) {
  if (!hit) return "face-unknown";
  const normal = hit.normal.map((value) => value.toFixed(2)).join(",");
  const point = hit.hitPoint.map((value) => value.toFixed(2)).join(",");
  return String(hit.object.userData.opencaeFaceId ?? `face-hit:${normal}:${point}`);
}
