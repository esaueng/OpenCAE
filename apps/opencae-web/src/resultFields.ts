import type { DisplayFace, ResultField, ResultSummary } from "@opencae/schema";

export type ResultFieldMode = "stress" | "displacement" | "safety_factor" | "velocity" | "acceleration";

export interface FaceResultSample {
  face: DisplayFace;
  value: number;
  normalized: number;
  fieldSamples?: FieldResultSample[];
  diagnostic?: string;
}

export interface FieldResultSample {
  point: [number, number, number];
  normal: [number, number, number];
  value: number;
  normalized: number;
  vector?: [number, number, number];
}

export type ResultProbeTone = "max" | "mid" | "min";

export interface FaceResultProbeSample {
  face: DisplayFace;
  value: number;
  label: string;
  tone: ResultProbeTone;
}

export function resultFrameIndexes(fields: ResultField[]): number[] {
  return [...new Set(fields.map((field) => field.frameIndex ?? 0))].sort((left, right) => left - right);
}

export interface DynamicPlaybackFrame {
  frameIndex: number;
  timeSeconds: number;
}

export function dynamicPlaybackFrames(fields: ResultField[]): DynamicPlaybackFrame[] {
  const frames = new Map<number, number>();
  for (const field of fields) {
    if (typeof field.frameIndex !== "number" || !Number.isFinite(field.frameIndex)) continue;
    if (typeof field.timeSeconds !== "number" || !Number.isFinite(field.timeSeconds)) continue;
    frames.set(field.frameIndex, field.timeSeconds);
  }
  return [...frames.entries()]
    .map(([frameIndex, timeSeconds]) => ({ frameIndex, timeSeconds }))
    .sort((left, right) => left.frameIndex - right.frameIndex);
}

export function hasDynamicPlaybackFrames(summary: Pick<ResultSummary, "transient">, fields: ResultField[]): boolean {
  if (!summary.transient || !Number.isFinite(summary.transient.frameCount) || summary.transient.frameCount <= 1) return false;
  const framedFields = fields.filter((field) => typeof field.frameIndex === "number");
  if (!framedFields.length) return false;
  const frameIndexes = new Set<number>();
  for (const field of framedFields) {
    const frameIndex = field.frameIndex;
    if (typeof frameIndex !== "number" || !Number.isFinite(frameIndex)) return false;
    if (typeof field.timeSeconds !== "number" || !Number.isFinite(field.timeSeconds)) return false;
    frameIndexes.add(frameIndex);
  }
  return frameIndexes.size > 1 && dynamicPlaybackFrames(fields).length > 1;
}

export interface ResultFrameCache {
  frameIndexes: number[];
  fieldsForFrame: (frameIndex: number) => ResultField[];
  fieldsForFramePosition: (framePosition: number) => ResultField[];
  timeForFramePosition: (framePosition: number) => number;
}

export interface PackedResultPlaybackFieldDescriptor {
  id: string;
  runId: string;
  type: ResultField["type"];
  location: ResultField["location"];
  units: string;
}

export interface PackedResultPlaybackCache {
  frameCount: number;
  fieldCount: number;
  valueCount: number;
  sampleCount: number;
  frameIndexes: Int32Array;
  times: Float32Array;
  fieldDescriptors: PackedResultPlaybackFieldDescriptor[];
  fieldOffsets: Int32Array;
  fieldLengths: Int32Array;
  fieldMins: Float32Array;
  fieldMaxes: Float32Array;
  values: Float32Array;
  sampleOffsets: Int32Array;
  sampleLengths: Int32Array;
  sampleValues: Float32Array;
  samplePoints: Float32Array;
  sampleNormals: Float32Array;
  sampleVectors: Float32Array;
  estimatedBytes: number;
  fieldsForFrame: (frameIndex: number) => ResultField[];
  fieldsForFramePosition: (framePosition: number) => ResultField[];
  timeForFramePosition: (framePosition: number) => number;
}

