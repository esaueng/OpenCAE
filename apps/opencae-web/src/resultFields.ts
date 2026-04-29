import type { DisplayFace, ResultField } from "@opencae/schema";

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

export function resultSamplesForFaces(faces: DisplayFace[], fields: ResultField[], mode: ResultFieldMode): FaceResultSample[] {
  const field = fields.find((candidate) => candidate.type === mode && candidate.location === "face");
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
  const field = fields.find((candidate) => candidate.type === mode && candidate.location === "face");
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
