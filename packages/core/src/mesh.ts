import type { ElementBlockJson, ElementType, OpenCAEModelJson, SurfaceFacetJson, SurfaceSetJson } from "./model-json";

export type MeshUtilityModel = Pick<OpenCAEModelJson, "nodes" | "elementBlocks"> & {
  surfaceFacets?: SurfaceFacetJson[];
};

export type ElementFace = {
  elementFace: number;
  nodes: number[];
};

export type MeshConnectedComponents = {
  componentCount: number;
  components: number[][];
};

export type MeshQualitySummary = {
  elementCount: number;
  nodeCount: number;
  surfaceFacetCount: number;
  connectedComponentCount: number;
  minTetVolume: number;
  maxTetVolume: number;
  invertedElementCount: number;
  orphanNodeCount: number;
};

const TET_CORNER_FACES = [
  [1, 2, 3],
  [0, 3, 2],
  [0, 1, 3],
  [0, 2, 1]
] as const;

const TET10_FACES = [
  [1, 2, 3, 5, 9, 8],
  [0, 3, 2, 7, 9, 6],
  [0, 1, 3, 4, 8, 7],
  [0, 2, 1, 6, 5, 4]
] as const;

export function elementNodeCount(type: ElementType): number {
  return type === "Tet4" ? 4 : 10;
}

export function tet4Volume(coordinates: ArrayLike<number>, nodeIds: ArrayLike<number>): number {
  const ax = coordinateAt(coordinates, nodeIds[0], 0);
  const ay = coordinateAt(coordinates, nodeIds[0], 1);
  const az = coordinateAt(coordinates, nodeIds[0], 2);
  const bx = coordinateAt(coordinates, nodeIds[1], 0) - ax;
  const by = coordinateAt(coordinates, nodeIds[1], 1) - ay;
  const bz = coordinateAt(coordinates, nodeIds[1], 2) - az;
  const cx = coordinateAt(coordinates, nodeIds[2], 0) - ax;
  const cy = coordinateAt(coordinates, nodeIds[2], 1) - ay;
  const cz = coordinateAt(coordinates, nodeIds[2], 2) - az;
  const dx = coordinateAt(coordinates, nodeIds[3], 0) - ax;
  const dy = coordinateAt(coordinates, nodeIds[3], 1) - ay;
  const dz = coordinateAt(coordinates, nodeIds[3], 2) - az;
  return (bx * (cy * dz - cz * dy) - cx * (by * dz - bz * dy) + dx * (by * cz - bz * cy)) / 6;
}

export function elementFaces(type: ElementType, connectivity: ArrayLike<number>): ElementFace[] {
  const faces = type === "Tet10" ? TET10_FACES : type === "Tet4" ? TET_CORNER_FACES : [];
  return faces.map((face, elementFace) => ({
    elementFace,
    nodes: face.map((localNode) => connectivity[localNode])
  }));
}

export function extractBoundarySurfaceFacets(model: MeshUtilityModel): SurfaceFacetJson[] {
  const faces = new Map<string, SurfaceFacetJson & { count: number }>();
  let elementIndex = 0;

  for (const block of model.elementBlocks) {
    forEachElement(block, (connectivity) => {
      for (const face of elementFaces(block.type, connectivity)) {
        const key = faceKey(face.nodes);
        const existing = faces.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          const geometry = triangleGeometry(model.nodes.coordinates, face.nodes);
          faces.set(key, {
            id: faces.size,
            element: elementIndex,
            elementFace: face.elementFace,
            nodes: [...face.nodes],
            area: geometry.area,
            normal: geometry.normal,
            center: geometry.center,
            count: 1
          });
        }
      }
      elementIndex += 1;
    });
  }

  return [...faces.values()]
    .filter((facet) => facet.count === 1)
    .map(({ count, ...facet }, id) => ({ ...facet, id }));
}

export function nodeSetFromSurfaceSet(surfaceSet: SurfaceSetJson, surfaceFacets: SurfaceFacetJson[]): number[] {
  const facetById = facetMap(surfaceFacets);
  const nodes = new Set<number>();
  for (const facetId of surfaceSet.facets) {
    for (const node of facetById.get(facetId)?.nodes ?? []) {
      nodes.add(node);
    }
  }
  return [...nodes].sort((a, b) => a - b);
}

export function surfaceArea(surfaceSet: SurfaceSetJson, surfaceFacets: SurfaceFacetJson[]): number {
  const facetById = facetMap(surfaceFacets);
  return surfaceSet.facets.reduce((area, facetId) => area + (facetById.get(facetId)?.area ?? 0), 0);
}

export function surfaceNormalAverage(surfaceSet: SurfaceSetJson, surfaceFacets: SurfaceFacetJson[]): [number, number, number] {
  const facetById = facetMap(surfaceFacets);
  let x = 0;
  let y = 0;
  let z = 0;

  for (const facetId of surfaceSet.facets) {
    const facet = facetById.get(facetId);
    if (!facet?.normal) continue;
    const weight = facet.area ?? 1;
    x += facet.normal[0] * weight;
    y += facet.normal[1] * weight;
    z += facet.normal[2] * weight;
  }

  const length = Math.hypot(x, y, z);
  return length > 0 ? [x / length, y / length, z / length] : [0, 0, 0];
}

