import type { ResultField } from "@opencae/schema";
import { createPackedResultPlaybackCache, createResultFrameCache } from "./resultFields";
import { stressComponentForField } from "./resultSelection";

export type PlaybackFrameCacheMode = "full" | "reducedFps" | "integerFrames" | "fallback";

export interface PlaybackFrameCachePlan {
  mode: PlaybackFrameCacheMode;
  presentationFps: number;
  framePositions: number[];
  estimatedBytes: number;
  budgetBytes: number;
}

export interface PlaybackFrameCacheInput {
  fields?: ResultField[];
  packedFields?: PackedResultFieldsForPlayback;
  frameIndexes: number[];
  playbackFps: number;
  budgetBytes?: number;
  cacheKey?: string;
}

export interface PackedResultFieldsForPlayback {
  frameCount: number;
  fieldCount: number;
  valueCount: number;
  tensorCount: number;
  vectorCount: number;
  sampleCount: number;
  frameIndexes: Int32Array;
  times: Float32Array;
  fieldDescriptors: PackedPreparedPlaybackFieldDescriptor[];
  fieldOffsets: Int32Array;
  fieldLengths: Int32Array;
  fieldMins: Float32Array;
  fieldMaxes: Float32Array;
  values: Float32Array;
  tensorOffsets: Int32Array;
  tensorLengths: Int32Array;
  tensorValues: Float32Array;
  vectorOffsets: Int32Array;
  vectorLengths: Int32Array;
  vectors: Float32Array;
  sampleOffsets: Int32Array;
  sampleLengths: Int32Array;
  sampleValues: Float32Array;
  samplePoints: Float32Array;
  sampleNormals: Float32Array;
  sampleVectors: Float32Array;
}

export interface PreparedPlaybackField extends Omit<ResultField, "values" | "tensorValues"> {
  values: Float32Array;
  tensorValues?: Float32Array;
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
  packed?: PackedPreparedPlaybackCache;
}

const hydratedFrames = new WeakMap<PreparedPlaybackFrame, { framePosition: number; frameIndex: number; timeSeconds: number; fields: ResultField[] }>();

export interface PackedPreparedPlaybackFieldDescriptor {
  id: string;
  runId: string;
  variantId?: string;
  type: ResultField["type"];
  component?: ResultField["component"];
  modeIndex?: number;
  frequencyHz?: number;
  eigenvalue?: number;
  scaledResidual?: number;
  location: ResultField["location"];
  units: string;
  surfaceMeshRef?: string;
  visualizationSource?: string;
  engineeringSource?: string;
  provenance?: ResultField["provenance"];
}

export interface PackedPreparedPlaybackCache {
  frameCount: number;
  fieldCount: number;
  framePositions: Float32Array;
  frameIndexes: Int32Array;
  times: Float32Array;
  fieldDescriptors: PackedPreparedPlaybackFieldDescriptor[];
  fieldOffsets: Int32Array;
  fieldLengths: Int32Array;
  fieldMins: Float32Array;
  fieldMaxes: Float32Array;
  values: Float32Array;
  tensorOffsets: Int32Array;
  tensorLengths: Int32Array;
  tensorValues: Float32Array;
  vectorOffsets: Int32Array;
  vectorLengths: Int32Array;
  vectors: Float32Array;
  sampleOffsets: Int32Array;
  sampleLengths: Int32Array;
  sampleValues: Float32Array;
  samplePoints: Float32Array;
  sampleNormals: Float32Array;
  sampleVectors: Float32Array;
  actualBytes: number;
}

