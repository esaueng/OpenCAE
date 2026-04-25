import { describe, expect, test } from "vitest";
import type { DisplayModel } from "@opencae/schema";
import { formatModelOrientation, modelRotationRadians, rotateDisplayModel } from "./modelOrientation";

const baseModel: DisplayModel = {
  id: "display-1",
  name: "Display",
  bodyCount: 1,
  faces: []
};

describe("model orientation", () => {
  test("rotates a display model by quarter turns without mutating the source", () => {
    const rotatedX = rotateDisplayModel(baseModel, "x");
    const rotatedY = rotateDisplayModel(rotatedX, "y");

    expect(baseModel.orientation).toBeUndefined();
    expect(rotatedX.orientation).toEqual({ x: 90, y: 0, z: 0 });
    expect(rotatedY.orientation).toEqual({ x: 90, y: 90, z: 0 });
  });

  test("wraps model orientation at full turns", () => {
    const model = { ...baseModel, orientation: { x: 270, y: 0, z: 0 } } satisfies DisplayModel;

    expect(rotateDisplayModel(model, "x").orientation).toEqual({ x: 0, y: 0, z: 0 });
    expect(rotateDisplayModel(model, "z", -90).orientation).toEqual({ x: 270, y: 0, z: 270 });
  });

  test("converts saved orientation to radians for the 3D viewer", () => {
    const model = { ...baseModel, orientation: { x: 90, y: 180, z: 270 } } satisfies DisplayModel;

    expect(modelRotationRadians(model)).toEqual([Math.PI / 2, Math.PI, (Math.PI * 3) / 2]);
    expect(formatModelOrientation(model)).toBe("X 90 deg / Y 180 deg / Z 270 deg");
  });
});
