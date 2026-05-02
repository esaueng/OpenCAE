import * as THREE from "three";
import { describe, expect, test, vi } from "vitest";
import { VIEWER_AXIS_HEAD_RADIUS, VIEWER_AXIS_LABEL_BADGE_COLOR, VIEWER_AXIS_LABEL_BADGE_RADIUS, VIEWER_AXIS_LABEL_COLOR, VIEWER_AXIS_LABEL_FONT_SIZE, VIEWER_AXIS_LABEL_FONT_WEIGHT, VIEWER_AXIS_LABEL_OUTLINE_COLOR, VIEWER_AXIS_LABEL_OUTLINE_WIDTH, VIEWER_CREDIT_URL, VIEWER_GIZMO_ALIGNMENT, VIEWER_GIZMO_AXIS_LENGTH, VIEWER_GIZMO_LABEL_DISTANCE, VIEWER_GIZMO_MARGIN, VIEWER_GIZMO_SCALE, VIEWER_ISOMETRIC_GIZMO_VIEW, VIEWER_VIEW_CUBE_BODY_OPACITY, VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS, VIEWER_VIEW_CUBE_CORNER_RADIUS, VIEWER_VIEW_CUBE_EDGE_COLOR, VIEWER_VIEW_CUBE_FACE_HOVER_OPACITY, VIEWER_VIEW_CUBE_FACE_LABEL_FONT_SIZE, VIEWER_VIEW_CUBE_FACE_OPACITY, VIEWER_VIEW_CUBE_SIZE, applyResultFrameToGeometry, axisLabelToViewAxis, beamDemoDisplacementAtStation, beamDemoPayloadOffset, beamDemoStationForPoint, cameraDistanceForBounds, cameraViewForAxis, cloneResultPreviewObject, colorizeResultObject, colorizeSampleResultGeometry, createBeamDemoCoordinate, createUndeformedResultOutlineObject, defaultHomeViewTarget, deformationScaleForResultFields, displayedLegendTickLabels, finalVisualScaleForDisplacementField, getViewCubeCornerDescriptors, getViewCubeFaceDescriptors, gizmoViewTargetToRequest, interpolateDisplacementAtPoint, legendMeshStats, legendTickLabels, normalizedPointLoadCantileverShape, payloadHighlightObjectId, pointLoadCantileverShape, printLayerVisualizationForBounds, resultLegendContentScale, resultLegendResizeDimensions, resultProbesForKind, resultValueForPoint, rotatedCameraOrbit, shouldShowDimensionOverlay, shouldShowModelHitLabel, shouldShowResultMarkers, shouldShowUndeformedResultOutline, shouldShowViewCubeFaceLabel, updatePackedSamples, viewCubeFaceToGizmoView, viewerCameraResetPose, viewerGizmoLayout } from "./CadViewer";
import type { FaceResultSample } from "../resultFields";
import type { DisplayFace, ResultField } from "@opencae/schema";
import type { PackedPreparedPlaybackCache } from "../resultPlaybackCache";
import { resetVertexResultMappingStatsForTests, vertexResultMappingBuildCountForTests } from "../resultVertexMapping";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cadViewerSource = readFileSync(resolve(__dirname, "CadViewer.tsx"), "utf8");

const samples: FaceResultSample[] = [
  {
    face: { id: "left", label: "Left", color: "#4da3ff", center: [-1, 0, 0], normal: [1, 0, 0], stressValue: 10 },
    value: 10,
    normalized: 0
  },
  {
    face: { id: "right", label: "Right", color: "#f59e0b", center: [1, 0, 0], normal: [-1, 0, 0], stressValue: 100 },
    value: 100,
    normalized: 1
  }
];

function expectVectorCloseTo(actual: THREE.Vector3, expected: number[]) {
  expect(actual.x).toBeCloseTo(expected[0] ?? 0);
  expect(actual.y).toBeCloseTo(expected[1] ?? 0);
  expect(actual.z).toBeCloseTo(expected[2] ?? 0);
}

