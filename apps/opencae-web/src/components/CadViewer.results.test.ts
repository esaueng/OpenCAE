import * as THREE from "three";
import { describe, expect, test, vi } from "vitest";
import { REPORT_CAPTURE_BACKGROUND, VIEWER_AXIS_HEAD_RADIUS, VIEWER_AXIS_LABEL_BADGE_COLOR, VIEWER_AXIS_LABEL_BADGE_RADIUS, VIEWER_AXIS_LABEL_COLOR, VIEWER_AXIS_LABEL_FONT_SIZE, VIEWER_AXIS_LABEL_FONT_WEIGHT, VIEWER_AXIS_LABEL_OUTLINE_COLOR, VIEWER_AXIS_LABEL_OUTLINE_WIDTH, VIEWER_CREDIT_URL, VIEWER_GIZMO_ALIGNMENT, VIEWER_GIZMO_AXIS_LENGTH, VIEWER_GIZMO_LABEL_DISTANCE, VIEWER_GIZMO_MARGIN, VIEWER_GIZMO_SCALE, VIEWER_ISOMETRIC_GIZMO_VIEW, VIEWER_VIEW_CUBE_BODY_OPACITY, VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS, VIEWER_VIEW_CUBE_CORNER_RADIUS, VIEWER_VIEW_CUBE_EDGE_COLOR, VIEWER_VIEW_CUBE_FACE_HOVER_OPACITY, VIEWER_VIEW_CUBE_FACE_LABEL_FONT_SIZE, VIEWER_VIEW_CUBE_FACE_OPACITY, VIEWER_VIEW_CUBE_SIZE, applyResultFrameToGeometry, axisLabelToViewAxis, beamDemoDisplacementAtStation, beamDemoPayloadOffset, beamDemoStationForPoint, buildSolverSurfaceOutlineGeometry, buildSolverSurfaceResultGeometry, cameraDistanceForBounds, cameraViewForAxis, cloneResultPreviewObject, colorizeResultObject, colorizeSampleResultGeometry, createBeamDemoCoordinate, createRenderedFrameCaptureController, createUndeformedResultOutlineObject, defaultHomeViewTarget, deformationScaleForResultFields, displayedLegendTickLabels, finalVisualScaleForDisplacementField, getViewCubeCornerDescriptors, getViewCubeFaceDescriptors, gizmoViewTargetToRequest, interpolateDisplacementAtPoint, legendMeshStats, legendTickLabels, normalizedPointLoadCantileverShape, payloadHighlightObjectId, pointLoadCantileverShape, printLayerVisualizationForBounds, recoverSurfaceNodeScalarField, renderReportCapture, reportCaptureBounds, resultFieldValuesAlignedToGeometry, resultLegendContentScale, resultLegendResizeDimensions, resultProbesForKind, resultValueForPoint, rotatedCameraOrbit, shouldDisableResultDeformation, shouldShowDimensionOverlay, shouldShowModelHitLabel, shouldShowResultMarkers, shouldShowUndeformedResultOutline, shouldShowViewCubeFaceLabel, solverSpaceResultCoordinateTransform, solverSurfaceDisplayFootprint, solverSurfaceResultFields, updatePackedSamples, viewCubeFaceToGizmoView, viewerCameraResetPose, viewerGizmoLayout } from "./CadViewer";
import { solverSurfaceDisplayBoundsForDisplayModel } from "./CadViewer";
import { createPackedResultPlaybackCache, createResultFrameCache, type FaceResultSample } from "../resultFields";
import type { DisplayFace, DisplayModel, ResultField } from "@opencae/schema";
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
  test("captures pixels only after the requested WebGL frame has rendered", async () => {
    let afterRender: (() => void) | null = null;
    let renderedPixels = "data:image/png;base64,initial-frame";
    const invalidate = vi.fn();
    const readPixels = vi.fn(() => renderedPixels);
    const unsubscribe = vi.fn();
    const controller = createRenderedFrameCaptureController({
      invalidate,
      readPixels,
      subscribeAfterRender: (callback) => {
        afterRender = callback;
        return unsubscribe;
      }
    });

    const capture = controller.capture();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(readPixels).not.toHaveBeenCalled();

    renderedPixels = "data:image/png;base64,peak-frame";
    afterRender!();

    await expect(capture).resolves.toBe("data:image/png;base64,peak-frame");
    expect(readPixels).toHaveBeenCalledOnce();
    controller.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("report capture renders white-background tight-fit frames, then restores the live viewer", () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#070b10");
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
    mesh.position.set(5, 0, 0);
    scene.add(mesh);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(80, 80, 80));
    hidden.visible = false;
    scene.add(hidden);
    const camera = new THREE.PerspectiveCamera(42, 1.6);
    camera.position.set(40, 40, 40);
    camera.lookAt(5, 0, 0);
    camera.updateMatrixWorld();
    const originalQuaternion = camera.quaternion.clone();

    const renderedFrames: Array<{ background: string | null; position: THREE.Vector3 }> = [];
    const gl = {
      render: vi.fn((renderScene: THREE.Scene, renderCamera: THREE.Camera) => {
        renderedFrames.push({
          background: renderScene.background instanceof THREE.Color ? `#${renderScene.background.getHexString()}` : null,
          position: renderCamera.position.clone()
        });
      }),
      domElement: { toDataURL: vi.fn(() => "data:image/png;base64,report-frame") }
    };

    const png = renderReportCapture(gl, scene, camera);

    expect(png).toBe("data:image/png;base64,report-frame");
    expect(renderedFrames).toHaveLength(2);
    // The captured frame renders on the report page background, framed tight on
    // the visible mesh (the invisible box must not inflate the fit).
    expect(renderedFrames[0]!.background).toBe(REPORT_CAPTURE_BACKGROUND);
    expect(renderedFrames[0]!.position.distanceTo(new THREE.Vector3(5, 0, 0))).toBeLessThan(6);
    // The repaint after the capture restores the interactive viewer exactly.
    expect(renderedFrames[1]!.background).toBe("#070b10");
    expectVectorCloseTo(renderedFrames[1]!.position, [40, 40, 40]);
    expect(scene.background instanceof THREE.Color && `#${scene.background.getHexString()}`).toBe("#070b10");
    expectVectorCloseTo(camera.position, [40, 40, 40]);
    expect(camera.quaternion.angleTo(originalQuaternion)).toBeCloseTo(0);
  });

  test("report capture bounds track baked-in deformation past stale geometry bounding boxes", () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    geometry.computeBoundingBox();
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let index = 0; index < positions.count; index += 1) {
      positions.setX(index, positions.getX(index) + 10);
    }
    positions.needsUpdate = true;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry));

    const bounds = reportCaptureBounds(scene);
    expect(bounds).not.toBeNull();
    expectVectorCloseTo(bounds!.getCenter(new THREE.Vector3()), [10, 0, 0]);
    expect(reportCaptureBounds(new THREE.Scene())).toBeNull();
  });

  test("viewer captures route through the report styling pass", () => {
    expect(cadViewerSource).toContain("renderReportCapture(gl, scene, camera)");
  });

  test("keeps the Esau Engineering attribution target stable outside the viewer", () => {
    expect(VIEWER_CREDIT_URL).toBe("https://esauengineering.com/");
    expect(cadViewerSource).not.toContain('className="viewer-watermark"');
  });

  test("disables deformed rendering for complex geometry with preview provenance", () => {
    const bracketLikeDisplayModel: DisplayModel = {
      id: "display-bracket-demo",
      name: "Bracket demo body",
      bodyCount: 1,
      dimensions: { x: 120, y: 88, z: 34, units: "mm" },
      faces: [
        { id: "face-base-left", label: "Base mounting holes", color: "#4da3ff", center: [0, 0, 0], normal: [0, 0, 1], stressValue: 0 },
        { id: "face-rib-side", label: "Rib side face", color: "#22c55e", center: [1, 1, 0], normal: [0, 0, 1], stressValue: 0 }
      ]
    };
    const previewField: ResultField = {
      id: "field-displacement-preview",
      runId: "run-preview",
      type: "displacement",
      location: "node",
      values: [0, 0.1],
      min: 0,
      max: 0.1,
      units: "mm",
      provenance: { kind: "local_estimate", solver: "opencae-core-preview-sdof", solverVersion: "0.1.0", meshSource: "structured_block_proxy", resultSource: "computed_preview", units: "mm-N-s-MPa" }
    };

    expect(shouldDisableResultDeformation(bracketLikeDisplayModel, [previewField])).toBe(true);
  });

  test("builds solver-surface result geometry with direct vertex colors and vectors by index", () => {
    resetVertexResultMappingStatsForTests();
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ] as [number, number, number][],
      triangles: [[0, 1, 2], [0, 2, 3]] as [number, number, number][],
      nodeMap: [0, 1, 2, 3]
    };
    const stressField: ResultField = {
      id: "stress-surface",
      runId: "run-surface",
      type: "stress",
      location: "node",
      values: [0, 10, 20, 30],
      min: 0,
      max: 30,
      units: "MPa",
      surfaceMeshRef: "solver-surface"
    };
    const displacementField: ResultField = {
      id: "displacement-surface",
      runId: "run-surface",
      type: "displacement",
      location: "node",
      values: [0.1, 0, 0, 0],
      vectors: [[0, 0, 0.1], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
      min: 0,
      max: 0.1,
      units: "mm",
      surfaceMeshRef: "solver-surface"
    };

    const geometry = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField: stressField,
      displacementField,
      resultMode: "stress",
      showDeformed: true,
      deformationScale: 1
    });
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const minColor = new THREE.Color("#0759d6");
    const maxColor = new THREE.Color("#ef4444");

    expect(vertexResultMappingBuildCountForTests()).toBe(0);
    expect(geometry.index?.array).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
    expect(position.getZ(0)).toBeGreaterThan(0);
    expect(color.getX(0)).toBeCloseTo(minColor.r, 5);
    expect(color.getY(0)).toBeCloseTo(minColor.g, 5);
    expect(color.getZ(0)).toBeCloseTo(minColor.b, 5);
    expect(color.getX(3)).toBeCloseTo(maxColor.r, 5);
    expect(color.getY(3)).toBeCloseTo(maxColor.g, 5);
    expect(color.getZ(3)).toBeCloseTo(maxColor.b, 5);
  });

  test("uses the shared manual clamp and banding scale for solver-surface colors", () => {
    const surfaceMesh = {
      id: "solver-surface-scale",
      nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]] as [number, number, number][],
      triangles: [[0, 1, 2], [1, 3, 2]] as [number, number, number][]
    };
    const scalarField: ResultField = {
      id: "stress-scale",
      runId: "run-scale",
      type: "stress",
      component: "von_mises",
      location: "node",
      values: [0, 10, 20, 30],
      min: 0,
      max: 30,
      units: "MPa",
      surfaceMeshRef: surfaceMesh.id
    };
    const geometry = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField,
      resultMode: "stress",
      showDeformed: false,
      deformationScale: 1,
      resultColorScale: { type: "stress", component: "von_mises", min: 10, max: 20, bands: "bands8" }
    });
    const colors = geometry.getAttribute("color") as THREE.BufferAttribute;

    expect(colors.getX(0)).toBeCloseTo(colors.getX(1), 6);
    expect(colors.getY(0)).toBeCloseTo(colors.getY(1), 6);
    expect(colors.getZ(0)).toBeCloseTo(colors.getZ(1), 6);
    expect(colors.getX(2)).toBeCloseTo(colors.getX(3), 6);
    expect(colors.getY(2)).toBeCloseTo(colors.getY(3), 6);
    expect(colors.getZ(2)).toBeCloseTo(colors.getZ(3), 6);
    expect(colors.getX(0)).not.toBeCloseTo(colors.getX(3), 3);
  });

  test("coerces non-finite solver-surface result data so one bad node cannot scramble the mesh", () => {
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [Number.NaN, 0, 1]
      ] as [number, number, number][],
      triangles: [[0, 1, 2], [0, 2, 3]] as [number, number, number][],
      nodeMap: [0, 1, 2, 3]
    };
    const stressField: ResultField = {
      id: "stress-surface",
      runId: "run-surface",
      type: "stress",
      location: "node",
      values: [0, 10, Number.NaN, 30],
      min: 0,
      max: 30,
      units: "MPa",
      surfaceMeshRef: "solver-surface"
    };
    const displacementField: ResultField = {
      id: "displacement-surface",
      runId: "run-surface",
      type: "displacement",
      location: "node",
      values: [0.1, 0, 0, 0],
      vectors: [[0, 0, 0.1], [Number.POSITIVE_INFINITY, 0, 0], [0, 0, 0], [0, 0, 0]],
      min: 0,
      max: 0.1,
      units: "mm",
      surfaceMeshRef: "solver-surface"
    };

    const geometry = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField: stressField,
      displacementField,
      resultMode: "stress",
      showDeformed: true,
      deformationScale: 1
    });
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let index = 0; index < position.count * 3; index += 1) {
      expect(Number.isFinite((position.array as Float32Array)[index])).toBe(true);
      expect(Number.isFinite((color.array as Float32Array)[index])).toBe(true);
    }
    expect(geometry.boundingSphere).not.toBeNull();
    expect(Number.isFinite(geometry.boundingSphere?.radius ?? Number.NaN)).toBe(true);
  });

  test("keeps solver-surface undeformed outline geometry on original nodes", () => {
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ] as [number, number, number][],
      triangles: [[0, 1, 2]] as [number, number, number][],
      nodeMap: [0, 1, 2]
    };
    const stressField: ResultField = {
      id: "stress-surface",
      runId: "run-surface",
      type: "stress",
      location: "node",
      values: [0, 10, 20],
      min: 0,
      max: 20,
      units: "MPa",
      surfaceMeshRef: "solver-surface"
    };
    const displacementField: ResultField = {
      id: "displacement-surface",
      runId: "run-surface",
      type: "displacement",
      location: "node",
      values: [0.1, 0, 0],
      vectors: [[0, 0, 0.1], [0, 0, 0], [0, 0, 0]],
      min: 0,
      max: 0.1,
      units: "mm",
      surfaceMeshRef: "solver-surface"
    };

    const deformedGeometry = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField: stressField,
      displacementField,
      resultMode: "stress",
      showDeformed: true,
      deformationScale: 1
    });
    const outlineGeometry = buildSolverSurfaceOutlineGeometry(surfaceMesh);
    const deformedPosition = deformedGeometry.getAttribute("position") as THREE.BufferAttribute;
    const outlinePosition = outlineGeometry.getAttribute("position") as THREE.BufferAttribute;

    expect(outlineGeometry.userData.opencaeSolverSurfaceOutline).toBe(true);
    expect(outlineGeometry.index?.array).toEqual(new Uint32Array([0, 1, 2]));
    expect(outlinePosition.getZ(0)).toBe(0);
    expect(deformedPosition.getZ(0)).toBeGreaterThan(outlinePosition.getZ(0));
    expect(Array.from(outlinePosition.array)).toEqual(surfaceMesh.nodes.flat());
    expect(cadViewerSource).toContain("const outlineGeometry = useMemo(() => buildSolverSurfaceOutlineGeometry(surfaceMesh), [surfaceMesh]);");
    expect(cadViewerSource).toContain("{shouldShowUndeformedResultOutline(showDeformed) && <UndeformedGeometryOutline geometry={outlineGeometry} />}");
  });

  test("renders packed dynamic solver-surface fields with direct surface deformation", () => {
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ] as [number, number, number][],
      triangles: [[0, 1, 2]] as [number, number, number][],
      nodeMap: [0, 1, 2]
    };
    const cache = createPackedResultPlaybackCache([
      {
        id: "stress-surface-0",
        runId: "run-surface",
        type: "stress",
        location: "node",
        values: [0, 10, 20],
        min: 0,
        max: 30,
        units: "MPa",
        surfaceMeshRef: "solver-surface",
        frameIndex: 0,
        timeSeconds: 0
      },
      {
        id: "displacement-surface-0",
        runId: "run-surface",
        type: "displacement",
        location: "node",
        values: [0, 0, 0],
        vectors: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
        min: 0,
        max: 0.2,
        units: "mm",
        surfaceMeshRef: "solver-surface",
        frameIndex: 0,
        timeSeconds: 0
      },
      {
        id: "stress-surface-1",
        runId: "run-surface",
        type: "stress",
        location: "node",
        values: [0, 20, 30],
        min: 0,
        max: 30,
        units: "MPa",
        surfaceMeshRef: "solver-surface",
        frameIndex: 1,
        timeSeconds: 0.005
      },
      {
        id: "displacement-surface-1",
        runId: "run-surface",
        type: "displacement",
        location: "node",
        values: [0.2, 0, 0],
        vectors: [[0, 0, 0.2], [0, 0, 0], [0, 0, 0]],
        min: 0,
        max: 0.2,
        units: "mm",
        surfaceMeshRef: "solver-surface",
        frameIndex: 1,
        timeSeconds: 0.005
      }
    ] satisfies ResultField[]);
    const fields = cache!.fieldsForFrame(1);
    const stressField = fields.find((field) => field.type === "stress")!;
    const displacementField = fields.find((field) => field.type === "displacement")!;

    const geometry = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField: stressField,
      displacementField,
      resultMode: "stress",
      showDeformed: true,
      deformationScale: 1
    });
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;

    expect(stressField.surfaceMeshRef).toBe("solver-surface");
    expect(displacementField.vectors?.[0]?.[2]).toBeCloseTo(0.2);
    expect(position.getZ(0)).toBeGreaterThan(0);
  });

  test("refits the camera when result geometry replaces the model geometry", () => {
    expect(cadViewerSource).toContain("contentFitKey={viewerContentFitKey");
    expect(cadViewerSource).toContain("contentFitKey,");
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
      ["Left", { normal: [1, 0, 0], textUp: [0, 0, 1] }],
      ["Right", { normal: [-1, 0, 0], textUp: [0, 0, 1] }],
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

  test("renders solver surface results outside the legacy sample base rotation", () => {
    // Solver surface meshes are already in solver model space (Z-up). Nesting them in the
    // Y-up sample base rotation group tipped results 90 degrees away from the setup view.
    const modelRotationIndex = cadViewerSource.indexOf("<group rotation={modelRotation}>");
    const solverSurfaceIndex = cadViewerSource.indexOf("<SolverSurfaceResultMesh");
    const baseRotationIndex = cadViewerSource.indexOf("<group rotation={baseModelRotation}>");
    expect(modelRotationIndex).toBeGreaterThan(-1);
    expect(solverSurfaceIndex).toBeGreaterThan(modelRotationIndex);
    expect(baseRotationIndex).toBeGreaterThan(solverSurfaceIndex);
  });

  test("renders solver surface results exclusively, suppressing the procedural result solid", () => {
    // When a surface result exists, ONLY SolverSurfaceResultMesh renders; the procedural
    // result solid (AnalysisResultModel for all kinds) is suppressed so the real FEA mesh
    // is not hidden inside an opaque, garbage-colored procedural solid. The procedural IDW
    // path remains only as the fallback when no surface result exists.
    expect(cadViewerSource).toContain("{effectiveViewMode === \"results\" && solverSurfaceResult && (");
    expect(cadViewerSource).toContain("suppressProceduralResultSolid={Boolean(solverSurfaceResult)}");
    expect(cadViewerSource).toContain("suppressProceduralResultSolid ? null : <AnalysisResultModel");
    expect(cadViewerSource).toContain("<BracketModel {...props} showDeformed={effectiveShowDeformed} resultFields={resultFields} viewMode={effectiveViewMode}");
  });

  test("wraps the solver surface mesh in a display-footprint group without mutating geometry", () => {
    // The surface mesh arrives in raw solver coordinates (meters, ~0.16 units) while the
    // display solid is ~unit scale; the scale must be applied at the group level so the
    // displacement visual-scale math (self-normalized against mesh extent) is unaffected.
    expect(cadViewerSource).toContain("<group scale={solverSurfaceFootprint?.scale ?? 1} position={solverSurfaceFootprint?.position ?? [0, 0, 0]}>");
    const groupIndex = cadViewerSource.indexOf("<group scale={solverSurfaceFootprint?.scale ?? 1}");
    const surfaceMeshIndex = cadViewerSource.indexOf("<SolverSurfaceResultMesh");
    expect(groupIndex).toBeGreaterThan(-1);
    expect(surfaceMeshIndex).toBeGreaterThan(groupIndex);
  });

  test("computes the surface footprint deterministically from display and surface bounds", () => {
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [0, 0, 0],
        [0.16, 0, 0],
        [0, 0.02, 0],
        [0, 0, 0.02]
      ] as [number, number, number][],
      triangles: [[0, 1, 2], [0, 2, 3]] as [number, number, number][],
      nodeMap: [0, 1, 2, 3],
      coordinateSpace: "solver"
    };
    const baseModelRotation: [number, number, number] = [Math.PI / 2, 0, 0];
    const displayBounds = new THREE.Box3(new THREE.Vector3(-1.9, -0.07, -0.36), new THREE.Vector3(1.9, 0.43, 0.36));
    const footprint = solverSurfaceDisplayFootprint(surfaceMesh, displayBounds, baseModelRotation);

    // Max display dimension (3.8) over max surface dimension (0.16) — no ratio heuristic.
    expect(footprint.scale).toBeCloseTo(3.8 / 0.16, 9);
    // The bounds centers must coincide after the transform. The display bounds live inside
    // the legacy base rotation, so compare in the outer (Z-up) frame where the mesh renders.
    const rotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...baseModelRotation));
    const displayCenter = displayBounds.clone().applyMatrix4(rotation).getCenter(new THREE.Vector3());
    const surfaceCenter = new THREE.Vector3(0.08, 0.01, 0.01);
    expectVectorCloseTo(surfaceCenter.multiplyScalar(footprint.scale).add(new THREE.Vector3(...footprint.position)), displayCenter.toArray());
  });

  test("fits beam solver surfaces to the structural body instead of the payload assembly", () => {
    const beamDisplayModel: DisplayModel = {
      id: "display-plate",
      name: "end loaded beam assembly",
      bodyCount: 1,
      dimensions: { x: 160, y: 160 * (0.28 / 3.8), z: 160 * (0.36 / 3.8), units: "mm" },
      faces: []
    };
    const bounds = solverSurfaceDisplayBoundsForDisplayModel(beamDisplayModel, null);
    const size = bounds?.getSize(new THREE.Vector3());

    expect(size?.toArray()).toEqual([3.8, 0.28, 0.36]);
  });

  test("recenters near-unit-scale surface meshes too instead of gating on a scale ratio", () => {
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [10, 0, 0],
        [13.8, 0, 0],
        [10, 0.5, 0],
        [10, 0, 0.5]
      ] as [number, number, number][],
      triangles: [[0, 1, 2], [0, 2, 3]] as [number, number, number][],
      nodeMap: [0, 1, 2, 3]
    };
    const displayBounds = new THREE.Box3(new THREE.Vector3(-1.9, -0.25, -0.36), new THREE.Vector3(1.9, 0.25, 0.36));
    const footprint = solverSurfaceDisplayFootprint(surfaceMesh, displayBounds, [0, 0, 0]);
    // Same extent -> scale 1, but the offset origin still recenters onto the display bounds.
    expect(footprint.scale).toBeCloseTo(1, 9);
    expect(footprint.position[0]).toBeCloseTo(-11.9, 9);
  });

  test("returns an identity footprint for degenerate bounds", () => {
    const degenerateMesh = {
      id: "solver-surface",
      nodes: [] as [number, number, number][],
      triangles: [] as [number, number, number][],
      nodeMap: [] as number[]
    };
    expect(solverSurfaceDisplayFootprint(degenerateMesh, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)), [0, 0, 0])).toEqual({ scale: 1, position: [0, 0, 0] });
    const validMesh = {
      id: "solver-surface",
      nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
      triangles: [[0, 1, 2]] as [number, number, number][],
      nodeMap: [0, 1, 2]
    };
    expect(solverSurfaceDisplayFootprint(validMesh, null, [0, 0, 0])).toEqual({ scale: 1, position: [0, 0, 0] });
  });

  test("does not color procedural geometry by vertex index from a samples-less surface-node field", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const vertexCount = (geometry.getAttribute("position") as THREE.BufferAttribute).count;
    const surfaceField: ResultField = {
      id: "stress-surface",
      runId: "run-surface",
      type: "stress",
      location: "node",
      // Even a length-aligned values array must be ignored: these are surface-node values,
      // not procedural vertex values, and indexing them by vertex order painted garbage.
      values: Array.from({ length: vertexCount }, (_, index) => index),
      min: 0,
      max: vertexCount - 1,
      units: "MPa",
      surfaceMeshRef: "solver-surface"
    };
    expect(resultFieldValuesAlignedToGeometry(surfaceField, vertexCount)).toBe(false);

    applyResultFrameToGeometry({ geometry, fields: [surfaceField], resultMode: "stress", showDeformed: false, deformationScale: 1 });
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const neutral = new THREE.Color("#0759d6");
    for (let index = 0; index < color.count; index += 1) {
      expect(color.getX(index)).toBeCloseTo(neutral.r, 5);
      expect(color.getY(index)).toBeCloseTo(neutral.g, 5);
      expect(color.getZ(index)).toBeCloseTo(neutral.b, 5);
    }
  });

  test("still colors procedural geometry from genuinely vertex-aligned local field values", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const vertexCount = (geometry.getAttribute("position") as THREE.BufferAttribute).count;
    const alignedField: ResultField = {
      id: "stress-local",
      runId: "run-local",
      type: "stress",
      location: "node",
      values: Array.from({ length: vertexCount }, (_, index) => index),
      min: 0,
      max: vertexCount - 1,
      units: "MPa"
    };
    expect(resultFieldValuesAlignedToGeometry(alignedField, vertexCount)).toBe(true);
    expect(resultFieldValuesAlignedToGeometry(alignedField, vertexCount + 1)).toBe(false);

    applyResultFrameToGeometry({ geometry, fields: [alignedField], resultMode: "stress", showDeformed: false, deformationScale: 1 });
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const first = [color.getX(0), color.getY(0), color.getZ(0)];
    const last = [color.getX(color.count - 1), color.getY(color.count - 1), color.getZ(color.count - 1)];
    expect(first).not.toEqual(last);
  });

  test("steps per-frame surface fields through the surface render path with a run-wide deformation peak", () => {
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ] as [number, number, number][],
      triangles: [[0, 1, 2]] as [number, number, number][],
      nodeMap: [0, 1, 2]
    };
    const frameField = (partial: Partial<ResultField> & Pick<ResultField, "id" | "type" | "values" | "min" | "max" | "units">, frameIndex: number, timeSeconds: number): ResultField => ({
      runId: "run-surface",
      location: "node",
      surfaceMeshRef: "solver-surface",
      frameIndex,
      timeSeconds,
      ...partial
    } as ResultField);
    const fields: ResultField[] = [
      frameField({ id: "frame-0-stress-surface", type: "stress", values: [0, 1, 2], min: 0, max: 7, units: "MPa" }, 0, 0),
      frameField({ id: "frame-0-displacement-surface", type: "displacement", values: [0, 0, 0], vectors: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], min: 0, max: 0, units: "mm" }, 0, 0),
      frameField({ id: "frame-1-stress-surface", type: "stress", values: [5, 6, 7], min: 0, max: 7, units: "MPa" }, 1, 0.005),
      frameField({ id: "frame-1-displacement-surface", type: "displacement", values: [0.2, 0, 0], vectors: [[0, 0, 0.2], [0, 0, 0], [0, 0, 0]], min: 0, max: 0.2, units: "mm" }, 1, 0.005)
    ];
    const cache = createResultFrameCache(fields);

    const frame0 = solverSurfaceResultFields(surfaceMesh, cache.fieldsForFrame(0), "stress");
    const frame1 = solverSurfaceResultFields(surfaceMesh, cache.fieldsForFrame(1), "stress");
    expect(frame0?.scalarField.values).toEqual([0, 1, 2]);
    expect(frame1?.scalarField.values).toEqual([5, 6, 7]);
    // The near-zero opening frame must deform with the run-wide displacement peak so it
    // does not self-normalize into a torn shape.
    expect(frame0?.displacementPeakMagnitude).toBeCloseTo(0.2, 9);
    expect(frame1?.displacementPeakMagnitude).toBeCloseTo(0.2, 9);

    // Packed playback interpolation between frames preserves type/location/surfaceMeshRef
    // and node alignment, so the interpolated frame still renders on the surface path.
    const interpolated = cache.fieldsForFramePosition(0.5);
    const midSurface = solverSurfaceResultFields(surfaceMesh, interpolated, "stress");
    expect(midSurface).not.toBeNull();
    expect(midSurface?.scalarField.location).toBe("node");
    expect(midSurface?.scalarField.surfaceMeshRef).toBe("solver-surface");
    expect(midSurface?.scalarField.values.length).toBe(surfaceMesh.nodes.length);
    expect(midSurface?.scalarField.values[0]).toBeCloseTo(2.5, 9);
  });

  test("renders container safety-factor surface fields directly for static and dynamic results", () => {
    const surfaceMesh = {
      id: "solver-surface",
      nodes: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ] as [number, number, number][],
      triangles: [[0, 1, 2]] as [number, number, number][],
      nodeMap: [0, 1, 2]
    };
    const staticFields: ResultField[] = [
      {
        id: "safety-factor-surface",
        runId: "run-surface",
        type: "safety_factor",
        location: "node",
        values: [4, 3, 2],
        min: 0,
        max: 4,
        units: "ratio",
        surfaceMeshRef: "solver-surface"
      },
      {
        id: "displacement-surface",
        runId: "run-surface",
        type: "displacement",
        location: "node",
        values: [0.1, 0, 0],
        vectors: [[0, 0, 0.1], [0, 0, 0], [0, 0, 0]],
        min: 0,
        max: 0.1,
        units: "mm",
        surfaceMeshRef: "solver-surface"
      }
    ];
    const staticResult = solverSurfaceResultFields(surfaceMesh, staticFields, "safety_factor");
    expect(staticResult?.scalarField.id).toBe("safety-factor-surface");
    expect(staticResult?.scalarField.values).toEqual([4, 3, 2]);
    expect(staticResult?.displacementField?.id).toBe("displacement-surface");

    const dynamicFields: ResultField[] = [0, 1].flatMap((frameIndex): ResultField[] => [
      {
        id: `frame-${frameIndex}-safety-factor-surface`,
        runId: "run-surface",
        type: "safety_factor",
        location: "node",
        values: frameIndex === 0 ? [9, 8, 7] : [3, 2, 1],
        min: 0,
        max: 9,
        units: "ratio",
        surfaceMeshRef: "solver-surface",
        frameIndex,
        timeSeconds: frameIndex * 0.005
      },
      {
        id: `frame-${frameIndex}-displacement-surface`,
        runId: "run-surface",
        type: "displacement",
        location: "node",
        values: [0, 0, 0],
        vectors: [[0, 0, 0.1 * frameIndex], [0, 0, 0], [0, 0, 0]],
        min: 0,
        max: 0.1 * frameIndex,
        units: "mm",
        surfaceMeshRef: "solver-surface",
        frameIndex,
        timeSeconds: frameIndex * 0.005
      }
    ]);
    const cache = createResultFrameCache(dynamicFields);
    const frame1 = solverSurfaceResultFields(surfaceMesh, cache.fieldsForFrame(1), "safety_factor");
    expect(frame1?.scalarField.id).toBe("frame-1-safety-factor-surface");
    expect(frame1?.scalarField.values).toEqual([3, 2, 1]);
  });

  test("labels preset mesh summary values as estimates in the result legend", () => {
    expect(legendMeshStats({ nodes: 182400, elements: 119808, warnings: [], analysisSampleCount: 45000, quality: "ultra" })).toEqual({
      nodes: "182,400 (est.)",
      elements: "119,808 (est.)"
    });
  });

  test("shows solver-reported mesh statistics without an estimate marker", () => {
    expect(legendMeshStats({ nodes: 5132, elements: 18345, warnings: [], source: "core_solver" })).toEqual({
      nodes: "5,132",
      elements: "18,345"
    });
  });

  test("shows placeholders when no mesh summary exists instead of fabricated counts", () => {
    expect(legendMeshStats(undefined)).toEqual({ nodes: "--", elements: "--" });
  });

  test("resizes the result legend from a top-right handle", () => {
    expect(cadViewerSource).toContain("analysis-legend-resize");
    expect(cadViewerSource).toContain("Resize results legend");
    expect(cadViewerSource).toContain("const RESULT_LEGEND_MIN_HEIGHT = 154");
    expect(cadViewerSource).toContain("const RESULT_LEGEND_DEFAULT_HEIGHT = 154");

    expect(resultLegendResizeDimensions({
      currentClientX: 520,
      currentClientY: 120,
      maxHeight: 576,
      maxWidth: 976,
      minHeight: 154,
      minWidth: 280,
      startClientX: 460,
      startClientY: 180,
      startHeight: 154,
      startWidth: 360
    })).toEqual({ width: 420, height: 214 });
  });

  test("clamps result legend resize to viewport-safe dimensions", () => {
    expect(resultLegendResizeDimensions({
      currentClientX: 80,
      currentClientY: -800,
      maxHeight: 576,
      maxWidth: 976,
      minHeight: 154,
      minWidth: 280,
      startClientX: 460,
      startClientY: 180,
      startHeight: 154,
      startWidth: 360
    })).toEqual({ width: 280, height: 576 });
  });

  test("scales result legend content as the legend is resized", () => {
    expect(resultLegendContentScale({ width: 360, height: 154 })).toBe(1);
    expect(resultLegendContentScale({ width: 720, height: 308 })).toBe(1.75);
    expect(resultLegendContentScale({ width: 280, height: 154 })).toBe(0.78);
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

  test("uses Core displacement samples directly for separate meshes that share a joint", () => {
    const fields: ResultField[] = [{
      id: "field-displacement-core",
      runId: "run-core",
      type: "displacement",
      location: "node",
      values: [0.1, 0.1, 0.2, 0.2],
      min: 0,
      max: 0.2,
      units: "mm",
      samples: [
        { point: [-1, 0, 0], normal: [0, 1, 0], value: 0.1, vector: [0, 0.1, 0], nodeId: "N0", source: "opencae_core" },
        { point: [0, 0, 0], normal: [0, 1, 0], value: 0.1, vector: [0, 0.1, 0], nodeId: "N1", source: "opencae_core" },
        { point: [1, 0, 0], normal: [0, 1, 0], value: 0.2, vector: [0, 0.2, 0], nodeId: "N2", source: "opencae_core" },
        { point: [0, 1, 0], normal: [0, 1, 0], value: 0.2, vector: [0, 0.2, 0], nodeId: "N3", source: "opencae_core" }
      ],
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-cpu-tet4",
        solverVersion: "0.1.0",
        meshSource: "opencae_core_tet4",
        resultSource: "computed",
        units: "m-N-s-Pa"
      }
    }];
    const body = new THREE.BufferGeometry();
    body.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, -1, 0.1, 0], 3));
    body.setIndex([0, 1, 2]);
    const rib = new THREE.BufferGeometry();
    rib.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    rib.setIndex([0, 1, 2]);

    colorizeSampleResultGeometry(body, "bracket", "displacement", true, 1, [], [], 1, [], fields);
    colorizeSampleResultGeometry(rib, "bracket", "displacement", true, 1, [], [], 1, [], fields);

    const bodyPositions = body.getAttribute("position") as THREE.BufferAttribute;
    const ribPositions = rib.getAttribute("position") as THREE.BufferAttribute;
    expect(bodyPositions.getX(1)).toBeCloseTo(ribPositions.getX(0), 6);
    expect(bodyPositions.getY(1)).toBeCloseTo(ribPositions.getY(0), 6);
    expect(bodyPositions.getZ(1)).toBeCloseTo(ribPositions.getZ(0), 6);
  });

  test("does not extrapolate Core displacement spikes far outside the sample cloud", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 6, 0, 0.05, 6, 0], 3));
    geometry.setIndex([0, 1, 2]);
    const fields: ResultField[] = [{
      id: "field-displacement-core-sparse",
      runId: "run-core",
      type: "displacement",
      location: "node",
      values: [0, 0.1, 0.2, 0.3],
      min: 0,
      max: 0.3,
      units: "mm",
      samples: [
        { point: [-1, 0, 0], normal: [0, 1, 0], value: 0, vector: [0, 0, 0], nodeId: "N0", source: "opencae_core" },
        { point: [0, 0, 0], normal: [0, 1, 0], value: 0.1, vector: [0, 0.1, 0], nodeId: "N1", source: "opencae_core" },
        { point: [1, 0, 0], normal: [0, 1, 0], value: 0.2, vector: [0, 0.2, 0], nodeId: "N2", source: "opencae_core" },
        { point: [2, 0, 0], normal: [0, 1, 0], value: 0.3, vector: [0, 0.3, 0], nodeId: "N3", source: "opencae_core" }
      ]
    }];

    colorizeSampleResultGeometry(geometry, "bracket", "displacement", true, 1, [], [], 1, [], fields);

    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(Number.isFinite(positions.getY(1))).toBe(true);
    expect(Math.abs(positions.getY(1) - 6)).toBeLessThan(0.05);
    expect(Math.abs(positions.getY(2) - 6)).toBeLessThan(0.05);
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
      vectorOffsets: new Int32Array([0]),
      vectorLengths: new Int32Array([0]),
      vectors: new Float32Array([]),
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
    const sampleModel: DisplayModel = { id: "sample-bracket", name: "Sample bracket", bodyCount: 1, faces: [] };

    const zBuild = printLayerVisualizationForBounds(bounds, "z", sampleModel);
    const yBuild = printLayerVisualizationForBounds(bounds, "y", sampleModel);
    const xBuild = printLayerVisualizationForBounds(bounds, "x", sampleModel);

    expect(zBuild?.axis.toArray()).toEqual([0, 1, 0]);
    expect(zBuild).not.toHaveProperty("label");
    expect(zBuild?.planes).toHaveLength(7);
    expect(zBuild?.planes[0]?.every((point) => point[1] === -1)).toBe(true);
    expect(yBuild?.axis.toArray()).toEqual([0, 0, 1]);
    expect(yBuild?.planes[0]?.every((point) => point[2] === -0.5)).toBe(true);
    expect(xBuild?.axis.toArray()).toEqual([1, 0, 0]);
    expect(xBuild?.planes[0]?.every((point) => point[0] === -2)).toBe(true);

    const uploadedModel: DisplayModel = { id: "uploaded-step", name: "Uploaded STEP", bodyCount: 1, faces: [] };
    expect(printLayerVisualizationForBounds(bounds, "z", uploadedModel)?.axis.toArray()).toEqual([0, 0, 1]);
    expect(printLayerVisualizationForBounds(bounds, "y", uploadedModel)?.axis.toArray()).toEqual([0, 1, 0]);

    const rotatedUpload = { ...uploadedModel, orientation: { x: 0, y: 0, z: 90 } };
    expect(printLayerVisualizationForBounds(bounds, "y", rotatedUpload)?.axis.toArray()).toEqual([1, 0, 0]);
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
    // The run-wide peak gates deformation even when the opening frame is exactly zero, so a
    // ramp-from-rest transient still animates instead of being pinned undeformed.
    expect(deformationScaleForResultFields([{ ...zeroFrame, max: 0 }, peakFrame])).toBe(1);
  });

  test("keeps the paused opening transient frame undeformed instead of amplifying near-zero noise", () => {
    const points: [number, number, number][] = [[-1, 0, 0], [0, 0, 0], [1, 0, 0]];
    const buildGeometry = () => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
      return geometry;
    };
    // Opening frame: tiny, spatially incoherent displacement with its OWN per-frame max,
    // mirroring a non-stabilized Core Cloud frame 0 (ramp load starts at 0). Peak frame:
    // large coherent displacement. Both keep raw per-frame min/max (not globally stabilized).
    const openingFrame: ResultField = {
      id: "displacement-frame-0",
      runId: "run-transient",
      type: "displacement",
      location: "node",
      values: [0.001, 0.001, 0.001],
      min: 0,
      max: 0.001,
      units: "mm",
      frameIndex: 0,
      timeSeconds: 0,
      samples: points.map((point, index) => ({
        point,
        normal: [0, 1, 0] as [number, number, number],
        value: 0.001,
        vector: [0, index % 2 === 0 ? 0.001 : -0.001, 0] as [number, number, number]
      }))
    };
    const peakFrame: ResultField = {
      id: "displacement-frame-10",
      runId: "run-transient",
      type: "displacement",
      location: "node",
      values: [1, 1, 1],
      min: 0,
      max: 1,
      units: "mm",
      frameIndex: 10,
      timeSeconds: 0.1,
      samples: points.map((point) => ({
        point,
        normal: [0, 1, 0] as [number, number, number],
        value: 1,
        vector: [0, -1, 0] as [number, number, number]
      }))
    };

    const maxDelta = (geometry: THREE.BufferGeometry) => {
      const position = geometry.getAttribute("position") as THREE.BufferAttribute;
      let max = 0;
      for (let index = 0; index < position.count; index += 1) {
        max = Math.max(max, Math.abs(position.getY(index)));
      }
      return max;
    };

    // Paused on the opening frame: all frames are present (static path), the displacement
    // vectors come from frame 0, but the scale is normalized by the run-wide peak, so the
    // amplified near-zero noise must NOT tear the mesh.
    const pausedGeometry = buildGeometry();
    applyResultFrameToGeometry({
      geometry: pausedGeometry,
      fields: [openingFrame, peakFrame],
      resultMode: "displacement",
      showDeformed: true,
      deformationScale: 1
    });
    expect(maxDelta(pausedGeometry)).toBeLessThan(0.02);

    // The peak frame on its own still deforms visibly under the same scale.
    const peakGeometry = buildGeometry();
    applyResultFrameToGeometry({
      geometry: peakGeometry,
      fields: [peakFrame],
      resultMode: "displacement",
      showDeformed: true,
      deformationScale: 1
    });
    expect(maxDelta(peakGeometry)).toBeGreaterThan(0.05);
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

describe("solver-space cloud sample reconciliation (procedural path)", () => {
  // The documented solver<->display convention: procedural display geometry (mm, Y-up) reaches
  // the viewer via baseModelRotation [pi/2,0,0]; the cloud meshes/solves in solver space
  // (meters, Z-up). So a display point maps to solver space by R([pi/2,0,0]) then x0.001.
  const SOLVER_SCALE = 0.001;
  function displayToSolver(p: [number, number, number]): [number, number, number] {
    // R(+pi/2 about X): (x,y,z) -> (x,-z,y)
    return [p[0] * SOLVER_SCALE, -p[2] * SOLVER_SCALE, p[1] * SOLVER_SCALE];
  }

  // 120 x 88 x 34 mm display box (bracket-scale), centred at the origin.
  const DIMS: [number, number, number] = [120, 88, 34];
  function buildBox() {
    return new THREE.BoxGeometry(DIMS[0], DIMS[1], DIMS[2], 8, 8, 8);
  }

  // Cloud-style displacement + stress fields: sample POINTS in solver meters, a stress gradient
  // along display +X, and a displacement that grows toward display +X (cantilever-like) pointing
  // display -Y. The displacement vector is expressed in the SOLVER frame, as the cloud emits it.
  function solverSpaceFields(): ResultField[] {
    const dispSamples: NonNullable<ResultField["samples"]> = [];
    const stressSamples: NonNullable<ResultField["samples"]> = [];
    const dispValues: number[] = [];
    const stressValues: number[] = [];
    for (let ix = 0; ix <= 2; ix += 1) {
      for (let iy = 0; iy <= 2; iy += 1) {
        for (let iz = 0; iz <= 2; iz += 1) {
          const dx = (ix / 2 - 0.5) * DIMS[0];
          const dy = (iy / 2 - 0.5) * DIMS[1];
          const dz = (iz / 2 - 0.5) * DIMS[2];
          const tipFraction = ix / 2; // 0 at display -X (fixed), 1 at display +X (free)
          const magMm = 0.5 * tipFraction; // mm, grows toward +X
          const stress = 10 + 90 * tipFraction; // MPa gradient
          const point = displayToSolver([dx, dy, dz]);
          const solverVector = displayToSolver([0, -magMm, 0]).map((v, i) => v / SOLVER_SCALE) as [number, number, number]; // direction only, mm magnitude
          dispSamples.push({ point, normal: [0, 0, 1], value: magMm, vector: solverVector });
          stressSamples.push({ point, normal: [0, 0, 1], value: stress });
          dispValues.push(magMm);
          stressValues.push(stress);
        }
      }
    }
    return [
      { id: "disp", runId: "r", type: "displacement", location: "node", values: dispValues, min: 0, max: 0.5, units: "mm", samples: dispSamples, frameIndex: 10, timeSeconds: 0.1 },
      { id: "stress", runId: "r", type: "stress", location: "element", values: stressValues, min: 10, max: 100, units: "MPa", samples: stressSamples, frameIndex: 10, timeSeconds: 0.1 }
    ];
  }

  test("builds a reconciling transform only when samples are in solver space, and it round-trips", () => {
    const geometry = buildBox();
    geometry.computeBoundingBox();
    const transform = solverSpaceResultCoordinateTransform(geometry, solverSpaceFields());
    expect(transform).toBeTruthy();
    // A far display corner must map near its solver counterpart, NOT collapse to the origin.
    const corner = new THREE.Vector3(60, 44, 17);
    const mapped = transform!.toResultPoint(corner.clone());
    expect(mapped.length()).toBeGreaterThan(0.05); // ~0.075 m, not ~0
    const roundTrip = transform!.fromResultPoint(mapped);
    expect(roundTrip.x).toBeCloseTo(60, 3);
    expect(roundTrip.y).toBeCloseTo(44, 3);
    expect(roundTrip.z).toBeCloseTo(17, 3);

    // Display-space samples (same scale as the geometry) must NOT trigger a transform.
    const displaySpaceFields: ResultField[] = [{
      id: "disp", runId: "r", type: "displacement", location: "node", values: [0, 0],
      min: 0, max: 1, units: "mm", samples: [
        { point: [-60, -44, -17], normal: [0, 0, 1], value: 0, vector: [0, -1, 0] },
        { point: [60, 44, 17], normal: [0, 0, 1], value: 1, vector: [0, -1, 0] }
      ]
    }];
    expect(solverSpaceResultCoordinateTransform(buildBox(), displaySpaceFields)).toBeUndefined();
  });

  test("deforms the whole procedural mesh coherently instead of freezing it (the torn-shape fix)", () => {
    const geometry = buildBox();
    const basePositions = Float32Array.from(geometry.getAttribute("position").array as Float32Array);
    colorizeSampleResultGeometry(geometry, "bracket", "stress", true, 1, [], [], 1, [], solverSpaceFields());
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;

    let moved = 0;
    let maxAbsY = 0;
    let frontDeflection = 0; // display +X (free end)
    let backDeflection = 0; // display -X (fixed end)
    for (let i = 0; i < position.count; i += 1) {
      const bx = basePositions[i * 3] ?? 0;
      const dx = (position.array as Float32Array)[i * 3]! - bx;
      const dy = (position.array as Float32Array)[i * 3 + 1]! - (basePositions[i * 3 + 1] ?? 0);
      const dz = (position.array as Float32Array)[i * 3 + 2]! - (basePositions[i * 3 + 2] ?? 0);
      expect(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)).toBe(true);
      const mag = Math.hypot(dx, dy, dz);
      if (mag > 1e-6) moved += 1;
      maxAbsY = Math.max(maxAbsY, Math.abs(dy));
      if (bx > 30) frontDeflection = Math.max(frontDeflection, -dy);
      if (bx < -30) backDeflection = Math.max(backDeflection, -dy);
    }
    // Without the fix the meter-scale samples collapse near the origin and virtually every
    // vertex extrapolates to zero. With it, most of the mesh moves.
    expect(moved).toBeGreaterThan(position.count * 0.5);
    // Deformation is dominated by display -Y (the intended direction after frame reconciliation).
    expect(maxAbsY).toBeGreaterThan(0);
    // Spatially correct: the free (+X) end deflects more than the fixed (-X) end.
    expect(frontDeflection).toBeGreaterThan(backDeflection);
  });
});

