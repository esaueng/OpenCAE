import type { Diagnostic, Study } from "@opencae/schema";

export type PrintCriticalAxis = "x" | "y" | "z";

export interface PrintCriticalFace {
  selectionId?: string;
  entityId?: string;
  center: [number, number, number];
}

export function validateStaticStressStudy(study: Study): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (study.materialAssignments.length === 0) diagnostics.push(issue("validation-material", "Choose what the part is made of."));
  if (study.constraints.length === 0) diagnostics.push(issue("validation-support", "Choose where the part is held fixed."));
  if (study.loads.length === 0) diagnostics.push(issue("validation-load", "Choose where force, pressure, or payload weight is applied."));
  for (const load of study.loads) {
    const selection = study.namedSelections.find((item) => item.id === load.selectionRef);
    if (!selection || selection.entityType !== "face") {
      diagnostics.push(issue(`validation-load-selection-${load.id}`, `Load ${load.id} must reference a face selection.`));
    }
    if (!isPositiveFinite(load.parameters.value)) {
      diagnostics.push(issue(`validation-load-value-${load.id}`, `Load ${load.id} needs a positive finite magnitude.`));
    }
    if (!isDirection(load.parameters.direction)) {
      diagnostics.push(issue(`validation-load-direction-${load.id}`, `Load ${load.id} needs a 3D direction vector.`));
    }
  }
  if (study.meshSettings.status !== "complete") diagnostics.push(issue("validation-mesh", "Generate the mesh before running."));
  return diagnostics;
}

export function inferCriticalPrintAxis(study: Study, faces: PrintCriticalFace[]): PrintCriticalAxis | undefined {
  const supportFaces = study.constraints
    .map((constraint) => faceForSelection(study, faces, constraint.selectionRef))
    .filter((face): face is PrintCriticalFace => Boolean(face));
  if (!supportFaces.length) return undefined;

  let best: { axis: PrintCriticalAxis; score: number } | undefined;
  for (const load of study.loads) {
    const loadFace = faceForSelection(study, faces, load.selectionRef);
    if (!loadFace) continue;
    const loadPoint = vectorFrom(load.parameters.applicationPoint) ?? loadFace.center;
    const support = nearestFace(loadPoint, supportFaces);
    if (!support) continue;
    const span = subtract(loadPoint, support.center);
    const spanLength = length(span);
    const direction = vectorFrom(load.parameters.direction);
    if (!direction || spanLength <= 0) continue;
    const spanUnit = normalize(span);
    const directionUnit = normalize(direction);
    const perpendicular = length(cross(spanUnit, directionUnit));
    if (perpendicular < 0.35) continue;
    const axis = dominantAxis(span);
    const score = spanLength * perpendicular;
    if (!best || score > best.score) best = { axis, score };
  }
  return best?.axis;
}

function issue(id: string, message: string): Diagnostic {
  return { id, severity: "warning", source: "validation", message, suggestedActions: [] };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isDirection(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function faceForSelection(study: Study, faces: PrintCriticalFace[], selectionRef: string): PrintCriticalFace | undefined {
  const selection = study.namedSelections.find((item) => item.id === selectionRef);
  const entityId = selection?.geometryRefs[0]?.entityId;
  return faces.find((face) => face.selectionId === selectionRef || (entityId && face.entityId === entityId));
}

function nearestFace(point: [number, number, number], faces: PrintCriticalFace[]): PrintCriticalFace | undefined {
  return faces.reduce<PrintCriticalFace | undefined>((nearest, face) => {
    if (!nearest) return face;
    return distance(point, face.center) < distance(point, nearest.center) ? face : nearest;
  }, undefined);
}

function vectorFrom(value: unknown): [number, number, number] | undefined {
  return isDirection(value) ? value : undefined;
}

function subtract(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function length(vector: [number, number, number]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const vectorLength = length(vector) || 1;
  return [vector[0] / vectorLength, vector[1] / vectorLength, vector[2] / vectorLength];
}

function distance(left: [number, number, number], right: [number, number, number]): number {
  return length(subtract(left, right));
}

function dominantAxis(vector: [number, number, number]): PrintCriticalAxis {
  const values = [
    { axis: "x" as const, value: Math.abs(vector[0]) },
    { axis: "y" as const, value: Math.abs(vector[1]) },
    { axis: "z" as const, value: Math.abs(vector[2]) }
  ];
  return values.sort((left, right) => right.value - left.value)[0]?.axis ?? "x";
}