export interface PackedPreparedPlaybackFieldSlot {
  descriptor: PackedPreparedPlaybackFieldDescriptor;
  offset: number;
  length: number;
  min: number;
  max: number;
  values: Float32Array;
  tensorOffset: number;
  tensorLength: number;
  tensorValues: Float32Array;
  vectorOffset: number;
  vectorLength: number;
  vectors: Float32Array;
  sampleOffset: number;
  sampleLength: number;
  sampleValues: Float32Array;
  samplePoints: Float32Array;
  sampleNormals: Float32Array;
  sampleVectors: Float32Array;
}

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
  const fields = fieldsForPlaybackInput(input);
  const frameIndexes = normalizedFrameIndexes(input.frameIndexes);
  const budgetBytes = input.budgetBytes ?? playbackMemoryBudgetBytes();
  if (frameIndexes.length < 2 || !fields.length) {
    return fallbackPlan(budgetBytes);
  }
  const perFrameBytes = estimatePreparedFrameBytes(fields, frameIndexes[0] ?? 0);
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
  const fields = fieldsForPlaybackInput(input);
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

  const frameCache = createResultFrameCache(fields);
  let actualBytes = 0;
  const frames = plan.framePositions.map((framePosition) => {
    const fields = frameCache.fieldsForFramePosition(framePosition).map((field) => {
      const { tensorValues: sourceTensorValues, ...fieldWithoutTensors } = field;
      const values = new Float32Array(field.values);
      const tensorValues = sourceTensorValues ? new Float32Array(sourceTensorValues) : undefined;
      actualBytes += values.byteLength + (tensorValues?.byteLength ?? 0);
      return {
        ...fieldWithoutTensors,
        values,
        ...(tensorValues ? { tensorValues } : {})
      };
    });
    return {
      framePosition,
      frameIndex: Math.floor(framePosition),
      timeSeconds: frameCache.timeForFramePosition(framePosition),
      fields
    };
  });

  const packed = packPreparedPlaybackFrames(frames);
  actualBytes += packed?.actualBytes ?? 0;

  return {
    cacheKey: input.cacheKey,
    mode: plan.mode,
    presentationFps: plan.presentationFps,
    frameCount: frames.length,
    estimatedBytes: plan.estimatedBytes,
    actualBytes,
    frames,
    ...(packed ? { packed } : {})
  };
}

export function packResultFieldsForPlayback(fields: ResultField[]): PackedResultFieldsForPlayback | null {
  const packed = createPackedResultPlaybackCache(fields);
  if (!packed) return null;
  return {
    frameCount: packed.frameCount,
    fieldCount: packed.fieldCount,
    valueCount: packed.valueCount,
    tensorCount: packed.tensorCount,
    vectorCount: packed.vectors.length / 3,
    frameIndexes: packed.frameIndexes,
    times: packed.times,
    fieldDescriptors: packed.fieldDescriptors,
    fieldOffsets: packed.fieldOffsets,
    fieldLengths: packed.fieldLengths,
    fieldMins: packed.fieldMins,
    fieldMaxes: packed.fieldMaxes,
    values: packed.values,
    tensorOffsets: packed.tensorOffsets,
    tensorLengths: packed.tensorLengths,
    tensorValues: packed.tensorValues,
    vectorOffsets: packed.vectorOffsets,
    vectorLengths: packed.vectorLengths,
    vectors: packed.vectors,
    sampleCount: packed.sampleCount,
    sampleOffsets: packed.sampleOffsets,
    sampleLengths: packed.sampleLengths,
    sampleValues: packed.sampleValues,
    samplePoints: packed.samplePoints,
    sampleNormals: packed.sampleNormals,
    sampleVectors: packed.sampleVectors
  };
}

export function unpackResultFieldsForPlayback(packed: PackedResultFieldsForPlayback): ResultField[] {
  const fields: ResultField[] = [];
  for (let frameOrdinal = 0; frameOrdinal < packed.frameCount; frameOrdinal += 1) {
    const frameIndex = packed.frameIndexes[frameOrdinal] ?? frameOrdinal;
    const timeSeconds = packed.times[frameOrdinal] ?? 0;
    for (let fieldOrdinal = 0; fieldOrdinal < packed.fieldCount; fieldOrdinal += 1) {
      const descriptor = packed.fieldDescriptors[fieldOrdinal];
      if (!descriptor) continue;
      const slot = frameOrdinal * packed.fieldCount + fieldOrdinal;
      fields.push(unpackPackedInputFieldForSlot(
        descriptor,
        frameIndex,
        timeSeconds,
        slot,
        packed.fieldOffsets,
        packed.fieldLengths,
        packed.fieldMins,
        packed.fieldMaxes,
        packed.values,
        packed.tensorOffsets,
        packed.tensorLengths,
        packed.tensorValues,
        packed.vectorOffsets,
        packed.vectorLengths,
        packed.vectors,
        packed.sampleOffsets,
        packed.sampleLengths,
        packed.sampleValues,
        packed.samplePoints,
        packed.sampleNormals,
        packed.sampleVectors
      ));
    }
  }
  return fields;
}

