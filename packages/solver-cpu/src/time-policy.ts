/** Named tolerances and guards for transient integration, in seconds. */
export const TIME_INTEGRATION_POLICY = Object.freeze({
  /** Absolute product guard: smaller requested steps are clamped to one microsecond. */
  minimumTimeStepSeconds: 1e-6,
  /** Absolute event-comparison band retained for sub-second analysis schedules. */
  eventAbsoluteToleranceSeconds: 1e-12,
  /** Machine-relative band for large absolute time origins where an ulp exceeds the absolute band. */
  eventEpsilonMultiplier: 64
});

export function boundedTimeStepSeconds(timeStepSeconds: number): number {
  return Math.max(timeStepSeconds, TIME_INTEGRATION_POLICY.minimumTimeStepSeconds);
}

export function timeComparisonToleranceSeconds(...timeValuesSeconds: number[]): number {
  let scaleSeconds = 0;
  for (const value of timeValuesSeconds) {
    if (Number.isFinite(value)) scaleSeconds = Math.max(scaleSeconds, Math.abs(value));
  }
  return Math.max(
    TIME_INTEGRATION_POLICY.eventAbsoluteToleranceSeconds,
    TIME_INTEGRATION_POLICY.eventEpsilonMultiplier * Number.EPSILON * scaleSeconds
  );
}

export function timeValuesMatch(leftSeconds: number, rightSeconds: number): boolean {
  return Number.isFinite(leftSeconds)
    && Number.isFinite(rightSeconds)
    && Math.abs(leftSeconds - rightSeconds) <= timeComparisonToleranceSeconds(leftSeconds, rightSeconds);
}

export function timeIsBeforeTarget(timeSeconds: number, targetSeconds: number): boolean {
  return timeSeconds < targetSeconds - timeComparisonToleranceSeconds(timeSeconds, targetSeconds);
}

export function timeHasReachedTarget(timeSeconds: number, targetSeconds: number): boolean {
  return timeSeconds >= targetSeconds - timeComparisonToleranceSeconds(timeSeconds, targetSeconds);
}
