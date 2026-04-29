import type { DisplayFace, ResultField, ResultSummary } from "@opencae/schema";

export type ResultFieldMode = "stress" | "displacement" | "safety_factor" | "velocity" | "acceleration";

export interface FaceResultSample {
  face: DisplayFace;
  value: number;
  normalized: number;
  fieldSamples?: FieldResultSample[];
}

export interface FieldResultSample {
  point: [number, number, number];
  normal: [number, number, number];
  value: number;
  normalized: number;
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
  frameIndexes: Int32Array;
  times: Float32Array;
  fieldDescriptors: PackedResultPlaybackFieldDescriptor[];
  fieldOffsets: Int32Array;
  fieldLengths: Int32Array;
  fieldMins: Float32Array;
  fieldMaxes: Float32Array;
  values: Float32Array;
  estimatedBytes: number;
  fieldsForFrame: (frameIndex: number) => ResultField[];
  fieldsForFramePosition: (framePosition: number) => ResultField[];
  timeForFramePosition: (framePosition: number) => number;
}

export function createResultFrameCache(fields: ResultField[]): ResultFrameCache {
  const frameIndexes = resultFrameIndexes(fields);
  const hasFrames = fields.some((field) => typeof field.frameIndex === "number");
  const fieldsByFrame = new Map<number, ResultField[]>();
  const fieldMapsByFrame = new Map<number, Map<string, ResultField>>();
  const frameTimes = new Map<number, number>();
  if (!hasFrames) {
    const visible = fields.map((field) => fieldWithOwnValueRange(field));
    return {
      frameIndexes,
      fieldsForFrame: () => visible,
      fieldsForFramePosition: () => visible,
      timeForFramePosition: () => 0
    };
  }
  for (const field of fields) {
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
  const frameIndexes = resultFrameIndexes(fields);
  if (frameIndexes.length < 2 || !fields.some((field) => typeof field.frameIndex === "number")) return null;

  const fieldsByFrame = new Map<number, ResultField[]>();
  const fieldMapsByFrame = new Map<number, Map<string, ResultField>>();
  const frameTimes = new Map<number, number>();
  const descriptorKeys: string[] = [];
  const descriptorKeySet = new Set<string>();
  for (const field of fields) {
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
  const descriptors: PackedResultPlaybackFieldDescriptor[] = [];
  let valueCount = 0;

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
      valueCount += field?.values.length ?? 0;
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
  for (let frameOrdinal = 0; frameOrdinal < frameCount; frameOrdinal += 1) {
    const frameIndex = frameIndexes[frameOrdinal] ?? 0;
    const frameFieldMap = fieldMapsByFrame.get(frameIndex);
    for (let fieldOrdinal = 0; fieldOrdinal < fieldCount; fieldOrdinal += 1) {
      const field = frameFieldMap?.get(descriptorKeys[fieldOrdinal]!);
      if (!field) continue;
      const slot = frameOrdinal * fieldCount + fieldOrdinal;
      values.set(field.values, fieldOffsets[slot]);
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
      values
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
        values
      );
    });
  };

  return {
    frameCount,
    fieldCount,
    valueCount,
    frameIndexes: frameIndexArray,
    times,
    fieldDescriptors: descriptors,
    fieldOffsets,
    fieldLengths,
    fieldMins,
    fieldMaxes,
    values,
    estimatedBytes: frameIndexArray.byteLength + times.byteLength + fieldOffsets.byteLength + fieldLengths.byteLength + fieldMins.byteLength + fieldMaxes.byteLength + values.byteLength,
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
    cache.values.buffer
  ];
}

export function nextLoopedResultFrameIndex(frameIndexes: number[], currentFrameIndex: number): number {
  if (!frameIndexes.length) return 0;
  const currentIndex = frameIndexes.indexOf(currentFrameIndex);
  if (currentIndex < 0) return frameIndexes[0] ?? 0;
  return frameIndexes[(currentIndex + 1) % frameIndexes.length] ?? 0;
}

export function fieldsForResultFrame(fields: ResultField[], frameIndex: number): ResultField[] {
  const hasFrames = fields.some((field) => typeof field.frameIndex === "number");
  if (!hasFrames) return fields;
  return fields
    .filter((field) => (field.frameIndex ?? 0) === frameIndex)
    .map((field) => fieldWithOwnValueRange(field));
}

export function interpolatedFieldsForFramePosition(fields: ResultField[], framePosition: number): ResultField[] {
  return createResultFrameCache(fields).fieldsForFramePosition(framePosition);
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
  values: Float32Array
): ResultField {
  const length = fieldLengths[slot] ?? 0;
  const offset = fieldOffsets[slot] ?? 0;
  const fieldValues = new Array<number>(length);
  for (let index = 0; index < length; index += 1) {
    fieldValues[index] = values[offset + index] ?? 0;
  }
  return {
    ...descriptor,
    id: `${descriptor.id}-frame-${frameIndex}`,
    values: fieldValues,
    min: fieldMins[slot] ?? 0,
    max: fieldMaxes[slot] ?? 0,
    frameIndex,
    timeSeconds
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
  values: Float32Array
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
  return {
    ...descriptor,
    id: `${descriptor.id}-visual-${framePositionId(frameIndex)}`,
    values: fieldValues,
    min: lerp(fieldMins[lowerSlot] ?? 0, fieldMins[upperSlot] ?? fieldMins[lowerSlot] ?? 0, blend),
    max: lerp(fieldMaxes[lowerSlot] ?? 0, fieldMaxes[upperSlot] ?? fieldMaxes[lowerSlot] ?? 0, blend),
    frameIndex,
    timeSeconds
  };
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
  const values = faces.map((face, index) => {
    const solved = Number(field?.values[index]);
    return Number.isFinite(solved) ? solved : fallbackValue(face, mode);
  });
  const min = Number.isFinite(field?.min) ? Number(field?.min) : Math.min(...values);
  const max = Number.isFinite(field?.max) ? Number(field?.max) : Math.max(...values);
  const fieldSamples = field?.samples?.map((sample) => ({
    point: sample.point,
    normal: sample.normal,
    value: sample.value,
    normalized: normalizeValue(sample.value, min, max)
  }));
  return faces.map((face, index) => ({
    face,
    value: values[index] ?? fallbackValue(face, mode),
    normalized: normalizeValue(values[index] ?? fallbackValue(face, mode), min, max),
    ...(fieldSamples?.length ? { fieldSamples } : {})
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

function fallbackValue(face: DisplayFace, mode: ResultFieldMode): number {
  if (mode === "displacement") return face.stressValue / 770;
  if (mode === "velocity") return 0;
  if (mode === "acceleration") return 0;
  if (mode === "safety_factor") return Math.max(0.2, 276 / Math.max(face.stressValue, 0.001));
  return face.stressValue;
}

function normalizeValue(value: number, min: number, max: number): number {
  const range = max - min;
  if (!Number.isFinite(range) || Math.abs(range) < 1e-9) return 0.5;
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
      value: lerp(lowerSample.value, upperSample.value, blend)
    };
  });
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