function unpackPackedInputFieldForSlot(
  descriptor: PackedPreparedPlaybackFieldDescriptor,
  frameIndex: number,
  timeSeconds: number,
  slot: number,
  fieldOffsets: Int32Array,
  fieldLengths: Int32Array,
  fieldMins: Float32Array,
  fieldMaxes: Float32Array,
  values: Float32Array,
  tensorOffsets: Int32Array,
  tensorLengths: Int32Array,
  tensorValues: Float32Array,
  vectorOffsets: Int32Array,
  vectorLengths: Int32Array,
  vectors: Float32Array,
  sampleOffsets: Int32Array,
  sampleLengths: Int32Array,
  sampleValues: Float32Array,
  samplePoints: Float32Array,
  sampleNormals: Float32Array,
  sampleVectors: Float32Array
): ResultField {
  const length = fieldLengths[slot] ?? 0;
  const offset = fieldOffsets[slot] ?? 0;
  const fieldValues = new Array<number>(length);
  for (let index = 0; index < length; index += 1) {
    fieldValues[index] = values[offset + index] ?? 0;
  }
  const fieldVectors = unpackPackedVectorsForSlot(slot, vectorOffsets, vectorLengths, vectors);
  const tensors = unpackPackedFlatValuesForSlot(slot, tensorOffsets, tensorLengths, tensorValues);
  const samples = unpackPackedSamplesForSlot(slot, sampleOffsets, sampleLengths, sampleValues, samplePoints, sampleNormals, sampleVectors);
  return {
    ...descriptor,
    id: `${descriptor.id}-frame-${frameIndex}`,
    values: fieldValues,
    min: fieldMins[slot] ?? 0,
    max: fieldMaxes[slot] ?? 0,
    frameIndex,
    timeSeconds,
    ...(tensors.length ? { tensorValues: tensors } : {}),
    ...(fieldVectors.length ? { vectors: fieldVectors } : {}),
    ...(samples.length ? { samples } : {})
  };
}

function unpackPackedVectorsForSlot(
  slot: number,
  vectorOffsets: Int32Array,
  vectorLengths: Int32Array,
  vectors: Float32Array
): NonNullable<ResultField["vectors"]> {
  const length = vectorLengths[slot] ?? 0;
  const offset = vectorOffsets[slot] ?? 0;
  const fieldVectors: NonNullable<ResultField["vectors"]> = [];
  for (let index = 0; index < length; index += 1) {
    const vectorOffset = (offset + index) * 3;
    fieldVectors.push([
      vectors[vectorOffset] ?? 0,
      vectors[vectorOffset + 1] ?? 0,
      vectors[vectorOffset + 2] ?? 0
    ]);
  }
  return fieldVectors;
}

function unpackPackedSamplesForSlot(
  slot: number,
  sampleOffsets: Int32Array,
  sampleLengths: Int32Array,
  sampleValues: Float32Array,
  samplePoints: Float32Array,
  sampleNormals: Float32Array,
  sampleVectors: Float32Array
): NonNullable<ResultField["samples"]> {
  const length = sampleLengths[slot] ?? 0;
  const offset = sampleOffsets[slot] ?? 0;
  const samples: NonNullable<ResultField["samples"]> = [];
  for (let index = 0; index < length; index += 1) {
    const sampleIndex = offset + index;
    const pointOffset = sampleIndex * 3;
    const vector: [number, number, number] = [
      sampleVectors[pointOffset] ?? 0,
      sampleVectors[pointOffset + 1] ?? 0,
      sampleVectors[pointOffset + 2] ?? 0
    ];
    samples.push({
      point: [
        samplePoints[pointOffset] ?? 0,
        samplePoints[pointOffset + 1] ?? 0,
        samplePoints[pointOffset + 2] ?? 0
      ],
      normal: [
        sampleNormals[pointOffset] ?? 0,
        sampleNormals[pointOffset + 1] ?? 0,
        sampleNormals[pointOffset + 2] ?? 0
      ],
      value: sampleValues[sampleIndex] ?? 0,
      vector
    });
  }
  return samples;
}

