import {
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION,
  type BoundaryConditionJson,
  type CoordinateSystemJson,
  type ElementBlockJson,
  type IsotropicLinearElasticMaterialJson,
  type LoadJson,
  type MeshProvenanceJson,
  type NodeSetJson,
  type OpenCAEModelJson,
  type PhysicalGroupJson,
  type StepJson,
  type SurfaceSetJson
} from "./model-json";
import {
  buildSurfaceFacets,
  COMPLEX_GEOMETRY_REQUIRES_VOLUME_MESH,
  deriveNodeSetFromSurfaceSet,
  mapSelectionToSurfaceSet
} from "./topology";

export type VolumeMeshSurfaceSetInput =
  | SurfaceSetJson
  | {
      name: string;
      sourceFaceId?: string;
      sourceSelectionRef?: string;
    };

type SurfaceSetBuildInput = {
  name: string;
  facets?: number[];
  sourceFaceId?: string;
  sourceSelectionRef?: string;
};

export type VolumeMeshToModelInput = {
  nodes: {
    coordinates: number[];
  };
  materials: IsotropicLinearElasticMaterialJson[];
  elementBlocks: ElementBlockJson[];
  nodeSets?: NodeSetJson[];
  surfaceSets?: VolumeMeshSurfaceSetInput[];
  boundaryConditions?: BoundaryConditionJson[];
  loads?: LoadJson[];
  steps?: StepJson[];
  coordinateSystem?: CoordinateSystemJson;
  meshProvenance?: MeshProvenanceJson;
  sourceFaces?: {
    sourceFaceId?: string;
    sourceSelectionRef?: string;
    element: number;
    elementFace: number;
  }[];
  physicalGroups?: PhysicalGroupJson[];
};

export type DisplayModelLike = {
  kind?: string;
  type?: string;
  label?: string;
  name?: string;
  bodies?: unknown[];
  features?: string[];
  holes?: unknown[];
  ribs?: unknown[];
  gussets?: unknown[];
  uploaded?: boolean;
  sourceFormat?: string;
  actualCoreMesh?: unknown;
};

export function volumeMeshToModelJson(input: VolumeMeshToModelInput): OpenCAEModelJson {
  const surfaceFacets = buildSurfaceFacets({
    coordinates: input.nodes.coordinates,
    elementBlocks: input.elementBlocks,
    sourceFaces: input.sourceFaces
  });
  const surfaceSetInputs: SurfaceSetBuildInput[] = [
    ...(input.surfaceSets ?? []).map((surfaceSet) => ({ ...surfaceSet })),
    ...(input.physicalGroups ?? [])
      .filter((group) => group.dimension === 2)
      .map((group) => ({
        name: group.name,
        facets: group.facets,
        sourceFaceId: group.sourceFaceId,
        sourceSelectionRef: group.sourceSelectionRef
      }))
  ];
  const surfaceSets = surfaceSetInputs.map((surfaceSet) => {
    if ("facets" in surfaceSet && surfaceSet.facets !== undefined) {
      return { name: surfaceSet.name, facets: [...surfaceSet.facets] };
    }
    const selectionRef = surfaceSet.sourceSelectionRef ?? surfaceSet.sourceFaceId;
    if (!selectionRef) {
      return { name: surfaceSet.name, facets: surfaceFacets.map((facet) => facet.id) };
    }
    try {
      const mapped = mapSelectionToSurfaceSet(selectionRef, { surfaceFacets });
      return { name: surfaceSet.name, facets: mapped.facets };
    } catch {
      return { name: surfaceSet.name, facets: surfaceFacets.map((facet) => facet.id) };
    }
  });

  return {
    schema: OPENCAE_MODEL_SCHEMA,
    schemaVersion: OPENCAE_MODEL_SCHEMA_VERSION,
    nodes: {
      coordinates: [...input.nodes.coordinates]
    },
    materials: input.materials.map((material) => ({ ...material })),
    elementBlocks: input.elementBlocks.map((block) => ({
      name: block.name,
      type: block.type,
      material: block.material,
      connectivity: [...block.connectivity]
    })),
    nodeSets: input.nodeSets?.map((set) => ({ name: set.name, nodes: [...set.nodes] })) ?? [],
    elementSets: [
      {
        name: "allElements",
        elements: input.elementBlocks.flatMap((block, blockIndex) => {
          const nodesPerElement = block.type === "Tet4" ? 4 : 10;
          const count = Math.floor(block.connectivity.length / nodesPerElement);
          const prior = input.elementBlocks
            .slice(0, blockIndex)
            .reduce((sum, priorBlock) => {
              const priorNodesPerElement = priorBlock.type === "Tet4" ? 4 : 10;
              return sum + Math.floor(priorBlock.connectivity.length / priorNodesPerElement);
            }, 0);
          return Array.from({ length: count }, (_, index) => prior + index);
        })
      }
    ].concat(
      (input.physicalGroups ?? [])
        .filter((group) => group.dimension === 3 && group.elements !== undefined)
        .map((group) => ({ name: group.name, elements: [...(group.elements ?? [])] }))
    ),
    surfaceFacets,
    surfaceSets,
    boundaryConditions: input.boundaryConditions?.map((bc) => ({ ...bc })) ?? [],
    loads: input.loads?.map((load) => ({ ...load })) ?? [],
    steps: input.steps?.map((step) => ({ ...step })) ?? [],
    coordinateSystem: input.coordinateSystem ?? { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: input.meshProvenance ?? {
      kind: "opencae_core_fea",
      solver: "opencae-core-sparse-tet",
      resultSource: "computed",
      meshSource: "actual_volume_mesh"
    }
  };
}

export function deriveFixedSupportNodeSetFromSurface(
  name: string,
  surfaceSetName: string,
  model: Pick<OpenCAEModelJson, "surfaceFacets" | "surfaceSets">
): NodeSetJson {
  const surfaceSet = model.surfaceSets?.find((set) => set.name === surfaceSetName);
  if (!surfaceSet) {
    throw new Error(`Surface set ${surfaceSetName} was not found.`);
  }
  return deriveNodeSetFromSurfaceSet(name, surfaceSet, model.surfaceFacets ?? []);
}

export function isSimpleBlockLikeDisplayModel(displayModel: DisplayModelLike): boolean {
  const label = `${displayModel.kind ?? ""} ${displayModel.type ?? ""} ${displayModel.label ?? ""} ${displayModel.name ?? ""}`.toLowerCase();
  const bodyCount = displayModel.bodies?.length ?? 1;
  if (displayModel.actualCoreMesh) return false;
  if (bodyCount !== 1) return false;
  if (displayModel.uploaded || displayModel.sourceFormat) return false;
  if ((displayModel.holes?.length ?? 0) > 0) return false;
  if ((displayModel.ribs?.length ?? 0) > 0) return false;
  if ((displayModel.gussets?.length ?? 0) > 0) return false;
  if ((displayModel.features ?? []).some((feature) => /hole|rib|gusset|bracket|upright/i.test(feature))) {
    return false;
  }
  if (/bracket|hole|rib|gusset|upright|uploaded|step|stl|obj/.test(label)) return false;
  return /cantilever|block|beam|rectangular/.test(label);
}

export function assertCoreCanUseDisplayModel(displayModel: DisplayModelLike): void {
  if (!displayModel.actualCoreMesh && !isSimpleBlockLikeDisplayModel(displayModel)) {
    throw new Error(COMPLEX_GEOMETRY_REQUIRES_VOLUME_MESH);
  }
}
