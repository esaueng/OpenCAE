import type { Diagnostic, DisplayModel, DynamicSolverSettings, Load, ModalSolverSettings, Study } from "@opencae/schema";
import { manufacturingProcessCompatibilityError } from "@opencae/materials";

export type PrintCriticalAxis = "x" | "y" | "z";

export const MAX_DYNAMIC_INTEGRATION_STEPS = 2_000_000;

export interface PrintCriticalFace {
  selectionId?: string;
  entityId?: string;
  center: [number, number, number];
  /** Loaded face area in square metres, when known. */
  areaM2?: number;
}

/** Maps a model-local structural axis into the user-facing global build frame. */
export function modelAxisToGlobalBuildAxis(axis: PrintCriticalAxis, displayModel: DisplayModel | undefined): PrintCriticalAxis {
  if (!displayModel) return axis;
  let vector = vectorForAxis(axis);
  if (usesLegacySampleFrame(displayModel)) vector = rotateX(vector, Math.PI / 2);
  const orientation = displayModel.orientation ?? { x: 0, y: 0, z: 0 };
  vector = rotateX(vector, degreesToRadians(orientation.x));
  vector = rotateY(vector, degreesToRadians(orientation.y));
  vector = rotateZ(vector, degreesToRadians(orientation.z));
  return dominantAxis(vector);
}

/** Maps a user-facing global build direction back into model-local coordinates. */
export function globalBuildAxisToModelAxis(axis: PrintCriticalAxis, displayModel: DisplayModel | undefined): PrintCriticalAxis {
  if (!displayModel) return axis;
  const orientation = displayModel.orientation ?? { x: 0, y: 0, z: 0 };
  let vector = vectorForAxis(axis);
  vector = rotateZ(vector, -degreesToRadians(orientation.z));
  vector = rotateY(vector, -degreesToRadians(orientation.y));
  vector = rotateX(vector, -degreesToRadians(orientation.x));
  if (usesLegacySampleFrame(displayModel)) vector = rotateX(vector, -Math.PI / 2);
  return dominantAxis(vector);
}

export function inferGlobalCriticalPrintAxis(
  study: Study,
  faces: PrintCriticalFace[],
  displayModel: DisplayModel | undefined
): PrintCriticalAxis | undefined {
  const modelAxis = inferCriticalPrintAxis(study, faces);
  return modelAxis ? modelAxisToGlobalBuildAxis(modelAxis, displayModel) : undefined;
}

export function usesLegacySampleFrame(displayModel: DisplayModel): boolean {
  return displayModel.bodyCount !== 0 &&
    !displayModel.nativeCad &&
    !displayModel.visualMesh &&
    !displayModel.id.includes("uploaded");
}

export function validateStaticStressStudy(study: Study): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (study.materialAssignments.length === 0) diagnostics.push(issue("validation-material", "Choose what the part is made of."));
  diagnostics.push(...materialProcessDiagnostics(study));
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

export function validateStudy(study: Study): Diagnostic[] {
  if (study.type === "dynamic_structural") return validateDynamicStructuralStudy(study);
  if (study.type === "modal_analysis") return validateModalStudy(study);
  return validateStaticStressStudy(study);
}

export function validateModalStudy(study: Extract<Study, { type: "modal_analysis" }>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const settings = study.solverSettings as ModalSolverSettings;
  if (study.materialAssignments.length === 0) diagnostics.push(issue("validation-material", "Choose what the part is made of."));
  diagnostics.push(...materialProcessDiagnostics(study));
  if (study.constraints.length === 0) diagnostics.push(issue("validation-modal-support", "Add at least one support for modal analysis."));
  if (study.meshSettings.status !== "complete") diagnostics.push(issue("validation-mesh", "Generate the mesh before running."));
  if (!Number.isInteger(settings.modeCount) || settings.modeCount < 1 || settings.modeCount > 10) {
    diagnostics.push(issue("validation-modal-mode-count", "Modal mode count must be from 1 through 10."));
  }
  return diagnostics;
}

export function validateDynamicStructuralStudy(study: Study): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const solverSettings = study.solverSettings as DynamicSolverSettings;
  if (study.materialAssignments.length === 0) diagnostics.push(issue("validation-material", "Choose what the part is made of."));
  diagnostics.push(...materialProcessDiagnostics(study));
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
  if (study.loads.length === 0) diagnostics.push(issue("validation-load", "Choose where force, pressure, or payload weight is applied."));
  if (study.meshSettings.status !== "complete") diagnostics.push(issue("validation-mesh", "Generate the mesh before running."));
  if (study.constraints.length === 0 && solverSettings.allowFreeMotion !== true) {
    diagnostics.push(issue("validation-dynamic-support", "Add at least one support or enable free motion for the dynamic run."));
  }
  if (!(solverSettings.endTime > solverSettings.startTime)) {
    diagnostics.push(issue("validation-dynamic-end-time", "Dynamic end time must be greater than start time."));
  }
  if (!(solverSettings.timeStep > 0)) {
    diagnostics.push(issue("validation-dynamic-time-step", "Dynamic time step must be greater than zero."));
  } else if (solverSettings.endTime > solverSettings.startTime && (solverSettings.endTime - solverSettings.startTime) / solverSettings.timeStep > MAX_DYNAMIC_INTEGRATION_STEPS) {
    diagnostics.push(issue("validation-dynamic-step-count", `Dynamic run would need more than ${MAX_DYNAMIC_INTEGRATION_STEPS.toLocaleString("en-US")} integration steps. Increase the time step or shorten the time range.`));
  }
  if (!(solverSettings.outputInterval > 0 && solverSettings.outputInterval >= solverSettings.timeStep)) {
    diagnostics.push(issue("validation-dynamic-output-interval", "Dynamic output interval must be greater than zero and no smaller than the time step."));
  }
  if (!(solverSettings.dampingRatio >= 0)) {
    diagnostics.push(issue("validation-dynamic-damping", "Dynamic damping ratio cannot be negative."));
  }
  return diagnostics;
}