export function playbackFieldsForResultMode(
  fields: ResultField[],
  resultMode: ResultField["type"],
  stressComponent: ResultField["component"] = "von_mises"
): ResultField[] {
  let selected = fields.filter((field) =>
    field.type === resultMode &&
    (resultMode !== "stress" || stressComponentForField(field) === stressComponent));
  if (!selected.length && resultMode === "stress" && stressComponent !== "von_mises") {
    selected = fields.filter((field) => field.type === "stress"
      && stressComponentForField(field) === "von_mises"
      && field.tensorValues?.length === field.values.length * 6);
  }
  if (!selected.length) return fields;
  if (resultMode === "displacement" || resultMode === "mode_shape") return selected;
  const displacement = fields.filter((field) => field.type === "displacement");
  return displacement.length ? [...selected, ...displacement] : selected;
}

export function hydratePreparedPlaybackFrame(frame: PreparedPlaybackFrame): { framePosition: number; frameIndex: number; timeSeconds: number; fields: ResultField[] } {
  const cached = hydratedFrames.get(frame);
  if (cached) return cached;
  const hydrated = {
    framePosition: frame.framePosition,
    frameIndex: frame.frameIndex,
    timeSeconds: frame.timeSeconds,
    fields: frame.fields.map((field) => {
      const { tensorValues, ...fieldWithoutTensors } = field;
      return {
        ...fieldWithoutTensors,
        values: Array.prototype.slice.call(field.values) as number[],
        ...(tensorValues ? { tensorValues: Array.prototype.slice.call(tensorValues) as number[] } : {})
      };
    })
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
  if (cache.packed) {
    transferables.push(
      cache.packed.framePositions.buffer,
      cache.packed.frameIndexes.buffer,
      cache.packed.times.buffer,
      cache.packed.fieldOffsets.buffer,
      cache.packed.fieldLengths.buffer,
      cache.packed.fieldMins.buffer,
      cache.packed.fieldMaxes.buffer,
      cache.packed.values.buffer,
      cache.packed.tensorOffsets.buffer,
      cache.packed.tensorLengths.buffer,
      cache.packed.tensorValues.buffer,
      cache.packed.vectorOffsets.buffer,
      cache.packed.vectorLengths.buffer,
      cache.packed.vectors.buffer,
      cache.packed.sampleOffsets.buffer,
      cache.packed.sampleLengths.buffer,
      cache.packed.sampleValues.buffer,
      cache.packed.samplePoints.buffer,
      cache.packed.sampleNormals.buffer,
      cache.packed.sampleVectors.buffer
    );
  }
  for (const frame of cache.frames) {
    for (const field of frame.fields) {
      transferables.push(field.values.buffer);
      if (field.tensorValues) transferables.push(field.tensorValues.buffer);
    }
  }
  return transferables;
}

export function packedResultFieldsForPlaybackTransferables(packed: PackedResultFieldsForPlayback): Transferable[] {
  return [
    packed.frameIndexes.buffer,
    packed.times.buffer,
    packed.fieldOffsets.buffer,
    packed.fieldLengths.buffer,
    packed.fieldMins.buffer,
    packed.fieldMaxes.buffer,
    packed.values.buffer,
    packed.tensorOffsets.buffer,
    packed.tensorLengths.buffer,
    packed.tensorValues.buffer,
    packed.vectorOffsets.buffer,
    packed.vectorLengths.buffer,
    packed.vectors.buffer,
    packed.sampleOffsets.buffer,
    packed.sampleLengths.buffer,
    packed.sampleValues.buffer,
    packed.samplePoints.buffer,
    packed.sampleNormals.buffer,
    packed.sampleVectors.buffer
  ];
}

export function packedPreparedPlaybackFrameOrdinal(cache: PackedPreparedPlaybackCache, framePosition: number): number {
  if (!cache.frameCount) return 0;
  let bestOrdinal = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let ordinal = 0; ordinal < cache.framePositions.length; ordinal += 1) {
    const distance = Math.abs((cache.framePositions[ordinal] ?? 0) - framePosition);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    bestOrdinal = ordinal;
  }
  return bestOrdinal;
}

