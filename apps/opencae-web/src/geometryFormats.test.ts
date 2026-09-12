import { describe, expect, test } from "vitest";
import { isPreviewOnlyGeometry, PREVIEW_ONLY_GEOMETRY_NOTICE } from "./geometryFormats";

describe("isPreviewOnlyGeometry", () => {
  test("is true only for triangle-mesh imports without a B-rep", () => {
    expect(isPreviewOnlyGeometry({ visualMesh: { format: "stl" } })).toBe(true);
    expect(isPreviewOnlyGeometry({ visualMesh: { format: "obj" } })).toBe(true);
    expect(isPreviewOnlyGeometry({ nativeCad: { format: "step" }, visualMesh: { format: "stl" } })).toBe(false);
    expect(isPreviewOnlyGeometry({ nativeCad: { format: "step" } })).toBe(false);
    expect(isPreviewOnlyGeometry({})).toBe(false);
    expect(isPreviewOnlyGeometry(null)).toBe(false);
  });

  test("tells the user what to do instead", () => {
    expect(PREVIEW_ONLY_GEOMETRY_NOTICE).toContain("Import STEP to simulate.");
  });
});
