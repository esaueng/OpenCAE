import * as THREE from "three";
import { describe, expect, test, vi } from "vitest";
import { VIEWER_CREDIT_URL, VIEWER_GIZMO_ALIGNMENT, axisLabelToViewAxis, cameraDistanceForBounds, cameraViewForAxis, cloneResultPreviewObject, colorizeResultObject, colorizeSampleResultGeometry, createUndeformedResultOutlineObject, defaultHomeViewTarget, deformationScaleForResultFields, displayedLegendTickLabels, legendMeshStats, legendTickLabels, payloadHighlightObjectId, printLayerVisualizationForBounds, resultProbesForKind, resultValueForPoint, rotatedCameraOrbit, shouldShowDimensionOverlay, shouldShowModelHitLabel, shouldShowResultMarkers, shouldShowUndeformedResultOutline, viewerCameraResetPose } from "./CadViewer";
import type { FaceResultSample } from "../resultFields";
import type { DisplayFace, ResultField } from "@opencae/schema";
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

describe("CadViewer result coloring", () => {
  test("links the viewer watermark to the Esau Engineering website", () => {
    expect(VIEWER_CREDIT_URL).toBe("https://esauengineering.com/");
  });

  test("positions the viewer XYZ axes in the bottom-right corner", () => {
    expect(VIEWER_GIZMO_ALIGNMENT).toBe("bottom-right");
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

  test("uses active frame displacement values rather than global dynamic range for deformation scale", () => {
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

    expect(deformationScaleForResultFields([zeroFrame])).toBe(0);
    expect(deformationScaleForResultFields([peakFrame])).toBeGreaterThan(0);
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