export function packedPreparedPlaybackFieldSlot(
  cache: PackedPreparedPlaybackCache,
  frameOrdinal: number,
  type: ResultField["type"],
  location?: ResultField["location"],
  component?: ResultField["component"]
): PackedPreparedPlaybackFieldSlot | null {
  const clampedFrameOrdinal = Math.max(0, Math.min(cache.frameCount - 1, Math.floor(frameOrdinal)));
  const fieldOrdinal = packedPreparedPlaybackFieldOrdinal(cache.fieldDescriptors, type, location, component);
  if (fieldOrdinal < 0) return null;
  const slot = clampedFrameOrdinal * cache.fieldCount + fieldOrdinal;
  const offset = cache.fieldOffsets[slot] ?? 0;
  const length = cache.fieldLengths[slot] ?? 0;
  const vectorOffset = cache.vectorOffsets[slot] ?? 0;
  const vectorLength = cache.vectorLengths[slot] ?? 0;
  const tensorOffset = cache.tensorOffsets[slot] ?? 0;
  const tensorLength = cache.tensorLengths[slot] ?? 0;
  const sampleOffset = cache.sampleOffsets[slot] ?? 0;
  const sampleLength = cache.sampleLengths[slot] ?? 0;
  return {
    descriptor: cache.fieldDescriptors[fieldOrdinal]!,
    offset,
    length,
    min: cache.fieldMins[slot] ?? 0,
    max: cache.fieldMaxes[slot] ?? 0,
    values: cache.values,
    tensorOffset,
    tensorLength,
    tensorValues: cache.tensorValues,
    vectorOffset,
    vectorLength,
    vectors: cache.vectors,
    sampleOffset,
    sampleLength,
    sampleValues: cache.sampleValues,
    samplePoints: cache.samplePoints,
    sampleNormals: cache.sampleNormals,
    sampleVectors: cache.sampleVectors
  };
}

function packedPreparedPlaybackFieldOrdinal(
  descriptors: PackedPreparedPlaybackFieldDescriptor[],
  type: ResultField["type"],
  location?: ResultField["location"],
  component?: ResultField["component"]
): number {
  const matchesComponent = (descriptor: PackedPreparedPlaybackFieldDescriptor) =>
    type !== "stress" || (descriptor.component ?? "von_mises") === (component ?? "von_mises");
  if (location) {
    const exact = descriptors.findIndex((descriptor) => descriptor.type === type && descriptor.location === location && matchesComponent(descriptor));
    if (exact >= 0) return exact;
  }
  const face = descriptors.findIndex((descriptor) => descriptor.type === type && descriptor.location === "face" && matchesComponent(descriptor));
  if (face >= 0) return face;
  const nodeOrSample = descriptors.findIndex((descriptor) => descriptor.type === type && descriptor.location === "node" && matchesComponent(descriptor));
  if (nodeOrSample >= 0) return nodeOrSample;
  return descriptors.findIndex((descriptor) => descriptor.type === type && matchesComponent(descriptor));
}

