// Mirrored from opencae-core@5fff277 services/opencae-core-cloud/src/mesh/elevateArtifact.ts — pure elevation only.
// Upstream extraction into a shared package is planned (plan 016, A-M2). Do not diverge without syncing.
import { elevateTet4MeshToTet10 } from "@opencae/core";
import type { CoreVolumeMeshArtifact } from "./types";

export const DEFAULT_CLOUD_ELEMENT_ORDER = 2;

export function requestedElementOrder(solverSettings: Record<string, unknown> | undefined): 1 | 2 {
  const value = solverSettings?.elementOrder ?? solverSettings?.meshOrder;
  if (value === 1 || value === "1") return 1;
  if (value === 2 || value === "2") return 2;
  return DEFAULT_CLOUD_ELEMENT_ORDER;
}

// Upgrades a cloud-generated Tet4 artifact to Tet10 by inserting midside nodes.
// Facet ids, owning elements, areas, and normals are unchanged (straight edges),
// so surface sets and selection mappings stay valid. Element entries may carry a
// single tet or a flat multi-tet connectivity list (structured block generator).
export function elevateVolumeMeshArtifactToTet10(artifact: CoreVolumeMeshArtifact): CoreVolumeMeshArtifact {
  if (
    !artifact.elements.length ||
    artifact.elements.some((element) => element.type !== "Tet4" || element.connectivity.length % 4 !== 0)
  ) {
    return artifact;
  }

  const tetsPerEntry = artifact.elements.map((element) => element.connectivity.length / 4);
  const tetConnectivities: number[][] = [];
  for (const element of artifact.elements) {
    for (let offset = 0; offset < element.connectivity.length; offset += 4) {
      tetConnectivities.push(element.connectivity.slice(offset, offset + 4));
    }
  }

  const elevated = elevateTet4MeshToTet10({
    coordinates: artifact.nodes.coordinates,
    elements: tetConnectivities,
    facets: artifact.surfaceFacets.map((facet) => facet.nodes)
  });

  let tetCursor = 0;
  const elements = artifact.elements.map((element, index) => {
    // Non-null assertions only appease this repo's stricter noUncheckedIndexedAccess
    // tsconfig; tetsPerEntry is built from artifact.elements so index always exists.
    const connectivity = elevated.elements.slice(tetCursor, tetCursor + tetsPerEntry[index]!).flat();
    tetCursor += tetsPerEntry[index]!;
    return {
      ...element,
      type: "Tet10" as const,
      connectivity
    };
  });

  return {
    ...artifact,
    nodes: { coordinates: elevated.coordinates },
    elements,
    surfaceFacets: artifact.surfaceFacets.map((facet, index) => ({
      ...facet,
      nodes: elevated.facets[index] ?? facet.nodes
    })),
    metadata: {
      ...artifact.metadata,
      nodeCount: elevated.coordinates.length / 3,
      diagnostics: [
        ...artifact.metadata.diagnostics,
        `elevated ${tetConnectivities.length} Tet4 elements to Tet10 (${elevated.coordinates.length / 3} nodes)`
      ]
    }
  };
}
