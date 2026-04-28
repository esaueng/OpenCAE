import { normalizeVec3, vec3FromVector, vectorFromVec3 } from "./math";
import type { HoveredEntity, PlacementMode, SuggestionType, Vec3 } from "./types";

export interface ConstraintSuggestion {
  direction: Vec3;
  suggestionType: SuggestionType;
}

export function inferConstraintSuggestion(entity: HoveredEntity, mode: PlacementMode = "loads"): ConstraintSuggestion {
  if (mode === "supports") {
    return {
      direction: normalizeVec3(entity.normal ?? edgeDirection(entity) ?? [0, 0, 1]),
      suggestionType: "fixed"
    };
  }

  if (entity.type === "edge") {
    return {
      direction: normalizeVec3(edgeDirection(entity) ?? entity.normal ?? [0, 0, 1]),
      suggestionType: "distributed"
    };
  }

  return {
    direction: normalizeVec3(entity.normal ?? [0, 0, 1]),
    suggestionType: "force"
  };
}

function edgeDirection(entity: HoveredEntity): Vec3 | undefined {
  if (!entity.endpoints) return undefined;
  const direction = vectorFromVec3(entity.endpoints[1]).sub(vectorFromVec3(entity.endpoints[0]));
  if (direction.lengthSq() < 1e-12) return undefined;
  return vec3FromVector(direction.normalize());
}
