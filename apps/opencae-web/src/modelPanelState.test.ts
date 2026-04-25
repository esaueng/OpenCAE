import { describe, expect, test } from "vitest";
import { shouldShowSampleModelPicker } from "./modelPanelState";

describe("model panel state", () => {
  test("hides sample model controls for a blank new project", () => {
    expect(shouldShowSampleModelPicker({ geometryFiles: [] })).toBe(false);
  });

  test("shows sample model controls for projects opened from the sample menu", () => {
    expect(shouldShowSampleModelPicker({ geometryFiles: [{ metadata: { source: "sample", sampleModel: "bracket" } }] })).toBe(true);
  });

  test("hides sample model controls for uploaded models", () => {
    expect(shouldShowSampleModelPicker({ geometryFiles: [{ metadata: { source: "local-upload" } }] })).toBe(false);
  });
});