export function connectedComponents(model: Pick<OpenCAEModelJson, "elementBlocks">): MeshConnectedComponents {
  const elementNodes = collectElementNodes(model.elementBlocks);
  const components: number[][] = [];
  const componentByElement = new Int32Array(elementNodes.length);
  componentByElement.fill(-1);
  const elementsByNode = new Map<number, number[]>();

  elementNodes.forEach((nodes, element) => {
    for (const node of nodes) {
      const elements = elementsByNode.get(node);
      if (elements) elements.push(element);
      else elementsByNode.set(node, [element]);
    }
  });

  for (let start = 0; start < elementNodes.length; start += 1) {
    if (componentByElement[start] !== -1) continue;
    const componentIndex = components.length;
    const component: number[] = [];
    const stack = [start];
    componentByElement[start] = componentIndex;

    while (stack.length > 0) {
      const element = stack.pop() ?? 0;
      component.push(element);
      for (const node of elementNodes[element]) {
        for (const neighbor of elementsByNode.get(node) ?? []) {
          if (componentByElement[neighbor] === -1) {
            componentByElement[neighbor] = componentIndex;
            stack.push(neighbor);
          }
        }
      }
    }
    components.push(component.sort((a, b) => a - b));
  }

  return {
    componentCount: components.length,
    components
  };
}

export function orphanNodes(model: MeshUtilityModel): number[] {
  const used = new Set<number>();
  for (const block of model.elementBlocks) {
    for (const node of block.connectivity) {
      used.add(node);
    }
  }

  const nodeCount = model.nodes.coordinates.length / 3;
  const orphans: number[] = [];
  for (let node = 0; node < nodeCount; node += 1) {
    if (!used.has(node)) orphans.push(node);
  }
  return orphans;
}

export function meshQualitySummary(model: MeshUtilityModel): MeshQualitySummary {
  const volumes: number[] = [];
  let elementCount = 0;
  let invertedElementCount = 0;

  for (const block of model.elementBlocks) {
    forEachElement(block, (connectivity) => {
      elementCount += 1;
      if (block.type !== "Tet4") return;
      const volume = tet4Volume(model.nodes.coordinates, connectivity);
      volumes.push(volume);
      if (!Number.isFinite(volume) || volume <= 0) {
        invertedElementCount += 1;
      }
    });
  }

  const surfaceFacets = model.surfaceFacets ?? extractBoundarySurfaceFacets(model);
  return {
    elementCount,
    nodeCount: model.nodes.coordinates.length / 3,
    surfaceFacetCount: surfaceFacets.length,
    connectedComponentCount: connectedComponents(model).componentCount,
    minTetVolume: volumes.length > 0 ? Math.min(...volumes) : 0,
    maxTetVolume: volumes.length > 0 ? Math.max(...volumes) : 0,
    invertedElementCount,
    orphanNodeCount: orphanNodes(model).length
  };
}

function forEachElement(
  block: Pick<ElementBlockJson, "type" | "connectivity">,
  callback: (connectivity: number[]) => void
): void {
  const nodesPerElement = elementNodeCount(block.type);
  for (let offset = 0; offset + nodesPerElement <= block.connectivity.length; offset += nodesPerElement) {
    callback(block.connectivity.slice(offset, offset + nodesPerElement));
  }
}

function collectElementNodes(blocks: Pick<ElementBlockJson, "type" | "connectivity">[]): number[][] {
  const elements: number[][] = [];
  for (const block of blocks) {
    forEachElement(block, (connectivity) => {
      elements.push(connectivity);
    });
  }
  return elements;
}

function facetMap(surfaceFacets: SurfaceFacetJson[]): Map<number, SurfaceFacetJson> {
  return new Map(surfaceFacets.map((facet) => [facet.id, facet]));
}

function faceKey(nodes: number[]): string {
  return [...nodes].sort((a, b) => a - b).join(":");
}

function triangleGeometry(
  coordinates: ArrayLike<number>,
  nodes: number[]
): { area: number; normal: [number, number, number]; center: [number, number, number] } {
  const ax = coordinateAt(coordinates, nodes[0], 0);
  const ay = coordinateAt(coordinates, nodes[0], 1);
  const az = coordinateAt(coordinates, nodes[0], 2);
  const bx = coordinateAt(coordinates, nodes[1], 0);
  const by = coordinateAt(coordinates, nodes[1], 1);
  const bz = coordinateAt(coordinates, nodes[1], 2);
  const cx = coordinateAt(coordinates, nodes[2], 0);
  const cy = coordinateAt(coordinates, nodes[2], 1);
  const cz = coordinateAt(coordinates, nodes[2], 2);
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return {
    area: length / 2,
    normal: length > 0 ? [nx / length, ny / length, nz / length] : [0, 0, 0],
    center: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3]
  };
}

function coordinateAt(coordinates: ArrayLike<number>, node: number, component: number): number {
  return coordinates[node * 3 + component] ?? 0;
}
