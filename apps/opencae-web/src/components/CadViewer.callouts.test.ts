import { describe, expect, test } from "vitest";
import { shouldShowModelHitLabel, supportMarkerAnchor } from "./CadViewer";

describe("CadViewer callouts", () => {
  test("uses the real cantilever fixed face as the support callout anchor", () => {
    const face = {
      id: "face-base-left",
      label: "Fixed end face",
      color: "#4da3ff",
      center: [-1.8, 0.18, 0] as [number, number, number],
      normal: [-1, 0, 0] as [number, number, number],
      stressValue: 132
    };
    const marker = { id: "support-1", faceId: "face-base-left", type: "fixed", displayLabel: "FS 1", label: "Fixed end face", stackIndex: 0 };

    expect(supportMarkerAnchor("cantilever", marker, face)).toEqual(face.center);
    expect(supportMarkerAnchor("bracket", marker, face)).not.toEqual(face.center);
  });

  test("keeps model hit labels unless a draft load preview is active", () => {
    expect(shouldShowModelHitLabel("model", true, false)).toBe(true);
    expect(shouldShowModelHitLabel("model", true, true)).toBe(false);
    expect(shouldShowModelHitLabel("results", true, false)).toBe(false);
  });
});