export function createResultFrameCache(fields: ResultField[]): ResultFrameCache {
  const normalizedFields = normalizeTransientFieldRanges(fields);
  const frameIndexes = resultFrameIndexes(normalizedFields);
  const hasFrames = normalizedFields.some((field) => typeof field.frameIndex === "number");
  const fieldsByFrame = new Map<number, ResultField[]>();
  const fieldMapsByFrame = new Map<number, Map<string, ResultField>>();
  const frameTimes = new Map<number, number>();
  if (!hasFrames) {
    const visible = normalizedFields.map((field) => fieldWithOwnValueRange(field));
    return {
      frameIndexes,
      fieldsForFrame: () => visible,
      fieldsForFramePosition: () => visible,
      timeForFramePosition: () => 0
    };
  }
  for (const field of normalizedFields) {
    const frameIndex = field.frameIndex ?? 0;
    const visibleField = fieldWithOwnValueRange(field);
    const frameFields = fieldsByFrame.get(frameIndex) ?? [];
    frameFields.push(visibleField);
    fieldsByFrame.set(frameIndex, frameFields);
    const frameFieldMap = fieldMapsByFrame.get(frameIndex) ?? new Map<string, ResultField>();
    frameFieldMap.set(fieldSeriesKey(visibleField), visibleField);
    fieldMapsByFrame.set(frameIndex, frameFieldMap);
    if (typeof field.timeSeconds === "number" && Number.isFinite(field.timeSeconds)) {
      frameTimes.set(frameIndex, field.timeSeconds);
    }
  }
  const fallbackFrame = frameIndexes[0] ?? 0;
  const fieldsForFrame = (frameIndex: number) => fieldsByFrame.get(frameIndex) ?? fieldsByFrame.get(fallbackFrame) ?? [];
  return {
    frameIndexes,
    fieldsForFrame,
    fieldsForFramePosition: (framePosition) => interpolatedFieldsForCachedFramePosition(frameIndexes, fieldsForFrame, fieldMapsByFrame, framePosition),
    timeForFramePosition: (framePosition) => interpolatedTimeForFramePosition(frameIndexes, frameTimes, framePosition)
  };
}