describe("CadViewer result coloring", () => {
  test("links the viewer watermark to the Esau Engineering website", () => {
    expect(VIEWER_CREDIT_URL).toBe("https://esauengineering.com/");
  });

  test("positions the viewer XYZ axes in the bottom-right corner", () => {
    expect(VIEWER_GIZMO_ALIGNMENT).toBe("bottom-right");
  });

  test("places the bottom-right gizmo away from the viewport corner", () => {
    expect(VIEWER_GIZMO_MARGIN).toEqual([112, 112]);
    expect(VIEWER_GIZMO_MARGIN[0]).toBe(VIEWER_GIZMO_MARGIN[1]);
    expect(VIEWER_GIZMO_MARGIN[0]).toBeGreaterThan(83);
    expect(cadViewerSource).toContain("margin={VIEWER_GIZMO_MARGIN}");
  });

  test("renders compact positive viewer XYZ axis labels", () => {
    expect(VIEWER_GIZMO_SCALE).toBe(40);
    expect(VIEWER_AXIS_HEAD_RADIUS).toBe(0.26);
    expect(VIEWER_AXIS_LABEL_BADGE_RADIUS).toBe(0.18);
    expect(VIEWER_AXIS_LABEL_BADGE_COLOR).toBe("#07111d");
    expect(VIEWER_AXIS_LABEL_FONT_SIZE).toBe(0.24);
    expect(VIEWER_AXIS_LABEL_FONT_WEIGHT).toBe(800);
    expect(VIEWER_AXIS_LABEL_COLOR).toBe("#ffffff");
    expect(VIEWER_AXIS_LABEL_OUTLINE_COLOR).toBe("#07111d");
    expect(VIEWER_AXIS_LABEL_OUTLINE_WIDTH).toBe(0.028);
    expect(cadViewerSource).toContain("<ringGeometry args={[VIEWER_AXIS_LABEL_BADGE_RADIUS, VIEWER_AXIS_HEAD_RADIUS, 40]}");
    expect(cadViewerSource).toContain("fontWeight={VIEWER_AXIS_LABEL_FONT_WEIGHT}");
  });

  test("renders a positive-octant triad view cube without negative label clutter", () => {
    expect(VIEWER_VIEW_CUBE_SIZE).toBe(1.2);
    expect(VIEWER_VIEW_CUBE_BODY_OPACITY).toBe(1);
    expect(VIEWER_VIEW_CUBE_FACE_OPACITY).toBe(0.62);
    expect(VIEWER_VIEW_CUBE_FACE_HOVER_OPACITY).toBe(0.78);
    expect(VIEWER_GIZMO_AXIS_LENGTH).toBe(1.75);
    expect(VIEWER_GIZMO_LABEL_DISTANCE).toBe(1.9);
    expect(viewerGizmoLayout().origin).toEqual([0, 0, 0]);
    expect(viewerGizmoLayout().cubeMin).toEqual([0, 0, 0]);
    expect(viewerGizmoLayout().cubeMax).toEqual([1.2, 1.2, 1.2]);
    expect(viewerGizmoLayout().cubeCenter).toEqual([0.6, 0.6, 0.6]);
    expect(viewerGizmoLayout().contentCenter).toEqual([0.95, 0.95, 0.95]);
    expect(viewerGizmoLayout().contentOffset).toEqual([-0.95, -0.95, -0.95]);
    expect(viewerGizmoLayout().axisCapPositions).toEqual({
      x: [1.9, 0, 0],
      y: [0, 1.9, 0],
      z: [0, 0, 1.9]
    });
    expect(VIEWER_GIZMO_LABEL_DISTANCE).toBeGreaterThan(VIEWER_VIEW_CUBE_SIZE);
    expect(VIEWER_VIEW_CUBE_EDGE_COLOR).toBe("#8fb4d8");
    expect(VIEWER_VIEW_CUBE_FACE_LABEL_FONT_SIZE).toBe(0.32);
    expect(cadViewerSource).toContain("function PositiveOctantViewCube");
    expect(cadViewerSource).toContain("function GizmoAxis");
    expect(cadViewerSource).toContain("function ViewCubeFace");
    expect(cadViewerSource).toContain("function ViewCubeEdges");
    expect(cadViewerSource).toContain("function AxisCap");
    expect(cadViewerSource).toContain("function IsoOriginButton");
    expect(cadViewerSource).toContain("function GizmoTextLabel");
    expect(cadViewerSource).toContain("<PositiveOctantViewCube onSelectView={onSelectView} />");
    expect(cadViewerSource).not.toContain("<Billboard position={[0, 0, 0.036]} renderOrder={4}>");
    expect(cadViewerSource).toContain("shouldShowViewCubeFaceLabel");
    expect(cadViewerSource).toContain("VIEWER_VIEW_CUBE_FACE_VISIBILITY_THRESHOLD = 0");
    expect(cadViewerSource).toContain("camera.position");
    expect(cadViewerSource).toContain("faceNormalWorld");
    expect(cadViewerSource).toContain("transparent={false}");
    expect(cadViewerSource).toContain("opacity={VIEWER_VIEW_CUBE_BODY_OPACITY}");
    expect(cadViewerSource).toContain("depthWrite");
    expect(cadViewerSource).toContain("depthTest");
    expect(cadViewerSource).toContain("axis origin is one cube corner.");
    expect(cadViewerSource).toContain("cube bounds are [0, cubeSize] on X/Y/Z.");
    expect(cadViewerSource).toContain("const origin: [number, number, number] = [0, 0, 0];");
    expect(cadViewerSource).toContain("const layout = viewerGizmoLayout();");
    expect(cadViewerSource).toContain("position={layout.contentOffset}");
    expect(cadViewerSource).toContain("position={[half, half, half]}");
    expect(cadViewerSource).not.toContain("function MiniAxisCube");
    expect(cadViewerSource).not.toContain("function AxisDot");
    expect(cadViewerSource).not.toContain("function PositiveAxis");
    expect(cadViewerSource).not.toContain("function AxisHead");
    expect(cadViewerSource).not.toContain("function IsoCenterButton");
    expect(cadViewerSource).not.toContain("-X");
    expect(cadViewerSource).not.toContain("-Y");
    expect(cadViewerSource).not.toContain("-Z");
  });

  test("defines all view cube face labels with outward normals and readable text-up directions", () => {
    const descriptors = getViewCubeFaceDescriptors();

    expect(descriptors.map((face) => face.label).sort()).toEqual(["Back", "Bottom", "Front", "Left", "Right", "Top"]);
    expect(new Set(descriptors.map((face) => face.label)).size).toBe(6);

    const expected = new Map([
      ["Front", { normal: [0, 1, 0], textUp: [0, 0, 1] }],
      ["Back", { normal: [0, -1, 0], textUp: [0, 0, 1] }],
      ["Right", { normal: [1, 0, 0], textUp: [0, 0, 1] }],
      ["Left", { normal: [-1, 0, 0], textUp: [0, 0, 1] }],
      ["Top", { normal: [0, 0, 1], textUp: [-1, 0, 0] }],
      ["Bottom", { normal: [0, 0, -1], textUp: [1, 0, 0] }]
    ]);

    for (const descriptor of descriptors) {
      const rotation = new THREE.Euler(...descriptor.rotation);
      const actualNormal = new THREE.Vector3(0, 0, 1).applyEuler(rotation);
      const actualTextUp = new THREE.Vector3(0, 1, 0).applyEuler(rotation);
      const faceExpected = expected.get(descriptor.label);

      expectVectorCloseTo(actualNormal, faceExpected?.normal ?? []);
      expectVectorCloseTo(actualTextUp, faceExpected?.textUp ?? []);
    }
  });

  test("defines clickable view cube corners for every signed diagonal", () => {
    const descriptors = getViewCubeCornerDescriptors();
    const cubeSize = VIEWER_VIEW_CUBE_SIZE;

    expect(descriptors).toHaveLength(8);
    expect(new Set(descriptors.map((corner) => corner.title)).size).toBe(8);
    expect(new Set(descriptors.map((corner) => corner.position.join(","))).size).toBe(8);
    expect(descriptors.map((corner) => corner.position.join(",")).sort()).toEqual([
      `0,0,0`,
      `0,0,${cubeSize}`,
      `0,${cubeSize},0`,
      `0,${cubeSize},${cubeSize}`,
      `${cubeSize},0,0`,
      `${cubeSize},0,${cubeSize}`,
      `${cubeSize},${cubeSize},0`,
      `${cubeSize},${cubeSize},${cubeSize}`
    ]);
    expect(descriptors.map((corner) => corner.direction.join(",")).sort()).toEqual([
      "-1,-1,-1",
      "-1,-1,1",
      "-1,1,-1",
      "-1,1,1",
      "1,-1,-1",
      "1,-1,1",
      "1,1,-1",
      "1,1,1"
    ]);
    expect(descriptors.find((corner) => corner.direction.join(",") === "1,1,1")?.title).toBe("View +X +Y +Z");
    expect(cadViewerSource).toContain("function ViewCubeCorner");
    expect(cadViewerSource).toContain("<ViewCubeCorner");
  });

  test("uses a larger invisible hit target without enlarging visible view cube corner balls", () => {
    expect(VIEWER_VIEW_CUBE_CORNER_RADIUS).toBe(0.082);
    expect(VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS).toBeGreaterThan(VIEWER_VIEW_CUBE_CORNER_RADIUS * 2);
    expect(cadViewerSource).toContain("<sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS, 18, 18]}");
    expect(cadViewerSource).toContain("opacity={0}");
    expect(cadViewerSource).toContain("<sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_RADIUS, 18, 18]}");
  });

  test("rotates the top face label 90 degrees counterclockwise while keeping it flat", () => {
    const top = getViewCubeFaceDescriptors().find((face) => face.label === "Top");

    expect(top?.rotation).toEqual([0, 0, Math.PI / 2]);
    expect(new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...top!.rotation)).toArray()).toEqual([0, 0, 1]);
  });

  test("uses depth-tested single cube edge rendering instead of per-face outlines", () => {
    expect(cadViewerSource).toContain("depthTest={true}");
    expect(cadViewerSource).toContain("edgeInset");
    expect(cadViewerSource).not.toContain("[-VIEWER_VIEW_CUBE_SIZE * 0.41, -VIEWER_VIEW_CUBE_SIZE * 0.41, 0.004]");
  });

  test("shows view cube face labels for any camera-facing normal half-space", () => {
    expect(shouldShowViewCubeFaceLabel(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1))).toBe(true);
    expect(shouldShowViewCubeFaceLabel(new THREE.Vector3(0, 0, 1), new THREE.Vector3(10, 0, 0.1))).toBe(true);
    expect(shouldShowViewCubeFaceLabel(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1))).toBe(false);
    expect(shouldShowViewCubeFaceLabel(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))).toBe(false);
  });

  test("culls view cube face labels from camera direction rather than HUD face position", () => {
    expect(cadViewerSource).toContain("camera.getWorldDirection");
    expect(cadViewerSource).toContain("labelObject.visible = shouldShowViewCubeFaceLabel(faceNormalWorld, toCameraWorld)");
    expect(cadViewerSource).not.toContain("camera.position)");
    expect(cadViewerSource).not.toContain("faceCenterWorld");
  });

  test("maps view cube faces and center button to camera reset requests", () => {
    expect(viewCubeFaceToGizmoView("Front")).toBe("y");
    expect(viewCubeFaceToGizmoView("Back")).toBe("y");
    expect(viewCubeFaceToGizmoView("Right")).toBe("x");
    expect(viewCubeFaceToGizmoView("Left")).toBe("x");
    expect(viewCubeFaceToGizmoView("Top")).toBe("z");
    expect(viewCubeFaceToGizmoView("Bottom")).toBe("z");
    expect(gizmoViewTargetToRequest("+x")).toBe("x");
    expect(gizmoViewTargetToRequest("+y")).toBe("y");
    expect(gizmoViewTargetToRequest("+z")).toBe("z");
    expect(gizmoViewTargetToRequest("front")).toBe("y");
    expect(gizmoViewTargetToRequest("right")).toBe("x");
    expect(gizmoViewTargetToRequest("top")).toBe("z");
    expect(gizmoViewTargetToRequest("iso")).toBe("iso");
    expect(VIEWER_ISOMETRIC_GIZMO_VIEW).toBe("iso");
    expect(cadViewerSource).toContain('onSelectView(gizmoViewTargetToRequest("iso"))');
  });

  test("reports orbit interaction start and end so playback can yield render budget", () => {
    expect(cadViewerSource).toContain("onViewerInteractionChange?: (interacting: boolean) => void;");
    expect(cadViewerSource).toContain("onInteractionChange={handleViewerInteractionChange}");
    expect(cadViewerSource).toContain("props.onViewerInteractionChange?.(interacting)");
    expect(cadViewerSource).toContain("onStart={() => onInteractionChange?.(true)}");
    expect(cadViewerSource).toContain("onEnd={() => onInteractionChange?.(false)}");
  });

  test("keeps result legend extrema labels separate from numeric ticks", () => {
    expect(legendTickLabels(88.3, 156.6)).toEqual(["88.3", "105.375", "122.45", "139.525", "156.6"]);
  });

  test("shows only min, middle, and max result legend tick labels", () => {
    expect(displayedLegendTickLabels(88.3, 156.6)).toEqual(["88.3", "122.45", "156.6"]);
  });

  test("uses mesh summary values for result legend mesh stats", () => {
    expect(legendMeshStats({ nodes: 182400, elements: 119808, warnings: [], analysisSampleCount: 45000, quality: "ultra" })).toEqual({
      nodes: "182,400",
      elements: "119,808"
    });
  });

  test("resizes the result legend from a top-right handle", () => {
    expect(cadViewerSource).toContain("analysis-legend-resize");
    expect(cadViewerSource).toContain("Resize results legend");

    expect(resultLegendResizeDimensions({
      currentClientX: 520,
      currentClientY: 120,
      maxHeight: 576,
      maxWidth: 976,
      minHeight: 148,
      minWidth: 280,
      startClientX: 460,
      startClientY: 180,
      startHeight: 148,
      startWidth: 360
    })).toEqual({ width: 420, height: 208 });
  });

  test("clamps result legend resize to viewport-safe dimensions", () => {
    expect(resultLegendResizeDimensions({
      currentClientX: 80,
      currentClientY: -800,
      maxHeight: 576,
      maxWidth: 976,
      minHeight: 148,
      minWidth: 280,
      startClientX: 460,
      startClientY: 180,
      startHeight: 148,
      startWidth: 360
    })).toEqual({ width: 280, height: 576 });
  });

  test("scales result legend content as the legend is resized", () => {
    expect(resultLegendContentScale({ width: 360, height: 148 })).toBe(1);
    expect(resultLegendContentScale({ width: 720, height: 296 })).toBe(1.68);
    expect(resultLegendContentScale({ width: 280, height: 148 })).toBe(0.78);
    expect(resultLegendContentScale({ width: 1240, height: 720 })).toBe(2.4);
  });

  test("resets the result legend to default size on double click", () => {
    expect(cadViewerSource).toContain("function resetResultLegendSize");
    expect(cadViewerSource).toContain("setLegendSize(null)");
    expect(cadViewerSource).toContain("onDoubleClick={resetResultLegendSize}");
    expect(cadViewerSource).toContain('title="Double-click to reset legend size"');
    expect(cadViewerSource).not.toContain("setLegendSize({ width: RESULT_LEGEND_DEFAULT_WIDTH, height: RESULT_LEGEND_DEFAULT_HEIGHT })");
  });

  test("maps gizmo Z clicks to a clockwise square top view", () => {
    const topView = cameraViewForAxis(axisLabelToViewAxis("Z"));

    expect(topView.direction.toArray()).toEqual([0, 0, 1]);
    expect(topView.up.toArray()).toEqual([-1, 0, 0]);
  });

  test("rotates the camera orbit around a requested gizmo axis", () => {
    const rotated = rotatedCameraOrbit(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 1),
      "z",
      Math.PI / 2
    );

    expect(rotated.position.x).toBeCloseTo(0);
    expect(rotated.position.y).toBeCloseTo(1);
    expect(rotated.position.z).toBeCloseTo(0);
    expect(rotated.up.toArray()).toEqual([0, 0, 1]);
  });

  test("fits camera distance to the projected bounds width", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-5, -0.5, -0.5), new THREE.Vector3(5, 0.5, 0.5));
    const distance = cameraDistanceForBounds(
      bounds,
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 1, 0),
      42,
      1,
      1.2
    );

    expect(distance).toBeCloseTo((0.5 + 5 / Math.tan(THREE.MathUtils.degToRad(21))) * 1.2);
  });

  test("fits camera distance to long model depth in side view", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-5, -0.5, -0.5), new THREE.Vector3(5, 0.5, 0.5));
    const distance = cameraDistanceForBounds(
      bounds,
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      42,
      1,
      1.2
    );

    expect(distance).toBeCloseTo((5 + 0.5 / Math.tan(THREE.MathUtils.degToRad(21))) * 1.2);
  });

  test("fits isometric reset distance to the projected diagonal height", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
    const view = {
      direction: new THREE.Vector3(1, 1, 1).normalize(),
      up: new THREE.Vector3(0, 0, 1).projectOnPlane(new THREE.Vector3(1, 1, 1).normalize()).normalize()
    };

    const distance = cameraDistanceForBounds(bounds, view.direction, view.up, 42, 1, 1.28);

    expect(distance).toBeCloseTo(30.92, 1);
  });

  test("pans the default home target lower so the model appears higher in the viewport", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
    const direction = new THREE.Vector3(1, 1, 1).normalize();
    const up = new THREE.Vector3(0, 0, 1).projectOnPlane(direction).normalize();
    const center = bounds.getCenter(new THREE.Vector3());
    const target = defaultHomeViewTarget(bounds, direction, up);

    expect(target.clone().sub(center).dot(up)).toBeLessThan(0);
    expect(target.clone().sub(center).dot(up)).toBeCloseTo(-1.47, 1);
  });

  test("computes an idempotent home camera pose for repeated reset clicks", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-5, -1, -0.5), new THREE.Vector3(5, 1, 0.5));
    const center = bounds.getCenter(new THREE.Vector3());
    const firstPose = viewerCameraResetPose(bounds, center, 10, null, 42, 16 / 9);
    const secondPose = viewerCameraResetPose(bounds, center, 10, null, 42, 16 / 9);

    expect(firstPose.position.toArray()).toEqual(secondPose.position.toArray());
    expect(firstPose.target.toArray()).toEqual(secondPose.target.toArray());
    expect(firstPose.up.toArray()).toEqual(secondPose.up.toArray());
  });

  test("computes corner gizmo camera poses from signed diagonal directions", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
    const center = bounds.getCenter(new THREE.Vector3());
    const pose = viewerCameraResetPose(bounds, center, 10, { kind: "corner", direction: [-1, 1, 1] }, 42, 1);
    const direction = pose.position.clone().sub(pose.target).normalize();
    const expectedDirection = new THREE.Vector3(-1, 1, 1).normalize();
    const expectedUp = new THREE.Vector3(0, 0, 1).projectOnPlane(expectedDirection).normalize();

    expectVectorCloseTo(direction, expectedDirection.toArray());
    expectVectorCloseTo(pose.up, expectedUp.toArray());
    expect(pose.target.toArray()).toEqual(center.toArray());
    expect(pose.position.distanceTo(pose.target)).toBeCloseTo(cameraDistanceForBounds(bounds, expectedDirection, expectedUp, 42, 1, 1.28));
  });

  test("hides face selection callouts so snapping markers carry placement feedback", () => {
    expect(shouldShowModelHitLabel("results", true)).toBe(false);
    expect(shouldShowModelHitLabel("model", true)).toBe(false);
    expect(shouldShowModelHitLabel("mesh", false)).toBe(false);
  });

  test("hides overall dimensions in result view even when dimensions are enabled", () => {
    expect(shouldShowDimensionOverlay(true, "results")).toBe(false);
    expect(shouldShowDimensionOverlay(true, "model")).toBe(true);
    expect(shouldShowDimensionOverlay(false, "model")).toBe(false);
  });

  test("hides result probe callouts on the results page", () => {
    expect(shouldShowResultMarkers("results", "results", false)).toBe(false);
    expect(shouldShowResultMarkers("results", "results", true)).toBe(false);
    expect(shouldShowResultMarkers("model", "results", true)).toBe(false);
  });

  test("avoids square-root distance work while blending face samples", () => {
    const manySamples = Array.from({ length: 24 }, (_, index): FaceResultSample => ({
      face: {
        id: `face-${index}`,
        label: `Face ${index}`,
        color: "#4da3ff",
        center: [index % 6, Math.floor(index / 6), index % 3] as [number, number, number],
        normal: [0, 0, 1],
        stressValue: index
      },
      value: index,
      normalized: index / 23
    }));
    const distanceSpy = vi.spyOn(THREE.Vector3.prototype, "distanceTo");

    resultValueForPoint("bracket", "stress", 1.8, new THREE.Vector3(1, 1, 1), manySamples);

    expect(distanceSpy).not.toHaveBeenCalled();
    distanceSpy.mockRestore();
  });

  test("anchors beam result probes to solved faces instead of static fallback points", () => {
    const beamFaces: DisplayFace[] = [
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.9, 0.14, 0], normal: [-1, 0, 0], stressValue: 82 },
      { id: "face-load-top", label: "End payload mass", color: "#f59e0b", center: [1.48, 0.49, 0], normal: [0, 1, 0], stressValue: 118 },
      { id: "face-web-front", label: "Beam top face", color: "#22c55e", center: [0, 0.38, 0], normal: [0, 1, 0], stressValue: 92 },
      { id: "face-base-bottom", label: "Beam body", color: "#8b949e", center: [0, 0.14, 0], normal: [0, 0, 1], stressValue: 58 }
    ];
    const fields: ResultField[] = [{
      id: "stress",
      runId: "run",
      type: "stress",
      location: "face",
      values: [22.8, 37.4, 35.6, 30.1],
      min: 22.8,
      max: 37.4,
      units: "MPa"
    }];

    const probes = resultProbesForKind("plate", beamFaces, "stress", fields, "SI");

    expect(probes.map((probe) => [probe.tone, probe.label])).toEqual([
      ["max", "Stress: 37.4 MPa"],
      ["mid", "Stress: 35.6 MPa"],
      ["min", "Stress: 22.8 MPa"]
    ]);
    expect(probes[0]?.anchor).toEqual([1.48, 0.34, 0]);
    expect(probes[1]?.anchor).toEqual([0, 0.34, 0]);
    expect(probes[2]?.anchor).toEqual([-1.96, 0.14, 0]);
  });

  test("anchors cantilever stress probes at the fixed support for transverse bending", () => {
    const cantileverFaces: DisplayFace[] = [
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], stressValue: 132 },
      { id: "face-load-top", label: "Free end load face", color: "#f59e0b", center: [1.9, 0.18, 0], normal: [1, 0, 0], stressValue: 96 },
      { id: "face-web-front", label: "Top beam face", color: "#22c55e", center: [0, 0.42, 0], normal: [0, 1, 0], stressValue: 74 },
      { id: "face-base-bottom", label: "Beam bottom face", color: "#8b949e", center: [0, -0.08, 0], normal: [0, -1, 0], stressValue: 46 }
    ];
    const fields: ResultField[] = [{
      id: "stress",
      runId: "run",
      type: "stress",
      location: "face",
      values: [155.1, 108.4, 87.5, 42.2],
      min: 42.2,
      max: 155.1,
      units: "MPa"
    }];

    const probes = resultProbesForKind("cantilever", cantileverFaces, "stress", fields, "SI");

    expect(probes[0]).toMatchObject({ tone: "max", label: "Stress: 155.1 MPa" });
    expect(probes[0]?.anchor[0]).toBeLessThan(-1.8);
    expect(probes[0]?.anchor[1]).toBeGreaterThan(0.42);
    expect(probes[0]?.labelPosition[1]).toBeGreaterThan(probes[0]?.anchor[1] ?? 0);
    expect(probes[2]?.anchor[1]).toBeLessThan(-0.06);
    expect(probes[2]?.labelPosition[1]).toBeLessThan(probes[2]?.anchor[1] ?? 0);
  });

  test("renders cantilever stress as a fixed-end outer-fiber contour without a free-end hotspot", () => {
    const fixedOuter = resultValueForPoint("cantilever", "stress", 1, new THREE.Vector3(-1.82, 0.42, 0.34), []);
    const fixedNeutral = resultValueForPoint("cantilever", "stress", 1, new THREE.Vector3(-1.82, 0.18, 0), []);
    const midOuter = resultValueForPoint("cantilever", "stress", 1, new THREE.Vector3(0, 0.42, 0.34), []);
    const freeOuter = resultValueForPoint("cantilever", "stress", 1, new THREE.Vector3(1.82, 0.42, 0.34), []);
    const fixedDisplacement = resultValueForPoint("cantilever", "displacement", 1, new THREE.Vector3(-1.82, 0.18, 0), []);
    const freeDisplacement = resultValueForPoint("cantilever", "displacement", 1, new THREE.Vector3(1.82, 0.18, 0), []);

    expect(fixedOuter).toBeGreaterThan(freeOuter * 1.6);
    expect(fixedOuter).toBeGreaterThan(fixedNeutral);
    expect(midOuter).toBeGreaterThan(freeOuter);
    expect(freeDisplacement).toBeGreaterThan(fixedDisplacement);
  });

  test("uses solved cantilever stress samples when coloring dynamic frames", () => {
    const point = new THREE.Vector3(0, 0.18, 0);
    const lowFrameSamples: FaceResultSample[] = samples.map((sample) => ({ ...sample, value: 10, normalized: 0.08 }));
    const highFrameSamples: FaceResultSample[] = samples.map((sample) => ({ ...sample, value: 180, normalized: 0.92 }));

    const lowFrameValue = resultValueForPoint("cantilever", "stress", 1, point, lowFrameSamples);
    const highFrameValue = resultValueForPoint("cantilever", "stress", 1, point, highFrameSamples);

    expect(highFrameValue).toBeGreaterThan(lowFrameValue + 0.5);
  });

  test("uses dense field samples for built-in dynamic sample coloring", () => {
    const dynamicSamples: FaceResultSample[] = [
      {
        face: { id: "low", label: "Low", color: "#4da3ff", center: [0, 0.18, 0], normal: [0, 1, 0], stressValue: 10 },
        value: 10,
        normalized: 0.08,
        fieldSamples: [
          { point: [0, 0.18, 0], normal: [0, 1, 0], value: 999, normalized: 1 }
        ]
      }
    ];

    expect(resultValueForPoint("cantilever", "stress", 1, new THREE.Vector3(0, 0.18, 0), dynamicSamples)).toBeGreaterThan(0.9);
    expect(resultValueForPoint("uploaded", "stress", 1, new THREE.Vector3(0, 0.18, 0), dynamicSamples)).toBeGreaterThan(0.9);
  });

  test("does not clamp solved stress samples to blue when visual exaggeration is high", () => {
    const dynamicSamples: FaceResultSample[] = [
      {
        face: { id: "mid", label: "Mid", color: "#4da3ff", center: [0, 0.18, 0], normal: [0, 1, 0], stressValue: 35 },
        value: 35,
        normalized: 0.35,
        fieldSamples: [
          { point: [0, 0.18, 0], normal: [0, 1, 0], value: 35, normalized: 0.35 }
        ]
      }
    ];

    expect(resultValueForPoint("plate", "stress", 4, new THREE.Vector3(0, 0.18, 0), dynamicSamples)).toBeCloseTo(0.35);
  });

  test("remaps solved sample colors across the visible built-in result geometry", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 0.1, 0], 3));
    geometry.setIndex([0, 1, 2]);
    const highBiasedSamples: FaceResultSample[] = [
      {
        face: { id: "visible", label: "Visible", color: "#4da3ff", center: [0, 0, 0], normal: [0, 1, 0], stressValue: 60 },
        value: 60,
        normalized: 0.6,
        fieldSamples: [
          { point: [-1, 0, 0], normal: [0, 1, 0], value: 60, normalized: 0.6 },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 90, normalized: 0.9 }
        ]
      }
    ];

    const colorized = colorizeSampleResultGeometry(geometry, "plate", "stress", false, 1, highBiasedSamples, []);
    const colors = colorized.getAttribute("color");

    expect(colors.getZ(0)).toBeGreaterThan(colors.getX(0));
    expect(colors.getX(1)).toBeGreaterThan(colors.getZ(1));
  });

  test("packed playback updates dense field samples without replacing sample objects", () => {
    const initialSamples: FaceResultSample[] = [
      {
        face: { id: "visible", label: "Visible", color: "#4da3ff", center: [0, 0, 0], normal: [0, 1, 0], stressValue: 60 },
        value: 0,
        normalized: 0.5,
        fieldSamples: [
          { point: [0, 0, 0], normal: [0, 1, 0], value: 0, normalized: 0.5 },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 0, normalized: 0.5 }
        ]
      }
    ];
    const firstFieldSample = initialSamples[0]!.fieldSamples![0]!;
    const cache: PackedPreparedPlaybackCache = {
      frameCount: 1,
      fieldCount: 1,
      framePositions: new Float32Array([0]),
      frameIndexes: new Int32Array([0]),
      times: new Float32Array([0]),
      fieldDescriptors: [{ id: "stress", runId: "run", type: "stress", location: "face", units: "MPa" }],
      fieldOffsets: new Int32Array([0]),
      fieldLengths: new Int32Array([1]),
      fieldMins: new Float32Array([0]),
      fieldMaxes: new Float32Array([100]),
      values: new Float32Array([50]),
      sampleOffsets: new Int32Array([0]),
      sampleLengths: new Int32Array([2]),
      sampleValues: new Float32Array([10, 80]),
      samplePoints: new Float32Array([0, 0, 0, 1, 0, 0]),
      sampleNormals: new Float32Array([0, 1, 0, 0, 1, 0]),
      sampleVectors: new Float32Array([0, 0, 0, 0, 0, 0]),
      actualBytes: 0
    };

    updatePackedSamples(initialSamples, cache, 0, "stress");

    expect(initialSamples[0]?.fieldSamples?.[0]).toBe(firstFieldSample);
    expect(initialSamples[0]?.fieldSamples?.map((sample) => sample.value)).toEqual([10, 80]);
    expect(initialSamples[0]?.fieldSamples?.map((sample) => sample.normalized)).toEqual([0.1, 0.8]);
  });

  test("prefers solver point samples over face fallback when coloring uploaded result geometry", () => {
    const lowFaceSamples: FaceResultSample[] = [
      {
        face: { id: "left", label: "Left", color: "#4da3ff", center: [-1, 0, 0], normal: [1, 0, 0], stressValue: 10 },
        value: 10,
        normalized: 0,
        fieldSamples: [
          { point: [-1, 0, 0], normal: [0, 1, 0], value: 10, normalized: 0 },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 100, normalized: 1 }
        ]
      }
    ];

    const left = resultValueForPoint("uploaded", "stress", 1, new THREE.Vector3(-1, 0, 0), lowFaceSamples);
    const right = resultValueForPoint("uploaded", "stress", 1, new THREE.Vector3(1, 0, 0), lowFaceSamples);

    expect(left).toBeLessThan(0.1);
    expect(right).toBeGreaterThan(0.9);
  });

  test("shows undeformed result outlines only while displaying deformed shape", () => {
    expect(shouldShowUndeformedResultOutline(true)).toBe(true);
    expect(shouldShowUndeformedResultOutline(false)).toBe(false);
  });

  test("uses only hovered payload hits for setup-view object highlighting", () => {
    expect(payloadHighlightObjectId(true, null)).toBeUndefined();
    expect(payloadHighlightObjectId(true, { id: "payload-part", label: "Payload part", center: [0, 0, 0] })).toBe("payload-part");
    expect(payloadHighlightObjectId(false, { id: "payload-part", label: "Payload part", center: [0, 0, 0] })).toBeUndefined();
  });

  test("builds layer visualization planes perpendicular to the selected viewer print direction", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-2, -1, -0.5), new THREE.Vector3(2, 1, 0.5));

    const zBuild = printLayerVisualizationForBounds(bounds, "z");
    const yBuild = printLayerVisualizationForBounds(bounds, "y");
    const xBuild = printLayerVisualizationForBounds(bounds, "x");

    expect(zBuild?.axis.toArray()).toEqual([0, 1, 0]);
    expect(zBuild).not.toHaveProperty("label");
    expect(zBuild?.planes).toHaveLength(7);
    expect(zBuild?.planes[0]?.every((point) => point[1] === -1)).toBe(true);
    expect(yBuild?.axis.toArray()).toEqual([0, 0, 1]);
    expect(yBuild?.planes[0]?.every((point) => point[2] === -0.5)).toBe(true);
    expect(xBuild?.axis.toArray()).toEqual([1, 0, 0]);
    expect(xBuild?.planes[0]?.every((point) => point[0] === -2)).toBe(true);
  });

  test("applies vertex result colors to imported native CAD preview meshes", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.add(mesh);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, []);

    const colors = Array.from((mesh.geometry as THREE.BufferGeometry).getAttribute("color").array);
    expect(colors.slice(0, 3)).not.toEqual(colors.slice(6, 9));
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });

  test("builds undeformed outline geometry before native CAD result meshes are deformed", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
    geometry.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.add(mesh);

    const outline = createUndeformedResultOutlineObject(group);
    colorizeResultObject(group, "uploaded", "stress", true, 4, samples, []);

    const outlineLine = outline.children[0] as THREE.LineSegments<THREE.BufferGeometry>;
    const outlinePositions = Array.from(outlineLine.geometry.getAttribute("position").array);
    const deformedPositions = Array.from((mesh.geometry as THREE.BufferGeometry).getAttribute("position").array);

    expect(outlinePositions).toContain(-1);
    expect(deformedPositions).not.toEqual([-1, 0, 0, 0, 0, 0, 1, 0, 0]);
  });

  test("keeps native CAD undeformed outline at the imported preview scale", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-100, 0, 0, 0, 0, 0, 100, 0, 0], 3));
    geometry.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.scale.setScalar(0.01);
    group.position.set(0.5, 0, 0);
    group.add(mesh);
    group.updateMatrixWorld(true);

    const outline = createUndeformedResultOutlineObject(group);
    const modelBounds = new THREE.Box3().setFromObject(group);
    const outlineBounds = new THREE.Box3().setFromObject(outline);

    expect(outlineBounds.min.x).toBeCloseTo(modelBounds.min.x);
    expect(outlineBounds.max.x).toBeCloseTo(modelBounds.max.x);
  });

  test("keeps uploaded result geometry undeformed when the active displacement frame is zero", () => {
    const originalPositions = [-1, 0, 0, 0, 0, 0, 1, 0, 0];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(originalPositions, 3));
    geometry.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.add(mesh);
    const zeroDisplacementSamples: FaceResultSample[] = samples.map((sample) => ({
      ...sample,
      value: 0,
      normalized: 0
    }));

    colorizeResultObject(group, "uploaded", "displacement", true, 1, zeroDisplacementSamples, [{
      id: "load-1",
      faceId: "right",
      type: "force",
      value: 500,
      units: "N",
      direction: [0, 0, -1],
      directionLabel: "-Z",
      labelIndex: 0,
      stackIndex: 0
    }]);

    expect(Array.from((mesh.geometry as THREE.BufferGeometry).getAttribute("position").array)).toEqual(originalPositions);
  });

  test("uses nonzero global displacement range as the auto-scale multiplier", () => {
    const zeroFrame: ResultField = {
      id: "displacement-0",
      runId: "run-1",
      type: "displacement",
      location: "face",
      values: [0],
      min: 0,
      max: 10,
      units: "mm",
      samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 0 }]
    };
    const peakFrame: ResultField = {
      ...zeroFrame,
      id: "displacement-1",
      values: [10],
      samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 10 }]
    };

    expect(deformationScaleForResultFields([{ ...zeroFrame, max: 0 }])).toBe(0);
    expect(deformationScaleForResultFields([zeroFrame])).toBe(1);
    expect(deformationScaleForResultFields([peakFrame])).toBe(1);
  });

  test("applies displacement vectors to geometry positions when deformed results are enabled", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    const fields: ResultField[] = [
      {
        id: "stress-1",
        runId: "run",
        type: "stress",
        location: "node",
        values: [0, 10],
        min: 0,
        max: 10,
        units: "MPa",
        samples: [
          { point: [0, 0, 0], normal: [0, 1, 0], value: 0 },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 10 }
        ]
      },
      {
        id: "displacement-1",
        runId: "run",
        type: "displacement",
        location: "node",
        values: [0, 0.006],
        min: 0,
        max: 0.006,
        units: "mm",
        samples: [
          { point: [0, 0, 0], normal: [0, 1, 0], value: 0, vector: [0, 0, 0] },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 0.006, vector: [0, -0.006, 0] }
        ]
      }
    ];

    applyResultFrameToGeometry({ geometry, fields, resultMode: "stress", showDeformed: true, deformationScale: 1 });

    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(positions.getY(0)).toBeCloseTo(0);
    expect(positions.getY(1)).toBeLessThan(-0.05);
    expect(positions.version).toBeGreaterThan(0);
  });

  test("multiplies displayed displacement vectors by deformation scale", () => {
    const fields: ResultField[] = [{
      id: "displacement-scale",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [1],
      min: 0,
      max: 1,
      units: "mm",
      samples: [{ point: [1, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, 1, 0] }]
    }];
    const coordinateTransform = {
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12.5, 0, 0)),
      toResultPoint: (point: THREE.Vector3) => point.clone(),
      fromResultPoint: (point: THREE.Vector3) => point.clone()
    };
    const deformedY = (deformationScale: number) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0, 0], 3));
      applyResultFrameToGeometry({
        geometry,
        fields,
        resultMode: "displacement",
        showDeformed: true,
        deformationScale,
        coordinateTransform,
        deformationCapFraction: 1
      });
      return (geometry.getAttribute("position") as THREE.BufferAttribute).getY(0);
    };

    expect(deformedY(1)).toBeCloseTo(1);
    expect(deformedY(4)).toBeCloseTo(4);
  });

  test("returns to the same deformed position when scale is restored", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0, 0], 3));
    const fields: ResultField[] = [{
      id: "displacement-reversible",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [1],
      min: 0,
      max: 1,
      units: "mm",
      samples: [{ point: [1, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, 1, 0] }]
    }];
    const coordinateTransform = {
      bounds: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12.5, 0, 0)),
      toResultPoint: (point: THREE.Vector3) => point.clone(),
      fromResultPoint: (point: THREE.Vector3) => point.clone()
    };

    applyResultFrameToGeometry({ geometry, fields, resultMode: "displacement", showDeformed: true, deformationScale: 1, coordinateTransform, deformationCapFraction: 1 });
    const yAtOne = (geometry.getAttribute("position") as THREE.BufferAttribute).getY(0);
    const basePositions = geometry.userData.basePositions;
    applyResultFrameToGeometry({ geometry, fields, resultMode: "displacement", showDeformed: true, deformationScale: 4, coordinateTransform, deformationCapFraction: 1 });
    applyResultFrameToGeometry({ geometry, fields, resultMode: "displacement", showDeformed: true, deformationScale: 1, coordinateTransform, deformationCapFraction: 1 });

    expect((geometry.getAttribute("position") as THREE.BufferAttribute).getY(0)).toBeCloseTo(yAtOne);
    expect(geometry.userData.basePositions).toBe(basePositions);
    expect(Array.from(geometry.userData.basePositions)).toEqual([1, 0, 0]);
  });

  test("reports final visual scale and cap state separately from user scale", () => {
    const field: ResultField = {
      id: "displacement-cap",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [1],
      min: 0,
      max: 1,
      units: "mm",
      samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, 1, 0] }]
    };

    const oneX = finalVisualScaleForDisplacementField(12.5, field, 1, 1);
    const fourX = finalVisualScaleForDisplacementField(12.5, field, 4, 1);
    const capped = finalVisualScaleForDisplacementField(12.5, field, 4, 0.25);

    expect(oneX.finalVisualScale).toBeCloseTo(1);
    expect(fourX.finalVisualScale).toBeCloseTo(4);
    expect(fourX.finalVisualScale).toBeGreaterThan(oneX.finalVisualScale);
    expect(capped.capActive).toBe(true);
    expect(capped.finalVisualScale).toBeCloseTo(capped.maxFinalScale);
  });

  test("keeps beam-like displacement interpolation smooth between result samples", () => {
    const geometry = new THREE.BufferGeometry();
    const basePositions: number[] = [];
    for (let index = 0; index <= 40; index += 1) {
      const x = -1 + index / 20;
      basePositions.push(x, 0, 0);
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(basePositions, 3));
    const displacementSamples = Array.from({ length: 13 }, (_, index) => {
      const x = -1 + index / 6;
      const travel = (x + 1) / 2;
      const offset = index % 2 === 0 ? 0.28 : -0.28;
      const value = 0.006 * travel * travel * (3 - 2 * travel);
      return { point: [x, offset, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value, vector: [0, -value, 0] as [number, number, number] };
    });
    const fields: ResultField[] = [{
      id: "displacement-smooth",
      runId: "run",
      type: "displacement",
      location: "node",
      values: displacementSamples.map((sample) => sample.value),
      min: 0,
      max: 0.006,
      units: "mm",
      samples: displacementSamples
    }];

    applyResultFrameToGeometry({ geometry, fields, resultMode: "displacement", showDeformed: true, deformationScale: 1 });

    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    const offsets = Array.from({ length: positions.count }, (_, index) => positions.getY(index));
    const slopeChanges = offsets.slice(2).map((value, index) => value - 2 * offsets[index + 1]! + offsets[index]!);
    const worstCurvatureJump = Math.max(...slopeChanges.map(Math.abs));

    expect(worstCurvatureJump).toBeLessThan(0.004);
  });

  test("interpolates displacement with exact nodal vector matches before smoothing", () => {
    const field: ResultField = {
      id: "displacement-exact",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [1, 0.2, 2, 3],
      min: 0,
      max: 3,
      units: "mm",
      samples: [
        { point: [0, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, -1, 0] },
        { point: [0, 0.2, 0], normal: [0, 1, 0], value: 0.2, vector: [0, -0.2, 0] },
        { point: [1, 0, 0], normal: [0, 1, 0], value: 2, vector: [0, -2, 0] },
        { point: [2, 0, 0], normal: [0, 1, 0], value: 3, vector: [0, -3, 0] }
      ]
    };

    expect(interpolateDisplacementAtPoint([0, 0, 0], field)).toEqual([0, -1, 0]);
  });

  test("applies result sample vectors along model Z instead of model Y", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0], 3));
    const fields: ResultField[] = [{
      id: "displacement-z",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [1, 1, 1],
      min: 0,
      max: 1,
      units: "mm",
      samples: [
        { point: [0, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, 0, -1] },
        { point: [1, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, 0, -1] },
        { point: [2, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, 0, -1] }
      ]
    }];

    applyResultFrameToGeometry({ geometry, fields, resultMode: "displacement", showDeformed: true, deformationScale: 1 });

    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(positions.getY(1)).toBeCloseTo(0);
    expect(positions.getZ(1)).toBeLessThan(0);
  });

  test("uses dense solver cantilever vectors instead of a linear deformation ramp", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0], 3));
    const fields: ResultField[] = [{
      id: "displacement-cubic-cantilever",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [0, 0.3125, 1],
      min: 0,
      max: 1,
      units: "mm",
      samples: [
        { point: [0, 0, 0], normal: [0, 1, 0], value: 0, vector: [0, 0, 0] },
        { point: [1, 0, 0], normal: [0, 1, 0], value: 0.3125, vector: [0, -0.3125, 0] },
        { point: [2, 0, 0], normal: [0, 1, 0], value: 1, vector: [0, -1, 0] }
      ]
    }];

    applyResultFrameToGeometry({
      geometry,
      fields,
      resultMode: "displacement",
      showDeformed: true,
      deformationScale: 1,
      deformationCapFraction: 1
    });

    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    const midOffset = Math.abs(positions.getY(1));
    const tipOffset = Math.abs(positions.getY(2));

    expect(midOffset / tipOffset).toBeCloseTo(0.3125, 5);
    expect(midOffset / tipOffset).not.toBeCloseTo(0.5, 1);
  });

  test("uses stored model-space load marker direction for fallback deformation", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1.9, 0.18, 0, 1.9, 0.18, 0], 3));
    const deformed = colorizeSampleResultGeometry(
      geometry,
      "cantilever",
      "displacement",
      true,
      1,
      [
        { face: { id: "left", label: "Fixed", color: "#4da3ff", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], stressValue: 10 }, value: 0, normalized: 0 },
        { face: { id: "right", label: "Load", color: "#f59e0b", center: [1.9, 0.18, 0], normal: [1, 0, 0], stressValue: 100 }, value: 1, normalized: 1 }
      ],
      [{
        id: "load-1",
        faceId: "right",
        type: "force",
        value: 500,
        units: "N",
        direction: [0, 0, -1],
        directionLabel: "-Z",
        labelIndex: 0,
        stackIndex: 0
      }],
      1,
      [{ id: "support-1", faceId: "left", type: "fixed", displayLabel: "FS 1", label: "Fixed", stackIndex: 0 }],
      []
    );

    const positions = deformed.getAttribute("position") as THREE.BufferAttribute;
    expect(positions.getY(1)).toBeCloseTo(0.18);
    expect(positions.getZ(1)).toBeLessThan(0);
  });

  test("applies changed scalar frames to geometry colors", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    const frame = (value: number): ResultField[] => [{
      id: `stress-${value}`,
      runId: "run",
      type: "stress",
      location: "node",
      values: [value, value],
      min: 0,
      max: 10,
      units: "MPa",
      samples: [
        { point: [0, 0, 0], normal: [0, 1, 0], value },
        { point: [1, 0, 0], normal: [0, 1, 0], value }
      ]
    }];

    applyResultFrameToGeometry({ geometry, fields: frame(0), resultMode: "stress", showDeformed: false, deformationScale: 1 });
    const lowColors = Array.from(geometry.getAttribute("color").array);
    applyResultFrameToGeometry({ geometry, fields: frame(10), resultMode: "stress", showDeformed: false, deformationScale: 1 });
    const highColors = Array.from(geometry.getAttribute("color").array);

    expect(highColors).not.toEqual(lowColors);
  });

  test("reuses result geometry buffers and cached vertex mappings across frame updates", () => {
    resetVertexResultMappingStatsForTests();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    const fields: ResultField[] = [
      {
        id: "stress",
        runId: "run",
        type: "stress",
        location: "node",
        values: [0, 10],
        min: 0,
        max: 10,
        units: "MPa",
        samples: [
          { point: [0, 0, 0], normal: [0, 1, 0], value: 0 },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 10 }
        ]
      },
      {
        id: "displacement",
        runId: "run",
        type: "displacement",
        location: "node",
        values: [0, 0.006],
        min: 0,
        max: 0.006,
        units: "mm",
        samples: [
          { point: [0, 0, 0], normal: [0, 1, 0], value: 0, vector: [0, 0, 0] },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 0.006, vector: [0, -0.006, 0] }
        ]
      }
    ];

    applyResultFrameToGeometry({ geometry, fields, resultMode: "stress", showDeformed: true, deformationScale: 1 });
    const basePositions = geometry.userData.basePositions;
    const colorAttribute = geometry.getAttribute("color");
    const mappingsAfterFirstFrame = vertexResultMappingBuildCountForTests();
    applyResultFrameToGeometry({ geometry, fields, resultMode: "stress", showDeformed: true, deformationScale: 0.5 });

    expect(geometry.userData.basePositions).toBe(basePositions);
    expect(geometry.getAttribute("color")).toBe(colorAttribute);
    expect(mappingsAfterFirstFrame).toBe(2);
    expect(vertexResultMappingBuildCountForTests()).toBe(mappingsAfterFirstFrame);
  });

  test("can skip derived geometry recomputation on playback frame updates", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    const normalsSpy = vi.spyOn(geometry, "computeVertexNormals");
    const sphereSpy = vi.spyOn(geometry, "computeBoundingSphere");
    const fields: ResultField[] = [{
      id: "stress",
      runId: "run",
      type: "stress",
      location: "node",
      values: [0, 10],
      min: 0,
      max: 10,
      units: "MPa",
      samples: [
        { point: [0, 0, 0], normal: [0, 1, 0], value: 0 },
        { point: [1, 0, 0], normal: [0, 1, 0], value: 10 }
      ]
    }];

    applyResultFrameToGeometry({
      geometry,
      fields,
      resultMode: "stress",
      showDeformed: false,
      deformationScale: 1,
      recomputeDerivedGeometry: false
    });

    expect(normalsSpy).not.toHaveBeenCalled();
    expect(sphereSpy).not.toHaveBeenCalled();
  });

  test("separates beam fixed end, free end, and payload station for payload-mass fallback", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-1.9, 0, -0.18), new THREE.Vector3(1.9, 0.28, 0.18));
    const payloadMarker = {
      id: "payload-load",
      faceId: "load-face",
      payloadObject: { id: "payload", label: "Payload", center: [0.65, 0.5, 0] as [number, number, number] },
      type: "gravity",
      value: 2,
      units: "kg",
      direction: [0, -1, 0] as [number, number, number],
      directionLabel: "Normal",
      labelIndex: 0,
      stackIndex: 0
    };
    const supportMarker = {
      id: "fixed-right",
      faceId: "fixed-face",
      type: "fixed",
      displayLabel: "FS 1",
      label: "Right",
      stackIndex: 0
    };
    const coordinate = createBeamDemoCoordinate({
      bounds,
      samples: [
        { face: { id: "fixed-face", label: "Fixed", color: "#4da3ff", center: [1.9, 0.14, 0], normal: [1, 0, 0], stressValue: 10 }, value: 10, normalized: 0 },
        { face: { id: "load-face", label: "Payload", color: "#f59e0b", center: [0.65, 0.28, 0], normal: [0, 1, 0], stressValue: 80 }, value: 80, normalized: 1 }
      ],
      loadMarkers: [payloadMarker],
      supportMarkers: [supportMarker]
    });

    expect(coordinate).not.toBeNull();
    expect(beamDemoStationForPoint(coordinate!.fixedEnd, coordinate!)).toBeCloseTo(0);
    expect(beamDemoStationForPoint(coordinate!.beamFreeEnd, coordinate!)).toBeCloseTo(1);
    expect(coordinate!.payloadStation).toBeGreaterThan(0);
    expect(coordinate!.payloadStation).toBeLessThan(1);
    expect(coordinate!.fixedEnd.x).toBeCloseTo(1.9);
    expect(coordinate!.beamFreeEnd.x).toBeCloseTo(-1.9);
  });

  test("does not clamp all beam vertices beyond the payload station to identical displacement", () => {
    const payloadStation = 0.35;
    const justBeyondPayload = normalizedPointLoadCantileverShape(payloadStation + 0.05, payloadStation);
    const freeEnd = normalizedPointLoadCantileverShape(1, payloadStation);

    expect(pointLoadCantileverShape(0, payloadStation)).toBeCloseTo(0);
    expect(justBeyondPayload).toBeGreaterThan(0);
    expect(freeEnd).toBeCloseTo(1);
    expect(freeEnd).toBeGreaterThan(justBeyondPayload);
  });

  test("keeps point-load beam deformation smooth across the payload station", () => {
    const payloadStation = 0.42;
    const before = normalizedPointLoadCantileverShape(payloadStation - 0.01, payloadStation);
    const at = normalizedPointLoadCantileverShape(payloadStation, payloadStation);
    const after = normalizedPointLoadCantileverShape(payloadStation + 0.01, payloadStation);

    expect(at - before).toBeGreaterThan(0);
    expect(after - at).toBeGreaterThan(0);
    expect(Math.abs((at - before) - (after - at))).toBeLessThan(0.01);
  });

  test("treats an end force load as the standard end-load cantilever shape", () => {
    for (const station of [0, 0.25, 0.5, 0.75, 1]) {
      expect(normalizedPointLoadCantileverShape(station, 1)).toBeCloseTo(0.5 * station * station * (3 - station));
    }
  });

  test("moves Beam Demo payload mass by the beam displacement at its payload station", () => {
    const coordinate = {
      fixedEnd: new THREE.Vector3(1.9, 0.14, 0),
      beamFreeEnd: new THREE.Vector3(-1.9, 0.14, 0),
      beamAxis: new THREE.Vector3(-1, 0, 0),
      length: 3.8,
      payloadStation: 0.35,
      loadDirection: new THREE.Vector3(0, -1, 0)
    };

    const expected = beamDemoDisplacementAtStation(coordinate.payloadStation, coordinate, 0.12);
    const offset = beamDemoPayloadOffset(coordinate, 0.12);

    expect(offset.toArray()).toEqual(expected.toArray());
    expect(offset.y).toBeLessThan(0);
  });

  test("scales support-to-load deformation by the active dynamic displacement", () => {
    const deformedFreeEndY = (deformationScale: number) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
      geometry.setIndex([0, 1, 2]);
      const deformed = colorizeSampleResultGeometry(
        geometry,
        "cantilever",
        "displacement",
        true,
        1,
        samples,
        [{
          id: "load-1",
          faceId: "right",
          type: "force",
          value: 500,
          units: "N",
          direction: [0, -1, 0],
          directionLabel: "Normal",
          labelIndex: 0,
          stackIndex: 0
        }],
        deformationScale,
        [{
          id: "support-1",
          faceId: "left",
          type: "fixed",
          displayLabel: "FS 1",
          label: "Left",
          stackIndex: 0
        }]
      );
      return deformed.getAttribute("position").getY(2);
    };

    expect(deformedFreeEndY(1)).toBeLessThan(deformedFreeEndY(0.25));
  });

  test("reverses support-to-load deformation for signed dynamic displacement", () => {
    const deformedFreeEndY = (deformationScale: number) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
      geometry.setIndex([0, 1, 2]);
      const deformed = colorizeSampleResultGeometry(
        geometry,
        "cantilever",
        "displacement",
        true,
        1,
        samples,
        [{
          id: "load-1",
          faceId: "right",
          type: "force",
          value: 500,
          units: "N",
          direction: [0, -1, 0],
          directionLabel: "Normal",
          labelIndex: 0,
          stackIndex: 0
        }],
        deformationScale,
        [{
          id: "support-1",
          faceId: "left",
          type: "fixed",
          displayLabel: "FS 1",
          label: "Left",
          stackIndex: 0
        }]
      );
      return deformed.getAttribute("position").getY(2);
    };

    expect(deformedFreeEndY(1)).toBeLessThan(0);
    expect(deformedFreeEndY(-1)).toBeGreaterThan(0);
  });

  test("uses result displacement rather than raw load magnitude for uploaded result deformation", () => {
    const deformedYForLoad = (loadValue: number) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
      geometry.setIndex([0, 1, 2]);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
      const group = new THREE.Group();
      group.add(mesh);

      colorizeResultObject(group, "uploaded", "displacement", true, 1, samples, [{
        id: "load-1",
        faceId: "right",
        type: "force",
        value: loadValue,
        units: "N",
        direction: [0, 0, -1],
        directionLabel: "-Z",
        labelIndex: 0,
        stackIndex: 0
      }], 1);

      return (mesh.geometry as THREE.BufferGeometry).getAttribute("position").getY(0);
    };

    expect(deformedYForLoad(500_000)).toBeCloseTo(deformedYForLoad(500));
  });

  test("keeps the fixed support end anchored during uploaded result deformation", () => {
    const originalPositions = [-1, 0, 0, 0, 0, 0, 1, 0, 0];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(originalPositions, 3));
    geometry.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.add(mesh);

    colorizeResultObject(group, "uploaded", "displacement", true, 1, samples, [{
      id: "load-1",
      faceId: "right",
      type: "force",
      value: 500,
      units: "N",
      direction: [0, -1, 0],
      directionLabel: "Normal",
      labelIndex: 0,
      stackIndex: 0
    }], 1, [{
      id: "support-1",
      faceId: "left",
      type: "fixed",
      displayLabel: "FS 1",
      label: "Left",
      stackIndex: 0
    }]);

    const positions = mesh.geometry.getAttribute("position");
    expect(positions.getY(0)).toBeCloseTo(0);
    expect(positions.getY(1)).toBeLessThan(0);
    expect(positions.getY(2)).toBeLessThan(positions.getY(1));
  });

  test("keeps the selected cantilever support end anchored during built-in result deformation", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
    geometry.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.add(mesh);

    colorizeResultObject(group, "cantilever", "displacement", true, 4, samples, [{
      id: "load-1",
      faceId: "left",
      type: "force",
      value: 500,
      units: "N",
      direction: [0, -1, 0],
      directionLabel: "Normal",
      labelIndex: 0,
      stackIndex: 0
    }], 1, [{
      id: "support-1",
      faceId: "right",
      type: "fixed",
      displayLabel: "FS 1",
      label: "Right",
      stackIndex: 0
    }]);

    const positions = mesh.geometry.getAttribute("position");
    expect(positions.getY(2)).toBeCloseTo(0);
    expect(positions.getY(0)).toBeLessThan(0);
  });

  test("passes support markers through the built-in cantilever result deformation path", () => {
    const geometry = new THREE.BoxGeometry(3.8, 0.5, 0.72, 4, 1, 1);
    const originalY = Array.from({ length: geometry.getAttribute("position").count }, (_, index) => geometry.getAttribute("position").getY(index));

    const deformed = colorizeSampleResultGeometry(
      geometry,
      "cantilever",
      "displacement",
      true,
      4,
      samples,
      [{
        id: "load-1",
        faceId: "right",
        type: "force",
        value: 500,
        units: "N",
        direction: [0, -1, 0],
        directionLabel: "Normal",
        labelIndex: 0,
        stackIndex: 0
      }],
      1,
      [{
        id: "support-1",
        faceId: "left",
        type: "fixed",
        displayLabel: "FS 1",
        label: "Left",
        stackIndex: 0
      }]
    );

    const positions = deformed.getAttribute("position");
    const fixedIndices = Array.from({ length: positions.count }, (_, index) => index).filter((index) => positions.getX(index) < -1.89);
    const freeIndices = Array.from({ length: positions.count }, (_, index) => index).filter((index) => positions.getX(index) > 1.89);
    const fixedYOffsets = fixedIndices.map((index) => positions.getY(index) - (originalY[index] ?? 0));
    const freeYOffsets = freeIndices.map((index) => positions.getY(index) - (originalY[index] ?? 0));

    expect(Math.max(...fixedYOffsets.map(Math.abs))).toBeCloseTo(0, 6);
    expect(Math.min(...freeYOffsets)).toBeLessThan(-0.01);
  });

  test("renders low-amplitude dynamic stress cooler than high-amplitude stress under one global range", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
    const lowMesh = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const highMesh = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const lowGroup = new THREE.Group();
    const highGroup = new THREE.Group();
    lowGroup.add(lowMesh);
    highGroup.add(highMesh);
    const lowAmplitudeSamples: FaceResultSample[] = [
      { ...samples[0]!, value: 1, normalized: 0.02 },
      { ...samples[1]!, value: 2, normalized: 0.04 }
    ];
    const highAmplitudeSamples: FaceResultSample[] = [
      { ...samples[0]!, value: 80, normalized: 0.8 },
      { ...samples[1]!, value: 95, normalized: 0.95 }
    ];

    colorizeResultObject(lowGroup, "uploaded", "stress", false, 1, lowAmplitudeSamples, []);
    colorizeResultObject(highGroup, "uploaded", "stress", false, 1, highAmplitudeSamples, []);

    const lowColors = Array.from((lowMesh.geometry as THREE.BufferGeometry).getAttribute("color").array);
    const highColors = Array.from((highMesh.geometry as THREE.BufferGeometry).getAttribute("color").array);
    const lowHighEndColor = new THREE.Color(lowColors[6]!, lowColors[7]!, lowColors[8]!);
    const highHighEndColor = new THREE.Color(highColors[6]!, highColors[7]!, highColors[8]!);
    expect(lowHighEndColor.r).toBeLessThan(0.2);
    expect(highHighEndColor.r).toBeGreaterThan(lowHighEndColor.r);
  });

  test("clones loaded STEP result previews before frame coloring mutates geometry", () => {
    const source = new THREE.Group();
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
    const sourceMesh = new THREE.Mesh(sourceGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    source.add(sourceMesh);

    const frameObject = cloneResultPreviewObject(source);
    colorizeResultObject(frameObject, "uploaded", "stress", true, 2, samples, []);

    expect(sourceGeometry.getAttribute("color")).toBeUndefined();
    expect(sourceMesh.geometry.getAttribute("position").getY(0)).toBeCloseTo(0);
    expect(frameObject.children[0]).not.toBe(sourceMesh);
    expect((frameObject.children[0] as THREE.Mesh).geometry).not.toBe(sourceGeometry);
  });

  test("samples transformed native CAD vertices in normalized result coordinates", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([1000, 0, 0, 1050, 0, 0, 1100, 0, 0], 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    const group = new THREE.Group();
    group.scale.setScalar(0.024);
    group.position.set(-25.2, 0, 0);
    group.add(mesh);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, []);

    const colors = Array.from((mesh.geometry as THREE.BufferGeometry).getAttribute("color").array);
    expect(colors.slice(0, 3)).not.toEqual(colors.slice(6, 9));
  });

  test("shows payload mass meshes as solid parts while stretching simulated vertices across the full stress ramp", () => {
    const simulatedGeometry = new THREE.BufferGeometry();
    simulatedGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.2, 0, 0, 0, 0, 0, 0.2, 0, 0], 3));
    const simulatedMesh = new THREE.Mesh(simulatedGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    simulatedMesh.userData.opencaeObjectId = "simulated-part";

    const payloadGeometry = new THREE.BufferGeometry();
    payloadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0, 0, 1.1, 0, 0, 1.2, 0, 0], 3));
    const payloadMesh = new THREE.Mesh(payloadGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    payloadMesh.userData.opencaeObjectId = "payload-part";

    const group = new THREE.Group();
    group.add(simulatedMesh, payloadMesh);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, [{
      id: "load-payload",
      faceId: "right",
      payloadObject: { id: "payload-part", label: "Payload part", center: [1.1, 0, 0] },
      type: "gravity",
      value: 2,
      units: "kg",
      direction: [0, 0, -1],
      directionLabel: "-Z",
      labelIndex: 0,
      stackIndex: 0
    }]);

    const colors = Array.from(simulatedGeometry.getAttribute("color").array);
    const lowColor = new THREE.Color(colors[0]!, colors[1]!, colors[2]!);
    const highColor = new THREE.Color(colors[6]!, colors[7]!, colors[8]!);

    expect(payloadMesh.visible).toBe(true);
    expect((payloadMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    expect((payloadMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("8f9aa5");
    expect(lowColor.b).toBeGreaterThan(lowColor.r);
    expect(highColor.r).toBeGreaterThan(highColor.b);
  });

  test("translates uploaded payload meshes rigidly with deformed attachment displacement", () => {
    const simulatedGeometry = new THREE.BufferGeometry();
    simulatedGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0], 3));
    const simulatedMesh = new THREE.Mesh(simulatedGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    simulatedMesh.userData.opencaeObjectId = "simulated-part";

    const payloadGeometry = new THREE.BufferGeometry();
    payloadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0, 0, 1.1, 0, 0, 1.2, 0, 0], 3));
    const payloadMesh = new THREE.Mesh(payloadGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    payloadMesh.userData.opencaeObjectId = "payload-part";

    const group = new THREE.Group();
    group.add(simulatedMesh, payloadMesh);
    const displacementField: ResultField = {
      id: "displacement",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [0, 0.006],
      min: 0,
      max: 0.006,
      units: "mm",
      samples: [
        { point: [-1, 0, 0], normal: [0, 1, 0], value: 0, vector: [0, 0, 0] },
        { point: [1.1, 0, 0], normal: [0, 1, 0], value: 0.006, vector: [0, -0.006, 0] }
      ]
    };

    colorizeResultObject(group, "uploaded", "stress", true, 1, samples, [{
      id: "load-payload",
      faceId: "right",
      payloadObject: { id: "payload-part", label: "Payload part", center: [1.1, 0, 0] },
      type: "gravity",
      value: 2,
      units: "kg",
      direction: [0, 0, -1],
      directionLabel: "-Z",
      labelIndex: 0,
      stackIndex: 0
    }], 1, [], [displacementField]);

    expect(payloadMesh.position.y).toBeLessThan(-0.05);
    const payloadPositions = Array.from(payloadGeometry.getAttribute("position").array);
    [1, 0, 0, 1.1, 0, 0, 1.2, 0, 0].forEach((value, index) => {
      expect(payloadPositions[index]).toBeCloseTo(value);
    });
  });

  test("keeps split meshes for the same payload-loaded object solid grey", () => {
    const simulatedGeometry = new THREE.BufferGeometry();
    simulatedGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.2, 0, 0, 0, 0, 0, 0.2, 0, 0], 3));
    const simulatedMesh = new THREE.Mesh(simulatedGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    simulatedMesh.userData.opencaeObjectId = "simulated-part";

    const payloadGroup = new THREE.Group();
    payloadGroup.userData.opencaeObjectId = "rod-group";
    payloadGroup.userData.opencaeObjectLabel = "Rod 1";

    const selectedPayloadGeometry = new THREE.BufferGeometry();
    selectedPayloadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0, 0, 1.1, 0, 0, 1.2, 0, 0], 3));
    const selectedPayloadMesh = new THREE.Mesh(selectedPayloadGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    selectedPayloadMesh.userData.opencaeObjectId = "rod-segment-a";
    selectedPayloadMesh.userData.opencaeObjectLabel = "Rod 1";

    const siblingPayloadGeometry = new THREE.BufferGeometry();
    siblingPayloadGeometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 0.1, 0, 1.1, 0.1, 0, 1.2, 0.1, 0], 3));
    const siblingPayloadMesh = new THREE.Mesh(siblingPayloadGeometry, new THREE.MeshStandardMaterial({ color: "#63a9e5" }));
    siblingPayloadMesh.userData.opencaeObjectId = "rod-segment-b";
    siblingPayloadMesh.userData.opencaeObjectLabel = "Rod 1";

    payloadGroup.add(selectedPayloadMesh, siblingPayloadMesh);

    const group = new THREE.Group();
    group.add(simulatedMesh, payloadGroup);

    colorizeResultObject(group, "uploaded", "stress", false, 1, samples, [{
      id: "load-payload",
      faceId: "right",
      payloadObject: { id: "rod-segment-a", label: "Rod 1", center: [1.1, 0, 0] },
      type: "gravity",
      value: 2,
      units: "kg",
      direction: [0, 0, -1],
      directionLabel: "-Z",
      labelIndex: 0,
      stackIndex: 0
    }]);

    expect((selectedPayloadMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    expect((selectedPayloadMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("8f9aa5");
    expect((siblingPayloadMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false);
    expect((siblingPayloadMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe("8f9aa5");
    expect((simulatedMesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });
});
