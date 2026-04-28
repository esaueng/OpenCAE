import { describe, expect, test } from "vitest";
import { beamPayloadSelectionForTarget, faceIdForPlacementSnap, faceSnapAxesForDisplayModel, loadGlyphLabelPosition, loadGlyphSurfacePoint, pointForPlacementSnap, shouldShowModelHitLabel, supportGlyphAnchor, supportMarkerAnchor } from "./CadViewer";

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

  test("uses exact snap targets while preserving face-based selections", () => {
    const snap = {
      hovered: { type: "vertex" as const, id: "vertex-1", position: [1, 1, 1] as [number, number, number], faceId: "face-load-top" },
      snapPoint: [0.95, 0.95, 1] as [number, number, number],
      rawSnapPoint: [1, 1, 1] as [number, number, number],
      direction: [0, 0, 1] as [number, number, number],
      suggestionType: "force" as const,
      candidateKind: "vertex" as const,
      score: 0.01
    };

    expect(pointForPlacementSnap([0.9, 0.9, 1], snap)).toEqual([1, 1, 1]);
    expect(pointForPlacementSnap([0.9, 0.9, 1], snap, true)).toEqual([0.9, 0.9, 1]);
    expect(faceIdForPlacementSnap("face-load-top", snap)).toBe("face-load-top");
  });

  test("does not stack-offset explicit point load anchors", () => {
    const face = {
      id: "face-load-top",
      label: "Free end load face",
      color: "#4da3ff",
      center: [0, 0, 0] as [number, number, number],
      normal: [0, 1, 0] as [number, number, number],
      stressValue: 72
    };
    const marker = {
      id: "load-1",
      faceId: "face-load-top",
      point: [0.5, 0.5, 0] as [number, number, number],
      type: "force",
      value: 500,
      units: "N",
      direction: [0, 0, -1] as [number, number, number],
      directionLabel: "-Z",
      labelIndex: 0,
      stackIndex: 3
    };

    expect(loadGlyphSurfacePoint(marker, face).toArray()).toEqual([0.5, 0.5, 0]);
  });

  test("keeps adjacent point load labels in distinct local lanes", () => {
    const face = {
      id: "face-load-top",
      label: "Free end load face",
      color: "#4da3ff",
      center: [0, 0, 0] as [number, number, number],
      normal: [1, 0, 0] as [number, number, number],
      stressValue: 72
    };
    const markers = [0, 1, 2].map((labelIndex) => ({
      id: `load-${labelIndex + 1}`,
      faceId: "face-load-top",
      point: [0, labelIndex * 0.05, 0] as [number, number, number],
      type: "force",
      value: 500,
      units: "N",
      direction: [0, 0, -1] as [number, number, number],
      directionLabel: "-Z",
      labelIndex,
      stackIndex: 0
    }));

    const labelPositions = markers.map((marker) => loadGlyphLabelPosition(marker, face).toArray());

    expect(new Set(labelPositions.map((position) => position.map((value) => value.toFixed(3)).join(","))).size).toBe(3);
    expect(labelPositions.every((position) => position.every(Number.isFinite))).toBe(true);
  });

  test("derives whole-unit snap axes from displayed model dimensions", () => {
    const displayModel = {
      id: "display-cantilever",
      name: "Cantilever",
      bodyCount: 1,
      dimensions: { x: 180, y: 24, z: 24, units: "mm" as const },
      faces: []
    };
    const face = {
      id: "face-load-top",
      label: "Free end load face",
      color: "#4da3ff",
      center: [1.9, 0.18, 0] as [number, number, number],
      normal: [1, 0, 0] as [number, number, number],
      stressValue: 96
    };

    const axes = faceSnapAxesForDisplayModel(displayModel, face);

    expect(axes).toHaveLength(2);
    expect(axes[0]).toMatchObject({ direction: [0, 1, 0], minPoint: [1.9, -0.07, 0], maxPoint: [1.9, 0.43, 0], units: "mm", unitStep: 1 });
    expect(axes[0]?.unitsPerWorld).toBeCloseTo(48);
    expect(axes[1]).toMatchObject({ direction: [0, 0, 1], minPoint: [1.9, 0.18, -0.36], maxPoint: [1.9, 0.18, 0.36], units: "mm", unitStep: 1 });
    expect(axes[1]?.unitsPerWorld).toBeCloseTo(33.333333);
  });
});