export function createPackedResultPlaybackCache(fields: ResultField[]): PackedResultPlaybackCache | null {
  const normalizedFields = normalizeTransientFieldRanges(fields);
  const frameIndexes = resultFrameIndexes(normalizedFields);
  if (frameIndexes.length < 2 || !normalizedFields.some((field) => typeof field.frameIndex === "number")) return null;

  const fieldsByFrame = new Map<number, ResultField[]>();
  const fieldMapsByFrame = new Map<number, Map<string, ResultField>>();
  const frameTimes = new Map<number, number>();
  const descriptorKeys: string[] = [];
  const descriptorKeySet = new Set<string>();
  for (const field of normalizedFields) {
    const frameIndex = field.frameIndex ?? 0;
    const frameFields = fieldsByFrame.get(frameIndex) ?? [];
    frameFields.push(field);
    fieldsByFrame.set(frameIndex, frameFields);
    const frameFieldMap = fieldMapsByFrame.get(frameIndex) ?? new Map<string, ResultField>();
    const key = fieldSeriesKey(field);
    frameFieldMap.set(key, field);
    fieldMapsByFrame.set(frameIndex, frameFieldMap);
    if (!descriptorKeySet.has(key)) {
      descriptorKeySet.add(key);
      descriptorKeys.push(key);
    }
    if (typeof field.timeSeconds === "number" && Number.isFinite(field.timeSeconds)) {
      frameTimes.set(frameIndex, field.timeSeconds);
    }
  }
  if (!descriptorKeys.length) return null;

  const frameCount = frameIndexes.length;
  const fieldCount = descriptorKeys.length;
  const frameIndexArray = new Int32Array(frameIndexes);
  const times = new Float32Array(frameCount);
  const fieldOffsets = new Int32Array(frameCount * fieldCount);
  const fieldLengths = new Int32Array(frameCount * fieldCount);
  const fieldMins = new Float32Array(frameCount * fieldCount);
  const fieldMaxes = new Float32Array(frameCount * fieldCount);
  const sampleOffsets = new Int32Array(frameCount * fieldCount);
  const sampleLengths = new Int32Array(frameCount * fieldCount);
  const descriptors: PackedResultPlaybackFieldDescriptor[] = [];
  let valueCount = 0;
  let sampleCount = 0;

  for (let frameOrdinal = 0; frameOrdinal < frameCount; frameOrdinal += 1) {
    const frameIndex = frameIndexes[frameOrdinal] ?? 0;
    times[frameOrdinal] = frameTimes.get(frameIndex) ?? 0;
    const frameFieldMap = fieldMapsByFrame.get(frameIndex);
    for (let fieldOrdinal = 0; fieldOrdinal < fieldCount; fieldOrdinal += 1) {
      const field = frameFieldMap?.get(descriptorKeys[fieldOrdinal]!);
      const slot = frameOrdinal * fieldCount + fieldOrdinal;
      fieldOffsets[slot] = valueCount;
      fieldLengths[slot] = field?.values.length ?? 0;
      fieldMins[slot] = field ? Number(field.min) : 0;
      fieldMaxes[slot] = field ? Number(field.max) : 0;
      sampleOffsets[slot] = sampleCount;
      sampleLengths[slot] = field?.samples?.length ?? 0;
      valueCount += field?.values.length ?? 0;
      sampleCount += field?.samples?.length ?? 0;
      if (frameOrdinal === 0) {
        const descriptorField = field ?? firstFieldForSeries(fieldMapsByFrame, descriptorKeys[fieldOrdinal]!);
        if (descriptorField) {
          descriptors[fieldOrdinal] = {
            id: descriptorField.id,
            runId: descriptorField.runId,
            type: descriptorField.type,
            location: descriptorField.location,
            units: descriptorField.units
          };
        }
      }
    }
  }

  const values = new Float32Array(valueCount);
  const sampleValues = new Float32Array(sampleCount);
  const samplePoints = new Float32Array(sampleCount * 3);
  const sampleNormals = new Float32Array(sampleCount * 3);
  const sampleVectors = new Float32Array(sampleCount * 3);
  for (let frameOrdinal = 0; frameOrdinal < frameCount; frameOrdinal += 1) {
    const frameIndex = frameIndexes[frameOrdinal] ?? 0;
    const frameFieldMap = fieldMapsByFrame.get(frameIndex);
    for (let fieldOrdinal = 0; fieldOrdinal < fieldCount; fieldOrdinal += 1) {
      const field = frameFieldMap?.get(descriptorKeys[fieldOrdinal]!);
      if (!field) continue;
      const slot = frameOrdinal * fieldCount + fieldOrdinal;
      values.set(field.values, fieldOffsets[slot]);
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

  const fieldsForFrameOrdinal = (frameOrdinal: number): ResultField[] => {
    const clampedOrdinal = Math.max(0, Math.min(frameCount - 1, frameOrdinal));
    const frameIndex = frameIndexArray[clampedOrdinal] ?? 0;
    return descriptors.map((descriptor, fieldOrdinal) => unpackFieldForSlot(
      descriptor,
      frameIndex,
      times[clampedOrdinal] ?? 0,
      clampedOrdinal * fieldCount + fieldOrdinal,
      fieldOffsets,
      fieldLengths,
      fieldMins,
      fieldMaxes,
      values,
      sampleOffsets,
      sampleLengths,
      sampleValues,
      samplePoints,
      sampleNormals,
      sampleVectors
    ));
  };

  const fieldsForFramePosition = (framePosition: number): ResultField[] => {
    if (frameCount < 2) return fieldsForFrameOrdinal(0);
    const { lowerOrdinal, upperOrdinal, blend } = interpolationOrdinalsForFramePosition(frameIndexArray, framePosition);
    if (lowerOrdinal === upperOrdinal) return fieldsForFrameOrdinal(lowerOrdinal);
    const frameIndex = framePosition;
    const timeSeconds = lerp(times[lowerOrdinal] ?? 0, times[upperOrdinal] ?? times[lowerOrdinal] ?? 0, blend);
    return descriptors.map((descriptor, fieldOrdinal) => {
      const lowerSlot = lowerOrdinal * fieldCount + fieldOrdinal;
      const upperSlot = upperOrdinal * fieldCount + fieldOrdinal;
      return unpackInterpolatedFieldForSlots(
        descriptor,
        frameIndex,
        timeSeconds,
        lowerSlot,
        upperSlot,
        blend,
        fieldOffsets,
        fieldLengths,
        fieldMins,
        fieldMaxes,
        values,
        sampleOffsets,
        sampleLengths,
        sampleValues,
        samplePoints,
        sampleNormals,
        sampleVectors
      );
    });
  };

  return {
    frameCount,
    fieldCount,
    valueCount,
    sampleCount,
    frameIndexes: frameIndexArray,
    times,
    fieldDescriptors: descriptors,
    fieldOffsets,
    fieldLengths,
    fieldMins,
    fieldMaxes,
    values,
    sampleOffsets,
    sampleLengths,
    sampleValues,
    samplePoints,
    sampleNormals,
    sampleVectors,
    estimatedBytes: frameIndexArray.byteLength + times.byteLength + fieldOffsets.byteLength + fieldLengths.byteLength + fieldMins.byteLength + fieldMaxes.byteLength + values.byteLength + sampleOffsets.byteLength + sampleLengths.byteLength + sampleValues.byteLength + samplePoints.byteLength + sampleNormals.byteLength + sampleVectors.byteLength,
    fieldsForFrame: (frameIndex) => {
      const ordinal = indexOfFrame(frameIndexArray, frameIndex);
      return fieldsForFrameOrdinal(ordinal >= 0 ? ordinal : 0);
    },
    fieldsForFramePosition,
    timeForFramePosition: (framePosition) => {
      const { lowerOrdinal, upperOrdinal, blend } = interpolationOrdinalsForFramePosition(frameIndexArray, framePosition);
      return lerp(times[lowerOrdinal] ?? 0, times[upperOrdinal] ?? times[lowerOrdinal] ?? 0, blend);
    }
  };
}

export function packedResultPlaybackTransferables(cache: PackedResultPlaybackCache): Transferable[] {
  return [
    cache.frameIndexes.buffer,
    cache.times.buffer,
    cache.fieldOffsets.buffer,
    cache.fieldLengths.buffer,
    cache.fieldMins.buffer,
    cache.fieldMaxes.buffer,
    cache.values.buffer,
    cache.sampleOffsets.buffer,
    cache.sampleLengths.buffer,
    cache.sampleValues.buffer,
    cache.samplePoints.buffer,
    cache.sampleNormals.buffer,
    cache.sampleVectors.buffer
  ];
}

export function nextLoopedResultFrameIndex(frameIndexes: number[], currentFrameIndex: number): number {
  if (!frameIndexes.length) return 0;
  const currentIndex = frameIndexes.indexOf(currentFrameIndex);
  if (currentIndex < 0) return frameIndexes[0] ?? 0;
  return frameIndexes[(currentIndex + 1) % frameIndexes.length] ?? 0;
}

export function fieldsForResultFrame(fields: ResultField[], frameIndex: number): ResultField[] {
  const normalizedFields = normalizeTransientFieldRanges(fields);
  const hasFrames = normalizedFields.some((field) => typeof field.frameIndex === "number");
  if (!hasFrames) return normalizedFields;
  return normalizedFields
    .filter((field) => (field.frameIndex ?? 0) === frameIndex)
    .map((field) => fieldWithOwnValueRange(field));
}

export function interpolatedFieldsForFramePosition(fields: ResultField[], framePosition: number): ResultField[] {
  return createResultFrameCache(fields).fieldsForFramePosition(framePosition);
}

export function normalizeTransientFieldRanges(fields: ResultField[]): ResultField[] {
  const rangesByGroup = new Map<string, { min: number; max: number; transient: boolean; type: ResultField["type"] }>();
  for (const field of fields) {
    const transient = isTransientField(field);
    if (!transient) continue;
    const key = transientFieldRangeKey(field);
    const existing = rangesByGroup.get(key) ?? { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, transient, type: field.type };
    for (const value of finiteFieldValues(field)) {
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
    }
    rangesByGroup.set(key, existing);
  }
  return fields.map((field) => {
    if (!isTransientField(field)) return field;
    const range = rangesByGroup.get(transientFieldRangeKey(field));
    if (!range?.transient || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return field;
    const normalizedRange = normalizedRangeForFieldType(range.type, range.min, range.max);
    if (field.min === normalizedRange.min && field.max === normalizedRange.max) return field;
    return {
      ...field,
      min: normalizedRange.min,
      max: normalizedRange.max
    };
  });
}

function interpolatedFieldsForCachedFramePosition(
  frameIndexes: number[],
  fieldsForFrame: (frameIndex: number) => ResultField[],
  fieldMapsByFrame: Map<number, Map<string, ResultField>>,
  framePosition: number
): ResultField[] {
  if (frameIndexes.length < 2) return fieldsForFrame(Math.round(framePosition));
  const { lowerFrame, upperFrame, blend } = interpolationBoundsForFramePosition(frameIndexes, framePosition);
  if (lowerFrame === upperFrame) return fieldsForFrame(lowerFrame);
  const lowerFields = fieldsForFrame(lowerFrame);
  const upperFieldMap = fieldMapsByFrame.get(upperFrame);
  return lowerFields.map((lowerField) => {
    const upperField = upperFieldMap?.get(fieldSeriesKey(lowerField));
    if (!upperField) return lowerField;
    return fieldWithOwnValueRange(interpolateField(lowerField, upperField, blend, framePosition));
  });
}

function interpolatedTimeForFramePosition(frameIndexes: number[], frameTimes: Map<number, number>, framePosition: number): number {
  if (!frameIndexes.length) return 0;
  if (frameIndexes.length < 2) return frameTimes.get(frameIndexes[0] ?? 0) ?? 0;
  const { lowerFrame, upperFrame, blend } = interpolationBoundsForFramePosition(frameIndexes, framePosition);
  const lowerTime = frameTimes.get(lowerFrame) ?? 0;
  const upperTime = frameTimes.get(upperFrame) ?? lowerTime;
  return lerp(lowerTime, upperTime, blend);
}

function firstFieldForSeries(fieldMapsByFrame: Map<number, Map<string, ResultField>>, key: string): ResultField | undefined {
  for (const fieldMap of fieldMapsByFrame.values()) {
    const field = fieldMap.get(key);
    if (field) return field;
  }
  return undefined;
}

function indexOfFrame(frameIndexes: Int32Array, frameIndex: number): number {
  for (let index = 0; index < frameIndexes.length; index += 1) {
    if (frameIndexes[index] === frameIndex) return index;
  }
  return -1;
}

function interpolationOrdinalsForFramePosition(frameIndexes: Int32Array, framePosition: number) {
  let lowerOrdinal = 0;
  let upperOrdinal = frameIndexes.length - 1;
  for (let ordinal = 0; ordinal < frameIndexes.length; ordinal += 1) {
    const frameIndex = frameIndexes[ordinal] ?? 0;
    if (frameIndex <= framePosition) lowerOrdinal = ordinal;
    if (frameIndex >= framePosition) {
      upperOrdinal = ordinal;
      break;
    }
  }
  const lowerFrame = frameIndexes[lowerOrdinal] ?? 0;
  const upperFrame = frameIndexes[upperOrdinal] ?? lowerFrame;
  const blend = lowerFrame === upperFrame ? 0 : (framePosition - lowerFrame) / (upperFrame - lowerFrame);
  return { lowerOrdinal, upperOrdinal, blend };
}

function unpackFieldForSlot(
  descriptor: PackedResultPlaybackFieldDescriptor,
  frameIndex: number,
  timeSeconds: number,
  slot: number,
  fieldOffsets: Int32Array,
  fieldLengths: Int32Array,
  fieldMins: Float32Array,
  fieldMaxes: Float32Array,
  values: Float32Array,
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
  const samples = unpackSamplesForSlot(slot, sampleOffsets, sampleLengths, sampleValues, samplePoints, sampleNormals, sampleVectors);
  return {
    ...descriptor,
    id: `${descriptor.id}-frame-${frameIndex}`,
    values: fieldValues,
    min: fieldMins[slot] ?? 0,
    max: fieldMaxes[slot] ?? 0,
    frameIndex,
    timeSeconds,
    ...(samples.length ? { samples } : {})
  };
}

function unpackInterpolatedFieldForSlots(
  descriptor: PackedResultPlaybackFieldDescriptor,
  frameIndex: number,
  timeSeconds: number,
  lowerSlot: number,
  upperSlot: number,
  blend: number,
  fieldOffsets: Int32Array,
  fieldLengths: Int32Array,
  fieldMins: Float32Array,
  fieldMaxes: Float32Array,
  values: Float32Array,
  sampleOffsets: Int32Array,
  sampleLengths: Int32Array,
  sampleValues: Float32Array,
  samplePoints: Float32Array,
  sampleNormals: Float32Array,
  sampleVectors: Float32Array
): ResultField {
  const lowerLength = fieldLengths[lowerSlot] ?? 0;
  const upperLength = fieldLengths[upperSlot] ?? 0;
  const count = Math.max(lowerLength, upperLength);
  const lowerOffset = fieldOffsets[lowerSlot] ?? 0;
  const upperOffset = fieldOffsets[upperSlot] ?? 0;
  const fieldValues = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    const lowerValue = index < lowerLength ? values[lowerOffset + index] ?? 0 : values[upperOffset + index] ?? 0;
    const upperValue = index < upperLength ? values[upperOffset + index] ?? 0 : values[lowerOffset + index] ?? 0;
    fieldValues[index] = lerp(lowerValue, upperValue, blend);
  }
  const lowerSamples = unpackSamplesForSlot(lowerSlot, sampleOffsets, sampleLengths, sampleValues, samplePoints, sampleNormals, sampleVectors);
  const upperSamples = unpackSamplesForSlot(upperSlot, sampleOffsets, sampleLengths, sampleValues, samplePoints, sampleNormals, sampleVectors);
  const samples = lowerSamples.length && upperSamples.length ? interpolateSamples(lowerSamples, upperSamples, blend) : lowerSamples;
  return {
    ...descriptor,
    id: `${descriptor.id}-visual-${framePositionId(frameIndex)}`,
    values: fieldValues,
    min: lerp(fieldMins[lowerSlot] ?? 0, fieldMins[upperSlot] ?? fieldMins[lowerSlot] ?? 0, blend),
    max: lerp(fieldMaxes[lowerSlot] ?? 0, fieldMaxes[upperSlot] ?? fieldMaxes[lowerSlot] ?? 0, blend),
    frameIndex,
    timeSeconds,
    ...(samples.length ? { samples } : {})
  };
}

function unpackSamplesForSlot(
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

function framePositionId(framePosition: number): string {
  return Number.isInteger(framePosition) ? String(framePosition) : framePosition.toFixed(3);
}

function interpolationBoundsForFramePosition(frameIndexes: number[], framePosition: number) {
  let lowerFrame = frameIndexes[0]!;
  let upperFrame = frameIndexes[frameIndexes.length - 1]!;
  for (const frameIndex of frameIndexes) {
    if (frameIndex <= framePosition) lowerFrame = frameIndex;
    if (frameIndex >= framePosition) {
      upperFrame = frameIndex;
      break;
    }
  }
  const blend = lowerFrame === upperFrame ? 0 : (framePosition - lowerFrame) / (upperFrame - lowerFrame);
  return { lowerFrame, upperFrame, blend };
}

export function resultSamplesForFaces(faces: DisplayFace[], fields: ResultField[], mode: ResultFieldMode): FaceResultSample[] {
  const field = resultFieldForMode(fields, mode);
  const mapped = field ? mappedValuesForFaces(faces, field, mode) : {
    values: faces.map((face) => fallbackValue(face, mode)),
    diagnostic: undefined
  };
  const min = Number.isFinite(field?.min) ? Number(field?.min) : Math.min(...mapped.values);
  const max = Number.isFinite(field?.max) ? Number(field?.max) : Math.max(...mapped.values);
  const fieldSamples = field?.samples?.map((sample) => ({
    point: sample.point,
    normal: sample.normal,
    value: sample.value,
    normalized: normalizeValueForRender(sample.value, min, max),
    ...(sample.vector ? { vector: sample.vector } : {})
  }));
  return faces.map((face, index) => ({
    face,
    value: mapped.values[index] ?? 0,
    normalized: normalizeValueForRender(mapped.values[index] ?? 0, min, max),
    ...(fieldSamples?.length ? { fieldSamples } : {}),
    ...(mapped.diagnostic ? { diagnostic: mapped.diagnostic } : {})
  }));
}

export function resultProbeSamplesForFaces(faces: DisplayFace[], fields: ResultField[], mode: ResultFieldMode): FaceResultProbeSample[] {
  const field = resultFieldForMode(fields, mode);
  if (!field?.values.length) return [];
  const samples = resultSamplesForFaces(faces, fields, mode)
    .filter((sample) => Number.isFinite(sample.value))
    .sort((left, right) => {
      const difference = mode === "safety_factor" ? left.value - right.value : right.value - left.value;
      return Math.abs(difference) > 1e-9 ? difference : left.face.id.localeCompare(right.face.id);
    });
  if (!samples.length) return [];
  const midIndex = Math.max(0, Math.ceil(samples.length / 2) - 1);
  const picks = [
    { sample: samples[0]!, tone: "max" as const },
    { sample: samples[midIndex]!, tone: "mid" as const },
    { sample: samples[samples.length - 1]!, tone: "min" as const }
  ];
  return picks.map(({ sample, tone }) => ({
    face: sample.face,
    value: sample.value,
    label: resultProbeLabel(mode, sample.value, field.units),
    tone
  }));
}

function resultFieldForMode(fields: ResultField[], mode: ResultFieldMode): ResultField | undefined {
  return fields.find((candidate) => candidate.type === mode && candidate.location === "face")
    ?? fields.find((candidate) => candidate.type === mode && candidate.samples?.length)
    ?? fields.find((candidate) => candidate.type === mode);
}

function mappedValuesForFaces(faces: DisplayFace[], field: ResultField, mode: ResultFieldMode): { values: number[]; diagnostic?: string } {
  if (field.location === "face" && field.values.length === faces.length) {
    return { values: faces.map((_, index) => finiteOrNeutral(field.values[index], mode)) };
  }
  if (field.samples?.length) {
    const values = faces.map((face) => interpolatedFieldSampleValue(face.center, field.samples!, mode));
    const faceBounds = displayFaceBounds(faces);
    const bounds = sampleBounds(field.samples);
    const diagnostic = coordinateSpaceDiagnostic(bounds, faceBounds);
    logDebugResultMapping(field, mode, bounds, faceBounds, values);
    return { values, ...(diagnostic ? { diagnostic } : {}) };
  }
  return {
    values: faces.map(() => neutralValue(mode)),
    diagnostic: `Solver ${field.location} ${field.type} field cannot be mapped to display faces without sample coordinates.`
  };
}

function sampleBounds(samples: NonNullable<ResultField["samples"]>) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const sample of samples) {
    for (const axis of [0, 1, 2] as const) {
      const coordinate = sample.point[axis] ?? 0;
      min[axis] = Math.min(min[axis], coordinate);
      max[axis] = Math.max(max[axis], coordinate);
    }
  }
  return { min, max };
}

function displayFaceBounds(faces: DisplayFace[]) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const face of faces) {
    for (const axis of [0, 1, 2] as const) {
      const coordinate = face.center[axis] ?? 0;
      min[axis] = Math.min(min[axis], coordinate);
      max[axis] = Math.max(max[axis], coordinate);
    }
  }
  return { min, max };
}

