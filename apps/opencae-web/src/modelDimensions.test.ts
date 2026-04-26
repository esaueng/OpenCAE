import { describe, expect, test } from "vitest";
import type { DisplayModel } from "@opencae/schema";
import { dimensionValuesForDisplayModel } from "./modelDimensions";

const sampleModel: DisplayModel = {
  id: "display-bracket",
  name: "Bracket",
  bodyCount: 1,
  dimensions: { x: 120, y: 88, z: 34, units: "mm" },
  faces: []
};

const uploadedModel: DisplayModel = {
  id: "display-uploaded",
  name: "Imported",
  bodyCount: 1,
  dimensions: { x: 120, y: 88, z: 34, units: "mm" },
  faces: [],
  nativeCad: {
    format: "step",
    filename: "part.step"
  }
};

describe("model dimension values", () => {
  test("keeps legacy sample Y/Z display mapping", () => {
    expect(dimensionValuesForDisplayModel(sampleModel)).toEqual({
      x: 120,
      y: 34,
      z: 88,
      units: "mm"
    });
  });

  test("preserves uploaded model dimensions in source axes", () => {
    expect(dimensionValuesForDisplayModel(uploadedModel)).toEqual({
      x: 120,
      y: 88,
      z: 34,
      units: "mm"
    });
  });
});
