// Post-mesh facet -> B-rep face attribution (plan A-M3).
//
// gmsh's msh2 output groups boundary triangles per geometric surface (the
// parser's `surface_<tag>` sets). For each of those sets we sample facet
// centroids, find the nearest triangle of the STEP import's display
// tessellation (occt-import-js `brep_faces` ranges), require normal
// agreement, and majority-vote a display faceId for the WHOLE set. Every
// facet in the set is then stamped with `sourceFaceId`, which makes the
// mirrored `mapSelectionToSurfaceSet` byFace branch work unchanged.
//
// Deliberately whole-set voting, never per-facet: gmsh surface tags and
// occt-import-js face ordering are NOT assumed to match (both run their own
// OCCT sessions), so the geometric vote is the only bridge — and a per-facet
// stamp would let boundary-adjacent facets bleed across face borders.
import type { CoreVolumeMeshArtifact } from "./types";

/**
 * Display tessellation of a STEP import, flattened across all imported meshes,
 * in a worker-transferable layout (three typed arrays plus a faceId table).
 * `positions` are in the STEP file's model units (mm for our fixtures);
 * `unitScale` converts them to the solver's meters (0.001 for mm).
 */
export type StepAttributionTessellation = {
  positions: Float64Array;
  /** Triangle vertex indices into positions (3 per triangle). */
  indices: Uint32Array;
  /** Per-triangle index into faceIds. */
  triangleFaceIndex: Uint32Array;
  faceIds: string[];
  unitScale: number;
};

export type StepTessellatedMeshInput = {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** occt-import-js brep_faces triangle ranges (inclusive). */
  brepFaces: Array<{ first: number; last: number }>;
};

export type BuildStepAttributionOptions = {
  /** Prefix for generated faceIds; the k-th face across all meshes becomes `${prefix}${k}`. */
  faceIdPrefix?: string;
  /** Explicit faceIds (overrides prefix numbering); length must equal the total face count. */
  faceIds?: string[];
  /** Model-units -> meters scale. Defaults to 0.001 (mm). */
  unitScale?: number;
};

export type SurfaceSetAttribution = {
  surfaceSet: string;
  facetCount: number;
  sampledFacetCount: number;
  /** Winning display faceId, or null when no sample produced a confident vote. */
  faceId: string | null;
  /** Winning votes / sampled facets (0 when faceId is null). */
  agreement: number;
  votes: Array<{ faceId: string; votes: number }>;
};

export type FacetAttributionReport = {
  sets: SurfaceSetAttribution[];
  attributedSetCount: number;
  attributedFacetCount: number;
  totalSurfaceFacetCount: number;
};

export type AttributeFacetsOptions = {
  /** Minimum |dot(facetNormal, triangleNormal)| for a sample to vote. Default 0.6. */
  normalAgreementMin?: number;
  /** Max sampled facets per surface set. Default 48. */
  maxSamplesPerSet?: number;
  /** Max centroid -> tessellation distance for a vote, in meters. Default 5% of the tessellation bbox diagonal. */
  maxDistance?: number;
};

/**
 * Flatten occt-import-js meshes (positions/index/brep_faces) into the
 * transferable attribution tessellation. Face numbering is global across
 * meshes in input order, matching the app-side STEP face registry.
 */
export function buildStepAttributionTessellation(
  meshes: StepTessellatedMeshInput[],
  options: BuildStepAttributionOptions = {}
): StepAttributionTessellation {
  const unitScale = options.unitScale ?? 0.001;
  const prefix = options.faceIdPrefix ?? "step-face-";
  let vertexCount = 0;
  let triangleCount = 0;
  let faceCount = 0;
  for (const mesh of meshes) {
    vertexCount += Math.floor(mesh.positions.length / 3);
    triangleCount += Math.floor(mesh.indices.length / 3);
    faceCount += mesh.brepFaces.length;
  }
  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  const triangleFaceIndex = new Uint32Array(triangleCount);
  const faceIds = options.faceIds ? [...options.faceIds] : Array.from({ length: faceCount }, (_v, k) => `${prefix}${k}`);
  if (faceIds.length !== faceCount) {
    throw new Error(`STEP attribution faceIds length ${faceIds.length} does not match the tessellation face count ${faceCount}.`);
  }

  let vertexOffset = 0;
  let triangleOffset = 0;
  let faceOffset = 0;
  for (const mesh of meshes) {
    const meshVertexCount = Math.floor(mesh.positions.length / 3);
    for (let index = 0; index < meshVertexCount * 3; index += 1) {
      positions[vertexOffset * 3 + index] = Number(mesh.positions[index]);
    }
    const meshTriangleCount = Math.floor(mesh.indices.length / 3);
    for (let index = 0; index < meshTriangleCount * 3; index += 1) {
      indices[triangleOffset * 3 + index] = Number(mesh.indices[index]) + vertexOffset;
    }
    for (const [faceInMesh, range] of mesh.brepFaces.entries()) {
      for (let triangle = range.first; triangle <= range.last; triangle += 1) {
        triangleFaceIndex[triangleOffset + triangle] = faceOffset + faceInMesh;
      }
    }
    vertexOffset += meshVertexCount;
    triangleOffset += meshTriangleCount;
    faceOffset += mesh.brepFaces.length;
  }

  return { positions, indices, triangleFaceIndex, faceIds, unitScale };
}

