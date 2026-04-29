import type { ResultField } from "@opencae/schema";
import { createResultFrameCache } from "./resultFields";

export type PlaybackFrameCacheMode = "full" | "reducedFps" | "integerFrames" | "fallback";

export interface PlaybackFrameCachePlan {
  mode: PlaybackFrameCacheMode;
  presentationFps: number;
  framePositions: number[];
  estimatedBytes: number;
  budgetBytes: number;
}

export interface PlaybackFrameCacheInput {
  fields: ResultField[];
  frameIndexes: number[];
  playbackFps: number;
  budgetBytes?: number;
  cacheKey?: string;
}

export interface PreparedPlaybackField extends Omit<ResultField, "values"> {
  values: Float64Array;
}

export interface PreparedPlaybackFrame {
  framePosition: number;
  frameIndex: number;
  timeSeconds: number;
  fields: PreparedPlaybackField[];
}

export interface PreparedPlaybackFrameCache {
  cacheKey?: string;
  mode: PlaybackFrameCacheMode;
  presentationFps: number;
  frameCount: number;
  estimatedBytes: number;
  actualBytes: number;
  frames: PreparedPlaybackFrame[];
}

const hydratedFrames = new WeakMap<PreparedPlaybackFrame, { framePosition: number; frameIndex: number; timeSeconds: number; fields: ResultField[] }>();

const DESKTOP_PLAYBACK_BUDGET_BYTES = 192 * 1024 * 1024;
const CONSTRAINED_PLAYBACK_BUDGET_BYTES = 64 * 1024 * 1024;
const CONSTRAINED_DEVICE_MEMORY_GB = 4;
const PRESENTATION_FPS_CANDIDATES = [60, 30, 24] as const;
const ESTIMATE_OVERHEAD_MULTIPLIER = 1.25;

export function playbackMemoryBudgetBytes(deviceMemoryGb?: number): number {
  if (typeof deviceMemoryGb === "number" && Number.isFinite(deviceMemoryGb) && deviceMemoryGb <= CONSTRAINED_DEVICE_MEMORY_GB) {
    return CONSTRAINED_PLAYBACK_BUDGET_BYTES;
  }
  return DESKTOP_PLAYBACK_BUDGET_BYTES;
}

export function planPlaybackFrameCache(input: PlaybackFrameCacheInput): PlaybackFrameCachePlan {
  const frameIndexes = normalizedFrameIndexes(input.frameIndexes);
  const budgetBytes = input.budgetBytes ?? playbackMemoryBudgetBytes();
  if (frameIndexes.length < 2 || !input.fields.length) {
    return fallbackPlan(budgetBytes);
  }
  const perFrameBytes = estimatePreparedFrameBytes(input.fields, frameIndexes[0] ?? 0);
  for (const presentationFps of PRESENTATION_FPS_CANDIDATES) {
    const framePositions = presentationFramePositions(frameIndexes, input.playbackFps, presentationFps);
    const estimatedBytes = estimateTotalBytes(perFrameBytes, framePositions.length);
    if (estimatedBytes <= budgetBytes) {
      return {
        mode: presentationFps === 60 ? "full" : "reducedFps",
        presentationFps,
        framePositions,
        estimatedBytes,
        budgetBytes
      };
    }
  }

  const integerPositions = frameIndexes;
  const integerBytes = perFrameBytes * integerPositions.length;
  if (integerBytes <= budgetBytes) {
    return {
      mode: "integerFrames",
      presentationFps: Math.max(1, Math.min(30, Math.round(input.playbackFps))),
      framePositions: integerPositions,
      estimatedBytes: integerBytes,
      budgetBytes
    };
  }
  return fallbackPlan(budgetBytes);
}

