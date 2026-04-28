import { distanceVec3 } from "./math";
import { DEFAULT_SNAP_CONFIG, type ScoredSnapCandidate, type SnapCandidate, type SnapConfig, type Vec3 } from "./types";

export function selectBestSnapCandidate(candidates: SnapCandidate[], cursorPoint: Vec3, config: SnapConfig = {}): ScoredSnapCandidate | null {
  const thresholdWorld = config.thresholdWorld ?? DEFAULT_SNAP_CONFIG.thresholdWorld;
  const thresholdPixels = config.thresholdPixels ?? DEFAULT_SNAP_CONFIG.thresholdPixels;
  const distanceWeight = config.distanceWeight ?? DEFAULT_SNAP_CONFIG.distanceWeight;
  const useScreenDistance = Boolean(config.screenPosition && config.projectToScreen);
  let bestPreferred: ScoredSnapCandidate | null = null;
  let bestFallback: ScoredSnapCandidate | null = null;

  for (const candidate of candidates) {
    const distanceToCursor = useScreenDistance
      ? screenDistance(config.projectToScreen?.(candidate.point), config.screenPosition)
      : distanceVec3(candidate.point, cursorPoint);
    const threshold = useScreenDistance ? thresholdPixels : thresholdWorld;
    if (distanceToCursor > threshold) continue;
    const score = distanceWeight * distanceToCursor + candidate.priority;
    const scored = { candidate, score, distanceToCursor };
    if (candidate.fallback) {
      if (!bestFallback || score < bestFallback.score) bestFallback = scored;
    } else if (!bestPreferred || score < bestPreferred.score) {
      bestPreferred = scored;
    }
  }

  return bestPreferred ?? bestFallback;
}

function screenDistance(candidate: { x: number; y: number } | undefined, cursor: { x: number; y: number } | undefined) {
  if (!candidate || !cursor) return Number.POSITIVE_INFINITY;
  return Math.hypot(candidate.x - cursor.x, candidate.y - cursor.y);
}