/**
 * Stamp `sourceFaceId` on the artifact's boundary facets, one vote per
 * surface set (see module header). Mutates `artifact.surfaceFacets` in place
 * and returns a per-set report for diagnostics/tests.
 */
export function attributeFacetsToStepFaces(
  artifact: CoreVolumeMeshArtifact,
  tessellation: StepAttributionTessellation,
  options: AttributeFacetsOptions = {}
): FacetAttributionReport {
  const soup = triangleSoupInMeters(tessellation);
  const grid = buildTriangleGrid(soup);
  const normalAgreementMin = options.normalAgreementMin ?? 0.6;
  const maxSamplesPerSet = options.maxSamplesPerSet ?? 48;
  const maxDistance = options.maxDistance ?? soup.bboxDiagonal * 0.05;

  const facetById = new Map(artifact.surfaceFacets.map((facet) => [facet.id, facet]));
  const sets: SurfaceSetAttribution[] = [];
  let attributedFacetCount = 0;

  for (const surfaceSet of artifact.surfaceSets) {
    const facets = surfaceSet.facets
      .map((facetId) => facetById.get(facetId))
      .filter((facet): facet is NonNullable<typeof facet> => Boolean(facet));
    const sampled = sampleEvenly(facets, maxSamplesPerSet);
    const votes = new Map<string, number>();
    for (const facet of sampled) {
      const center = facet.center;
      const normal = facet.normal;
      if (!center || !normal) continue;
      const nearest = nearestTriangle(soup, grid, center, maxDistance);
      if (!nearest) continue;
      const agreement = Math.abs(
        normal[0] * soup.normals[nearest.triangle * 3]! +
        normal[1] * soup.normals[nearest.triangle * 3 + 1]! +
        normal[2] * soup.normals[nearest.triangle * 3 + 2]!
      );
      if (agreement < normalAgreementMin) continue;
      const faceId = tessellation.faceIds[tessellation.triangleFaceIndex[nearest.triangle]!];
      if (!faceId) continue;
      votes.set(faceId, (votes.get(faceId) ?? 0) + 1);
    }

    const ranked = [...votes.entries()].sort((left, right) => right[1] - left[1]);
    const winner = ranked[0];
    const faceId = winner ? winner[0] : null;
    if (faceId) {
      for (const facet of facets) {
        facet.sourceFaceId = faceId;
      }
      attributedFacetCount += facets.length;
    }
    sets.push({
      surfaceSet: surfaceSet.name,
      facetCount: facets.length,
      sampledFacetCount: sampled.length,
      faceId,
      agreement: winner && sampled.length > 0 ? winner[1] / sampled.length : 0,
      votes: ranked.map(([id, count]) => ({ faceId: id, votes: count }))
    });
  }

  return {
    sets,
    attributedSetCount: sets.filter((set) => set.faceId !== null).length,
    attributedFacetCount,
    totalSurfaceFacetCount: artifact.surfaceFacets.length
  };
}

type TriangleSoup = {
  /** Scaled to meters, 9 floats per triangle (deindexed). */
  vertices: Float64Array;
  /** Unit normals, 3 floats per triangle. */
  normals: Float64Array;
  triangleCount: number;
  min: [number, number, number];
  max: [number, number, number];
  bboxDiagonal: number;
};

type TriangleGrid = {
  cellSize: number;
  cells: Map<string, number[]>;
};

function triangleSoupInMeters(tessellation: StepAttributionTessellation): TriangleSoup {
  const scale = tessellation.unitScale;
  const triangleCount = Math.floor(tessellation.indices.length / 3);
  const vertices = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = tessellation.indices[triangle * 3 + corner]!;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = tessellation.positions[vertex * 3 + axis]! * scale;
        vertices[triangle * 9 + corner * 3 + axis] = value;
        if (value < min[axis]!) min[axis] = value;
        if (value > max[axis]!) max[axis] = value;
      }
    }
    const base = triangle * 9;
    const abx = vertices[base + 3]! - vertices[base]!;
    const aby = vertices[base + 4]! - vertices[base + 1]!;
    const abz = vertices[base + 5]! - vertices[base + 2]!;
    const acx = vertices[base + 6]! - vertices[base]!;
    const acy = vertices[base + 7]! - vertices[base + 1]!;
    const acz = vertices[base + 8]! - vertices[base + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    normals[triangle * 3] = length > 0 ? nx / length : 0;
    normals[triangle * 3 + 1] = length > 0 ? ny / length : 0;
    normals[triangle * 3 + 2] = length > 0 ? nz / length : 0;
  }
  const bboxDiagonal = triangleCount > 0 ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  return { vertices, normals, triangleCount, min, max, bboxDiagonal };
}

