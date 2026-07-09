import type {
  ElementBlockJson,
  ElementType,
  SurfaceFacetJson,
  SurfaceSetJson,
  SolverSurfaceMeshJson
} from "./model-json";

export const COMPLEX_GEOMETRY_REQUIRES_VOLUME_MESH =
  "OpenCAE Core requires an actual volume mesh for complex geometry. Use Cloud FEA or generate a Core mesh.";

export type MeshLike = {
  nodes?: { coordinates?: number[] | Float64Array };
  coordinates?: number[] | Float64Array;
  elementBlocks: Pick<ElementBlockJson, "name" | "type" | "material" | "connectivity">[];
  surfaceFacets?: SurfaceFacetJson[];
};

export type ConnectedComponentsResult = {
  componentCount: number;
  elementComponentIds: Int32Array;
};

export type BuildSurfaceFacetsInput = {
  coordinates: number[] | Float64Array;
  elementBlocks: Pick<ElementBlockJson, "name" | "type" | "material" | "connectivity">[];
  sourceFaces?: {
    sourceFaceId?: string;
    sourceSelectionRef?: string;
    element: number;
    elementFace: number;
  }[];
};

export type SelectionMappingOptions = {
  minConfidence?: number;
};

export type SolverSurfaceMeshInput = {
  coordinates: number[] | Float64Array;
  surfaceFacets: SurfaceFacetJson[];
  coordinateSpace?: string;
  meshRef?: string;
};

