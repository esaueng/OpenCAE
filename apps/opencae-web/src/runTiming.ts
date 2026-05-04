import type { RunTimingEstimate } from "@opencae/schema";

export function deriveRunTiming({
  progress,
  eventTiming,
  startedAtMs,
  nowMs
}: {
  progress: number;
  eventTiming?: RunTimingEstimate | null;
  startedAtMs?: number | null;
  nowMs: number;
}): RunTimingEstimate | null {
  if (eventTiming && Object.keys(eventTiming).length > 0) return eventTiming;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return null;

  const elapsedMs = Math.max(0, Math.round(nowMs - startedAtMs));
  const clampedProgress = Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0));
  if (clampedProgress <= 0 || clampedProgress >= 100) return { elapsedMs };

  return {
    elapsedMs,
    estimatedRemainingMs: Math.max(0, Math.round((elapsedMs * (100 - clampedProgress)) / clampedProgress))
  };
}