function coordinateSpaceDiagnostic(
  sample: { min: [number, number, number]; max: [number, number, number] },
  face: { min: [number, number, number]; max: [number, number, number] }
) {
  const sampleExtent = boundsExtent(sample);
  const faceExtent = boundsExtent(face);
  if (!Number.isFinite(sampleExtent) || !Number.isFinite(faceExtent) || sampleExtent <= 1e-12 || faceExtent <= 1e-12) return undefined;
  const ratio = Math.max(sampleExtent / faceExtent, faceExtent / sampleExtent);
  return ratio > 25 ? "Result samples appear to be in a different coordinate space than the display model." : undefined;
}

function boundsExtent(bounds: { min: [number, number, number]; max: [number, number, number] }) {
  return Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
}

function logDebugResultMapping(
  field: ResultField,
  mode: ResultFieldMode,
  bounds: { min: [number, number, number]; max: [number, number, number] },
  faceBounds: { min: [number, number, number]; max: [number, number, number] },
  values: number[]
) {
  if (typeof window === "undefined") return;
  if (new URLSearchParams(window.location.search).get("debugResults") !== "1") return;
  console.info("[OpenCAE debugResults] result sample face mapping", {
    mode,
    fieldId: field.id,
    sampleBounds: bounds,
    displayFaceBounds: faceBounds,
    fieldMin: field.min,
    fieldMax: field.max,
    mappedFaceValues: values.slice(0, 8)
  });
}

