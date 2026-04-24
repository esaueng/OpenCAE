import type { DisplayFace, ResultField } from "@opencae/schema";

export type ResultFieldMode = "stress" | "displacement" | "safety_factor";

export interface FaceResultSample {
  face: DisplayFace;
  value: number;
  normalized: number;
}

export function resultSamplesForFaces(faces: DisplayFace[], fields: ResultField[], mode: ResultFieldMode): FaceResultSample[] {
  const field = fields.find((candidate) => candidate.type === mode && candidate.location === "face");
  const values = faces.map((face, index) => {
    const solved = Number(field?.values[index]);
    return Number.isFinite(solved) ? solved : fallbackValue(face, mode);
  });
  const min = Number.isFinite(field?.min) ? Number(field?.min) : Math.min(...values);
  const max = Number.isFinite(field?.max) ? Number(field?.max) : Math.max(...values);
  return faces.map((face, index) => ({
    face,
    value: values[index] ?? fallbackValue(face, mode),
    normalized: normalizeValue(values[index] ?? fallbackValue(face, mode), min, max)
  }));
}

function fallbackValue(face: DisplayFace, mode: ResultFieldMode): number {
  if (mode === "displacement") return face.stressValue / 770;
  if (mode === "safety_factor") return Math.max(0.2, 276 / Math.max(face.stressValue, 0.001));
  return face.stressValue;
}

function normalizeValue(value: number, min: number, max: number): number {
  const range = max - min;
  if (!Number.isFinite(range) || Math.abs(range) < 1e-9) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / range));
}