export function preparePlaybackFrames(input: PlaybackFrameCacheInput): PreparedPlaybackFrameCache {
  const plan = planPlaybackFrameCache(input);
  if (plan.mode === "fallback") {
    return {
      cacheKey: input.cacheKey,
      mode: "fallback",
      presentationFps: 0,
      frameCount: 0,
      estimatedBytes: plan.estimatedBytes,
      actualBytes: 0,
      frames: []
    };
  }

  const frameCache = createResultFrameCache(input.fields);
  let actualBytes = 0;
  const frames = plan.framePositions.map((framePosition) => {
    const fields = frameCache.fieldsForFramePosition(framePosition).map((field) => {
      const values = new Float64Array(field.values);
      actualBytes += values.byteLength;
      return {
        ...field,
        values
      };
    });
    return {
      framePosition,
      frameIndex: Math.floor(framePosition),
      timeSeconds: frameCache.timeForFramePosition(framePosition),
      fields
    };
  });

  return {
    cacheKey: input.cacheKey,
    mode: plan.mode,
    presentationFps: plan.presentationFps,
    frameCount: frames.length,
    estimatedBytes: plan.estimatedBytes,
    actualBytes,
    frames
  };
}

export function hydratePreparedPlaybackFrame(frame: PreparedPlaybackFrame): { framePosition: number; frameIndex: number; timeSeconds: number; fields: ResultField[] } {
  const cached = hydratedFrames.get(frame);
  if (cached) return cached;
  const hydrated = {
    framePosition: frame.framePosition,
    frameIndex: frame.frameIndex,
    timeSeconds: frame.timeSeconds,
    fields: frame.fields.map((field) => ({
      ...field,
      values: Array.from(field.values)
    }))
  };
  hydratedFrames.set(frame, hydrated);
  return hydrated;
}

export function preparedPlaybackFrameForPosition(cache: PreparedPlaybackFrameCache | null | undefined, framePosition: number): PreparedPlaybackFrame | null {
  if (!cache?.frames.length) return null;
  let low = 0;
  let high = cache.frames.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const frame = cache.frames[mid]!;
    if (Math.abs(frame.framePosition - framePosition) < 1e-9) return frame;
    if (frame.framePosition < framePosition) low = mid + 1;
    else high = mid - 1;
  }
  const before = cache.frames[Math.max(0, high)];
  const after = cache.frames[Math.min(cache.frames.length - 1, low)];
  if (!before) return after ?? null;
  if (!after) return before;
  return Math.abs(before.framePosition - framePosition) <= Math.abs(after.framePosition - framePosition) ? before : after;
}

export function preparedPlaybackTransferables(cache: PreparedPlaybackFrameCache): Transferable[] {
  const transferables: Transferable[] = [];
  for (const frame of cache.frames) {
    for (const field of frame.fields) {
      transferables.push(field.values.buffer);
    }
  }
  return transferables;
}

function normalizedFrameIndexes(frameIndexes: number[]): number[] {
  return [...new Set(frameIndexes.filter((frameIndex) => Number.isFinite(frameIndex)).map((frameIndex) => Math.floor(frameIndex)))]
    .sort((left, right) => left - right);
}

function presentationFramePositions(frameIndexes: number[], playbackFps: number, presentationFps: number): number[] {
  const first = frameIndexes[0] ?? 0;
  const last = frameIndexes[frameIndexes.length - 1] ?? first;
  const span = Math.max(0, last - first);
  if (span <= 0) return [first];
  const safePlaybackFps = Math.max(1, Math.min(30, playbackFps));
  const loopSeconds = Math.max(frameIndexes.length / safePlaybackFps, span / safePlaybackFps);
  const frameCount = Math.max(2, Math.ceil(loopSeconds * presentationFps) + 1);
  return Array.from({ length: frameCount }, (_, index) => {
    const t = index / (frameCount - 1);
    return first + span * t;
  });
}

function estimatePreparedFrameBytes(fields: ResultField[], fallbackFrameIndex: number): number {
  const fieldsForFrame = fields.filter((field) => (field.frameIndex ?? fallbackFrameIndex) === fallbackFrameIndex);
  const visibleFields = fieldsForFrame.length ? fieldsForFrame : fields;
  const valueCount = visibleFields.reduce((total, field) => total + field.values.length, 0);
  return Math.max(1, valueCount) * Float64Array.BYTES_PER_ELEMENT;
}

function estimateTotalBytes(perFrameBytes: number, frameCount: number): number {
  return Math.ceil(perFrameBytes * Math.max(0, frameCount) * ESTIMATE_OVERHEAD_MULTIPLIER);
}

function fallbackPlan(budgetBytes: number): PlaybackFrameCachePlan {
  return {
    mode: "fallback",
    presentationFps: 0,
    framePositions: [],
    estimatedBytes: 0,
    budgetBytes
  };
}
