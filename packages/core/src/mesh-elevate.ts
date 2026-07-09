// Elevates straight-sided Tet4 meshes to Tet10 by inserting midside nodes on each
// unique edge. Node ordering follows the package convention (VTK quadratic tet):
// vertices 0-3, then midsides on edges (0,1), (1,2), (0,2), (0,3), (1,3), (2,3).

export const TET10_EDGE_VERTEX_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [0, 2],
  [0, 3],
  [1, 3],
  [2, 3]
];

export type ElevateTet4MeshInput = {
  coordinates: ArrayLike<number>;
  elements: ReadonlyArray<ArrayLike<number>>;
  facets?: ReadonlyArray<ArrayLike<number>>;
};

export type ElevateTet4MeshResult = {
  coordinates: number[];
  elements: number[][];
  facets: number[][];
};

export function elevateTet4MeshToTet10(input: ElevateTet4MeshInput): ElevateTet4MeshResult {
  const coordinates = Array.from(input.coordinates, (value) => Number(value));
  const midNodeByEdge = new Map<string, number>();

  const midNode = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const existing = midNodeByEdge.get(key);
    if (existing !== undefined) return existing;
    const node = coordinates.length / 3;
    coordinates.push(
      (coordinates[a * 3] + coordinates[b * 3]) / 2,
      (coordinates[a * 3 + 1] + coordinates[b * 3 + 1]) / 2,
      (coordinates[a * 3 + 2] + coordinates[b * 3 + 2]) / 2
    );
    midNodeByEdge.set(key, node);
    return node;
  };

  const elements = input.elements.map((element) => {
    if (element.length !== 4) {
      throw new Error(`elevateTet4MeshToTet10 requires Tet4 connectivity, got ${element.length} nodes.`);
    }
    const corners = [element[0], element[1], element[2], element[3]] as number[];
    return [
      ...corners,
      ...TET10_EDGE_VERTEX_PAIRS.map(([m, n]) => midNode(corners[m], corners[n]))
    ];
  });

  const facets = (input.facets ?? []).map((facet) => {
    const corners = [facet[0], facet[1], facet[2]] as number[];
    return [
      ...corners,
      midNode(corners[0], corners[1]),
      midNode(corners[1], corners[2]),
      midNode(corners[2], corners[0])
    ];
  });

  return { coordinates, elements, facets };
}