function buildTriangleGrid(soup: TriangleSoup): TriangleGrid {
  // ~24 cells along the longest axis keeps cells comfortably larger than a
  // typical display triangle while bounding candidate counts.
  const longest = Math.max(soup.max[0] - soup.min[0], soup.max[1] - soup.min[1], soup.max[2] - soup.min[2], 1e-9);
  const cellSize = longest / 24;
  const cells = new Map<string, number[]>();
  for (let triangle = 0; triangle < soup.triangleCount; triangle += 1) {
    const base = triangle * 9;
    let minI = Infinity, minJ = Infinity, minK = Infinity;
    let maxI = -Infinity, maxJ = -Infinity, maxK = -Infinity;
    for (let corner = 0; corner < 3; corner += 1) {
      const i = Math.floor((soup.vertices[base + corner * 3]! - soup.min[0]) / cellSize);
      const j = Math.floor((soup.vertices[base + corner * 3 + 1]! - soup.min[1]) / cellSize);
      const k = Math.floor((soup.vertices[base + corner * 3 + 2]! - soup.min[2]) / cellSize);
      minI = Math.min(minI, i); maxI = Math.max(maxI, i);
      minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j);
      minK = Math.min(minK, k); maxK = Math.max(maxK, k);
    }
    for (let i = minI; i <= maxI; i += 1) {
      for (let j = minJ; j <= maxJ; j += 1) {
        for (let k = minK; k <= maxK; k += 1) {
          const key = `${i},${j},${k}`;
          const bucket = cells.get(key);
          if (bucket) bucket.push(triangle);
          else cells.set(key, [triangle]);
        }
      }
    }
  }
  return { cellSize, cells };
}

function nearestTriangle(
  soup: TriangleSoup,
  grid: TriangleGrid,
  point: [number, number, number],
  maxDistance: number
): { triangle: number; distance: number } | null {
  if (soup.triangleCount === 0) return null;
  const baseI = Math.floor((point[0] - soup.min[0]) / grid.cellSize);
  const baseJ = Math.floor((point[1] - soup.min[1]) / grid.cellSize);
  const baseK = Math.floor((point[2] - soup.min[2]) / grid.cellSize);
  const maxRing = Math.max(2, Math.ceil(maxDistance / grid.cellSize) + 1);

  let bestTriangle = -1;
  let bestDistance = Infinity;
  const seen = new Set<number>();
  for (let ring = 0; ring <= maxRing; ring += 1) {
    // Once a hit exists, finish the next ring (a nearer triangle can live one
    // ring further out than the ring that produced the first hit) and stop.
    for (let i = baseI - ring; i <= baseI + ring; i += 1) {
      for (let j = baseJ - ring; j <= baseJ + ring; j += 1) {
        for (let k = baseK - ring; k <= baseK + ring; k += 1) {
          if (Math.max(Math.abs(i - baseI), Math.abs(j - baseJ), Math.abs(k - baseK)) !== ring) continue;
          const bucket = grid.cells.get(`${i},${j},${k}`);
          if (!bucket) continue;
          for (const triangle of bucket) {
            if (seen.has(triangle)) continue;
            seen.add(triangle);
            const distance = pointTriangleDistance(soup.vertices, triangle, point);
            if (distance < bestDistance) {
              bestDistance = distance;
              bestTriangle = triangle;
            }
          }
        }
      }
    }
    if (bestTriangle >= 0 && ring >= 1) break;
  }
  return bestTriangle >= 0 && bestDistance <= maxDistance ? { triangle: bestTriangle, distance: bestDistance } : null;
}

/** Exact point-to-triangle distance (Ericson, Real-Time Collision Detection). */
function pointTriangleDistance(vertices: Float64Array, triangle: number, p: [number, number, number]): number {
  const base = triangle * 9;
  const ax = vertices[base]!, ay = vertices[base + 1]!, az = vertices[base + 2]!;
  const bx = vertices[base + 3]!, by = vertices[base + 4]!, bz = vertices[base + 5]!;
  const cx = vertices[base + 6]!, cy = vertices[base + 7]!, cz = vertices[base + 8]!;

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);

  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(apx - v * abx, apy - v * aby, apz - v * abz);
  }

  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(apx - w * acx, apy - w * acy, apz - w * acz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(bpx - w * (cx - bx), bpy - w * (cy - by), bpz - w * (cz - bz));
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return Math.hypot(apx - (v * abx + w * acx), apy - (v * aby + w * acy), apz - (v * abz + w * acz));
}

function sampleEvenly<T>(items: T[], maxSamples: number): T[] {
  if (items.length <= maxSamples) return items;
  const stride = items.length / maxSamples;
  const sampled: T[] = [];
  for (let index = 0; index < maxSamples; index += 1) {
    sampled.push(items[Math.floor(index * stride)]!);
  }
  return sampled;
}
