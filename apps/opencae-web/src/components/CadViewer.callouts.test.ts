import { describe, expect, test } from "vitest";
import { beamPayloadSelectionForTarget, faceIdForPlacementSnap, pointForPlacementSnap, shouldShowModelHitLabel, supportGlyphAnchor, supportMarkerAnchor } from "./CadViewer";

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

  test("centers beam and cantilever support glyphs on the fixed end face", () => {
    const face = {
      id: "face-base-left",
      label: "Fixed end face",
      color: "#4da3ff",
      center: [-1.9, 0.14, 0] as [number, number, number],
      normal: [-1, 0, 0] as [number, number, number],
      stressValue: 82
    };
    const marker = { id: "support-1", faceId: "face-base-left", type: "fixed", displayLabel: "FS 1", label: "Fixed end face", stackIndex: 0 };

    const beamAnchor = supportGlyphAnchor("plate", marker, face);
    const cantileverAnchor = supportGlyphAnchor("cantilever", marker, face);

    expect(beamAnchor.x).toBeCloseTo(-1.94);
    expect(beamAnchor.y).toBeCloseTo(0.14);
    expect(beamAnchor.z).toBeCloseTo(0);
    expect(cantileverAnchor.x).toBeCloseTo(-1.94);
    expect(cantileverAnchor.y).toBeCloseTo(0.14);
    expect(cantileverAnchor.z).toBeCloseTo(0);
  });

  test("hides placement hover labels so snap indicators mark the target", () => {
    expect(shouldShowModelHitLabel("model", true, false)).toBe(false);
    expect(shouldShowModelHitLabel("model", true, true)).toBe(false);
    expect(shouldShowModelHitLabel("results", true, false)).toBe(false);
  });

  test("selects the visible beam end payload mass as the payload object", () => {
    expect(beamPayloadSelectionForTarget("payload-display-plate")).toEqual({
      id: "payload-display-plate",
      label: "end payload mass",
      center: [1.48, 0.49, 0],
      volumeM3: 0.00018432,
      volumeSource: "bounds-fallback",
      volumeStatus: "estimated"
    });
    expect(beamPayloadSelectionForTarget("beam-body")).toBeNull();
  });

  test("uses snapped placement points while preserving face-based selections", () => {
    const snap = {
      hovered: { type: "vertex" as const, id: "vertex-1", position: [1, 1, 1] as [number, number, number], faceId: "face-load-top" },
      snapPoint: [0.95, 0.95, 1] as [number, number, number],
      rawSnapPoint: [1, 1, 1] as [number, number, number],
      direction: [0, 0, 1] as [number, number, number],
      suggestionType: "force" as const,
      candidateKind: "vertex" as const,
      score: 0.01
    };

    expect(pointForPlacementSnap([0.9, 0.9, 1], snap)).toEqual([0.95, 0.95, 1]);
    expect(faceIdForPlacementSnap("face-load-top", snap)).toBe("face-load-top");
  });
});