function packPreparedPlaybackFrames(frames: PreparedPlaybackFrame[]): PackedPreparedPlaybackCache | undefined {
  const firstFrame = frames[0];
  if (!firstFrame?.fields.length) return undefined;
  const descriptors = firstFrame.fields.map((field) => descriptorForPackedPlaybackField(field));
  const frameCount = frames.length;
  const fieldCount = descriptors.length;
  const framePositions = new Float32Array(frameCount);
  const frameIndexes = new Int32Array(frameCount);
  const times = new Float32Array(frameCount);
  const fieldOffsets = new Int32Array(frameCount * fieldCount);
  const fieldLengths = new Int32Array(frameCount * fieldCount);
  const fieldMins = new Float32Array(frameCount * fieldCount);
  const fieldMaxes = new Float32Array(frameCount * fieldCount);
  const vectorOffsets = new Int32Array(frameCount * fieldCount);
  const tensorOffsets = new Int32Array(frameCount * fieldCount);
  const tensorLengths = new Int32Array(frameCount * fieldCount);
  const vectorLengths = new Int32Array(frameCount * fieldCount);
  const sampleOffsets = new Int32Array(frameCount * fieldCount);
  const sampleLengths = new Int32Array(frameCount * fieldCount);
  let valueCount = 0;
  let tensorCount = 0;
  let vectorCount = 0;
  let sampleCount = 0;

  for (let frameOrdinal = 0; frameOrdinal < frameCount; frameOrdinal += 1) {
    const frame = frames[frameOrdinal]!;
    framePositions[frameOrdinal] = frame.framePosition;
    frameIndexes[frameOrdinal] = frame.frameIndex;
    times[frameOrdinal] = frame.timeSeconds;
    for (let fieldOrdinal = 0; fieldOrdinal < fieldCount; fieldOrdinal += 1) {
      const field = frame.fields[fieldOrdinal];
      const slot = frameOrdinal * fieldCount + fieldOrdinal;
      fieldOffsets[slot] = valueCount;
      fieldLengths[slot] = field?.values.length ?? 0;
      fieldMins[slot] = field?.min ?? 0;
      fieldMaxes[slot] = field?.max ?? 0;
      vectorOffsets[slot] = vectorCount;
      tensorOffsets[slot] = tensorCount;
      tensorLengths[slot] = field?.tensorValues?.length ?? 0;
      vectorLengths[slot] = field?.vectors?.length ?? 0;
      sampleOffsets[slot] = sampleCount;
      sampleLengths[slot] = field?.samples?.length ?? 0;
      valueCount += field?.values.length ?? 0;
      tensorCount += field?.tensorValues?.length ?? 0;
      vectorCount += field?.vectors?.length ?? 0;
      sampleCount += field?.samples?.length ?? 0;
    }
  }

  const values = new Float32Array(valueCount);
  const tensorValues = new Float32Array(tensorCount);
  const vectors = new Float32Array(vectorCount * 3);
  const sampleValues = new Float32Array(sampleCount);
  const samplePoints = new Float32Array(sampleCount * 3);
  const sampleNormals = new Float32Array(sampleCount * 3);
  const sampleVectors = new Float32Array(sampleCount * 3);
  for (let frameOrdinal = 0; frameOrdinal < frameCount; frameOrdinal += 1) {
    const frame = frames[frameOrdinal]!;
    for (let fieldOrdinal = 0; fieldOrdinal < fieldCount; fieldOrdinal += 1) {
      const field = frame.fields[fieldOrdinal];
      if (!field) continue;
      const slot = frameOrdinal * fieldCount + fieldOrdinal;
      values.set(field.values, fieldOffsets[slot]);
      if (field.tensorValues) tensorValues.set(field.tensorValues, tensorOffsets[slot]);
      const fieldVectors = field.vectors ?? [];
      const vectorOffset = vectorOffsets[slot] ?? 0;
      for (let vectorIndex = 0; vectorIndex < fieldVectors.length; vectorIndex += 1) {
        vectors.set(fieldVectors[vectorIndex] ?? [0, 0, 0], (vectorOffset + vectorIndex) * 3);
      }
      const samples = field.samples ?? [];
      const sampleOffset = sampleOffsets[slot] ?? 0;
      for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
        const sample = samples[sampleIndex]!;
        const targetIndex = sampleOffset + sampleIndex;
        sampleValues[targetIndex] = sample.value;
        samplePoints.set(sample.point, targetIndex * 3);
        sampleNormals.set(sample.normal, targetIndex * 3);
        sampleVectors.set(sample.vector ?? [0, 0, 0], targetIndex * 3);
      }
    }
  }

  return {
    frameCount,
    fieldCount,
    framePositions,
    frameIndexes,
    times,
    fieldDescriptors: descriptors,
    fieldOffsets,
    fieldLengths,
    fieldMins,
    fieldMaxes,
    values,
    tensorOffsets,
    tensorLengths,
    tensorValues,
    vectorOffsets,
    vectorLengths,
    vectors,
    sampleOffsets,
    sampleLengths,
    sampleValues,
    samplePoints,
    sampleNormals,
    sampleVectors,
    actualBytes: framePositions.byteLength + frameIndexes.byteLength + times.byteLength + fieldOffsets.byteLength + fieldLengths.byteLength + fieldMins.byteLength + fieldMaxes.byteLength + values.byteLength + tensorOffsets.byteLength + tensorLengths.byteLength + tensorValues.byteLength + vectorOffsets.byteLength + vectorLengths.byteLength + vectors.byteLength + sampleOffsets.byteLength + sampleLengths.byteLength + sampleValues.byteLength + samplePoints.byteLength + sampleNormals.byteLength + sampleVectors.byteLength
  };
}

