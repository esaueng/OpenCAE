import { queryHoveredEntity } from "./geometryQuery";
import { vec3FromVector, vectorFromVec3 } from "./math";
import { generateSnapCandidates } from "./snapGenerator";
import { selectBestSnapCandidate } from "./snapScoring";
import { inferConstraintSuggestion } from "./constraintInference";
import { DEFAULT_SNAP_CONFIG, type CursorRay, type SnapQueryContext, type SnapResult, type Vec3 } from "./types";

export function createSnapSuggestionProvider(context: SnapQueryContext) {
  return {
    getSnapSuggestion(cursorRay: CursorRay) {
      return getSnapSuggestion(cursorRay, context);
    }
  };
}

export function getSnapSuggestion(cursorRay: CursorRay, context: SnapQueryContext): SnapResult | null {
  const hovered = queryHoveredEntity(cursorRay, context);
  if (!hovered) return null;

  const candidates = generateSnapCandidates(hovered, cursorRay);
  const best = selectBestSnapCandidate(candidates, cursorRay.cursorPoint, { ...context, screenPosition: cursorRay.screenPosition });
  if (!best) return null;

  const alpha = context.smoothingAlpha ?? DEFAULT_SNAP_CONFIG.smoothingAlpha;
  const suggestion = inferConstraintSuggestion(hovered, context.mode);
  return {
    hovered,
    snapPoint: smoothSnapPoint(cursorRay.cursorPoint, best.candidate.point, alpha),
    rawSnapPoint: best.candidate.point,
    direction: suggestion.direction,
    suggestionType: suggestion.suggestionType,
    candidateKind: best.candidate.kind,
    score: best.score,
    measurements: best.candidate.measurements
  };
}

export function smoothSnapPoint(cursorPoint: Vec3, snapPoint: Vec3, alpha: number): Vec3 {
  const clampedAlpha = Math.min(1, Math.max(0, alpha));
  return vec3FromVector(vectorFromVec3(cursorPoint).lerp(vectorFromVec3(snapPoint), clampedAlpha));
}
