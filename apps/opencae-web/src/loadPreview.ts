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
  volumeM3?: number;
  volumeSource?: "mesh" | "step" | "bounds-fallback" | "manual";
  volumeStatus?: "available" | "estimated" | "unknown";
}
export type PayloadMassMode = "material" | "manual";
export interface PayloadLoadMetadata {
  payloadMaterialId?: string;
  payloadVolumeM3?: number;
  payloadMassMode?: PayloadMassMode;
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
  return {
    id: value.id,
    label: value.label,
    center: value.center,
    ...(positiveNumber(value.volumeM3) ? { volumeM3: value.volumeM3 } : {}),
    ...(isVolumeSource(value.volumeSource) ? { volumeSource: value.volumeSource } : {}),
    ...(isVolumeStatus(value.volumeStatus) ? { volumeStatus: value.volumeStatus } : {})
  };
}

export function loadMarkerFromLoad(load: Load, study: Study, stackIndex: number): ViewerLoadMarker | null {
  const selection = study.namedSelections.find((item) => item.id === load.selectionRef);
  const faceId = selection?.geometryRefs[0]?.entityId;
  if (!faceId) return null;
  const direction = isDirection(load.parameters.direction) ? load.parameters.direction : ([0, 0, -1] as LoadDirection);
  const payloadObject = payloadObjectForLoad(load);
  return {
    id: load.id,
    faceId,
    point: applicationPointForLoad(load) ?? (load.type === "gravity" ? payloadObject?.center : undefined),
    payloadObject,
    type: load.type,
    value: Number(load.parameters.value ?? 0),
    units: String(load.parameters.units ?? unitsForLoadType(load.type)),
    direction,
    directionLabel: directionLabelForVector(direction),
    labelIndex: stackIndex,
    stackIndex
  };
}

export function createViewerLoadMarkers({ study, loadPreviews = [] }: { study: Study | null; loadPreviews?: Load[] }): ViewerLoadMarker[] {
  if (!study) return [];
  const previewsById = new Map(loadPreviews.map((load) => [load.id, load]));
  const faceCounts = new Map<string, number>();
  let labelIndex = 0;
  return study.loads.flatMap((load) => {
    const marker = loadMarkerFromLoad(previewsById.get(load.id) ?? load, study, 0);
    if (!marker) return [];
    const stackIndex = faceCounts.get(marker.faceId) ?? 0;
    faceCounts.set(marker.faceId, stackIndex + 1);
    return [{ ...marker, labelIndex: labelIndex++, stackIndex }];
  });
}

export function loadMarkerOrdinalLabel(marker: ViewerLoadMarker) {
  return `L${marker.labelIndex + 1}`;
}

export function loadMarkerDisplayLabel(marker: ViewerLoadMarker) {
  const kind = marker.type === "pressure" ? "P" : marker.type === "gravity" ? "G" : "F";
  return `${loadMarkerOrdinalLabel(marker)} ${kind} ${formatLoadMarkerValue(marker.value)} ${marker.units} ${marker.directionLabel}`;
}

export function loadMarkerViewportPresentation(marker: ViewerLoadMarker) {
  if (marker.type === "gravity") {
    const targetLabel = marker.payloadObject?.label?.trim();
    return {
      label: targetLabel ? `${loadMarkerOrdinalLabel(marker)} ${targetLabel}` : loadMarkerOrdinalLabel(marker),
      showArrow: false,
      showLeader: true,
      tone: "payload-mass" as const,
      color: "#34d399"
    };
  }
  return {
    label: loadMarkerDisplayLabel(marker),
    showArrow: true,
    showLeader: false,
    tone: "load" as const,
    color: "#f59e0b"
  };
}

function formatLoadMarkerValue(value: number) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
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

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isVolumeSource(value: unknown): value is NonNullable<PayloadObjectSelection["volumeSource"]> {
  return value === "mesh" || value === "step" || value === "bounds-fallback" || value === "manual";
}

function isVolumeStatus(value: unknown): value is NonNullable<PayloadObjectSelection["volumeStatus"]> {
  return value === "available" || value === "estimated" || value === "unknown";
}