function fallbackValue(face: DisplayFace, mode: ResultFieldMode): number {
  if (mode === "displacement") return face.stressValue / 770;
  if (mode === "velocity") return 0;
  if (mode === "acceleration") return 0;
  if (mode === "safety_factor") return Math.max(0.2, 276 / Math.max(face.stressValue, 0.001));
  return face.stressValue;
}

function neutralValue(mode: ResultFieldMode): number {
  if (mode === "safety_factor") return 1;
  return 0;
}

function finiteOrNeutral(value: unknown, mode: ResultFieldMode): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : neutralValue(mode);
}

function interpolatedFieldSampleValue(point: [number, number, number], samples: NonNullable<ResultField["samples"]>, mode: ResultFieldMode): number {
  const neighbors = samples
    .map((sample) => ({ sample, distanceSq: squaredDistance(point, sample.point) }))
    .filter((entry) => Number.isFinite(entry.sample.value) && Number.isFinite(entry.distanceSq))
    .sort((left, right) => left.distanceSq - right.distanceSq)
    .slice(0, Math.min(8, Math.max(3, samples.length)));
  const exact = neighbors.find((entry) => entry.distanceSq <= 1e-18);
  if (exact) return exact.sample.value;
  let weighted = 0;
  let totalWeight = 0;
  for (const neighbor of neighbors) {
    const weight = 1 / Math.max(neighbor.distanceSq, 1e-18);
    weighted += neighbor.sample.value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : neutralValue(mode);
}

function squaredDistance(left: [number, number, number], right: [number, number, number]) {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return dx * dx + dy * dy + dz * dz;
}

export function normalizeValueForLegend(value: number, min: number, max: number): number {
  const range = max - min;
  if (!Number.isFinite(range) || Math.abs(range) < 1e-9) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / range));
}

