export function playbackOrdinalForSolverFramePosition(frameIndexes: number[], framePosition: number): number {
  const frames = normalizedFrameIndexes(frameIndexes);
  if (!frames.length || frames.length === 1) return 0;
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  if (framePosition <= first) return 0;
  if (framePosition >= last) return frames.length - 1;
  for (let index = 0; index < frames.length - 1; index += 1) {
    const lower = frames[index]!;
    const upper = frames[index + 1]!;
    if (framePosition < lower || framePosition > upper) continue;
    if (upper === lower) return index;
    return index + clamp01((framePosition - lower) / (upper - lower));
  }
  return 0;
}

export function solverFramePositionForPlaybackOrdinal(frameIndexes: number[], ordinalPosition: number): number {
  const frames = normalizedFrameIndexes(frameIndexes);
  if (!frames.length) return 0;
  if (frames.length === 1) return frames[0] ?? 0;
  if (ordinalPosition <= 0) return frames[0] ?? 0;
  if (ordinalPosition >= frames.length - 1) return frames[frames.length - 1] ?? 0;
  const lowerOrdinal = Math.floor(ordinalPosition);
  const upperOrdinal = Math.min(frames.length - 1, lowerOrdinal + 1);
  const lowerFrame = frames[lowerOrdinal] ?? frames[0] ?? 0;
  const upperFrame = frames[upperOrdinal] ?? lowerFrame;
  return lowerFrame + (upperFrame - lowerFrame) * clamp01(ordinalPosition - lowerOrdinal);
}

export function frameIndexForPlaybackOrdinal(frameIndexes: number[], ordinalPosition: number): number {
  const frames = normalizedFrameIndexes(frameIndexes);
  if (!frames.length) return 0;
  const index = Math.max(0, Math.min(frames.length - 1, Math.floor(ordinalPosition)));
  return frames[index] ?? frames[0] ?? 0;
}

export function frameIndexForRoundedPlaybackOrdinal(frameIndexes: number[], ordinalPosition: number): number {
  const frames = normalizedFrameIndexes(frameIndexes);
  if (!frames.length) return 0;
  const index = Math.max(0, Math.min(frames.length - 1, Math.round(ordinalPosition)));
  return frames[index] ?? frames[0] ?? 0;
}

export function loopedPlaybackOrdinalPosition(frameCount: number, ordinalPosition: number): number {
  if (!Number.isFinite(frameCount) || frameCount < 2) return 0;
  return (((ordinalPosition % frameCount) + frameCount) % frameCount);
}

export function boundedPlaybackOrdinalDelta(elapsedMs: number, frameDurationMs: number): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(frameDurationMs) || frameDurationMs <= 0 || elapsedMs <= 0) return 0;
  return Math.min(1, elapsedMs / frameDurationMs);
}

function normalizedFrameIndexes(frameIndexes: number[]): number[] {
  return [...new Set(frameIndexes.filter(Number.isFinite).map((frameIndex) => Math.floor(frameIndex)))]
    .sort((left, right) => left - right);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