function descriptorForPackedPlaybackField(field: Pick<ResultField, "id" | "runId" | "variantId" | "type" | "component" | "modeIndex" | "frequencyHz" | "eigenvalue" | "scaledResidual" | "location" | "units" | "surfaceMeshRef" | "visualizationSource" | "engineeringSource" | "provenance">): PackedPreparedPlaybackFieldDescriptor {
  return {
    id: field.id,
    runId: field.runId,
    ...(field.variantId ? { variantId: field.variantId } : {}),
    type: field.type,
    ...(field.component ? { component: field.component } : {}),
    ...(field.modeIndex !== undefined ? { modeIndex: field.modeIndex } : {}),
    ...(field.frequencyHz !== undefined ? { frequencyHz: field.frequencyHz } : {}),
    ...(field.eigenvalue !== undefined ? { eigenvalue: field.eigenvalue } : {}),
    ...(field.scaledResidual !== undefined ? { scaledResidual: field.scaledResidual } : {}),
    location: field.location,
    units: field.units,
    ...(field.surfaceMeshRef ? { surfaceMeshRef: field.surfaceMeshRef } : {}),
    ...(field.visualizationSource ? { visualizationSource: field.visualizationSource } : {}),
    ...(field.engineeringSource ? { engineeringSource: field.engineeringSource } : {}),
    ...(field.provenance ? { provenance: field.provenance } : {})
  };
}

function unpackPackedFlatValuesForSlot(slot: number, offsets: Int32Array, lengths: Int32Array, values: Float32Array): number[] {
  const offset = offsets[slot] ?? 0;
  const length = lengths[slot] ?? 0;
  return Array.from(values.subarray(offset, offset + length));
}

function normalizedFrameIndexes(frameIndexes: number[]): number[] {
  return [...new Set(frameIndexes.filter((frameIndex) => Number.isFinite(frameIndex)).map((frameIndex) => Math.floor(frameIndex)))]
    .sort((left, right) => left - right);
}

function fieldsForPlaybackInput(input: PlaybackFrameCacheInput): ResultField[] {
  if (input.packedFields) return unpackResultFieldsForPlayback(input.packedFields);
  return input.fields ?? [];
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
  const tensorCount = visibleFields.reduce((total, field) => total + (field.tensorValues?.length ?? 0), 0);
  const sampleCount = visibleFields.reduce((total, field) => total + (field.samples?.length ?? 0), 0);
  return Math.max(1, valueCount + tensorCount) * Float64Array.BYTES_PER_ELEMENT + sampleCount * 10 * Float32Array.BYTES_PER_ELEMENT;
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