export function normalizeValueForRender(value: number, min: number, max: number): number {
  const range = max - min;
  if (!Number.isFinite(value) || !Number.isFinite(range) || Math.abs(range) < 1e-12) return 0;
  return Math.max(0, Math.min(1, (value - min) / range));
}

function fieldWithOwnValueRange(field: ResultField): ResultField {
  if (typeof field.frameIndex === "number") return field;
  const values = [
    ...field.values,
    ...(field.samples?.map((sample) => sample.value) ?? [])
  ].filter(Number.isFinite);
  if (!values.length) return field;
  return {
    ...field,
    min: Math.min(...values),
    max: Math.max(...values)
  };
}

function transientFieldRangeKey(field: ResultField): string {
  return `${field.runId}\u0000${field.type}\u0000${field.location}`;
}

function isTransientField(field: ResultField): boolean {
  return typeof field.frameIndex === "number" && typeof field.timeSeconds === "number";
}

function finiteFieldValues(field: ResultField): number[] {
  return [
    ...field.values,
    ...(field.samples?.map((sample) => sample.value) ?? []),
    field.min,
    field.max
  ].filter(Number.isFinite);
}

function normalizedRangeForFieldType(type: ResultField["type"], min: number, max: number): { min: number; max: number } {
  if (type === "velocity" || type === "acceleration") {
    const bound = Math.max(Math.abs(min), Math.abs(max));
    return { min: -bound, max: bound };
  }
  if (type === "stress" || (type === "displacement" && min >= 0)) {
    return { min: 0, max };
  }
  return { min, max };
}

