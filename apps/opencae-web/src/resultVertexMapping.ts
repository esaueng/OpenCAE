export type VertexSampleWeight = {
  sampleIndex: number;
  weight: number;
};

export type VertexResultMapping = {
  vertexCount: number;
  weightsByVertex: VertexSampleWeight[][];
};

type ResultSamplePoint = {
  point: [number, number, number];
  value?: number;
};

type CreateVertexResultMappingInput = {
  basePositions: Float32Array;
  samples: readonly ResultSamplePoint[];
  maxNeighbors?: number;
};

type SpatialGrid = {
  boundsMin: [number, number, number];
  inverseCellSize: number;
  cells: Map<string, number[]>;
};

let vertexResultMappingBuildCount = 0;

export function createVertexResultMapping({
  basePositions,
  samples,
  maxNeighbors = 8
}: CreateVertexResultMappingInput): VertexResultMapping {
  vertexResultMappingBuildCount += 1;
  const vertexCount = Math.floor(basePositions.length / 3);
  const neighborCount = Math.max(1, Math.floor(maxNeighbors));
  const weightsByVertex: VertexSampleWeight[][] = Array.from({ length: vertexCount });
  const grid = samples.length > 512 ? createSampleSpatialGrid(samples) : null;

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const offset = vertexIndex * 3;
    weightsByVertex[vertexIndex] = nearestSampleWeights(
      basePositions[offset] ?? 0,
      basePositions[offset + 1] ?? 0,
      basePositions[offset + 2] ?? 0,
      samples,
      neighborCount,
      grid
    );
  }

  return { vertexCount, weightsByVertex };
}

export function resetVertexResultMappingStatsForTests() {
  vertexResultMappingBuildCount = 0;
}

export function vertexResultMappingBuildCountForTests() {
  return vertexResultMappingBuildCount;
}

function nearestSampleWeights(
  x: number,
  y: number,
  z: number,
  samples: readonly ResultSamplePoint[],
  maxNeighbors: number,
  grid: SpatialGrid | null
): VertexSampleWeight[] {
  if (!samples.length) return [];
  const candidates = grid ? nearbyGridSampleIndexes(x, y, z, samples, grid, maxNeighbors) : null;
  const nearest: { sampleIndex: number; distanceSq: number }[] = [];
  const scanCount = candidates?.length ?? samples.length;
  for (let scanIndex = 0; scanIndex < scanCount; scanIndex += 1) {
    const sampleIndex = candidates ? candidates[scanIndex]! : scanIndex;
    const sample = samples[sampleIndex];
    if (!sample) continue;
    const distanceSq = squaredDistanceToPoint(x, y, z, sample.point);
    if (!Number.isFinite(distanceSq)) continue;
    if (distanceSq <= 1e-18) return [{ sampleIndex, weight: 1 }];
    insertNearestSample(nearest, { sampleIndex, distanceSq }, maxNeighbors);
  }
  if (!nearest.length && candidates) {
    return nearestSampleWeights(x, y, z, samples, maxNeighbors, null);
  }
  let totalWeight = 0;
  const weights = nearest.map((entry) => {
    const weight = 1 / Math.max(entry.distanceSq, 1e-18);
    totalWeight += weight;
    return { sampleIndex: entry.sampleIndex, weight };
  });
  if (totalWeight <= 0) return [];
  for (const entry of weights) entry.weight /= totalWeight;
  return weights;
}

function insertNearestSample(
  nearest: { sampleIndex: number; distanceSq: number }[],
  entry: { sampleIndex: number; distanceSq: number },
  maxNeighbors: number
) {
  let insertionIndex = nearest.length;
  while (insertionIndex > 0 && entry.distanceSq < nearest[insertionIndex - 1]!.distanceSq) {
    insertionIndex -= 1;
  }
  if (insertionIndex >= maxNeighbors) return;
  nearest.splice(insertionIndex, 0, entry);
  if (nearest.length > maxNeighbors) nearest.pop();
}

function createSampleSpatialGrid(samples: readonly ResultSamplePoint[]): SpatialGrid | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    const [x, y, z] = sample.point;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const maxExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!Number.isFinite(maxExtent) || maxExtent <= 1e-12) return null;
  const cellsPerAxis = Math.max(4, Math.ceil(Math.cbrt(samples.length)));
  const inverseCellSize = cellsPerAxis / maxExtent;
  const grid: SpatialGrid = { boundsMin: [minX, minY, minZ], inverseCellSize, cells: new Map() };
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]!;
    const key = cellKeyForPoint(sample.point[0], sample.point[1], sample.point[2], grid);
    const bucket = grid.cells.get(key);
    if (bucket) {
      bucket.push(sampleIndex);
    } else {
      grid.cells.set(key, [sampleIndex]);
    }
  }
  return grid;
}

function nearbyGridSampleIndexes(
  x: number,
  y: number,
  z: number,
  samples: readonly ResultSamplePoint[],
  grid: SpatialGrid,
  maxNeighbors: number
): number[] {
  const [cx, cy, cz] = cellCoordinatesForPoint(x, y, z, grid);
  const candidates: number[] = [];
  const targetCount = Math.max(maxNeighbors * 3, maxNeighbors);
  for (let radius = 0; radius <= 4 && candidates.length < targetCount; radius += 1) {
    for (let ix = cx - radius; ix <= cx + radius; ix += 1) {
      for (let iy = cy - radius; iy <= cy + radius; iy += 1) {
        for (let iz = cz - radius; iz <= cz + radius; iz += 1) {
          if (radius > 0 && Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz)) !== radius) continue;
          const bucket = grid.cells.get(`${ix}:${iy}:${iz}`);
          if (bucket) candidates.push(...bucket);
        }
      }
    }
  }
  return candidates.length ? candidates : samples.map((_sample, index) => index);
}

function cellKeyForPoint(x: number, y: number, z: number, grid: SpatialGrid) {
  const [cx, cy, cz] = cellCoordinatesForPoint(x, y, z, grid);
  return `${cx}:${cy}:${cz}`;
}

function cellCoordinatesForPoint(x: number, y: number, z: number, grid: SpatialGrid): [number, number, number] {
  return [
    Math.floor((x - grid.boundsMin[0]) * grid.inverseCellSize),
    Math.floor((y - grid.boundsMin[1]) * grid.inverseCellSize),
    Math.floor((z - grid.boundsMin[2]) * grid.inverseCellSize)
  ];
}

function squaredDistanceToPoint(x: number, y: number, z: number, point: [number, number, number]) {
  const dx = x - point[0];
  const dy = y - point[1];
  const dz = z - point[2];
  return dx * dx + dy * dy + dz * dz;
}