const TET4_FACES = [
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

export function nodesPerElement(type: ElementType): number {
  return type === "Tet4" ? 4 : 10;
}

export function connectedComponents(mesh: MeshLike): ConnectedComponentsResult {
  const elementNodes = collectElementNodes(mesh.elementBlocks);
  const componentIds = new Int32Array(elementNodes.length);
  componentIds.fill(-1);
  let componentCount = 0;

  const elementsByNode = new Map<number, number[]>();
  elementNodes.forEach((nodes, elementIndex) => {
    for (const node of nodes) {
      const elements = elementsByNode.get(node);
      if (elements) elements.push(elementIndex);
      else elementsByNode.set(node, [elementIndex]);
    }
  });

  for (let start = 0; start < elementNodes.length; start += 1) {
    if (componentIds[start] !== -1) continue;
    const stack = [start];
    componentIds[start] = componentCount;
    while (stack.length > 0) {
      const element = stack.pop() ?? 0;
      for (const node of elementNodes[element]) {
        for (const neighbor of elementsByNode.get(node) ?? []) {
          if (componentIds[neighbor] === -1) {
            componentIds[neighbor] = componentCount;
            stack.push(neighbor);
          }
        }
      }
    }
    componentCount += 1;
  }

  return {
    componentCount,
    elementComponentIds: componentIds
  };
}

export function buildSurfaceFacets(input: BuildSurfaceFacetsInput): SurfaceFacetJson[] {
  const coordinates = input.coordinates;
  const sourceByElementFace = new Map<string, { sourceFaceId?: string; sourceSelectionRef?: string }>();
  for (const source of input.sourceFaces ?? []) {
    sourceByElementFace.set(`${source.element}:${source.elementFace}`, {
      sourceFaceId: source.sourceFaceId,
      sourceSelectionRef: source.sourceSelectionRef
    });
  }

  const faces = new Map<string, SurfaceFacetJson & { _count: number }>();
  let globalElement = 0;
  for (const block of input.elementBlocks) {
    const nodesPer = nodesPerElement(block.type);
    const faceTable = block.type === "Tet10" ? TET10_FACES : TET4_FACES;
    for (let offset = 0; offset + nodesPer <= block.connectivity.length; offset += nodesPer) {
      for (let faceIndex = 0; faceIndex < faceTable.length; faceIndex += 1) {
        const face = faceTable[faceIndex];
        const nodes = face.map((localNode) => block.connectivity[offset + localNode]);
        const key = [...nodes].sort((a, b) => a - b).join(":");
        const existing = faces.get(key);
        if (existing) {
          existing._count += 1;
          continue;
        }
        const geometry = triangleGeometry(coordinates, nodes);
        const source = sourceByElementFace.get(`${globalElement}:${faceIndex}`) ?? {};
        faces.set(key, {
          id: faces.size,
          element: globalElement,
          elementFace: faceIndex,
          nodes,
          area: geometry.area,
          normal: geometry.normal,
          center: geometry.center,
          sourceFaceId: source.sourceFaceId,
          sourceSelectionRef: source.sourceSelectionRef,
          _count: 1
        });
      }
      globalElement += 1;
    }
  }

  return [...faces.values()]
    .filter((facet) => facet._count === 1)
    .map(({ _count, ...facet }, index) => ({ ...facet, id: index }));
}

export function mapSelectionToSurfaceSet(
  selectionRef: string,
  mesh: { surfaceFacets?: SurfaceFacetJson[] },
  options: SelectionMappingOptions = {}
): SurfaceSetJson {
  const facets = mesh.surfaceFacets ?? [];
  const matches = facets.filter(
    (facet) => facet.sourceFaceId === selectionRef || facet.sourceSelectionRef === selectionRef
  );
  const confidence = matches.length > 0 ? 1 : 0;
  if (matches.length === 0 || confidence < (options.minConfidence ?? 0.95)) {
    throw new Error(COMPLEX_GEOMETRY_REQUIRES_VOLUME_MESH);
  }
  return {
    name: selectionRef,
    facets: matches.map((facet) => facet.id)
  };
}

export function deriveNodeSetFromSurfaceSet(
  name: string,
  surfaceSet: SurfaceSetJson,
  facets: SurfaceFacetJson[]
): { name: string; nodes: number[] } {
  const facetById = new Map(facets.map((facet) => [facet.id, facet]));
  const nodes = new Set<number>();
  for (const facetId of surfaceSet.facets) {
    for (const node of facetById.get(facetId)?.nodes ?? []) {
      nodes.add(node);
    }
  }
  return {
    name,
    nodes: [...nodes].sort((a, b) => a - b)
  };
}

export function createSolverSurfaceMesh(input: SolverSurfaceMeshInput): SolverSurfaceMeshJson {
  const nodeMap = new Map<number, number>();
  const surfaceNodes: number[] = [];
  const surfaceTriangles: number[] = [];

  for (const facet of input.surfaceFacets) {
    if (facet.nodes.length < 3) continue;
    for (const facetTriangle of triangulateFacetNodes(facet.nodes)) {
      const triangle = facetTriangle.map((node) => {
        let mapped = nodeMap.get(node);
        if (mapped === undefined) {
          mapped = surfaceNodes.length / 3;
          nodeMap.set(node, mapped);
          surfaceNodes.push(
            coordinateAt(input.coordinates, node, 0),
            coordinateAt(input.coordinates, node, 1),
            coordinateAt(input.coordinates, node, 2)
          );
        }
        return mapped;
      });
      surfaceTriangles.push(...triangle);
    }
  }

  return {
    surfaceNodes,
    surfaceTriangles,
    coordinateSpace: input.coordinateSpace ?? "solver",
    meshRef: input.meshRef ?? "solver-surface"
  };
}

function triangulateFacetNodes(nodes: ArrayLike<number>): [number, number, number][] {
  if (nodes.length >= 6) {
    return [
      [nodes[0], nodes[3], nodes[5]],
      [nodes[3], nodes[1], nodes[4]],
      [nodes[5], nodes[4], nodes[2]],
      [nodes[3], nodes[4], nodes[5]]
    ];
  }
  return [[nodes[0], nodes[1], nodes[2]]];
}

export function computeTet4SignedVolume(coordinates: number[] | Float64Array, nodes: ArrayLike<number>): number {
  const ax = coordinateAt(coordinates, nodes[0], 0);
  const ay = coordinateAt(coordinates, nodes[0], 1);
  const az = coordinateAt(coordinates, nodes[0], 2);
  const bx = coordinateAt(coordinates, nodes[1], 0) - ax;
  const by = coordinateAt(coordinates, nodes[1], 1) - ay;
  const bz = coordinateAt(coordinates, nodes[1], 2) - az;
  const cx = coordinateAt(coordinates, nodes[2], 0) - ax;
  const cy = coordinateAt(coordinates, nodes[2], 1) - ay;
  const cz = coordinateAt(coordinates, nodes[2], 2) - az;
  const dx = coordinateAt(coordinates, nodes[3], 0) - ax;
  const dy = coordinateAt(coordinates, nodes[3], 1) - ay;
  const dz = coordinateAt(coordinates, nodes[3], 2) - az;
  return (
    bx * (cy * dz - cz * dy) -
    cx * (by * dz - bz * dy) +
    dx * (by * cz - bz * cy)
  ) / 6;
}

function collectElementNodes(
  blocks: Pick<ElementBlockJson, "type" | "connectivity">[]
): number[][] {
  const elements: number[][] = [];
  for (const block of blocks) {
    const nodesPer = nodesPerElement(block.type);
    for (let offset = 0; offset + nodesPer <= block.connectivity.length; offset += nodesPer) {
      elements.push(block.connectivity.slice(offset, offset + nodesPer));
    }
  }
  return elements;
}

function triangleGeometry(
  coordinates: number[] | Float64Array,
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
  const area = 0.5 * length;
  return {
    area,
    normal: length > 0 ? [nx / length, ny / length, nz / length] : [0, 0, 0],
    center: [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3]
  };
}

function coordinateAt(coordinates: number[] | Float64Array, node: number, component: number): number {
  return coordinates[node * 3 + component] ?? 0;
}