function fieldSeriesKey(field: ResultField): string {
  return `${field.runId}:${field.type}:${field.location}`;
}

function interpolateField(lowerField: ResultField, upperField: ResultField, blend: number, framePosition: number): ResultField {
  return {
    ...lowerField,
    id: `${lowerField.id}-visual-${framePosition.toFixed(3)}`,
    values: interpolateNumbers(lowerField.values, upperField.values, blend),
    min: lerp(lowerField.min, upperField.min, blend),
    max: lerp(lowerField.max, upperField.max, blend),
    frameIndex: framePosition,
    timeSeconds: lerp(lowerField.timeSeconds ?? 0, upperField.timeSeconds ?? lowerField.timeSeconds ?? 0, blend),
    ...(lowerField.samples?.length && upperField.samples?.length
      ? { samples: interpolateSamples(lowerField.samples, upperField.samples, blend) }
      : {})
  };
}

function interpolateNumbers(lowerValues: number[], upperValues: number[], blend: number): number[] {
  const count = Math.max(lowerValues.length, upperValues.length);
  return Array.from({ length: count }, (_, index) => lerp(lowerValues[index] ?? upperValues[index] ?? 0, upperValues[index] ?? lowerValues[index] ?? 0, blend));
}

function interpolateSamples(lowerSamples: NonNullable<ResultField["samples"]>, upperSamples: NonNullable<ResultField["samples"]>, blend: number): NonNullable<ResultField["samples"]> {
  return lowerSamples.map((lowerSample, index) => {
    const upperSample = upperSamples[index];
    if (!upperSample) return lowerSample;
    return {
      ...lowerSample,
      value: lerp(lowerSample.value, upperSample.value, blend),
      vector: interpolateVector(lowerSample.vector, upperSample.vector, blend)
    };
  });
}

function interpolateVector(lowerVector: [number, number, number] | undefined, upperVector: [number, number, number] | undefined, blend: number): [number, number, number] {
  const lower = lowerVector ?? [0, 0, 0];
  const upper = upperVector ?? [0, 0, 0];
  return [
    lerp(lower[0], upper[0], blend),
    lerp(lower[1], upper[1], blend),
    lerp(lower[2], upper[2], blend)
  ];
}

function lerp(left: number, right: number, blend: number): number {
  return left + (right - left) * Math.max(0, Math.min(1, blend));
}

function resultProbeLabel(mode: ResultFieldMode, value: number, units = "") {
  const unit = units ? ` ${units}` : "";
  if (mode === "displacement") return `Disp: ${formatResultValue(value)}${unit}`;
  if (mode === "velocity") return `Vel: ${formatResultValue(value)}${unit}`;
  if (mode === "acceleration") return `Accel: ${formatResultValue(value)}${unit}`;
  if (mode === "safety_factor") return `FoS: ${formatResultValue(value)}`;
  return `Stress: ${formatResultValue(value)}${unit}`;
}

export function formatResultValue(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
