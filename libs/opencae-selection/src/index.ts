import type { GeometryReference, NamedSelection } from "@opencae/schema";

export function createNamedSelection(id: string, name: string, ref: GeometryReference): NamedSelection {
  return {
    id,
    name,
    entityType: ref.entityType,
    geometryRefs: [ref],
    fingerprint: `${ref.bodyId}:${ref.entityType}:${ref.entityId}:v1`
  };
}