describe("element-stress recovery onto the solver surface (smooth contour fix)", () => {
  const surfaceMesh = {
    id: "solver-surface",
    nodes: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ] as [number, number, number][],
    triangles: [[0, 1, 2], [0, 2, 3]] as [number, number, number][],
    nodeMap: [0, 1, 2, 3]
  };

  // An element-located stress field whose samples sit exactly on the surface nodes (this is how
  // the cloud emits non-surface fields: sample.point = surface-node point). No surfaceMeshRef, so
  // it does NOT qualify as a solver-surface node field and would otherwise hit the streaky path.
  function elementStressField(): ResultField {
    return {
      id: "stress-element",
      runId: "run-surface",
      type: "stress",
      location: "element",
      values: [5, 15, 25, 35],
      min: 5,
      max: 35,
      units: "MPa",
      samples: [
        { point: [0, 0, 0], normal: [0, 0, 1], value: 5 },
        { point: [1, 0, 0], normal: [0, 0, 1], value: 15 },
        { point: [0, 1, 0], normal: [0, 0, 1], value: 25 },
        { point: [0, 0, 1], normal: [0, 0, 1], value: 35 }
      ]
    };
  }

  test("recovers a node-aligned stress field exactly when samples coincide with surface nodes", () => {
    const recovered = recoverSurfaceNodeScalarField(surfaceMesh, [elementStressField()], "stress");
    expect(recovered).toBeTruthy();
    expect(recovered!.location).toBe("node");
    expect(recovered!.surfaceMeshRef).toBe("solver-surface");
    expect(recovered!.values).toHaveLength(surfaceMesh.nodes.length);
    // Exact at coincident points (distance 0 short-circuits the IDW blend).
    expect(recovered!.values).toEqual([5, 15, 25, 35]);
    expect(recovered!.samples).toBeUndefined();
    // The recovered field must satisfy the smooth surface render path's invariants.
    const geometry = buildSolverSurfaceResultGeometry({
      surfaceMesh,
      scalarField: recovered!,
      resultMode: "stress",
      showDeformed: false,
      deformationScale: 1
    });
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    // A real gradient: the low-stress node and the high-stress node get different colors.
    const lowDiffersFromHigh =
      Math.abs(color.getX(0) - color.getX(3)) +
      Math.abs(color.getY(0) - color.getY(3)) +
      Math.abs(color.getZ(0) - color.getZ(3));
    expect(lowDiffersFromHigh).toBeGreaterThan(0.1);
  });

  test("interpolates smoothly (bounded, finite) when samples do not coincide with nodes", () => {
    const offsetSamples: ResultField = {
      ...elementStressField(),
      samples: [
        { point: [0.4, 0.1, 0.1], normal: [0, 0, 1], value: 10 },
        { point: [0.1, 0.4, 0.1], normal: [0, 0, 1], value: 20 },
        { point: [0.1, 0.1, 0.4], normal: [0, 0, 1], value: 30 }
      ]
    };
    const recovered = recoverSurfaceNodeScalarField(surfaceMesh, [offsetSamples], "stress");
    expect(recovered).toBeTruthy();
    expect(recovered!.values).toHaveLength(4);
    for (const value of recovered!.values) {
      expect(Number.isFinite(value)).toBe(true);
      // IDW stays within the sample range — no overshoot/ringing.
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(30);
    }
  });

  test("does not recover vector modes or when a real node field already exists", () => {
    expect(recoverSurfaceNodeScalarField(surfaceMesh, [elementStressField()], "displacement")).toBeNull();
    const nodeStress: ResultField = {
      id: "stress-node",
      runId: "run-surface",
      type: "stress",
      location: "node",
      values: [1, 2, 3, 4],
      min: 1,
      max: 4,
      units: "MPa",
      surfaceMeshRef: "solver-surface"
    };
    expect(recoverSurfaceNodeScalarField(surfaceMesh, [nodeStress, elementStressField()], "stress")).toBeNull();
  });

  test("returns null when there is no usable source field", () => {
    expect(recoverSurfaceNodeScalarField(surfaceMesh, [], "stress")).toBeNull();
    const noSamples: ResultField = { ...elementStressField(), samples: undefined };
    expect(recoverSurfaceNodeScalarField(surfaceMesh, [noSamples], "stress")).toBeNull();
  });
});
