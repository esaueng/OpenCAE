import type { DisplayModel } from "@opencae/schema";

export type RotationAxis = "x" | "y" | "z";

export interface ModelOrientation {
  x: number;
  y: number;
  z: number;
}

const DEFAULT_ORIENTATION: ModelOrientation = { x: 0, y: 0, z: 0 };

export function getModelOrientation(displayModel: DisplayModel): ModelOrientation {
  return {
    x: normalizeDegrees(displayModel.orientation?.x ?? 0),
    y: normalizeDegrees(displayModel.orientation?.y ?? 0),
    z: normalizeDegrees(displayModel.orientation?.z ?? 0)
  };
}

export function rotateDisplayModel(displayModel: DisplayModel, axis: RotationAxis, degrees = 90): DisplayModel {
  const orientation = getModelOrientation(displayModel);
  return {
    ...displayModel,
    orientation: {
      ...orientation,
      [axis]: normalizeDegrees(orientation[axis] + degrees)
    }
  };
}

export function resetDisplayModelOrientation(displayModel: DisplayModel): DisplayModel {
  return {
    ...displayModel,
    orientation: { ...DEFAULT_ORIENTATION }
  };
}

export function modelRotationRadians(displayModel: DisplayModel): [number, number, number] {
  const orientation = getModelOrientation(displayModel);
  return [
    THREE_DEG_TO_RAD * orientation.x,
    THREE_DEG_TO_RAD * orientation.y,
    THREE_DEG_TO_RAD * orientation.z
  ];
}

export function formatModelOrientation(displayModel: DisplayModel): string {
  const orientation = getModelOrientation(displayModel);
  return `X ${orientation.x} deg / Y ${orientation.y} deg / Z ${orientation.z} deg`;
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

const THREE_DEG_TO_RAD = Math.PI / 180;
