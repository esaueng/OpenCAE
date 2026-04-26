import type { DisplayFace, Load, Study } from "@opencae/schema";
import type { ViewerLoadMarker } from "./components/CadViewer";

export type LoadType = "force" | "pressure" | "gravity";
export type LoadDirectionLabel = "-Y" | "+Y" | "+X" | "-X" | "+Z" | "-Z" | "Normal";
export type LoadDirection = [number, number, number];
export type LoadApplicationPoint = [number, number, number];
export interface PayloadObjectSelection {
  id: string;
  label: string;
  center: LoadApplicationPoint;
}
export const STANDARD_GRAVITY = 9.80665;

const DIRECTION_VECTORS: Record<Exclude<LoadDirectionLabel, "Normal">, LoadDirection> = {
  "-Y": [0, -1, 0],
  "+Y": [0, 1, 0],
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0],
  "+Z": [0, 0, 1],
  "-Z": [0, 0, -1]
};

export function unitsForLoadType(type: LoadType) {
  if (type === "pressure") return "kPa";
  if (type === "gravity") return "kg";
  return "N";
}

export function equivalentForceForLoad(load: Pick<Load, "type" | "parameters">): number {
  const rawValue = Number(load.parameters.value ?? 0);
  if (!Number.isFinite(rawValue) || rawValue <= 0) return 0;
  if (load.type === "gravity") return rawValue * STANDARD_GRAVITY;
  return rawValue;
}

export function directionVectorForLabel(label: LoadDirectionLabel, face: DisplayFace): LoadDirection {
  if (label === "Normal") return [...face.normal] as LoadDirection;
  return DIRECTION_VECTORS[label];
}

export function directionLabelForVector(direction: unknown): LoadDirectionLabel {
  if (!isDirection(direction)) return "-Z";
  const [x, y, z] = direction;
  if (x === 1 && y === 0 && z === 0) return "+X";
  if (x === -1 && y === 0 && z === 0) return "-X";
  if (x === 0 && y === 1 && z === 0) return "+Y";
  if (x === 0 && y === -1 && z === 0) return "-Y";
  if (x === 0 && y === 0 && z === 1) return "+Z";
  if (x === 0 && y === 0 && z === -1) return "-Z";
  return "Normal";
}

export function directionLabelForLoad(load: Load): LoadDirectionLabel {
  return directionLabelForVector(load.parameters.direction);
}

export function applicationPointForLoad(load: Load): LoadApplicationPoint | undefined {
  return isVector3(load.parameters.applicationPoint) ? load.parameters.applicationPoint : undefined;
}

export function payloadObjectForLoad(load: Load): PayloadObjectSelection | undefined {
  const value = load.parameters.payloadObject;
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !isVector3(value.center)) return undefined;
  return { id: value.id, label: value.label, center: value.center };
}

export function loadMarkerFromLoad(load: Load, study: Study, stackIndex: number): ViewerLoadMarker | null {
  const selection = study.namedSelections.find((item) => item.id === load.selectionRef);
  const faceId = selection?.geometryRefs[0]?.entityId;
  if (!faceId) return null;
  const direction = isDirection(load.parameters.direction) ? load.parameters.direction : ([0, 0, -1] as LoadDirection);
  return {
    id: load.id,
    faceId,
    point: applicationPointForLoad(load),
    type: load.type,
    value: Number(load.parameters.value ?? 0),
    units: String(load.parameters.units ?? unitsForLoadType(load.type)),
    direction,
    directionLabel: directionLabelForVector(direction),
    stackIndex
  };
}

export function createViewerLoadMarkers({ study }: { study: Study | null }): ViewerLoadMarker[] {
  if (!study) return [];
  const faceCounts = new Map<string, number>();
  return study.loads.flatMap((load) => {
    const marker = loadMarkerFromLoad(load, study, 0);
    if (!marker) return [];
    const stackIndex = faceCounts.get(marker.faceId) ?? 0;
    faceCounts.set(marker.faceId, stackIndex + 1);
    return [{ ...marker, stackIndex }];
  });
}

function isDirection(value: unknown): value is LoadDirection {
  return isVector3(value);
}

function isVector3(value: unknown): value is LoadApplicationPoint {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
