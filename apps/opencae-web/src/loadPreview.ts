import type { DisplayFace, Load, Study } from "@opencae/schema";
import type { ViewerLoadMarker } from "./components/CadViewer";

export type LoadType = "force" | "pressure" | "gravity";
export type LoadDirectionLabel = "-Y" | "+Y" | "+X" | "-X" | "Normal";
export type LoadDirection = [number, number, number];

const DIRECTION_VECTORS: Record<Exclude<LoadDirectionLabel, "Normal">, LoadDirection> = {
  "-Y": [0, -1, 0],
  "+Y": [0, 1, 0],
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0]
};

export function unitsForLoadType(type: LoadType) {
  return type === "pressure" ? "kPa" : "N";
}

export function directionVectorForLabel(label: LoadDirectionLabel, face: DisplayFace): LoadDirection {
  if (label === "Normal") return [...face.normal] as LoadDirection;
  return DIRECTION_VECTORS[label];
}

export function directionLabelForVector(direction: unknown): LoadDirectionLabel {
  if (!isDirection(direction)) return "-Y";
  const [x, y, z] = direction;
  if (x === 1 && y === 0 && z === 0) return "+X";
  if (x === -1 && y === 0 && z === 0) return "-X";
  if (x === 0 && y === 1 && z === 0) return "+Y";
  if (x === 0 && y === -1 && z === 0) return "-Y";
  return "Normal";
}

export function directionLabelForLoad(load: Load): LoadDirectionLabel {
  return directionLabelForVector(load.parameters.direction);
}

export function loadMarkerFromLoad(load: Load, study: Study, stackIndex: number): ViewerLoadMarker | null {
  const selection = study.namedSelections.find((item) => item.id === load.selectionRef);
  const faceId = selection?.geometryRefs[0]?.entityId;
  if (!faceId) return null;
  const direction = isDirection(load.parameters.direction) ? load.parameters.direction : ([0, -1, 0] as LoadDirection);
  return {
    id: load.id,
    faceId,
    type: load.type,
    value: Number(load.parameters.value ?? 0),
    units: String(load.parameters.units ?? unitsForLoadType(load.type)),
    direction,
    directionLabel: directionLabelForVector(direction),
    stackIndex
  };
}

export function createDraftLoadMarker({
  selectedFace,
  type,
  value,
  directionLabel,
  stackIndex
}: {
  selectedFace: DisplayFace | null;
  type: LoadType;
  value: number;
  directionLabel: LoadDirectionLabel;
  stackIndex: number;
}): ViewerLoadMarker | null {
  if (!selectedFace) return null;
  return {
    id: "draft-load-preview",
    faceId: selectedFace.id,
    type,
    value,
    units: unitsForLoadType(type),
    direction: directionVectorForLabel(directionLabel, selectedFace),
    directionLabel,
    stackIndex,
    preview: true
  };
}

function isDirection(value: unknown): value is LoadDirection {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number");
}