export function inferCriticalPrintAxis(study: Study, faces: PrintCriticalFace[]): PrintCriticalAxis | undefined {
  const supportFaces = study.constraints
    .map((constraint) => faceForSelection(study, faces, constraint.selectionRef))
    .filter((face): face is PrintCriticalFace => Boolean(face));
  if (!supportFaces.length) return undefined;

  const candidates: Array<{
    axis: PrintCriticalAxis;
    spanLength: number;
    bendingLeverLength: number;
    isAxial: boolean;
    equivalentForceN?: number;
  }> = [];
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
    const axialSpan = scale(directionUnit, dot(span, directionUnit));
    const bendingLever = subtract(span, axialSpan);
    const bendingLeverLength = length(bendingLever);
    const isAxial = bendingLeverLength / spanLength < 0.35;
    const axis = isAxial ? dominantAxis(spanUnit) : dominantAxis(bendingLever);
    candidates.push({
      axis,
      spanLength,
      bendingLeverLength,
      isAxial,
      equivalentForceN: equivalentLoadForceNewtons(load, loadFace)
    });
  }
  if (!candidates.length) return undefined;
  // A pressure cannot be ranked against force or payload mass without loaded
  // area. Returning no governing axis keeps the FDM result conservative rather
  // than comparing incompatible raw N, kg, and pressure values.
  if (candidates.length > 1 && candidates.some((candidate) => candidate.equivalentForceN === undefined)) return undefined;

  const characteristicLength = Math.max(...candidates.map((candidate) => candidate.spanLength), 1e-9);
  let best: { axis: PrintCriticalAxis; score: number } | undefined;
  for (const candidate of candidates) {
    const normalizedLever = candidate.isAxial ? 1 : candidate.bendingLeverLength / characteristicLength;
    const score = (candidate.equivalentForceN ?? 1) * normalizedLever;
    if (!best || score > best.score) best = { axis: candidate.axis, score };
  }
  return best?.axis;
}

function equivalentLoadForceNewtons(load: Load, face: PrintCriticalFace): number | undefined {
  const explicit = positiveNumber(load.parameters.equivalentForceN);
  if (explicit !== undefined) return explicit;
  const value = positiveNumber(load.parameters.value);
  if (value === undefined) return undefined;
  const units = typeof load.parameters.units === "string" ? load.parameters.units : undefined;
  if (load.type === "gravity") {
    if (units === "N") return value;
    const massKg = units === "lb" ? value * 0.45359237 : value;
    return massKg * 9.80665;
  }
  if (load.type === "pressure") {
    if (!(face.areaM2 && Number.isFinite(face.areaM2) && face.areaM2 > 0)) return undefined;
    const pressurePa = units === "Pa"
      ? value
      : units === "MPa"
        ? value * 1_000_000
        : units === "psi"
          ? value * 6894.757293168
          : value * 1000;
    return pressurePa * face.areaM2;
  }
  return units === "lbf" ? value * 4.4482216152605 : value;
}

function materialProcessDiagnostics(study: Study): Diagnostic[] {
  return study.materialAssignments.flatMap((assignment) => {
    const processId = assignment.parameters?.manufacturingProcessId;
    if (processId === undefined) return [];
    const error = manufacturingProcessCompatibilityError(assignment.materialId, processId);
    return error ? [issue(`validation-material-process-${assignment.id}`, error)] : [];
  });
}

function issue(id: string, message: string): Diagnostic {
  return { id, severity: "warning", source: "validation", message, suggestedActions: [] };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isDirection(value: unknown): value is [number, number, number] {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    Math.hypot(value[0], value[1], value[2]) > 1e-12;
}

function vectorForAxis(axis: PrintCriticalAxis): [number, number, number] {
  if (axis === "x") return [1, 0, 0];
  return axis === "y" ? [0, 1, 0] : [0, 0, 1];
}

function degreesToRadians(value: number | undefined): number {
  return (Number.isFinite(value) ? value ?? 0 : 0) * Math.PI / 180;
}

function rotateX([x, y, z]: [number, number, number], radians: number): [number, number, number] {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [x, y * cosine - z * sine, y * sine + z * cosine];
}

function rotateY([x, y, z]: [number, number, number], radians: number): [number, number, number] {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [x * cosine + z * sine, y, -x * sine + z * cosine];
}

function rotateZ([x, y, z]: [number, number, number], radians: number): [number, number, number] {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [x * cosine - y * sine, x * sine + y * cosine, z];
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

function dot(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function scale(vector: [number, number, number], scalar: number): [number, number, number] {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
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
