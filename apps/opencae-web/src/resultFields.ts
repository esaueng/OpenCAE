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
}

export function createResultFrameCache(fields: ResultField[]): ResultFrameCache {
  const frameIndexes = resultFrameIndexes(fields);
  const hasFrames = fields.some((field) => typeof field.frameIndex === "number");
  const fieldsByFrame = new Map<number, ResultField[]>();
  if (!hasFrames) {
    const visible = fields.map((field) => fieldWithOwnValueRange(field));
    return {
      frameIndexes,
      fieldsForFrame: () => visible
    };
  }
  for (const frameIndex of frameIndexes) {
    fieldsByFrame.set(frameIndex, fields
      .filter((field) => (field.frameIndex ?? 0) === frameIndex)
      .map((field) => fieldWithOwnValueRange(field)));
  }
  return {
    frameIndexes,
    fieldsForFrame: (frameIndex) => fieldsByFrame.get(frameIndex) ?? fieldsByFrame.get(frameIndexes[0] ?? 0) ?? []
  };
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
  const frameIndexes = resultFrameIndexes(fields);
  if (frameIndexes.length < 2) return fieldsForResultFrame(fields, Math.round(framePosition));
  const lowerFrame = [...frameIndexes].reverse().find((frameIndex) => frameIndex <= framePosition) ?? frameIndexes[0]!;
  const upperFrame = frameIndexes.find((frameIndex) => frameIndex >= framePosition) ?? frameIndexes[frameIndexes.length - 1]!;
  if (lowerFrame === upperFrame) return fieldsForResultFrame(fields, lowerFrame);
  const lowerFields = fieldsForResultFrame(fields, lowerFrame);
  const upperFields = fieldsForResultFrame(fields, upperFrame);
  const blend = (framePosition - lowerFrame) / (upperFrame - lowerFrame);
  return lowerFields.map((lowerField) => {
    const upperField = upperFields.find((candidate) => sameFieldSeries(candidate, lowerField));
    if (!upperField) return lowerField;
    return fieldWithOwnValueRange(interpolateField(lowerField, upperField, blend, framePosition));
  });
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

function sameFieldSeries(left: ResultField, right: ResultField): boolean {
  return left.type === right.type && left.location === right.location && left.runId === right.runId;
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
