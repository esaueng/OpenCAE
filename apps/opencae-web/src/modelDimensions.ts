import type { DisplayModel } from "@opencae/schema";
import { isUploadedDisplayModel } from "./modelOrientation";

export interface DisplayDimensionValues {
  x: number;
  y: number;
  z: number;
  units: string;
}

export function dimensionValuesForDisplayModel(displayModel: DisplayModel): DisplayDimensionValues | undefined {
  const dimensions = displayModel.dimensions;
  if (!dimensions) return undefined;
  if (isUploadedDisplayModel(displayModel)) return dimensions;
  return {
    x: dimensions.x,
    y: dimensions.z,
    z: dimensions.y,
    units: dimensions.units
  };
}
