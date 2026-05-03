import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ElementRef, MouseEvent as ReactMouseEvent, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import { Billboard, Bounds, Edges, GizmoHelper, Html, Line, OrbitControls, Text, useBounds } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import type { DisplayFace, DisplayModel, MeshSummary, ResultField, ResultRenderBounds } from "@opencae/schema";
import { meshVolumeM3FromTriangles, type Triangle } from "@opencae/units";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import type { StepId } from "./StepBar";
import { faceForModelHit, type SampleModelKind } from "../modelSelection";
import { baseModelRotationRadians, modelRotationRadians, modelToViewerMatrix, viewerNormalToModelSpace, viewerPointToModelSpace, type RotationAxis } from "../modelOrientation";
import { dimensionValuesForDisplayModel } from "../modelDimensions";
import { formatResultValue, normalizeValueForRender, resultProbeSamplesForFaces, resultSamplesForFaces, type FaceResultSample, type FieldResultSample, type ResultProbeTone } from "../resultFields";
import { packedPreparedPlaybackFieldSlot, packedPreparedPlaybackFrameOrdinal, type PackedPreparedPlaybackCache } from "../resultPlaybackCache";
import { createVertexResultMapping, type VertexResultMapping } from "../resultVertexMapping";
import { stepPreviewFromBase64 } from "../stepPreview";
import { normalizedStlGeometryFromBuffer } from "../stlPreview";
import { lengthForUnits, stressForUnits, type UnitSystem } from "../unitDisplay";
import { loadMarkerViewportPresentation, type PayloadObjectSelection } from "../loadPreview";
import { highlightPayloadObjectMeshes } from "../payloadObjectHighlight";
import { layoutOutsideModelLabels, payloadMassLabelOffset, type LabelAnchor } from "../calloutLabelLayout";
import { getSnapSuggestion } from "../snapping/snapController";
import { isSnapOverlayObject, SnapVisualization } from "../snapping/Visualization";
import type { CursorRay, FaceSnapAxis, SnapMeasurement, SnapResult, Vec3 } from "../snapping/types";

export type ViewMode = "model" | "mesh" | "results";
export type ResultMode = "stress" | "displacement" | "safety_factor" | "velocity" | "acceleration";
export type ThemeMode = "dark" | "light";
export type PrintLayerOrientation = "x" | "y" | "z";
export interface ViewerLoadMarker {
  id: string;
  faceId: string;
  point?: [number, number, number];
  payloadObject?: PayloadObjectSelection;
  type: string;
  value: number;
  units: string;
  direction: [number, number, number];
  directionLabel: string;
  labelIndex: number;
  stackIndex: number;
  preview?: boolean;
}

export interface ViewerSupportMarker {
  id: string;
  faceId: string;
  type: string;
  displayLabel: string;
  label: string;
  stackIndex: number;
}

export interface ResultPlaybackFrameSnapshot {
  cache: PackedPreparedPlaybackCache;
  framePosition: number;
}

export interface ResultPlaybackFrameController {
  subscribe: (listener: (snapshot: ResultPlaybackFrameSnapshot) => void) => () => void;
  getSnapshot: () => ResultPlaybackFrameSnapshot | null;
}

interface CadViewerProps {
  displayModel: DisplayModel;
  activeStep: StepId;
  selectedFaceId: string | null;
  payloadObjectSelectionMode: boolean;
  selectedPayloadObject: PayloadObjectSelection | null;
  onViewerMiss: () => void;
  onSelectFace: (face: DisplayFace, point?: [number, number, number], payloadObject?: PayloadObjectSelection) => void;
  viewMode: ViewMode;
  resultMode: ResultMode;
  showDeformed: boolean;
  resultPlaybackPlaying: boolean;
  showDimensions: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  resultPlaybackBufferCache?: PackedPreparedPlaybackCache | null;
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  meshSummary?: MeshSummary;
  unitSystem: UnitSystem;
  themeMode: ThemeMode;
  fitSignal: number;
  viewAxis: RotationAxis | null;
  viewAxisSignal: number;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  printLayerOrientation: PrintLayerOrientation | null;
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onResultRenderBoundsChange?: (bounds: ResultRenderBounds | null) => void;
  onViewerInteractionChange?: (interacting: boolean) => void;
}

const BRACKET_DEPTH = 1.1;
const RIB_DEPTH = 0.38;
const BEAM_DEPTH = 0.36;
const BEAM_HEIGHT = 0.28;
const BEAM_CENTER_Y = BEAM_HEIGHT / 2;
const BEAM_TOP_Y = BEAM_HEIGHT;
const CANTILEVER_HEIGHT = 0.5;
const CANTILEVER_DEPTH = 0.72;
const CANTILEVER_CENTER_Y = 0.18;
const CANTILEVER_TOP_Y = CANTILEVER_CENTER_Y + CANTILEVER_HEIGHT / 2;
const CANTILEVER_BOTTOM_Y = CANTILEVER_CENTER_Y - CANTILEVER_HEIGHT / 2;
const CANTILEVER_OUTER_Z = CANTILEVER_DEPTH / 2;
const BEAM_PAYLOAD_HEIGHT = 0.42;
const BEAM_PAYLOAD_OBJECT_ID = "payload-display-plate";
const BEAM_PAYLOAD_LABEL = "end payload mass";
const BEAM_PAYLOAD_CENTER: [number, number, number] = [1.48, BEAM_TOP_Y + BEAM_PAYLOAD_HEIGHT / 2, 0];
const BEAM_PAYLOAD_VOLUME_M3 = 0.00018432;
const WORLD_UP = new THREE.Vector3(0, 0, 1);
const ISO_CAMERA_DIRECTION = new THREE.Vector3(1, 1, 1).normalize();
const ISO_CAMERA_UP = WORLD_UP.clone().projectOnPlane(ISO_CAMERA_DIRECTION).normalize();
const RESULT_PAYLOAD_MATERIAL_COLOR = "#8f9aa5";
const DEFAULT_DEFORMATION_REFERENCE_MM = 0.2;
const MAX_RESULT_DEFORMATION_SCALE = 2.5;
const BRACKET_HOLES = [
  { id: "upright-hole", center: [-1.2, 1.48] as [number, number], radius: 0.17, supported: false },
  { id: "base-hole-left", center: [0.24, 0] as [number, number], radius: 0.13, supported: true },
  { id: "base-hole-right", center: [1.2, 0] as [number, number], radius: 0.13, supported: true }
];
type ViewerOrbitControls = ElementRef<typeof OrbitControls>;
type ViewCubeCornerDirection = [number, number, number];
type GizmoViewRequest = RotationAxis | "iso" | { kind: "corner"; direction: ViewCubeCornerDirection };
export type ViewCubeFaceLabel = "Front" | "Back" | "Right" | "Left" | "Top" | "Bottom";
export type GizmoViewTarget = "+x" | "+y" | "+z" | "front" | "right" | "top" | "iso";
type ModelSelectionHit = { face: DisplayFace; point: [number, number, number]; payloadObject?: PayloadObjectSelection; snapResult?: SnapResult | null };
type ModelPickHandlers = {
  onPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: () => void;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
};
export const VIEWER_GIZMO_ALIGNMENT = "bottom-right";
export const VIEWER_GIZMO_MARGIN: [number, number] = [112, 112];
export const VIEWER_GIZMO_SCALE = 40;
export const VIEWER_AXIS_HEAD_RADIUS = 0.26;
export const VIEWER_AXIS_LABEL_BADGE_RADIUS = 0.18;
export const VIEWER_AXIS_LABEL_BADGE_COLOR = "#07111d";
export const VIEWER_AXIS_LABEL_FONT_SIZE = 0.24;
export const VIEWER_AXIS_LABEL_FONT_WEIGHT = 800;
export const VIEWER_AXIS_LABEL_COLOR = "#ffffff";
export const VIEWER_AXIS_LABEL_OUTLINE_COLOR = "#07111d";
export const VIEWER_AXIS_LABEL_OUTLINE_WIDTH = 0.028;
// Positive-octant view cube layout:
// axis origin is one cube corner.
// cube bounds are [0, cubeSize] on X/Y/Z.
// X/Y/Z axis labels sit beyond the cube in positive directions.
export const VIEWER_GIZMO_AXIS_LENGTH = 1.75;
export const VIEWER_GIZMO_LABEL_DISTANCE = 1.9;
export const VIEWER_VIEW_CUBE_SIZE = 1.2;
export const VIEWER_VIEW_CUBE_BODY_OPACITY = 1;
export const VIEWER_VIEW_CUBE_FACE_OPACITY = 0.62;
export const VIEWER_VIEW_CUBE_FACE_HOVER_OPACITY = 0.78;
export const VIEWER_VIEW_CUBE_EDGE_COLOR = "#8fb4d8";
export const VIEWER_VIEW_CUBE_FACE_LABEL_FONT_SIZE = 0.32;
export const VIEWER_VIEW_CUBE_CORNER_RADIUS = 0.082;
export const VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS = 0.19;
const VIEWER_VIEW_CUBE_FACE_VISIBILITY_THRESHOLD = 0;
export const VIEWER_ISOMETRIC_GIZMO_VIEW = "iso";
export const VIEWER_CREDIT_URL = "https://esauengineering.com/";
const VIEWER_FIT_MARGIN = 1.28;
const DEFAULT_HOME_FIT_MARGIN = 1.46;
const VIEWER_FIT_RETRY_DELAY_MS = 120;
const VIEWER_STATS_LOG_INTERVAL_MS = 1000;
const VIEWER_STATS_STORAGE_KEY = "opencae.perf.viewerStats";
const VIEWER_IDLE_DPR_RANGE: [number, number] = [1, 2];
const VIEWER_ACTIVE_DPR_RANGE: [number, number] = [1, 1.25];
const DEBUG_PERF =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("debugPerf") === "1";
const DEBUG_RESULTS =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("debugResults") === "1";
const DEBUG_FORCE_DEFORMATION_SCALE =
  import.meta.env.DEV && DEBUG_RESULTS && typeof window !== "undefined"
    ? Number(new URLSearchParams(window.location.search).get("forceDeformScale"))
    : Number.NaN;
const RESULT_DEFORMATION_TARGET_FRACTION = 0.08;
const RESULT_DEFORMATION_CAP_FRACTION = DEBUG_RESULTS ? 1 : 0.25;

export function viewerGizmoLayout() {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const origin: [number, number, number] = [0, 0, 0];
  const contentCenter: [number, number, number] = [
    VIEWER_GIZMO_LABEL_DISTANCE / 2,
    VIEWER_GIZMO_LABEL_DISTANCE / 2,
    VIEWER_GIZMO_LABEL_DISTANCE / 2
  ];
  return {
    origin,
    cubeMin: [0, 0, 0] as [number, number, number],
    cubeMax: [cubeSize, cubeSize, cubeSize] as [number, number, number],
    cubeCenter: [cubeSize / 2, cubeSize / 2, cubeSize / 2] as [number, number, number],
    contentCenter,
    contentOffset: contentCenter.map((value) => -value) as [number, number, number],
    axisCapPositions: {
      x: [VIEWER_GIZMO_LABEL_DISTANCE, 0, 0] as [number, number, number],
      y: [0, VIEWER_GIZMO_LABEL_DISTANCE, 0] as [number, number, number],
      z: [0, 0, VIEWER_GIZMO_LABEL_DISTANCE] as [number, number, number]
    }
  };
}

export function CadViewer(props: CadViewerProps) {
  const controlsRef = useRef<ViewerOrbitControls | null>(null);
  const [uploadedPreviewBounds, setUploadedPreviewBounds] = useState<THREE.Box3 | null>(null);
  const [gizmoViewRequest, setGizmoViewRequest] = useState<{ view: GizmoViewRequest | null; signal: number }>({ view: null, signal: 0 });
  const [viewerInteracting, setViewerInteracting] = useState(false);
  const effectiveViewMode: ViewMode = props.activeStep === "results" ? props.viewMode : props.viewMode === "mesh" ? "mesh" : "model";
  const suppressPlaybackOverlays = props.resultPlaybackPlaying;
  const showDimensionOverlay = shouldShowDimensionOverlay(props.showDimensions, effectiveViewMode) && !suppressPlaybackOverlays;
  const viewerDpr = props.resultPlaybackPlaying || viewerInteracting ? VIEWER_ACTIVE_DPR_RANGE : VIEWER_IDLE_DPR_RANGE;
  const isLightTheme = props.themeMode === "light";
  const viewportBackground = isLightTheme ? "#f7f9fc" : "#070b10";
  const modelRotation = useMemo(() => modelRotationRadians(props.displayModel), [props.displayModel]);
  const baseModelRotation = useMemo(() => baseModelRotationRadians(props.displayModel), [props.displayModel]);
  const resultFields = props.resultFields;
  const viewerStatsEnabled = isViewerRendererStatsEnabled();
  const handleViewerInteractionChange = (interacting: boolean) => {
    setViewerInteracting(interacting);
    props.onViewerInteractionChange?.(interacting);
  };
  useEffect(() => {
    setUploadedPreviewBounds(null);
  }, [props.displayModel.nativeCad?.contentBase64, props.displayModel.visualMesh?.contentBase64]);
  useEffect(() => {
    const kind = modelKindForDisplayModel(props.displayModel);
    const bounds = kind === "uploaded" && uploadedPreviewBounds ? uploadedPreviewBounds : dimensionBoundsForDisplayModel(props.displayModel);
    props.onResultRenderBoundsChange?.(bounds ? resultRenderBoundsForBox(bounds) : null);
  }, [props.displayModel, props.onResultRenderBoundsChange, uploadedPreviewBounds]);
  return (
    <section className={`viewer-shell ${effectiveViewMode === "results" ? "results-view" : ""}`} aria-label="3D CAD viewer">
      <Canvas frameloop="demand" dpr={viewerDpr} camera={{ position: [4.8, 4.8, 4.8], up: ISO_CAMERA_UP.toArray(), fov: 42 }} onPointerMissed={props.onViewerMiss}>
        <ViewerInvalidator
          activeStep={props.activeStep}
          displayModel={props.displayModel}
          effectiveViewMode={effectiveViewMode}
          fitSignal={props.fitSignal}
          loadMarkers={props.loadMarkers}
          printLayerOrientation={props.printLayerOrientation}
          resultFields={resultFields}
          resultPlaybackBufferCache={props.resultPlaybackBufferCache}
          resultPlaybackFrameController={props.resultPlaybackFrameController}
          resultMode={props.resultMode}
          resultPlaybackPlaying={props.resultPlaybackPlaying}
          selectedFaceId={props.selectedFaceId}
          selectedPayloadObject={props.selectedPayloadObject}
          showDeformed={props.showDeformed}
          showDimensions={props.showDimensions}
          stressExaggeration={props.stressExaggeration}
          supportMarkers={props.supportMarkers}
          themeMode={props.themeMode}
          unitSystem={props.unitSystem}
          uploadedPreviewBounds={uploadedPreviewBounds}
          viewAxis={props.viewAxis}
          viewAxisSignal={props.viewAxisSignal}
        />
        <color attach="background" args={[viewportBackground]} />
        <ambientLight intensity={effectiveViewMode === "results" || isLightTheme ? 1.4 : 0.75} />
        <directionalLight position={[4, 6, 3]} intensity={effectiveViewMode === "results" || isLightTheme ? 1.45 : 2.2} />
        <Bounds fit clip observe={!props.resultPlaybackPlaying} margin={VIEWER_FIT_MARGIN}>
          <group rotation={modelRotation}>
            <group rotation={baseModelRotation}>
              <BracketModel {...props} resultFields={resultFields} viewMode={effectiveViewMode} uploadedPreviewBounds={uploadedPreviewBounds} onUploadedPreviewBounds={setUploadedPreviewBounds} />
              {showDimensionOverlay && <ModelDimensionOverlay displayModel={props.displayModel} uploadedPreviewBounds={uploadedPreviewBounds} />}
            </group>
          </group>
          <BoundsCameraReset signal={props.fitSignal} viewAxis={props.viewAxis} viewAxisSignal={props.viewAxisSignal} controlsRef={controlsRef} />
          <GizmoCameraReset view={gizmoViewRequest.view} signal={gizmoViewRequest.signal} controlsRef={controlsRef} />
        </Bounds>
        <DemandOrbitControls controlsRef={controlsRef} onInteractionChange={handleViewerInteractionChange} />
        <ShiftPanControls controlsRef={controlsRef} onInteractionChange={handleViewerInteractionChange} />
        <GizmoHelper alignment={VIEWER_GIZMO_ALIGNMENT} margin={VIEWER_GIZMO_MARGIN}>
          <CleanAxisGizmo
            onSelectView={(view) => setGizmoViewRequest((request) => ({ view, signal: request.signal + 1 }))}
          />
        </GizmoHelper>
        {viewerStatsEnabled && <ViewerRendererStatsProbe />}
      </Canvas>
      <a className="viewer-watermark" href={VIEWER_CREDIT_URL} target="_blank" rel="noreferrer">Built by Esau Engineering</a>
      {effectiveViewMode === "results" && <ResultLegend resultMode={props.resultMode} resultFields={resultFields} unitSystem={props.unitSystem} meshSummary={props.meshSummary} />}
    </section>
  );
}

function ViewerRendererStatsProbe() {
  const { gl } = useThree();
  const lastLogRef = useRef(0);
  useFrame(({ clock }) => {
    const nowMs = clock.elapsedTime * 1000;
    if (nowMs - lastLogRef.current < VIEWER_STATS_LOG_INTERVAL_MS) return;
    lastLogRef.current = nowMs;
    console.debug("[OpenCAE viewer stats]", {
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      lines: gl.info.render.lines,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures
    });
  });
  return null;
}

function isViewerRendererStatsEnabled() {
  if (typeof window === "undefined") return false;
  const explicitlyEnabled = new URLSearchParams(window.location.search).get("opencaePerf") === "1" || safeViewerStatsStorageFlag() === "1";
  const productionOptInAllowed = !import.meta.env.DEV && explicitlyEnabled;
  return (import.meta.env.DEV && explicitlyEnabled) || productionOptInAllowed;
}

function safeViewerStatsStorageFlag() {
  try {
    return window.localStorage.getItem(VIEWER_STATS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function ViewerInvalidator({
  activeStep,
  displayModel,
  effectiveViewMode,
  fitSignal,
  loadMarkers,
  printLayerOrientation,
  resultFields,
  resultPlaybackBufferCache,
  resultPlaybackFrameController,
  resultMode,
  resultPlaybackPlaying,
  selectedFaceId,
  selectedPayloadObject,
  showDeformed,
  showDimensions,
  stressExaggeration,
  supportMarkers,
  themeMode,
  unitSystem,
  uploadedPreviewBounds,
  viewAxis,
  viewAxisSignal
}: {
  activeStep: StepId;
  displayModel: DisplayModel;
  effectiveViewMode: ViewMode;
  fitSignal: number;
  loadMarkers: ViewerLoadMarker[];
  printLayerOrientation: PrintLayerOrientation | null;
  resultFields: ResultField[];
  resultPlaybackBufferCache?: PackedPreparedPlaybackCache | null;
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  resultMode: ResultMode;
  resultPlaybackPlaying: boolean;
  selectedFaceId: string | null;
  selectedPayloadObject: PayloadObjectSelection | null;
  showDeformed: boolean;
  showDimensions: boolean;
  stressExaggeration: number;
  supportMarkers: ViewerSupportMarker[];
  themeMode: ThemeMode;
  unitSystem: UnitSystem;
  uploadedPreviewBounds: THREE.Box3 | null;
  viewAxis: RotationAxis | null;
  viewAxisSignal: number;
}) {
  const { invalidate } = useThree();
  useEffect(() => {
    if (resultPlaybackBufferCache) invalidate();
  }, [invalidate, resultPlaybackBufferCache]);
  useEffect(() => {
    if (!resultPlaybackFrameController) return undefined;
    return resultPlaybackFrameController.subscribe(() => invalidate());
  }, [invalidate, resultPlaybackFrameController]);
  useEffect(() => {
    invalidate();
  }, [
    activeStep,
    displayModel,
    effectiveViewMode,
    fitSignal,
    invalidate,
    loadMarkers,
    printLayerOrientation,
    resultFields,
    resultPlaybackBufferCache,
    resultPlaybackFrameController,
    resultMode,
    resultPlaybackPlaying,
    selectedFaceId,
    selectedPayloadObject,
    showDeformed,
    showDimensions,
    stressExaggeration,
    supportMarkers,
    themeMode,
    unitSystem,
    uploadedPreviewBounds,
    viewAxis,
    viewAxisSignal
  ]);
  return null;
}

function DemandOrbitControls({ controlsRef, onInteractionChange }: { controlsRef: MutableRefObject<ViewerOrbitControls | null>; onInteractionChange?: (interacting: boolean) => void }) {
  const { invalidate } = useThree();
  const invalidateViewer = () => invalidate();
  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      target={[0, 0, 0.75]}
      onChange={invalidateViewer}
      onStart={() => onInteractionChange?.(true)}
      onEnd={() => onInteractionChange?.(false)}
    />
  );
}

function ShiftPanControls({ controlsRef, onInteractionChange }: { controlsRef: MutableRefObject<ViewerOrbitControls | null>; onInteractionChange?: (interacting: boolean) => void }) {
  const { camera, gl, invalidate } = useThree();

  useEffect(() => {
    const element = gl.domElement;
    const drag = {
      active: false,
      pointerId: -1,
      x: 0,
      y: 0
    };

    function finishPan() {
      if (!drag.active) return;
      drag.active = false;
      onInteractionChange?.(false);
      const controls = controlsRef.current;
      if (controls) controls.enabled = true;
      if (drag.pointerId >= 0 && element.hasPointerCapture(drag.pointerId)) {
        element.releasePointerCapture(drag.pointerId);
      }
      drag.pointerId = -1;
    }

    function beginPan(event: PointerEvent) {
      if (!event.shiftKey || event.button !== 0) return;
      const controls = controlsRef.current;
      if (!controls) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drag.active = true;
      drag.pointerId = event.pointerId;
      drag.x = event.clientX;
      drag.y = event.clientY;
      controls.enabled = false;
      onInteractionChange?.(true);
      element.setPointerCapture(event.pointerId);
    }

    function movePan(event: PointerEvent) {
      if (!drag.active || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const controls = controlsRef.current;
      if (!controls) return;
      const deltaX = event.clientX - drag.x;
      const deltaY = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      panCamera(camera, controls.target, deltaX, deltaY, element.clientHeight || 1);
      invalidate();
      controls.update();
    }

    element.addEventListener("pointerdown", beginPan, { capture: true });
    element.addEventListener("pointermove", movePan, { capture: true });
    element.addEventListener("pointerup", finishPan, { capture: true });
    element.addEventListener("pointercancel", finishPan, { capture: true });
    element.addEventListener("lostpointercapture", finishPan);
    return () => {
      element.removeEventListener("pointerdown", beginPan, { capture: true });
      element.removeEventListener("pointermove", movePan, { capture: true });
      element.removeEventListener("pointerup", finishPan, { capture: true });
      element.removeEventListener("pointercancel", finishPan, { capture: true });
      element.removeEventListener("lostpointercapture", finishPan);
      const controls = controlsRef.current;
      if (controls) controls.enabled = true;
    };
  }, [camera, controlsRef, gl, invalidate, onInteractionChange]);

  return null;
}

function panCamera(camera: THREE.Camera, target: THREE.Vector3, deltaX: number, deltaY: number, viewportHeight: number) {
  const perspectiveCamera = camera as THREE.PerspectiveCamera;
  const distance = camera.position.distanceTo(target);
  const targetDistance = perspectiveCamera.isPerspectiveCamera
    ? distance * Math.tan((perspectiveCamera.fov / 2) * THREE.MathUtils.DEG2RAD)
    : distance;
  const scale = (2 * targetDistance) / viewportHeight;
  const panOffset = new THREE.Vector3();
  const xAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-deltaX * scale);
  const yAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(deltaY * scale);
  panOffset.add(xAxis).add(yAxis);
  camera.position.add(panOffset);
  target.add(panOffset);
}

function CleanAxisGizmo({ onSelectView }: { onSelectView: (view: GizmoViewRequest) => void }) {
  const layout = viewerGizmoLayout();

  return (
    <group scale={VIEWER_GIZMO_SCALE}>
      <group position={layout.contentOffset}>
        <PositiveOctantViewCube onSelectView={onSelectView} />
        {GIZMO_AXES.map((axis) => (
          <GizmoAxis key={axis.label} {...axis} onSelectView={onSelectView} />
        ))}
        <IsoOriginButton onSelectView={onSelectView} />
      </group>
    </group>
  );
}

const GIZMO_AXES: Array<{ label: "X" | "Y" | "Z"; color: string; target: GizmoViewTarget; direction: [number, number, number] }> = [
  { label: "X", color: "#ff4b7d", target: "+x", direction: [1, 0, 0] },
  { label: "Y", color: "#2ddc94", target: "+y", direction: [0, 1, 0] },
  { label: "Z", color: "#4da3ff", target: "+z", direction: [0, 0, 1] }
];

function GizmoAxis({
  label,
  color,
  target,
  direction,
  onSelectView
}: {
  label: "X" | "Y" | "Z";
  color: string;
  target: GizmoViewTarget;
  direction: [number, number, number];
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const origin = viewerGizmoLayout().origin;
  const lineEnd = direction.map((value) => value * VIEWER_GIZMO_AXIS_LENGTH) as [number, number, number];
  const capPosition = direction.map((value) => value * VIEWER_GIZMO_LABEL_DISTANCE) as [number, number, number];

  return (
    <group>
      <Line points={[origin, lineEnd]} color={color} lineWidth={hovered ? 4 : 3} transparent opacity={hovered ? 1 : 0.85} depthTest={false} />
      <AxisCap
        label={label}
        color={color}
        position={capPosition}
        target={target}
        hovered={hovered}
        onHoverChange={setHovered}
        onSelectView={onSelectView}
      />
    </group>
  );
}

function AxisCap({
  label,
  color,
  position,
  target,
  hovered,
  onHoverChange,
  onSelectView
}: {
  label: "X" | "Y" | "Z";
  color: string;
  position: [number, number, number];
  target: GizmoViewTarget;
  hovered: boolean;
  onHoverChange: (hovered: boolean) => void;
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const title = `View +${label}`;

  return (
    <Billboard
      name={title}
      position={position}
      scale={hovered ? 1.08 : 1}
      userData={{ title, ariaLabel: title }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView(gizmoViewTargetToRequest(target));
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onHoverChange(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onHoverChange(false);
      }}
    >
      {hovered && (
        <mesh position={[0, 0, -0.002]}>
          <ringGeometry args={[VIEWER_AXIS_HEAD_RADIUS * 1.02, VIEWER_AXIS_HEAD_RADIUS * 1.18, 40]} />
          <meshBasicMaterial color="#f8fbff" depthTest={false} transparent opacity={0.38} toneMapped={false} />
        </mesh>
      )}
      <mesh>
        <ringGeometry args={[VIEWER_AXIS_LABEL_BADGE_RADIUS, VIEWER_AXIS_HEAD_RADIUS, 40]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.004]}>
        <circleGeometry args={[VIEWER_AXIS_LABEL_BADGE_RADIUS, 36]} />
        <meshBasicMaterial color={VIEWER_AXIS_LABEL_BADGE_COLOR} depthTest={false} toneMapped={false} />
      </mesh>
      <Text
        anchorX="center"
        anchorY="middle"
        color={VIEWER_AXIS_LABEL_COLOR}
        fontSize={VIEWER_AXIS_LABEL_FONT_SIZE}
        fontWeight={VIEWER_AXIS_LABEL_FONT_WEIGHT}
        letterSpacing={0}
        outlineColor={VIEWER_AXIS_LABEL_OUTLINE_COLOR}
        outlineWidth={VIEWER_AXIS_LABEL_OUTLINE_WIDTH}
        position={[0, 0, 0.01]}
      >
        {label}
      </Text>
      <Text
        anchorX="center"
        anchorY="middle"
        color="#d7e3ee"
        fontSize={0.105}
        letterSpacing={0}
        outlineColor={VIEWER_AXIS_LABEL_OUTLINE_COLOR}
        outlineWidth={0.01}
        position={[0, -0.095, 0.011]}
      >
        +
      </Text>
    </Billboard>
  );
}

function PositiveOctantViewCube({ onSelectView }: { onSelectView: (view: GizmoViewRequest) => void }) {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const half = VIEWER_VIEW_CUBE_SIZE / 2;
  const faces = useMemo(() => getViewCubeFaceDescriptors(), []);
  const corners = useMemo(() => getViewCubeCornerDescriptors(), []);

  return (
    <group name="Positive-octant triad view cube">
      <mesh position={[half, half, half]} renderOrder={1}>
        <boxGeometry args={[cubeSize, cubeSize, cubeSize]} />
        <meshBasicMaterial color="#1d2b3d" depthTest={true} transparent={false} opacity={VIEWER_VIEW_CUBE_BODY_OPACITY} depthWrite toneMapped={false} />
      </mesh>
      <ViewCubeEdges />
      {faces.map((face) => (
        <ViewCubeFace key={face.label} {...face} onSelectView={onSelectView} />
      ))}
      {corners.map((corner) => (
        <ViewCubeCorner key={corner.title} {...corner} onSelectView={onSelectView} />
      ))}
    </group>
  );
}

export interface ViewCubeFaceDescriptor {
  label: ViewCubeFaceLabel;
  position: [number, number, number];
  rotation: [number, number, number];
  normal: [number, number, number];
}

export function getViewCubeFaceDescriptors(): ViewCubeFaceDescriptor[] {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const faceOffset = 0.006;
  const half = VIEWER_VIEW_CUBE_SIZE / 2;
  return [
    { label: "Front", position: [half, cubeSize + faceOffset, half], rotation: [-Math.PI / 2, 0, -Math.PI], normal: [0, 1, 0] },
    { label: "Back", position: [half, -faceOffset, half], rotation: [Math.PI / 2, 0, 0], normal: [0, -1, 0] },
    { label: "Right", position: [cubeSize + faceOffset, half, half], rotation: [Math.PI / 2, Math.PI / 2, 0], normal: [1, 0, 0] },
    { label: "Left", position: [-faceOffset, half, half], rotation: [Math.PI / 2, -Math.PI / 2, 0], normal: [-1, 0, 0] },
    { label: "Top", position: [half, half, cubeSize + faceOffset], rotation: [0, 0, Math.PI / 2], normal: [0, 0, 1] },
    { label: "Bottom", position: [half, half, -faceOffset], rotation: [-Math.PI, 0, -Math.PI / 2], normal: [0, 0, -1] }
  ];
}

export interface ViewCubeCornerDescriptor {
  title: string;
  position: [number, number, number];
  direction: ViewCubeCornerDirection;
}

export function getViewCubeCornerDescriptors(): ViewCubeCornerDescriptor[] {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const signs = [-1, 1] as const;
  const axisTitle = (axis: "X" | "Y" | "Z", sign: -1 | 1) => `${sign > 0 ? "+" : "-"}${axis}`;
  return signs.flatMap((x) =>
    signs.flatMap((y) =>
      signs.map((z) => ({
        title: `View ${axisTitle("X", x)} ${axisTitle("Y", y)} ${axisTitle("Z", z)}`,
        position: [x > 0 ? cubeSize : 0, y > 0 ? cubeSize : 0, z > 0 ? cubeSize : 0] as [number, number, number],
        direction: [x, y, z] as ViewCubeCornerDirection
      }))
    )
  );
}

function ViewCubeEdges({ active = false }: { active?: boolean }) {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const edgeInset = 0.004;
  const min = -edgeInset;
  const max = cubeSize + edgeInset;
  const edgeSegments: Array<[[number, number, number], [number, number, number]]> = [
    [[min, min, min], [max, min, min]],
    [[min, max, min], [max, max, min]],
    [[min, min, max], [max, min, max]],
    [[min, max, max], [max, max, max]],
    [[min, min, min], [min, max, min]],
    [[max, min, min], [max, max, min]],
    [[min, min, max], [min, max, max]],
    [[max, min, max], [max, max, max]],
    [[min, min, min], [min, min, max]],
    [[max, min, min], [max, min, max]],
    [[min, max, min], [min, max, max]],
    [[max, max, min], [max, max, max]]
  ];

  return (
    <group renderOrder={2}>
      {edgeSegments.map((segment, index) => (
        <Line
          key={index}
          points={segment}
          color={active ? "#d9ecff" : VIEWER_VIEW_CUBE_EDGE_COLOR}
          lineWidth={active ? 2 : 1}
          transparent
          opacity={active ? 0.82 : 0.56}
          depthTest={true}
        />
      ))}
    </group>
  );
}

function ViewCubeFace({
  label,
  position,
  rotation,
  normal,
  onSelectView
}: {
  label: ViewCubeFaceLabel;
  position: [number, number, number];
  rotation: [number, number, number];
  normal: [number, number, number];
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { camera } = useThree();
  const faceRef = useRef<THREE.Group | null>(null);
  const labelRef = useRef<THREE.Group | null>(null);
  const localNormal = useMemo(() => new THREE.Vector3(...normal), [normal]);
  const faceNormalWorldRef = useRef(new THREE.Vector3());
  const toCameraWorldRef = useRef(new THREE.Vector3());
  const normalMatrixRef = useRef(new THREE.Matrix3());
  const title = `${label} view`;
  useFrame(() => {
    const labelObject = labelRef.current;
    const cubeRootObject = faceRef.current?.parent;
    if (!labelObject || !cubeRootObject) return;
    const faceNormalWorld = faceNormalWorldRef.current.copy(localNormal).applyNormalMatrix(normalMatrixRef.current.getNormalMatrix(cubeRootObject.matrixWorld)).normalize();
    const toCameraWorld = camera.getWorldDirection(toCameraWorldRef.current).negate().normalize();
    labelObject.visible = shouldShowViewCubeFaceLabel(faceNormalWorld, toCameraWorld);
  });

  return (
    <group
      ref={faceRef}
      name={title}
      position={position}
      rotation={rotation}
      userData={{ title, ariaLabel: title }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView(gizmoViewTargetToRequest(viewCubeFaceToGizmoTarget(label)));
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(false);
      }}
    >
      <mesh renderOrder={3}>
        <planeGeometry args={[VIEWER_VIEW_CUBE_SIZE * 0.82, VIEWER_VIEW_CUBE_SIZE * 0.82]} />
        <meshBasicMaterial color={hovered ? "#6da4c9" : "#31516b"} depthTest transparent opacity={hovered ? VIEWER_VIEW_CUBE_FACE_HOVER_OPACITY : VIEWER_VIEW_CUBE_FACE_OPACITY} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={labelRef} position={[0, 0, 0.075]} renderOrder={4}>
        <GizmoTextLabel
          color={hovered ? "#ffffff" : "#e4eef8"}
          fontSize={VIEWER_VIEW_CUBE_FACE_LABEL_FONT_SIZE}
          opacity={hovered ? 1 : 0.95}
          depthTest
        >
          {label}
        </GizmoTextLabel>
      </group>
    </group>
  );
}

function ViewCubeCorner({
  title,
  position,
  direction,
  onSelectView
}: {
  title: string;
  position: [number, number, number];
  direction: ViewCubeCornerDirection;
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Billboard
      name={title}
      position={position}
      scale={hovered ? 1.22 : 1}
      userData={{ title, ariaLabel: title }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView({ kind: "corner", direction });
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(false);
      }}
    >
      <mesh renderOrder={3}>
        <sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS, 18, 18]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0} toneMapped={false} />
      </mesh>
      <mesh renderOrder={5}>
        <sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_RADIUS, 18, 18]} />
        <meshBasicMaterial color={hovered ? "#f8fbff" : "#a9c9e8"} depthTest={false} transparent opacity={hovered ? 0.96 : 0.78} toneMapped={false} />
      </mesh>
      {hovered && (
        <mesh renderOrder={4}>
          <sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_RADIUS * 1.7, 18, 18]} />
          <meshBasicMaterial color="#f8fbff" depthTest={false} transparent opacity={0.22} toneMapped={false} />
        </mesh>
      )}
    </Billboard>
  );
}

function IsoOriginButton({ onSelectView }: { onSelectView: (view: GizmoViewRequest) => void }) {
  const [hovered, setHovered] = useState(false);
  const half = VIEWER_VIEW_CUBE_SIZE / 2;

  return (
    <Billboard
      name="Isometric view"
      position={[half, half, half]}
      userData={{ title: "Isometric view", ariaLabel: "Isometric view" }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView(gizmoViewTargetToRequest("iso"));
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(false);
      }}
    >
      {hovered && (
        <mesh>
          <ringGeometry args={[0.075, 0.105, 28]} />
          <meshBasicMaterial color="#f8fbff" depthTest={false} transparent opacity={0.42} toneMapped={false} />
        </mesh>
      )}
      <mesh>
        <sphereGeometry args={[0.065, 18, 18]} />
        <meshBasicMaterial color="#d9e8f6" depthTest={false} toneMapped={false} />
      </mesh>
      {hovered && (
        <GizmoTextLabel color="#f8fbff" fontSize={0.095} position={[0, -0.16, 0.01]}>
          Iso
        </GizmoTextLabel>
      )}
    </Billboard>
  );
}

function GizmoTextLabel({
  children,
  color,
  fontSize,
  depthTest = false,
  opacity = 1,
  position = [0, 0, 0.01]
}: {
  children: string;
  color: string;
  fontSize: number;
  depthTest?: boolean;
  opacity?: number;
  position?: [number, number, number];
}) {
  return (
    <Text
      anchorX="center"
      anchorY="middle"
      color={color}
      fillOpacity={opacity}
      fontSize={fontSize}
      frustumCulled={false}
      letterSpacing={0}
      material-depthTest={depthTest}
      material-side={THREE.DoubleSide}
      material-toneMapped={false}
      outlineColor="#07111d"
      outlineOpacity={opacity}
      outlineWidth={0.014}
      position={position}
      renderOrder={5}
    >
      {children}
    </Text>
  );
}

function BracketModel({
  displayModel,
  activeStep,
  selectedFaceId,
  payloadObjectSelectionMode,
  selectedPayloadObject,
  onSelectFace,
  viewMode,
  resultMode,
  showDeformed,
  resultPlaybackPlaying,
  resultPlaybackFrameController,
  stressExaggeration,
  resultFields,
  unitSystem,
  loadMarkers,
  supportMarkers,
  onMeasureDisplayModelDimensions,
  printLayerOrientation,
  uploadedPreviewBounds,
  onUploadedPreviewBounds
}: CadViewerProps & { uploadedPreviewBounds: THREE.Box3 | null; onUploadedPreviewBounds: (bounds: THREE.Box3) => void }) {
  const [hoveredHit, setHoveredHit] = useState<ModelSelectionHit | null>(null);
  const [selectedHit, setSelectedHit] = useState<ModelSelectionHit | null>(null);
  const [snapResult, setSnapResult] = useState<SnapResult | null>(null);
  const modelKind = modelKindForDisplayModel(displayModel);
  const materialColor = useMemo(() => colorForResult(displayModel.faces, viewMode, resultMode), [displayModel.faces, resultMode, viewMode]);
  const showResultMarkers = shouldShowResultMarkers(viewMode, activeStep, resultPlaybackPlaying);
  const isResultView = viewMode === "results";
  const showBoundaryMarkers = !isResultView;
  const placementMode = activeStep === "loads" || activeStep === "supports";
  const activeHit = hoveredHit ?? selectedHit;
  const hasDraftLoadPreview = activeStep === "loads" && loadMarkers.some((marker) => marker.preview);
  const showModelHitLabel = shouldShowModelHitLabel(viewMode, Boolean(hoveredHit), hasDraftLoadPreview);
  const activePayloadObjectId = payloadHighlightObjectId(payloadObjectSelectionMode, selectedPayloadObject ?? hoveredHit?.payloadObject ?? null);
  const boundaryLabelPositions = useMemo(() => {
    if (!showBoundaryMarkers) return new Map<string, [number, number, number]>();
    const bounds = dimensionBoundsForDisplayModel(displayModel);
    if (!bounds) return new Map<string, [number, number, number]>();
    const anchors: LabelAnchor[] = [
      ...loadMarkers.filter((marker) => marker.type === "gravity").map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        return face ? { id: boundaryLabelKey("load", marker.id), anchor: loadMarkerAnchor(marker, face) } : null;
      }),
      ...supportMarkers.map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        return face ? { id: boundaryLabelKey("support", marker.id), anchor: supportMarkerAnchor(modelKind, marker, face) } : null;
      })
    ].filter((anchor): anchor is LabelAnchor => Boolean(anchor));

    return new Map(layoutOutsideModelLabels(anchors, boxToLabelBounds(bounds)).map((label) => [label.id, label.position]));
  }, [displayModel, loadMarkers, modelKind, showBoundaryMarkers, supportMarkers]);

  useEffect(() => {
    if (!selectedFaceId) {
      setSelectedHit(null);
      return;
    }
    if (selectedHit?.face.id === selectedFaceId) return;
    const face = displayModel.faces.find((candidate) => candidate.id === selectedFaceId);
    setSelectedHit(face ? { face, point: face.center } : null);
  }, [displayModel.faces, selectedFaceId, selectedHit?.face.id]);

  function hitFromEvent(event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): ModelSelectionHit | null {
    if (!placementMode || isResultView) return null;
    if (modelKind === "uploaded") {
      const hit = uploadedFaceHitFromEvent(event, displayModel);
      if (!hit) return null;
      const snap = snapResultFromEvent(event, displayModel, hit.face, activeStep);
      return {
        ...hit,
        point: pointForPlacementSnap(hit.point, snap, event.nativeEvent.altKey),
        snapResult: snap,
        payloadObject: payloadObjectSelectionMode ? payloadObjectFromEvent(event, displayModel, modelKind, hit.face) : undefined
      };
    }
    const modelPoint = viewerPointToModelSpace(event.point, displayModel);
    const face = faceForModelHit(modelKind, displayModel.faces, modelPoint);
    if (!face) return null;
    const snap = snapResultFromEvent(event, displayModel, face, activeStep);
    return {
      face,
      point: pointForPlacementSnap(modelPoint.toArray() as [number, number, number], snap, event.nativeEvent.altKey),
      snapResult: snap,
      payloadObject: payloadObjectSelectionMode ? payloadObjectFromEvent(event, displayModel, modelKind, face) : undefined
    };
  }

  const pickHandlers: ModelPickHandlers = {
    onPointerMove: (event) => {
      const hit = hitFromEvent(event);
      setHoveredHit(hit);
      setSnapResult(hit?.snapResult ?? null);
    },
    onPointerOut: () => {
      setHoveredHit(null);
      setSnapResult(null);
    },
    onClick: (event) => {
      const hit = hitFromEvent(event);
      if (!hit) return;
      event.stopPropagation();
      setSelectedHit(hit);
      onSelectFace(hit.face, hit.point, hit.payloadObject);
    }
  };
  const overlayFallbackPickHandlers: ModelPickHandlers = {
    onPointerMove: (event) => {
      if (!isSnapOverlayObject(event.object)) return;
      event.stopPropagation();
    },
    onClick: (event) => {
      if (!isSnapOverlayObject(event.object)) return;
      const hit = hoveredHit ?? selectedHit;
      if (!hit) return;
      event.stopPropagation();
      setSelectedHit(hit);
      onSelectFace(hit.face, hit.point, hit.payloadObject);
    }
  };

  return (
    <group {...overlayFallbackPickHandlers}>
      {isResultView ? (
        <AnalysisResultModel
          kind={modelKind}
          displayModel={displayModel}
          resultMode={resultMode}
          showDeformed={showDeformed}
          resultPlaybackPlaying={resultPlaybackPlaying}
          stressExaggeration={stressExaggeration}
          resultFields={resultFields}
          resultPlaybackFrameController={resultPlaybackFrameController}
          loadMarkers={loadMarkers}
          supportMarkers={supportMarkers}
          onMeasureDisplayModelDimensions={onMeasureDisplayModelDimensions}
          onUploadedPreviewBounds={onUploadedPreviewBounds}
        />
      ) : (
        <SampleSolid
          kind={modelKind}
          displayModel={displayModel}
          color={materialColor("face-base-bottom")}
          pickHandlers={pickHandlers}
          activePayloadObjectId={activePayloadObjectId}
          onMeasureDisplayModelDimensions={onMeasureDisplayModelDimensions}
          onUploadedPreviewBounds={onUploadedPreviewBounds}
        />
      )}
      {printLayerOrientation && !isResultView && (
        <PrintLayerOverlay
          bounds={modelKind === "uploaded" && uploadedPreviewBounds ? uploadedPreviewBounds : dimensionBoundsForDisplayModel(displayModel)}
          orientation={printLayerOrientation}
        />
      )}
      <HoleRims kind={modelKind} />
      {viewMode === "mesh" && <MeshOverlay kind={modelKind} />}
      {placementMode && !isResultView && <SnapVisualization result={snapResult} mode={activeStep === "supports" ? "supports" : "loads"} />}
      {showModelHitLabel && hoveredHit && <ModelHitLabel hit={hoveredHit} active={hoveredHit.face.id === selectedFaceId} />}
      {showBoundaryMarkers && loadMarkers.map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        if (!face) return null;
        return marker.preview
          ? <PickedLoadLocationMarker key={marker.id} marker={marker} face={face} active={activeStep === "loads"} />
          : <LoadGlyph key={marker.id} marker={marker} face={face} active={activeStep === "loads"} labelPosition={boundaryLabelPositions.get(boundaryLabelKey("load", marker.id))} />;
      })}
      {showBoundaryMarkers && supportMarkers.map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        return face ? <SupportGlyph key={marker.id} kind={modelKind} marker={marker} face={face} active={activeStep === "supports"} labelPosition={boundaryLabelPositions.get(boundaryLabelKey("support", marker.id))} /> : null;
      })}
      {showResultMarkers && resultProbesForKind(modelKind, displayModel.faces, resultMode, resultFields, unitSystem).map((probe) => <ResultProbe key={`${probe.tone}-${probe.label}-${probe.anchor.join(",")}`} {...probe} />)}
    </group>
  );
}

export function shouldShowModelHitLabel(_viewMode: ViewMode, _hasActiveHit: boolean, _suppressForDraftLoadPreview = false) {
  return false;
}

export function shouldShowDimensionOverlay(showDimensions: boolean, viewMode: ViewMode) {
  return showDimensions && viewMode !== "results";
}

export function shouldShowResultMarkers(_viewMode: ViewMode, _activeStep: StepId, _resultPlaybackPlaying: boolean) {
  return false;
}

export function payloadHighlightObjectId(payloadObjectSelectionMode: boolean, payloadObject: PayloadObjectSelection | null | undefined) {
  return payloadObjectSelectionMode ? payloadObject?.id : undefined;
}

function modelKindForDisplayModel(displayModel: DisplayModel): SampleModelKind {
  if (displayModel.bodyCount === 0 || displayModel.id.includes("blank")) return "blank";
  if (displayModel.id.includes("uploaded")) return "uploaded";
  if (displayModel.id.includes("plate")) return "plate";
  if (displayModel.id.includes("cantilever")) return "cantilever";
  return "bracket";
}

function transformedBox(bounds: THREE.Box3, transform: THREE.Matrix4) {
  const nextBounds = new THREE.Box3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        nextBounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(transform));
      }
    }
  }
  return nextBounds;
}

function dimensionBoundsForDisplayModel(displayModel: DisplayModel) {
  const kind = modelKindForDisplayModel(displayModel);
  if (kind === "blank") return null;
  if (kind === "plate") {
    return new THREE.Box3(new THREE.Vector3(-1.9, 0, -0.3), new THREE.Vector3(1.78, 0.8, 0.3));
  }
  if (kind === "cantilever") {
    return new THREE.Box3(new THREE.Vector3(-1.9, -0.07, -0.36), new THREE.Vector3(1.9, 0.43, 0.36));
  }
  if (kind === "uploaded") {
    const dimensions = displayModel.dimensions;
    if (!dimensions) return new THREE.Box3(new THREE.Vector3(-1.2, -1.2, -1.2), new THREE.Vector3(1.2, 1.2, 1.2));
    const maxDimension = Math.max(dimensions.x, dimensions.y, dimensions.z, 0.001);
    const halfSize = new THREE.Vector3(
      (dimensions.x / maxDimension) * 1.2,
      (dimensions.y / maxDimension) * 1.2,
      (dimensions.z / maxDimension) * 1.2
    );
    return new THREE.Box3(halfSize.clone().multiplyScalar(-1), halfSize);
  }
  return new THREE.Box3(new THREE.Vector3(-1.55, -0.24, -BRACKET_DEPTH / 2), new THREE.Vector3(2.35, 2.62, BRACKET_DEPTH / 2));
}

function boxToLabelBounds(bounds: THREE.Box3) {
  return {
    min: bounds.min.toArray() as [number, number, number],
    max: bounds.max.toArray() as [number, number, number]
  };
}

function resultRenderBoundsForBox(bounds: THREE.Box3): ResultRenderBounds {
  return {
    min: bounds.min.toArray() as [number, number, number],
    max: bounds.max.toArray() as [number, number, number],
    coordinateSpace: "display_model"
  };
}

export function faceSnapAxesForDisplayModel(displayModel: DisplayModel, face: DisplayFace): FaceSnapAxis[] {
  const bounds = dimensionBoundsForDisplayModel(displayModel);
  const dimensions = dimensionValuesForDisplayModel(displayModel);
  if (!bounds || !dimensions) return [];
  const normalAxis = dominantAxis(face.normal);
  return ([0, 1, 2] as const)
    .filter((axisIndex) => axisIndex !== normalAxis)
    .flatMap((axisIndex) => faceSnapAxisForBounds(bounds, dimensions, face.center, axisIndex));
}

function faceSnapAxisForBounds(
  bounds: THREE.Box3,
  dimensions: NonNullable<ReturnType<typeof dimensionValuesForDisplayModel>>,
  center: [number, number, number],
  axisIndex: 0 | 1 | 2
): FaceSnapAxis[] {
  const minValue = bounds.min.getComponent(axisIndex);
  const maxValue = bounds.max.getComponent(axisIndex);
  const spanWorld = maxValue - minValue;
  const spanUnits = dimensionValueForDisplayAxis(dimensions, axisIndex);
  if (!Number.isFinite(spanWorld) || !Number.isFinite(spanUnits) || spanWorld <= 0 || spanUnits <= 0) return [];
  const minPoint = [...center] as Vec3;
  const maxPoint = [...center] as Vec3;
  minPoint[axisIndex] = minValue;
  maxPoint[axisIndex] = maxValue;
  const direction = [0, 0, 0] as Vec3;
  direction[axisIndex] = 1;
  return [{
    direction,
    minPoint,
    maxPoint,
    unitsPerWorld: spanUnits / spanWorld,
    units: dimensions.units,
    unitStep: dimensions.units === "in" ? 0.05 : 1
  }];
}

function dimensionValueForDisplayAxis(dimensions: NonNullable<ReturnType<typeof dimensionValuesForDisplayModel>>, axisIndex: 0 | 1 | 2) {
  if (axisIndex === 0) return dimensions.x;
  if (axisIndex === 2) return dimensions.y;
  return dimensions.z;
}

function dominantAxis(vector: [number, number, number]) {
  const values = vector.map(Math.abs);
  if ((values[0] ?? 0) >= (values[1] ?? 0) && (values[0] ?? 0) >= (values[2] ?? 0)) return 0;
  if ((values[1] ?? 0) >= (values[2] ?? 0)) return 1;
  return 2;
}

function boundaryLabelKey(kind: "load" | "support", id: string) {
  return `${kind}:${id}`;
}

function loadMarkerAnchor(marker: ViewerLoadMarker, face: DisplayFace): [number, number, number] {
  return marker.point ?? marker.payloadObject?.center ?? face.center;
}

export function loadGlyphSurfacePoint(marker: ViewerLoadMarker, face: DisplayFace) {
  const center = new THREE.Vector3(...loadMarkerAnchor(marker, face));
  if (marker.point || marker.payloadObject) return center;
  const normal = new THREE.Vector3(...face.normal).normalize();
  const tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0));
  if (tangent.lengthSq() < 0.001) tangent.set(1, 0, 0);
  tangent.normalize();
  return center.add(tangent.multiplyScalar((marker.stackIndex - 0.5) * 0.22));
}

export function supportMarkerAnchor(kind: SampleModelKind, marker: ViewerSupportMarker, face: DisplayFace): [number, number, number] {
  if (kind === "bracket" && marker.faceId === "face-base-left") return [0.72, 0, BRACKET_DEPTH / 2 + 0.065];
  return face.center;
}

export function supportGlyphAnchor(kind: SampleModelKind, marker: ViewerSupportMarker, face: DisplayFace) {
  return new THREE.Vector3(...supportMarkerAnchor(kind, marker, face)).add(new THREE.Vector3(...face.normal).normalize().multiplyScalar(0.04));
}

export function beamPayloadSelectionForTarget(targetId: unknown): PayloadObjectSelection | null {
  if (targetId !== BEAM_PAYLOAD_OBJECT_ID) return null;
  return {
    id: BEAM_PAYLOAD_OBJECT_ID,
    label: BEAM_PAYLOAD_LABEL,
    center: BEAM_PAYLOAD_CENTER,
    volumeM3: BEAM_PAYLOAD_VOLUME_M3,
    volumeSource: "bounds-fallback",
    volumeStatus: "estimated"
  };
}

export function pointForPlacementSnap(point: [number, number, number], snapResult: SnapResult | null | undefined, freePlacement = false): [number, number, number] {
  if (freePlacement) return point;
  return snapResult?.rawSnapPoint ?? point;
}

export function faceIdForPlacementSnap(faceId: string, snapResult: SnapResult | null | undefined) {
  return snapResult?.hovered.faceId ?? faceId;
}

function snapResultFromEvent(event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>, displayModel: DisplayModel, face: DisplayFace, activeStep: StepId): SnapResult | null {
  const cursorRay = cursorRayFromEvent(event);
  const result = getSnapSuggestion(cursorRay, {
    objects: [event.object],
    mode: activeStep === "supports" ? "supports" : "loads",
    ownerFace: {
      id: face.id,
      position: modelPointToViewerSpace(face.center, displayModel),
      normal: modelNormalToViewerSpace(face.normal, displayModel),
      snapAxes: faceSnapAxesForDisplayModel(displayModel, face).map((axis) => ({
        ...axis,
        direction: modelNormalToViewerSpace(axis.direction, displayModel),
        minPoint: modelPointToViewerSpace(axis.minPoint, displayModel),
        maxPoint: modelPointToViewerSpace(axis.maxPoint, displayModel)
      }))
    }
  });
  return result ? snapResultToModelSpace(result, displayModel) : null;
}

function cursorRayFromEvent(event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): CursorRay {
  return {
    origin: event.ray.origin.toArray() as Vec3,
    direction: event.ray.direction.toArray() as Vec3,
    cursorPoint: event.point.toArray() as Vec3,
    screenPosition: { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY }
  };
}

function snapResultToModelSpace(result: SnapResult, displayModel: DisplayModel): SnapResult {
  return {
    ...result,
    snapPoint: viewerPointToModelSpace(new THREE.Vector3(...result.snapPoint), displayModel).toArray() as Vec3,
    rawSnapPoint: viewerPointToModelSpace(new THREE.Vector3(...result.rawSnapPoint), displayModel).toArray() as Vec3,
    direction: viewerNormalToModelSpace(new THREE.Vector3(...result.direction), displayModel).toArray() as Vec3,
    hovered: {
      ...result.hovered,
      position: viewerPointToModelSpace(new THREE.Vector3(...result.hovered.position), displayModel).toArray() as Vec3,
      normal: result.hovered.normal ? viewerNormalToModelSpace(new THREE.Vector3(...result.hovered.normal), displayModel).toArray() as Vec3 : undefined,
      endpoints: result.hovered.endpoints
        ? result.hovered.endpoints.map((point) => viewerPointToModelSpace(new THREE.Vector3(...point), displayModel).toArray() as Vec3) as [Vec3, Vec3]
        : undefined,
      snapAxes: result.hovered.snapAxes?.map((axis) => ({
        ...axis,
        direction: viewerNormalToModelSpace(new THREE.Vector3(...axis.direction), displayModel).toArray() as Vec3,
        minPoint: viewerPointToModelSpace(new THREE.Vector3(...axis.minPoint), displayModel).toArray() as Vec3,
        maxPoint: viewerPointToModelSpace(new THREE.Vector3(...axis.maxPoint), displayModel).toArray() as Vec3
      }))
    },
    measurements: result.measurements?.map((measurement) => snapMeasurementToModelSpace(measurement, displayModel))
  };
}

function snapMeasurementToModelSpace(measurement: SnapMeasurement, displayModel: DisplayModel): SnapMeasurement {
  return {
    ...measurement,
    start: viewerPointToModelSpace(new THREE.Vector3(...measurement.start), displayModel).toArray() as Vec3,
    end: viewerPointToModelSpace(new THREE.Vector3(...measurement.end), displayModel).toArray() as Vec3
  };
}

function modelPointToViewerSpace(point: [number, number, number], displayModel: DisplayModel): Vec3 {
  return new THREE.Vector3(...point).applyMatrix4(modelToViewerMatrix(displayModel)).toArray() as Vec3;
}

function modelNormalToViewerSpace(normal: [number, number, number], displayModel: DisplayModel): Vec3 {
  return new THREE.Vector3(...normal).transformDirection(modelToViewerMatrix(displayModel)).normalize().toArray() as Vec3;
}

function formatDimensionLabel(value: number, units: string) {
  const formatted = Number.isInteger(value) ? `${value}` : value.toFixed(1);
  return `${formatted} ${units}`;
}

function worldPointToModelSpace(point: THREE.Vector3) {
  return new THREE.Vector3(point.x, point.z, -point.y);
}

function worldNormalToModelSpace(normal: THREE.Vector3) {
  return new THREE.Vector3(normal.x, normal.z, -normal.y).normalize();
}

function markerDirectionInModelSpace(marker: ViewerLoadMarker) {
  return new THREE.Vector3(...marker.direction).normalize();
}

function labelLaneOffset(index: number) {
  const safeIndex = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  const lane = (safeIndex % 3) - 1;
  const row = Math.floor(safeIndex / 3);
  return { lane, row };
}

function ModelDimensionOverlay({ displayModel, uploadedPreviewBounds }: { displayModel: DisplayModel; uploadedPreviewBounds: THREE.Box3 | null }) {
  const dimensions = displayModel.dimensions;
  const dimensionValues = dimensionValuesForDisplayModel(displayModel);
  const bounds = modelKindForDisplayModel(displayModel) === "uploaded" && uploadedPreviewBounds
    ? uploadedPreviewBounds
    : dimensionBoundsForDisplayModel(displayModel);
  if (!dimensions || !dimensionValues || !bounds) return null;

  const min = bounds.min;
  const max = bounds.max;
  const xOffset = Math.max(0.16, (max.x - min.x) * 0.04);
  const yOffset = Math.max(0.16, (max.y - min.y) * 0.08);
  const zOffset = Math.max(0.16, (max.z - min.z) * 0.18);
  const xLineY = min.y - yOffset;
  const xLineZ = min.z - zOffset;
  const axisLineX = max.x + xOffset;

  return (
    <group renderOrder={20}>
      <DimensionLine
        start={[min.x, xLineY, xLineZ]}
        end={[max.x, xLineY, xLineZ]}
        label={`X ${formatDimensionLabel(dimensionValues.x, dimensionValues.units)}`}
      />
      <DimensionLine
        start={[axisLineX, xLineY, min.z]}
        end={[axisLineX, xLineY, max.z]}
        label={`Y ${formatDimensionLabel(dimensionValues.y, dimensionValues.units)}`}
      />
      <DimensionLine
        start={[axisLineX, min.y, max.z + zOffset]}
        end={[axisLineX, max.y, max.z + zOffset]}
        label={`Z ${formatDimensionLabel(dimensionValues.z, dimensionValues.units)}`}
      />
    </group>
  );
}

function DimensionLine({ start, end, label }: { start: [number, number, number]; end: [number, number, number]; label: string }) {
  const labelPosition: [number, number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  return (
    <group>
      <Line points={[start, end]} color="#4da3ff" lineWidth={1.8} transparent opacity={0.95} />
      <DimensionEndpoint position={start} />
      <DimensionEndpoint position={end} />
      <SceneLabel label={label} position={labelPosition} tone="dimension" />
    </group>
  );
}

function DimensionEndpoint({ position }: { position: [number, number, number] }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.035, 16, 16]} />
      <meshBasicMaterial color="#4da3ff" depthTest={false} toneMapped={false} />
    </mesh>
  );
}

interface PrintLayerVisualization {
  axis: THREE.Vector3;
  planes: Array<Array<[number, number, number]>>;
}

export function printLayerVisualizationForBounds(bounds: THREE.Box3 | null, orientation: PrintLayerOrientation): PrintLayerVisualization | null {
  if (!bounds || bounds.isEmpty()) return null;
  const axisIndex = orientation === "x" ? 0 : orientation === "y" ? 2 : 1;
  const axis = new THREE.Vector3(axisIndex === 0 ? 1 : 0, axisIndex === 1 ? 1 : 0, axisIndex === 2 ? 1 : 0);
  const min = bounds.min.toArray() as [number, number, number];
  const max = bounds.max.toArray() as [number, number, number];
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);
  const layerCount = 7;
  const planes = Array.from({ length: layerCount }, (_, index) => {
    const t = index / (layerCount - 1);
    const value = min[axisIndex] + (max[axisIndex] - min[axisIndex]) * t;
    return layerPlanePoints(min, max, axisIndex, value);
  });
  return {
    axis,
    planes
  };
}

function layerPlanePoints(min: [number, number, number], max: [number, number, number], axisIndex: number, value: number): Array<[number, number, number]> {
  const first = (axisIndex + 1) % 3;
  const second = (axisIndex + 2) % 3;
  const corners = [
    [min[first], min[second]],
    [max[first], min[second]],
    [max[first], max[second]],
    [min[first], max[second]],
    [min[first], min[second]]
  ];
  return corners.map(([firstValue, secondValue]) => {
    const point = [0, 0, 0] as [number, number, number];
    point[axisIndex] = value;
    point[first] = firstValue ?? 0;
    point[second] = secondValue ?? 0;
    return point;
  });
}

function PrintLayerOverlay({ bounds, orientation }: { bounds: THREE.Box3 | null; orientation: PrintLayerOrientation }) {
  const visualization = useMemo(() => printLayerVisualizationForBounds(bounds, orientation), [bounds, orientation]);
  if (!visualization) return null;
  return (
    <group renderOrder={18}>
      {visualization.planes.map((plane, index) => (
        <Line key={`${orientation}-layer-${index}`} points={plane} color="#63e6be" transparent opacity={0.34} lineWidth={1.15} />
      ))}
    </group>
  );
}

function uploadedFaceHitFromEvent(event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>, displayModel: DisplayModel): ModelSelectionHit | null {
  const worldNormal = event.face?.normal.clone().transformDirection(event.object.matrixWorld).normalize() ?? new THREE.Vector3(0, 0, 1);
  const normal = viewerNormalToModelSpace(worldNormal, displayModel);
  const point = viewerPointToModelSpace(event.point, displayModel).toArray() as [number, number, number];
  return {
    face: {
      id: uploadedFaceId(point, normal),
      label: labelForNormal(normal),
      color: "#4da3ff",
      center: point,
      normal: normal.toArray() as [number, number, number],
      stressValue: 72
    },
    point
  };
}

function payloadObjectFromEvent(event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>, displayModel: DisplayModel, kind: SampleModelKind, face: DisplayFace): PayloadObjectSelection {
  if (kind === "plate") {
    const payloadObject = beamPayloadSelectionForTarget(payloadObjectTargetFor(event.object).userData.opencaeObjectId);
    if (payloadObject) return payloadObject;
  }
  if (kind !== "uploaded") {
    const volumeM3 = fallbackDisplayModelVolumeM3(displayModel);
    return {
      id: `payload-${displayModel.id}`,
      label: displayModel.name,
      center: face.center,
      ...(volumeM3 ? { volumeM3, volumeSource: "bounds-fallback" as const, volumeStatus: "estimated" as const } : { volumeStatus: "unknown" as const })
    };
  }

  const target = payloadObjectTargetFor(event.object);
  const bounds = new THREE.Box3().setFromObject(target);
  const center = bounds.isEmpty()
    ? event.point
    : bounds.getCenter(new THREE.Vector3());
  return {
    id: String(target.userData.opencaeObjectId ?? target.uuid),
    label: String(target.userData.opencaeObjectLabel ?? (target.name || displayModel.name)),
    center: viewerPointToModelSpace(center, displayModel).toArray() as [number, number, number],
    ...payloadVolumeMetadata(target, displayModel, bounds)
  };
}

function payloadVolumeMetadata(target: THREE.Object3D, displayModel: DisplayModel, bounds: THREE.Box3): Pick<PayloadObjectSelection, "volumeM3" | "volumeSource" | "volumeStatus"> {
  const directVolume = Number(target.userData.opencaeVolumeM3);
  if (Number.isFinite(directVolume) && directVolume > 0) {
    return {
      volumeM3: directVolume,
      volumeSource: target.userData.opencaeVolumeSource === "step" ? "step" : "mesh",
      volumeStatus: "available"
    };
  }
  const fallback = fallbackVolumeM3ForBounds(displayModel, bounds);
  return fallback ? { volumeM3: fallback, volumeSource: "bounds-fallback", volumeStatus: "estimated" } : { volumeStatus: "unknown" };
}

function fallbackDisplayModelVolumeM3(displayModel: DisplayModel): number | undefined {
  const dimensions = displayModel.dimensions;
  return dimensions ? dimensionsVolumeM3(dimensions.x, dimensions.y, dimensions.z) : undefined;
}

function fallbackVolumeM3ForBounds(displayModel: DisplayModel, bounds: THREE.Box3): number | undefined {
  const dimensions = displayModel.dimensions;
  if (!dimensions || bounds.isEmpty()) return undefined;
  const full = dimensionBoundsForDisplayModel(displayModel);
  if (!full) return undefined;
  const fullSize = full.getSize(new THREE.Vector3());
  const targetSize = bounds.getSize(new THREE.Vector3());
  const fullVolume = fullSize.x * fullSize.y * fullSize.z;
  const targetVolume = targetSize.x * targetSize.y * targetSize.z;
  const ratio = fullVolume > 0 && targetVolume > 0 ? Math.min(1, targetVolume / fullVolume) : 1;
  return dimensionsVolumeM3(dimensions.x, dimensions.y, dimensions.z) * ratio;
}

function dimensionsVolumeM3(x: number, y: number, z: number) {
  return Math.max(x, 0) * Math.max(y, 0) * Math.max(z, 0) / 1_000_000_000;
}

function payloadObjectTargetFor(object: THREE.Object3D) {
  let target: THREE.Object3D = object;
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.opencaeObjectLabel) return current;
    if (current instanceof THREE.Mesh) target = current;
    current = current.parent;
  }
  return target;
}

function uploadedFaceId(point: [number, number, number], normal: THREE.Vector3) {
  const values = [...point, normal.x, normal.y, normal.z].map((value) => value.toFixed(2).replace("-", "m").replace(".", "p"));
  return `face-upload-picked-${values.join("-")}`;
}

function labelForNormal(normal: THREE.Vector3) {
  const axis = [
    { label: "Right face", value: normal.x },
    { label: "Left face", value: -normal.x },
    { label: "Back face", value: normal.y },
    { label: "Front face", value: -normal.y },
    { label: "Top face", value: normal.z },
    { label: "Bottom face", value: -normal.z }
  ].sort((left, right) => right.value - left.value)[0];
  return axis?.value && axis.value > 0.72 ? axis.label : "Selected model face";
}

function SampleSolid({
  kind,
  color,
  displayModel,
  pickHandlers,
  activePayloadObjectId,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  kind: SampleModelKind;
  color: string;
  displayModel?: DisplayModel;
  pickHandlers?: ModelPickHandlers;
  activePayloadObjectId?: string;
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds?: (bounds: THREE.Box3) => void;
}) {
  if (kind === "blank") return null;
  if (kind === "uploaded") {
    return (
      <UploadedSolid
        displayModel={displayModel}
        color={color}
        pickHandlers={pickHandlers}
        activePayloadObjectId={activePayloadObjectId}
        onMeasureDisplayModelDimensions={onMeasureDisplayModelDimensions}
        onUploadedPreviewBounds={onUploadedPreviewBounds}
      />
    );
  }
  if (kind === "plate") return <BeamSolid color={color} pickHandlers={pickHandlers} />;
  if (kind === "cantilever") return <CantileverSolid color={color} pickHandlers={pickHandlers} />;
  return <BracketSolid color={color} pickHandlers={pickHandlers} />;
}

function BracketSolid({ color, pickHandlers }: { color: string; pickHandlers?: ModelPickHandlers }) {
  const bodyGeometry = useMemo(() => createBracketBodyGeometry(), []);
  const ribGeometry = useMemo(() => createRibGeometry(), []);
  return (
    <group>
      <mesh {...pickHandlers}>
        <primitive attach="geometry" object={bodyGeometry} />
        <meshStandardMaterial color={color} metalness={0.22} roughness={0.52} />
        <Edges color="#aebdca" threshold={15} />
      </mesh>
      <mesh {...pickHandlers}>
        <primitive attach="geometry" object={ribGeometry} />
        <meshStandardMaterial color="#a8b8c6" metalness={0.18} roughness={0.5} />
        <Edges color="#c8d3df" threshold={15} />
      </mesh>
    </group>
  );
}

function BeamSolid({ color, pickHandlers }: { color: string; pickHandlers?: ModelPickHandlers }) {
  const beamGeometry = useMemo(() => createBeamGeometry(), []);
  const payloadGeometry = useMemo(() => createBeamPayloadGeometry(), []);
  return (
    <group {...pickHandlers}>
      <mesh geometry={beamGeometry}>
        <meshStandardMaterial color={color} metalness={0.22} roughness={0.5} />
        <Edges color="#c8d3df" threshold={15} />
      </mesh>
      <mesh geometry={payloadGeometry} userData={{ opencaeObjectId: BEAM_PAYLOAD_OBJECT_ID, opencaeObjectLabel: BEAM_PAYLOAD_LABEL }}>
        <meshStandardMaterial color="#8f9aa5" metalness={0.12} roughness={0.58} />
        <Edges color="#d1d8df" threshold={15} />
      </mesh>
    </group>
  );
}

function CantileverSolid({ color, pickHandlers }: { color: string; pickHandlers?: ModelPickHandlers }) {
  return (
    <mesh position={[0, 0.18, 0]} {...pickHandlers}>
      <boxGeometry args={[3.8, 0.5, 0.72]} />
      <meshStandardMaterial color={color} metalness={0.2} roughness={0.5} />
      <Edges color="#c8d3df" threshold={15} />
    </mesh>
  );
}

function UploadedSolid({
  displayModel,
  color,
  pickHandlers,
  activePayloadObjectId,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  displayModel?: DisplayModel;
  color: string;
  pickHandlers?: ModelPickHandlers;
  activePayloadObjectId?: string;
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds?: (bounds: THREE.Box3) => void;
}) {
  if (displayModel?.nativeCad) {
    return (
      <UploadedNativeCadModel
        displayModel={displayModel}
        color={color}
        pickHandlers={pickHandlers}
        activePayloadObjectId={activePayloadObjectId}
        onMeasureDisplayModelDimensions={onMeasureDisplayModelDimensions}
        onUploadedPreviewBounds={onUploadedPreviewBounds}
      />
    );
  }
  if (!displayModel?.visualMesh) return <UnsupportedUploadedModelNotice filename={displayModel?.name ?? "Uploaded model"} />;
  if (displayModel.visualMesh.format === "obj") return <UploadedObjModel displayModel={displayModel} pickHandlers={pickHandlers} activePayloadObjectId={activePayloadObjectId} />;
  return <UploadedStlModel displayModel={displayModel} color={color} pickHandlers={pickHandlers} activePayloadObjectId={activePayloadObjectId} />;
}

function UploadedNativeCadModel({
  displayModel,
  color,
  pickHandlers,
  activePayloadObjectId,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  displayModel: DisplayModel;
  color: string;
  pickHandlers?: ModelPickHandlers;
  activePayloadObjectId?: string;
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds?: (bounds: THREE.Box3) => void;
}) {
  const filename = displayModel.nativeCad?.filename ?? displayModel.name;
  const [preview, setPreview] = useState<{ status: "loading" | "ready" | "error"; object?: THREE.Group; message?: string }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: "loading" });
    stepPreviewFromBase64(displayModel.nativeCad?.contentBase64 ?? "", color)
      .then((nextPreview) => {
        if (cancelled) return;
        setPreview({ status: "ready", object: nextPreview.object });
        onMeasureDisplayModelDimensions?.(nextPreview.dimensions);
        onUploadedPreviewBounds?.(nextPreview.normalizedBounds);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "STEP preview could not be generated.";
        if (!cancelled) setPreview({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [color, displayModel.nativeCad?.contentBase64, onMeasureDisplayModelDimensions, onUploadedPreviewBounds]);

  useEffect(() => {
    if (preview.object) highlightPayloadObjectMeshes(preview.object, activePayloadObjectId, { baseColor: color, highlightColor: "#34d399" });
  }, [activePayloadObjectId, color, preview.object]);

  if (preview.status === "loading") {
    return (
      <Html center position={[0, 0.35, 0]} className="model-notice">
        <strong>Loading STEP preview</strong>
        <span>{filename}</span>
      </Html>
    );
  }

  if (preview.status === "error" || !preview.object) {
    return <UnsupportedUploadedModelNotice filename={`${filename} ${preview.message ?? ""}`.trim()} />;
  }

  return (
    <group {...pickHandlers}>
      <primitive object={preview.object} />
    </group>
  );
}

function UploadedStlModel({ displayModel, color, pickHandlers, activePayloadObjectId }: { displayModel: DisplayModel; color: string; pickHandlers?: ModelPickHandlers; activePayloadObjectId?: string }) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const geometry = useMemo(() => {
    const nextGeometry = normalizedStlGeometryFromBuffer(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? ""));
    nextGeometry.userData.opencaeObjectLabel = displayModel.name.replace(" uploaded model", "");
    nextGeometry.userData.opencaeObjectId = "uploaded-stl-object";
    return nextGeometry;
  }, [displayModel.visualMesh?.contentBase64]);

  useEffect(() => {
    if (meshRef.current) highlightPayloadObjectMeshes(meshRef.current, activePayloadObjectId, { baseColor: color, highlightColor: "#34d399" });
  }, [activePayloadObjectId, color]);

  return (
    <mesh ref={meshRef} geometry={geometry} userData={geometry.userData} {...pickHandlers}>
      <meshStandardMaterial color={color} metalness={0.18} roughness={0.54} />
      <Edges color="#c8d3df" threshold={15} />
    </mesh>
  );
}

function UploadedObjModel({ displayModel, pickHandlers, activePayloadObjectId }: { displayModel: DisplayModel; pickHandlers?: ModelPickHandlers; activePayloadObjectId?: string }) {
  const object = useMemo(() => {
    const text = new TextDecoder().decode(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? ""));
    const parsed = new OBJLoader().parse(text);
    const box = new THREE.Box3().setFromObject(parsed);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
    const scale = 2.4 / maxDimension;
    parsed.scale.setScalar(scale);
    parsed.position.copy(center.multiplyScalar(-scale));
    parsed.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.userData.opencaeObjectId = child.name || child.uuid;
        child.userData.opencaeObjectLabel = child.name || displayModel.name.replace(" uploaded model", "");
        const volumeM3 = volumeM3FromThreeGeometry(child.geometry);
        if (volumeM3) {
          child.userData.opencaeVolumeM3 = volumeM3;
          child.userData.opencaeVolumeSource = "mesh";
          child.userData.opencaeVolumeStatus = "available";
        }
        child.material = new THREE.MeshStandardMaterial({ color: "#9aa7b4", metalness: 0.18, roughness: 0.54 });
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return parsed;
  }, [displayModel.visualMesh?.contentBase64]);

  useEffect(() => {
    highlightPayloadObjectMeshes(object, activePayloadObjectId, { baseColor: "#9aa7b4", highlightColor: "#34d399" });
  }, [activePayloadObjectId, object]);

  return <primitive object={object} {...pickHandlers} />;
}

function volumeM3FromThreeGeometry(geometry: THREE.BufferGeometry): number | undefined {
  const positions = geometry.getAttribute("position");
  if (!positions) return undefined;
  const triangles: Triangle[] = [];
  const index = geometry.getIndex();
  if (index) {
    for (let offset = 0; offset + 2 < index.count; offset += 3) {
      triangles.push([threeVertexAt(positions, index.getX(offset)), threeVertexAt(positions, index.getX(offset + 1)), threeVertexAt(positions, index.getX(offset + 2))]);
    }
  } else {
    for (let offset = 0; offset + 2 < positions.count; offset += 3) {
      triangles.push([threeVertexAt(positions, offset), threeVertexAt(positions, offset + 1), threeVertexAt(positions, offset + 2)]);
    }
  }
  return meshVolumeM3FromTriangles(triangles);
}

function threeVertexAt(positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number): [number, number, number] {
  return [positions.getX(index), positions.getY(index), positions.getZ(index)];
}

function UnsupportedUploadedModelNotice({ filename }: { filename: string }) {
  return (
    <group>
      <mesh visible={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
      <Html center position={[0, 0.35, 0]} className="model-notice">
        <strong>Preview unavailable</strong>
        <span>{filename.replace(" uploaded model", "")}</span>
        <small>This local viewer can import STEP, STP, STL, or OBJ files. Replace this model with a supported file.</small>
      </Html>
    </group>
  );
}

function AnalysisResultModel({
  kind,
  displayModel,
  resultMode,
  showDeformed,
  resultPlaybackPlaying,
  stressExaggeration,
  resultFields,
  resultPlaybackFrameController,
  loadMarkers,
  supportMarkers,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  kind: SampleModelKind;
  displayModel: DisplayModel;
  resultMode: ResultMode;
  showDeformed: boolean;
  resultPlaybackPlaying: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds: (bounds: THREE.Box3) => void;
}) {
  if (kind === "blank") return null;
  const usesPackedPlaybackResults = Boolean(resultPlaybackPlaying && resultPlaybackFrameController);
  const staticSamples = useResultSamplesForFaces(displayModel.faces, resultFields, resultMode, !usesPackedPlaybackResults);
  const packedPlaybackSamples = useMemo(() => initialPackedPlaybackSamplesForFaces(displayModel.faces), [displayModel.faces]);
  const samples = usesPackedPlaybackResults ? packedPlaybackSamples : staticSamples;
  const deformationScale = useMemo(() => {
    const uiScale = stressExaggeration;
    const forcedScale = Number.isFinite(DEBUG_FORCE_DEFORMATION_SCALE) ? DEBUG_FORCE_DEFORMATION_SCALE : undefined;
    const resultModelScale = forcedScale ?? uiScale;
    const resultFieldAvailabilityScale = deformationScaleForResultFields(resultFields) ?? 1;
    const finalDisplayScale = resultFieldAvailabilityScale * resultModelScale;
    if (DEBUG_RESULTS) {
      console.debug("[OpenCAE deformation scale]", {
        uiScale,
        cadViewerPropScale: stressExaggeration,
        resultModelScale,
        finalDisplayScale
      });
    }
    return finalDisplayScale;
  }, [resultFields, stressExaggeration]);
  if (kind === "uploaded") {
    return (
      <UploadedResultSolid
        displayModel={displayModel}
        samples={samples}
        resultMode={resultMode}
        showDeformed={showDeformed}
        resultPlaybackPlaying={resultPlaybackPlaying}
        stressExaggeration={stressExaggeration}
        resultFields={resultFields}
        deformationScale={deformationScale}
        resultPlaybackFrameController={resultPlaybackFrameController}
        loadMarkers={loadMarkers}
        supportMarkers={supportMarkers}
        onMeasureDisplayModelDimensions={onMeasureDisplayModelDimensions}
        onUploadedPreviewBounds={onUploadedPreviewBounds}
      />
    );
  }
  if (kind === "bracket") {
    return <BracketResultSolid kind={kind} samples={samples} resultFields={resultFields} resultMode={resultMode} showDeformed={showDeformed} resultPlaybackPlaying={resultPlaybackPlaying} stressExaggeration={stressExaggeration} deformationScale={deformationScale} resultPlaybackFrameController={resultPlaybackFrameController} loadMarkers={loadMarkers} supportMarkers={supportMarkers} />;
  }
  return <SampleResultSolid kind={kind} samples={samples} resultFields={resultFields} resultMode={resultMode} showDeformed={showDeformed} resultPlaybackPlaying={resultPlaybackPlaying} stressExaggeration={stressExaggeration} deformationScale={deformationScale} resultPlaybackFrameController={resultPlaybackFrameController} loadMarkers={loadMarkers} supportMarkers={supportMarkers} />;
}

function useResultSamplesForFaces(faces: DisplayFace[], resultFields: ResultField[], resultMode: ResultMode, enabled: boolean) {
  return useMemo(
    () => enabled ? resultSamplesForFaces(faces, resultFields, resultMode) : [],
    [enabled, faces, resultFields, resultMode]
  );
}

function initialPackedPlaybackSamplesForFaces(faces: DisplayFace[]): FaceResultSample[] {
  return faces.map((face) => ({ face, value: 0, normalized: 0.5 }));
}

function UploadedResultSolid({
  displayModel,
  samples,
  resultMode,
  showDeformed,
  resultPlaybackPlaying,
  stressExaggeration,
  resultFields,
  deformationScale,
  resultPlaybackFrameController,
  loadMarkers,
  supportMarkers,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  displayModel: DisplayModel;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  resultPlaybackPlaying: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  deformationScale?: number;
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds: (bounds: THREE.Box3) => void;
}) {
  if (displayModel.nativeCad) {
    return (
      <UploadedNativeCadResultModel
        displayModel={displayModel}
        samples={samples}
        resultMode={resultMode}
        showDeformed={showDeformed}
        resultPlaybackPlaying={resultPlaybackPlaying}
        stressExaggeration={stressExaggeration}
        resultFields={resultFields}
        deformationScale={deformationScale}
        resultPlaybackFrameController={resultPlaybackFrameController}
        loadMarkers={loadMarkers}
        supportMarkers={supportMarkers}
        onMeasureDisplayModelDimensions={onMeasureDisplayModelDimensions}
        onUploadedPreviewBounds={onUploadedPreviewBounds}
      />
    );
  }

  if (displayModel.visualMesh?.format === "stl") {
    return (
      <UploadedStlResultModel
        displayModel={displayModel}
        samples={samples}
        resultMode={resultMode}
        showDeformed={showDeformed}
        resultPlaybackPlaying={resultPlaybackPlaying}
        stressExaggeration={stressExaggeration}
        resultFields={resultFields}
        deformationScale={deformationScale}
        resultPlaybackFrameController={resultPlaybackFrameController}
        loadMarkers={loadMarkers}
        supportMarkers={supportMarkers}
      />
    );
  }

  if (displayModel.visualMesh?.format === "obj") {
    return <UploadedObjModel displayModel={displayModel} />;
  }

  return <UnsupportedUploadedModelNotice filename={displayModel.name} />;
}

function UploadedNativeCadResultModel({
  displayModel,
  samples,
  resultMode,
  showDeformed,
  resultPlaybackPlaying,
  stressExaggeration,
  resultFields,
  deformationScale,
  resultPlaybackFrameController,
  loadMarkers,
  supportMarkers,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  displayModel: DisplayModel;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  resultPlaybackPlaying: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  deformationScale?: number;
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds: (bounds: THREE.Box3) => void;
}) {
  const filename = displayModel.nativeCad?.filename ?? displayModel.name;
  const contentBase64 = displayModel.nativeCad?.contentBase64 ?? "";
  const lightweightResultPlayback = Boolean(resultPlaybackFrameController);
  const [preview, setPreview] = useState<{
    status: "loading" | "ready" | "error";
    sourceObject?: THREE.Group;
    dimensions?: NonNullable<DisplayModel["dimensions"]>;
    normalizedBounds?: THREE.Box3;
    message?: string;
  }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPreview({ status: "loading" });
    stepPreviewFromBase64(contentBase64, "#63a9e5", { includeEdges: !lightweightResultPlayback, shareMaterials: lightweightResultPlayback })
      .then((nextPreview) => {
        if (cancelled) return;
        setPreview({
          status: "ready",
          sourceObject: nextPreview.object,
          dimensions: nextPreview.dimensions,
          normalizedBounds: nextPreview.normalizedBounds
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "STEP preview could not be generated.";
        if (!cancelled) setPreview({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [contentBase64, lightweightResultPlayback]);

  useEffect(() => {
    if (preview.status !== "ready" || !preview.dimensions || !preview.normalizedBounds) return;
    onMeasureDisplayModelDimensions?.(preview.dimensions);
    onUploadedPreviewBounds(preview.normalizedBounds);
  }, [onMeasureDisplayModelDimensions, onUploadedPreviewBounds, preview.dimensions, preview.normalizedBounds, preview.status]);

  const renderedPreview = useMemo(() => {
    if (preview.status !== "ready" || !preview.sourceObject) return null;
    const object = cloneResultPreviewObject(preview.sourceObject);
    const outline = showDeformed && !lightweightResultPlayback ? createUndeformedResultOutlineObject(object) : undefined;
    colorizeResultObject(object, "uploaded", resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers, resultFields);
    return { object, outline };
  }, [deformationScale, lightweightResultPlayback, loadMarkers, preview.sourceObject, preview.status, resultFields, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]);

  if (preview.status === "loading") {
    return (
      <Html center position={[0, 0.35, 0]} className="model-notice">
        <strong>Loading STEP preview</strong>
        <span>{filename}</span>
      </Html>
    );
  }

  if (preview.status === "error" || !renderedPreview) {
    return <UnsupportedUploadedModelNotice filename={`${filename} ${preview.message ?? ""}`.trim()} />;
  }

  return (
    <group>
      {renderedPreview.outline && <primitive object={renderedPreview.outline} />}
      <primitive object={renderedPreview.object} />
    </group>
  );
}

function UploadedStlResultModel({
  displayModel,
  samples,
  resultMode,
  showDeformed,
  resultPlaybackPlaying,
  stressExaggeration,
  resultFields,
  deformationScale,
  resultPlaybackFrameController,
  loadMarkers,
  supportMarkers
}: {
  displayModel: DisplayModel;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  resultPlaybackPlaying: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  deformationScale?: number;
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
}) {
  const lightweightResultPlayback = Boolean(resultPlaybackFrameController);
  const outlineGeometry = useMemo(() => normalizedStlGeometryFromBuffer(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? "")), [displayModel.visualMesh?.contentBase64]);
  const geometry = useMemo(() => {
    const parsed = normalizedStlGeometryFromBuffer(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? ""));
    return colorizeResultGeometry(parsed, "uploaded", resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, undefined, undefined, supportMarkers, resultFields);
  }, [deformationScale, displayModel.visualMesh?.contentBase64, loadMarkers, resultFields, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]);
  usePackedPlaybackGeometry(geometry, {
    kind: "uploaded",
    resultMode,
    showDeformed,
    stressExaggeration,
    initialSamples: samples,
    loadMarkers,
    deformationScale,
    supportMarkers,
    resultPlaybackFrameController
  });

  return (
    <group>
      {shouldShowUndeformedResultOutline(showDeformed) && !lightweightResultPlayback && <UndeformedGeometryOutline geometry={outlineGeometry} />}
      <mesh geometry={geometry}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
        {!lightweightResultPlayback && <Edges color="#43556a" threshold={18} />}
      </mesh>
    </group>
  );
}

function BracketResultSolid({
  kind,
  samples,
  resultFields,
  resultMode,
  showDeformed,
  resultPlaybackPlaying,
  stressExaggeration,
  deformationScale,
  resultPlaybackFrameController,
  loadMarkers,
  supportMarkers
}: {
  kind: SampleModelKind;
  samples: FaceResultSample[];
  resultFields: ResultField[];
  resultMode: ResultMode;
  showDeformed: boolean;
  resultPlaybackPlaying: boolean;
  stressExaggeration: number;
  deformationScale?: number;
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
}) {
  const outlineBodyGeometry = useMemo(() => createBracketBodyGeometry(), []);
  const outlineRibGeometry = useMemo(() => createRibGeometry(), []);
  const bodyGeometry = useMemo(
    () => colorizeSampleResultGeometry(createBracketBodyGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers, resultFields),
    [deformationScale, kind, loadMarkers, resultMode, resultFields, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  const ribGeometry = useMemo(
    () => colorizeSampleResultGeometry(createRibGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers, resultFields),
    [deformationScale, kind, loadMarkers, resultMode, resultFields, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  usePackedPlaybackGeometry(bodyGeometry, {
    kind,
    resultMode,
    showDeformed,
    stressExaggeration,
    initialSamples: samples,
    resultFields,
    loadMarkers,
    deformationScale,
    supportMarkers,
    resultPlaybackFrameController
  });
  usePackedPlaybackGeometry(ribGeometry, {
    kind,
    resultMode,
    showDeformed,
    stressExaggeration,
    initialSamples: samples,
    resultFields,
    loadMarkers,
    deformationScale,
    supportMarkers,
    resultPlaybackFrameController
  });
  return (
    <group>
      {shouldShowUndeformedResultOutline(showDeformed) && !resultPlaybackPlaying && (
        <>
          <UndeformedGeometryOutline geometry={outlineBodyGeometry} />
          <UndeformedGeometryOutline geometry={outlineRibGeometry} />
        </>
      )}
      <mesh geometry={bodyGeometry}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
        {!resultPlaybackPlaying && <Edges color="#43556a" threshold={18} />}
      </mesh>
      <mesh geometry={ribGeometry}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
        {!resultPlaybackPlaying && <Edges color="#43556a" threshold={18} />}
      </mesh>
      <HoleRims kind="bracket" />
    </group>
  );
}

function SampleResultSolid({
  kind,
  samples,
  resultFields,
  resultMode,
  showDeformed,
  resultPlaybackPlaying,
  stressExaggeration,
  deformationScale,
  resultPlaybackFrameController,
  loadMarkers,
  supportMarkers
}: {
  kind: SampleModelKind;
  samples: FaceResultSample[];
  resultFields: ResultField[];
  resultMode: ResultMode;
  showDeformed: boolean;
  resultPlaybackPlaying: boolean;
  stressExaggeration: number;
  deformationScale?: number;
  resultPlaybackFrameController?: ResultPlaybackFrameController;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
}) {
  const outlineBeamGeometry = useMemo(() => createBeamGeometry(), []);
  const outlineBeamPayloadGeometry = useMemo(() => createBeamPayloadGeometry(), []);
  const outlineCantileverGeometry = useMemo(() => new THREE.BoxGeometry(3.8, 0.5, 0.72, 40, 8, 8), []);
  const beamGeometry = useMemo(
    () => colorizeSampleResultGeometry(createBeamGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers, resultFields),
    [deformationScale, kind, loadMarkers, resultMode, resultFields, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  const beamPayloadGeometry = useMemo(() => createBeamPayloadGeometry(), []);
  const beamPayloadOffset = useMemo(
    () => resultPayloadOffsetForBeamDemo(beamGeometry, samples, loadMarkers, supportMarkers, resultFields, showDeformed, stressExaggeration, deformationScale ?? 1)
      ?? resultPayloadOffsetForFields(BEAM_PAYLOAD_CENTER, beamGeometry, resultFields, showDeformed, deformationScale ?? 1),
    [beamGeometry, deformationScale, loadMarkers, resultFields, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  const cantileverGeometry = useMemo(
    () => colorizeSampleResultGeometry(new THREE.BoxGeometry(3.8, 0.5, 0.72, 40, 8, 8), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers, resultFields),
    [deformationScale, kind, loadMarkers, resultMode, resultFields, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  usePackedPlaybackGeometry(beamGeometry, {
    kind,
    resultMode,
    showDeformed,
    stressExaggeration,
    initialSamples: samples,
    resultFields,
    loadMarkers,
    deformationScale,
    supportMarkers,
    resultPlaybackFrameController
  });
  usePackedPlaybackGeometry(cantileverGeometry, {
    kind,
    resultMode,
    showDeformed,
    stressExaggeration,
    initialSamples: samples,
    resultFields,
    loadMarkers,
    deformationScale,
    supportMarkers,
    resultPlaybackFrameController
  });
  if (kind === "plate") {
    return (
      <group>
        {shouldShowUndeformedResultOutline(showDeformed) && !resultPlaybackPlaying && (
          <>
            <UndeformedGeometryOutline geometry={outlineBeamGeometry} />
            <UndeformedGeometryOutline geometry={outlineBeamPayloadGeometry} />
          </>
        )}
        <mesh geometry={beamGeometry}>
          <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
          {!resultPlaybackPlaying && <Edges color="#43556a" threshold={18} />}
        </mesh>
        <mesh geometry={beamPayloadGeometry} position={beamPayloadOffset}>
          <meshStandardMaterial color={RESULT_PAYLOAD_MATERIAL_COLOR} metalness={0.12} roughness={0.58} />
          {!resultPlaybackPlaying && <Edges color="#596472" threshold={18} />}
        </mesh>
      </group>
    );
  }
  if (kind === "cantilever") {
    return (
      <group>
        {shouldShowUndeformedResultOutline(showDeformed) && !resultPlaybackPlaying && <UndeformedGeometryOutline geometry={outlineCantileverGeometry} position={[0, 0.18, 0]} />}
        <mesh geometry={cantileverGeometry} position={[0, 0.18, 0]}>
          <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} />
          {!resultPlaybackPlaying && <Edges color="#43556a" threshold={18} />}
        </mesh>
      </group>
    );
  }
  return <SampleSolid kind={kind} color={resultPalette(resultMode).body[2] ?? "#9aa7b4"} />;
}

export function shouldShowUndeformedResultOutline(showDeformed: boolean) {
  return showDeformed;
}

function UndeformedGeometryOutline({ geometry, position }: { geometry: THREE.BufferGeometry; position?: [number, number, number] }) {
  const edgeGeometry = useMemo(() => new THREE.EdgesGeometry(geometry, 18), [geometry]);

  return (
    <lineSegments geometry={edgeGeometry} position={position} renderOrder={8}>
      <lineBasicMaterial color="#dbeafe" transparent opacity={0.72} depthTest={false} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

export function createUndeformedResultOutlineObject(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const outline = new THREE.Group();
  outline.name = "undeformed-result-outline";
  outline.matrix.copy(object.matrix);
  outline.matrixAutoUpdate = false;
  const rootWorldInverse = object.matrixWorld.clone().invert();

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(child.geometry, 18),
      new THREE.LineBasicMaterial({
        color: "#dbeafe",
        transparent: true,
        opacity: 0.72,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      })
    );
    edges.name = `${child.name || "mesh"} undeformed outline`;
    edges.renderOrder = 8;
    edges.matrix.copy(rootWorldInverse.clone().multiply(child.matrixWorld));
    edges.matrixAutoUpdate = false;
    outline.add(edges);
  });

  return outline;
}

export function cloneResultPreviewObject(object: THREE.Group) {
  const clone = object.clone(true);
  clone.traverse((child) => {
    const cloneable = child as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (cloneable.geometry instanceof THREE.BufferGeometry) {
      cloneable.geometry = cloneable.geometry.clone();
    }
    if (Array.isArray(cloneable.material)) {
      cloneable.material = cloneable.material.map((material) => material.clone());
    } else if (cloneable.material instanceof THREE.Material) {
      cloneable.material = cloneable.material.clone();
    }
  });
  return clone;
}

export function applyResultFrameToGeometry({
  geometry,
  fields,
  resultMode,
  showDeformed,
  deformationScale,
  coordinateTransform,
  recomputeDerivedGeometry = true,
  deformationCapFraction = RESULT_DEFORMATION_CAP_FRACTION
}: {
  geometry: THREE.BufferGeometry;
  fields: ResultField[];
  resultMode: ResultMode;
  showDeformed: boolean;
  deformationScale: number;
  coordinateTransform?: ResultCoordinateTransform;
  recomputeDerivedGeometry?: boolean;
  deformationCapFraction?: number;
}) {
  const totalStart = DEBUG_PERF ? performance.now() : 0;
  let mappingMs = 0;
  let scalarMs = 0;
  let displacementMs = 0;
  let normalsMs = 0;
  let boundsMs = 0;
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) return geometry;
  const basePositions = basePositionArrayForGeometry(geometry, position);
  const { colorAttribute, colorAttributeRecreated } = prepareResultGeometryAttributes(geometry, position);

  const scalarField = selectedResultField(fields, resultMode);
  const displacementField = fields.find((field) => field.type === "displacement" && field.samples?.some((sample) => sample.vector));
  logResultFieldDiagnostics(scalarField, resultMode);
  const modelExtent = (coordinateTransform?.bounds ?? basePositionBoundsForGeometry(geometry, basePositions)).getSize(new THREE.Vector3()).length();
  const visualScaleResult = finalVisualScaleForDisplacementField(modelExtent, displacementField, deformationScale, deformationCapFraction);
  const visualScale = visualScaleResult.finalVisualScale;
  if (DEBUG_RESULTS) {
    console.debug("[OpenCAE final deformation scale]", {
      deformationScale: visualScaleResult.deformationScale,
      autoScale: visualScaleResult.autoScale,
      unclampedFinalScale: visualScaleResult.unclampedFinalScale,
      maxFinalScale: visualScaleResult.maxFinalScale,
      finalVisualScale: visualScaleResult.finalVisualScale,
      capActive: visualScaleResult.capActive
    });
  }
  const mappingStart = DEBUG_PERF ? performance.now() : 0;
  const resultBasePositions = coordinateTransform
    ? transformedBasePositionsForResult(geometry, basePositions, coordinateTransform)
    : basePositions;
  const scalarMapping = scalarField?.samples?.length
    ? vertexResultMappingForGeometry(geometry, resultBasePositions, scalarField, "scalar")
    : null;
  const displacementMapping = displacementField?.samples?.length
    ? vertexResultMappingForGeometry(geometry, resultBasePositions, displacementField, "displacement")
    : null;
  const smoothDisplacementInterpolator = displacementField?.samples?.length
    ? smoothVectorInterpolatorForSamples(displacementField.samples)
    : null;
  if (DEBUG_PERF) mappingMs = performance.now() - mappingStart;

  const colorArray = colorAttribute.array as Float32Array;
  const scalarStart = DEBUG_PERF ? performance.now() : 0;
  applyResultColorsToArray(colorArray, position.count, scalarField, scalarMapping, resultMode);
  if (DEBUG_PERF) scalarMs = performance.now() - scalarStart;

  const displacementStart = DEBUG_PERF ? performance.now() : 0;
  if (coordinateTransform) {
    applyTransformedResultPositions(position, basePositions, resultBasePositions, displacementField, displacementMapping, smoothDisplacementInterpolator, showDeformed, visualScale, coordinateTransform);
  } else {
    applyLocalResultPositions(position.array as Float32Array, basePositions, displacementField, displacementMapping, smoothDisplacementInterpolator, showDeformed, visualScale);
  }
  if (DEBUG_RESULTS) {
    logViewerResultDirectionAudit(position.array as Float32Array, basePositions, displacementField);
  }
  if (DEBUG_PERF) displacementMs = performance.now() - displacementStart;

  position.needsUpdate = true;
  colorAttribute.needsUpdate = true;
  if (recomputeDerivedGeometry) {
    const normalsStart = DEBUG_PERF ? performance.now() : 0;
    geometry.computeVertexNormals();
    if (DEBUG_PERF) normalsMs = performance.now() - normalsStart;
    const boundsStart = DEBUG_PERF ? performance.now() : 0;
    geometry.computeBoundingSphere();
    if (DEBUG_PERF) boundsMs = performance.now() - boundsStart;
  } else {
    ensureResultBoundingSphere(geometry, basePositions, modelExtent, visualScale, displacementField);
  }
  if (DEBUG_PERF) {
    console.table([{
      phase: "applyResultFrameToGeometry",
      vertices: position.count,
      samples: fields.reduce((count, field) => count + (field.samples?.length ?? 0), 0),
      mappingMs: roundPerfMs(mappingMs),
      scalarMs: roundPerfMs(scalarMs),
      displacementMs: roundPerfMs(displacementMs),
      computeVertexNormalsMs: roundPerfMs(normalsMs),
      computeBoundingSphereMs: roundPerfMs(boundsMs),
      totalMs: roundPerfMs(performance.now() - totalStart),
      colorAttributeRecreated,
      geometryRecreated: false,
      materialRecreated: false,
      attributesRecreated: colorAttributeRecreated
    }]);
  }
  return geometry;
}

const vertexResultMappingCache = new WeakMap<THREE.BufferGeometry, Map<string, VertexResultMapping>>();

function prepareResultGeometryAttributes(geometry: THREE.BufferGeometry, position: THREE.BufferAttribute) {
  const prepared = geometry.userData.opencaeResultAttributesPrepared === true;
  const colorAttribute = colorAttributeForGeometry(geometry, position.count);
  const colorAttributeRecreated = geometry.getAttribute("color") !== colorAttribute;
  if (colorAttributeRecreated) geometry.setAttribute("color", colorAttribute);
  if (!prepared || colorAttributeRecreated) {
    position.setUsage(THREE.DynamicDrawUsage);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.userData.opencaeResultAttributesPrepared = true;
  }
  return { colorAttribute, colorAttributeRecreated };
}

function vertexResultMappingForGeometry(
  geometry: THREE.BufferGeometry,
  basePositions: Float32Array,
  field: ResultField,
  purpose: "scalar" | "displacement"
): VertexResultMapping {
  let mappings = vertexResultMappingCache.get(geometry);
  if (!mappings) {
    mappings = new Map();
    vertexResultMappingCache.set(geometry, mappings);
  }
  const signature = `${purpose}:${resultFieldSampleGeometrySignature(field)}:${basePositions.length}`;
  const existing = mappings.get(signature);
  if (existing && existing.vertexCount === Math.floor(basePositions.length / 3)) return existing;
  const mapping = createVertexResultMapping({ basePositions, samples: field.samples ?? [], maxNeighbors: 8 });
  mappings.set(signature, mapping);
  return mapping;
}

function resultFieldSampleGeometrySignature(field: ResultField) {
  const samples = field.samples ?? [];
  let hash = 2166136261;
  for (const sample of samples) {
    for (const coordinate of sample.point) {
      hash ^= Math.round(coordinate * 1_000_000);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${field.type}:${field.location}:${samples.length}:${hash >>> 0}`;
}

function transformedBasePositionsForResult(
  geometry: THREE.BufferGeometry,
  basePositions: Float32Array,
  coordinateTransform: ResultCoordinateTransform
): Float32Array {
  const cached = geometry.userData.opencaeResultCoordinateBasePositions;
  if (cached instanceof Float32Array && cached.length === basePositions.length) return cached;
  const transformed = new Float32Array(basePositions.length);
  for (let offset = 0; offset + 2 < basePositions.length; offset += 3) {
    const point = coordinateTransform.toResultPoint(new THREE.Vector3(basePositions[offset] ?? 0, basePositions[offset + 1] ?? 0, basePositions[offset + 2] ?? 0));
    transformed[offset] = point.x;
    transformed[offset + 1] = point.y;
    transformed[offset + 2] = point.z;
  }
  geometry.userData.opencaeResultCoordinateBasePositions = transformed;
  return transformed;
}

function applyResultColorsToArray(
  colorArray: Float32Array,
  vertexCount: number,
  scalarField: ResultField | undefined,
  scalarMapping: VertexResultMapping | null,
  resultMode: ResultMode
) {
  for (let index = 0; index < vertexCount; index += 1) {
    const scalar = mappedScalarValue(index, scalarField, scalarMapping);
    const normalized = scalarField ? normalizeScalarValueForResultRender(scalar, scalarField) : 0;
    writeResultColorForValue(colorArray, index * 3, resultMode, normalized);
  }
}

function mappedScalarValue(vertexIndex: number, field: ResultField | undefined, mapping: VertexResultMapping | null) {
  if (!field) return 0;
  const samples = field.samples;
  const weights = mapping?.weightsByVertex[vertexIndex];
  if (samples?.length && weights?.length) {
    let value = 0;
    let totalWeight = 0;
    for (const sampleWeight of weights) {
      const sampleValue = samples[sampleWeight.sampleIndex]?.value;
      if (!Number.isFinite(sampleValue)) continue;
      value += Number(sampleValue) * sampleWeight.weight;
      totalWeight += sampleWeight.weight;
    }
    if (totalWeight > 0) return value / totalWeight;
  }
  return field.values[vertexIndex] ?? 0;
}

function normalizeScalarValueForResultRender(value: number, field: ResultField) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(field.min) || !Number.isFinite(field.max) || Math.abs(field.max - field.min) <= 1e-12) return 0;
  return normalizeValueForRender(value, field.min, field.max);
}

function writeResultColorForValue(colorArray: Float32Array, offset: number, resultMode: ResultMode, t: number) {
  const color = reusablePaletteColor(resultMode, t);
  colorArray[offset] = color.r;
  colorArray[offset + 1] = color.g;
  colorArray[offset + 2] = color.b;
}

const resultColorScratch = new THREE.Color();
const resultPaletteColorCache = new Map<ResultMode, THREE.Color[]>();

function reusablePaletteColor(resultMode: ResultMode, t: number) {
  const colors = cachedResultPaletteColors(resultMode);
  const value = Math.max(0, Math.min(1, t));
  const index = Math.min(colors.length - 2, Math.floor(value * (colors.length - 1)));
  const localT = value * (colors.length - 1) - index;
  return resultColorScratch.lerpColors(colors[index] ?? colors[0]!, colors[index + 1] ?? colors.at(-1)!, localT);
}

function cachedResultPaletteColors(resultMode: ResultMode) {
  const cached = resultPaletteColorCache.get(resultMode);
  if (cached) return cached;
  const colors = resultPalette(resultMode).body.map((color) => new THREE.Color(color));
  resultPaletteColorCache.set(resultMode, colors);
  return colors;
}

function applyLocalResultPositions(
  positionArray: Float32Array,
  basePositions: Float32Array,
  displacementField: ResultField | undefined,
  displacementMapping: VertexResultMapping | null,
  smoothDisplacementInterpolator: SmoothVectorInterpolator | null,
  showDeformed: boolean,
  visualScale: number
) {
  if (!showDeformed || !displacementField?.samples?.length || !displacementMapping || visualScale <= 0) {
    for (let index = 0; index < basePositions.length; index += 1) positionArray[index] = basePositions[index] ?? 0;
    return;
  }
  const vertexCount = Math.floor(basePositions.length / 3);
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const offset = vertexIndex * 3;
    const [ux, uy, uz] = displacementVectorForVertex(vertexIndex, offset, basePositions, displacementField, displacementMapping, smoothDisplacementInterpolator);
    positionArray[offset] = (basePositions[offset] ?? 0) + ux * visualScale;
    positionArray[offset + 1] = (basePositions[offset + 1] ?? 0) + uy * visualScale;
    positionArray[offset + 2] = (basePositions[offset + 2] ?? 0) + uz * visualScale;
  }
}

function applyTransformedResultPositions(
  position: THREE.BufferAttribute,
  basePositions: Float32Array,
  resultBasePositions: Float32Array,
  displacementField: ResultField | undefined,
  displacementMapping: VertexResultMapping | null,
  smoothDisplacementInterpolator: SmoothVectorInterpolator | null,
  showDeformed: boolean,
  visualScale: number,
  coordinateTransform: ResultCoordinateTransform
) {
  if (!showDeformed || !displacementField?.samples?.length || !displacementMapping || visualScale <= 0) {
    resetGeometryPositions(position, basePositions);
    return;
  }
  const vertexCount = Math.floor(basePositions.length / 3);
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const offset = vertexIndex * 3;
    const [ux, uy, uz] = displacementVectorForVertex(vertexIndex, offset, resultBasePositions, displacementField, displacementMapping, smoothDisplacementInterpolator);
    const resultPoint = new THREE.Vector3(
      (resultBasePositions[offset] ?? 0) + ux * visualScale,
      (resultBasePositions[offset + 1] ?? 0) + uy * visualScale,
      (resultBasePositions[offset + 2] ?? 0) + uz * visualScale
    );
    const local = coordinateTransform.fromResultPoint(resultPoint);
    position.setXYZ(vertexIndex, local.x, local.y, local.z);
  }
}

function displacementVectorForVertex(
  vertexIndex: number,
  offset: number,
  basePositions: Float32Array,
  field: ResultField,
  mapping: VertexResultMapping,
  smoothDisplacementInterpolator: SmoothVectorInterpolator | null
): [number, number, number] {
  const weights = mapping.weightsByVertex[vertexIndex];
  const exact = weights?.length === 1 && Math.abs((weights[0]?.weight ?? 0) - 1) <= 1e-12;
  if (!exact && smoothDisplacementInterpolator) {
    return smoothDisplacementInterpolator.interpolateComponents(
      basePositions[offset] ?? 0,
      basePositions[offset + 1] ?? 0,
      basePositions[offset + 2] ?? 0
    );
  }
  return mappedDisplacementVector(vertexIndex, field, mapping);
}

function mappedDisplacementVector(
  vertexIndex: number,
  field: ResultField,
  mapping: VertexResultMapping
): [number, number, number] {
  const weights = mapping.weightsByVertex[vertexIndex];
  const samples = field.samples ?? [];
  if (!weights?.length) return [0, 0, 0];
  let ux = 0;
  let uy = 0;
  let uz = 0;
  let totalWeight = 0;
  for (const sampleWeight of weights) {
    const vector = samples[sampleWeight.sampleIndex]?.vector;
    if (!vector?.every(Number.isFinite)) continue;
    ux += vector[0] * sampleWeight.weight;
    uy += vector[1] * sampleWeight.weight;
    uz += vector[2] * sampleWeight.weight;
    totalWeight += sampleWeight.weight;
  }
  if (totalWeight <= 0) return [0, 0, 0];
  return [ux / totalWeight, uy / totalWeight, uz / totalWeight];
}

function logViewerResultDirectionAudit(positionArray: Float32Array, basePositions: Float32Array, displacementField: ResultField | undefined) {
  const delta = maxVertexDelta(positionArray, basePositions);
  const vectors = displacementField?.samples?.map((sample) => sample.vector).filter((vector): vector is [number, number, number] => Boolean(vector)) ?? [];
  console.info("[OpenCAE debugResults] viewer result direction audit", {
    fieldId: displacementField?.id ?? null,
    displacementSampleVector: vectors[0] ?? null,
    displacementSampleDominantAxis: dominantArrayVectorAxis(vectors),
    deformedVertexDelta: delta,
    deformedVertexDeltaDominantAxis: delta ? dominantArrayVectorAxis([delta]) : null
  });
}

function maxVertexDelta(positionArray: Float32Array, basePositions: Float32Array): [number, number, number] | null {
  let maxDelta: [number, number, number] | null = null;
  let maxMagnitude = 0;
  for (let offset = 0; offset + 2 < basePositions.length; offset += 3) {
    const delta: [number, number, number] = [
      (positionArray[offset] ?? 0) - (basePositions[offset] ?? 0),
      (positionArray[offset + 1] ?? 0) - (basePositions[offset + 1] ?? 0),
      (positionArray[offset + 2] ?? 0) - (basePositions[offset + 2] ?? 0)
    ];
    const magnitude = Math.hypot(...delta);
    if (magnitude > maxMagnitude) {
      maxMagnitude = magnitude;
      maxDelta = delta;
    }
  }
  return maxDelta;
}

function dominantArrayVectorAxis(vectors: Array<[number, number, number]>): { axis: "x" | "y" | "z"; sign: -1 | 0 | 1 } {
  const absolute: [number, number, number] = [0, 0, 0];
  const signed: [number, number, number] = [0, 0, 0];
  for (const vector of vectors) {
    absolute[0] += Math.abs(vector[0]);
    absolute[1] += Math.abs(vector[1]);
    absolute[2] += Math.abs(vector[2]);
    signed[0] += vector[0];
    signed[1] += vector[1];
    signed[2] += vector[2];
  }
  const axisIndex = absolute[0] >= absolute[1] && absolute[0] >= absolute[2] ? 0 : absolute[1] >= absolute[2] ? 1 : 2;
  return {
    axis: (["x", "y", "z"] as const)[axisIndex],
    sign: signed[axisIndex] > 1e-9 ? 1 : signed[axisIndex] < -1e-9 ? -1 : 0
  };
}

function ensureResultBoundingSphere(
  geometry: THREE.BufferGeometry,
  basePositions: Float32Array,
  modelExtent: number,
  visualScale: number,
  displacementField: ResultField | undefined
) {
  const displacementMax = maxDisplacementMagnitude(displacementField);
  const key = `${basePositions.length}:${modelExtent}:${visualScale}:${displacementMax}`;
  if (geometry.boundingSphere && geometry.userData.opencaeResultExpandedBoundingSphereKey === key) return;
  const bounds = basePositionBounds(basePositions);
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const expansion = Math.min(modelExtent * RESULT_DEFORMATION_CAP_FRACTION, Math.max(0, visualScale * displacementMax));
  sphere.radius += expansion;
  geometry.boundingSphere = sphere;
  geometry.userData.opencaeResultExpandedBoundingSphere = true;
  geometry.userData.opencaeResultExpandedBoundingSphereKey = key;
}

function roundPerfMs(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function interpolateDisplacementAtPoint(
  point: [number, number, number],
  displacementField: ResultField
): [number, number, number] {
  if (displacementField.type !== "displacement") return [0, 0, 0];
  const samples = displacementField.samples?.filter((sample) => (
    sample.point.every(Number.isFinite) &&
    Boolean(sample.vector?.every(Number.isFinite))
  ));
  if (!samples?.length) return [0, 0, 0];

  const exact = samples.find((sample) => squaredDistanceArrays(point, sample.point) <= 1e-18);
  if (exact?.vector) return exact.vector;

  const smoothInterpolator = smoothVectorInterpolatorForSamples(samples);
  if (smoothInterpolator) return smoothInterpolator.interpolate(new THREE.Vector3(...point)).toArray() as [number, number, number];

  const neighbors = nearestResultSamples(new THREE.Vector3(...point), samples, (sample) => Boolean(sample.vector?.every(Number.isFinite)));
  if (!neighbors.length) return [0, 0, 0];
  const vector = new THREE.Vector3();
  let totalWeight = 0;
  for (const neighbor of neighbors) {
    if (!neighbor.sample.vector) continue;
    const weight = 1 / Math.max(neighbor.distanceSq, 1e-18);
    vector.addScaledVector(new THREE.Vector3(...neighbor.sample.vector), weight);
    totalWeight += weight;
  }
  return (totalWeight > 0 ? vector.multiplyScalar(1 / totalWeight) : vector).toArray() as [number, number, number];
}

export function finalVisualScaleForDisplacementField(
  modelExtent: number,
  displacementField: ResultField | undefined,
  deformationScale: number,
  capFraction = RESULT_DEFORMATION_CAP_FRACTION
) {
  const displacementMax = maxDisplacementMagnitude(displacementField);
  const requestedScale = Math.max(0, deformationScale);
  const safeExtent = Math.max(0, modelExtent);
  const autoScale = displacementMax > 1e-12
    ? (safeExtent * RESULT_DEFORMATION_TARGET_FRACTION) / displacementMax
    : 0;
  const unclampedFinalScale = autoScale * requestedScale;
  const maxVisualDisplacement = safeExtent * Math.max(0, capFraction);
  const maxFinalScale = displacementMax > 1e-12
    ? maxVisualDisplacement / displacementMax
    : 0;
  const finalVisualScale = Math.min(unclampedFinalScale, maxFinalScale);
  return {
    deformationScale: requestedScale,
    autoScale,
    unclampedFinalScale,
    maxFinalScale,
    finalVisualScale,
    capActive: unclampedFinalScale > maxFinalScale
  };
}

function visualScaleForDisplacementField(modelExtent: number, displacementField: ResultField | undefined, deformationScale: number): number {
  return finalVisualScaleForDisplacementField(modelExtent, displacementField, deformationScale).finalVisualScale;
}

function colorizeResultGeometry(
  geometry: THREE.BufferGeometry,
  kind: SampleModelKind,
  resultMode: ResultMode,
  showDeformed: boolean,
  stressExaggeration: number,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  deformationScale?: number,
  coordinateTransform?: ResultCoordinateTransform,
  valueRange?: ResultValueRange,
  supportMarkers: ViewerSupportMarker[] = [],
  resultFields: ResultField[] = [],
  recomputeDerivedGeometry = true
) {
  const positions = geometry.getAttribute("position");
  if (!(positions instanceof THREE.BufferAttribute)) return geometry;
  const usesBeamPayloadFallback = shouldUseBeamDemoPayloadFallback(kind, loadMarkers, resultFields);
  if (resultFields.length && !coordinateTransform && !usesBeamPayloadFallback) {
    return applyResultFrameToGeometry({
      geometry,
      fields: resultFields,
      resultMode,
      showDeformed,
      deformationScale: deformationScale ?? 1
    });
  }
  if (resultFields.length && coordinateTransform) {
    return applyResultFrameToGeometry({
      geometry,
      fields: resultFields,
      resultMode,
      showDeformed,
      deformationScale: deformationScale ?? 1,
      coordinateTransform
    });
  }
  const basePositions = basePositionArrayForGeometry(geometry, positions);
  resetGeometryPositions(positions, basePositions);
  const color = new THREE.Color();
  const resolvedDeformationScale = deformationScale ?? deformationScaleForSamples(resultMode, samples);
  const usesResultDeformationScale = typeof deformationScale === "number";
  if (recomputeDerivedGeometry || !geometry.boundingBox) geometry.computeBoundingBox();
  const bounds = coordinateTransform?.bounds ?? geometry.boundingBox?.clone() ?? basePositionBoundsForGeometry(geometry, basePositions);
  const beamDemoCoordinate = usesBeamPayloadFallback
    ? createBeamDemoCoordinate({ bounds, samples, loadMarkers, supportMarkers })
    : null;
  const beamDemoMaxDisplacement = beamDemoCoordinate
    ? beamDemoMaxDisplacementForLoads(stressExaggeration, loadMarkers, resolvedDeformationScale, usesResultDeformationScale)
    : 0;
  const range = valueRange ?? (beamDemoCoordinate ? { min: 0, max: 1 } : resultValueRangeForGeometry(geometry, kind, resultMode, stressExaggeration, samples, coordinateTransform));
  const colorAttribute = colorAttributeForGeometry(geometry, positions.count);
  for (let index = 0; index < positions.count; index += 1) {
    const baseOffset = index * 3;
    const point = new THREE.Vector3(basePositions[baseOffset] ?? 0, basePositions[baseOffset + 1] ?? 0, basePositions[baseOffset + 2] ?? 0);
    const resultPoint = coordinateTransform?.toResultPoint(point) ?? point;
    const value = beamDemoCoordinate
      ? beamDemoFallbackValueForPoint(resultMode, resultPoint, beamDemoCoordinate)
      : resultValueForPoint(kind, resultMode, stressExaggeration, resultPoint, samples);
    color.copy(resultColorForValue(resultMode, normalizeResultValue(value, range)));
    colorAttribute.setXYZ(index, color.r, color.g, color.b);
    if (showDeformed) {
      const deformed = beamDemoCoordinate
        ? deformedBeamDemoPayloadPoint(resultPoint, beamDemoCoordinate, beamDemoMaxDisplacement)
        : deformedPointForResults(kind, resultPoint, stressExaggeration, samples, loadMarkers, resolvedDeformationScale, usesResultDeformationScale, bounds, supportMarkers);
      const localDeformed = coordinateTransform?.fromResultPoint(deformed) ?? deformed;
      positions.setXYZ(index, localDeformed.x, localDeformed.y, localDeformed.z);
    }
  }
  if (geometry.getAttribute("color") !== colorAttribute) geometry.setAttribute("color", colorAttribute);
  colorAttribute.needsUpdate = true;
  positions.needsUpdate = true;
  if (recomputeDerivedGeometry) {
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  } else {
    ensureResultBoundingSphere(geometry, basePositions, bounds.getSize(new THREE.Vector3()).length(), 0, undefined);
  }
  return geometry;
}

function basePositionArrayForGeometry(geometry: THREE.BufferGeometry, positions: THREE.BufferAttribute): Float32Array {
  const standard = geometry.userData.basePositions;
  const sourceArray = positions.array;
  const storedSourceArray = geometry.userData.opencaeBasePositionSourceArray;
  if (
    standard instanceof Float32Array &&
    standard.length === sourceArray.length &&
    (storedSourceArray === undefined || storedSourceArray === sourceArray)
  ) {
    geometry.userData.opencaeBasePositions = standard;
    geometry.userData.basePositionCount = positions.count;
    geometry.userData.opencaeBasePositionSourceArray ??= sourceArray;
    return standard;
  }
  const existing = geometry.userData.opencaeBasePositions;
  if (
    existing instanceof Float32Array &&
    existing.length === sourceArray.length &&
    (storedSourceArray === undefined || storedSourceArray === sourceArray)
  ) {
    geometry.userData.basePositions = existing;
    geometry.userData.basePositionCount = positions.count;
    geometry.userData.opencaeBasePositionSourceArray ??= sourceArray;
    return existing;
  }
  const base = new Float32Array(sourceArray as ArrayLike<number>);
  geometry.userData.opencaeBasePositions = base;
  geometry.userData.basePositions = base;
  geometry.userData.basePositionCount = positions.count;
  geometry.userData.opencaeBasePositionSourceArray = sourceArray;
  delete geometry.userData.opencaeBasePositionBounds;
  delete geometry.userData.opencaeResultExpandedBoundingSphereKey;
  return base;
}

function resetGeometryPositions(positions: THREE.BufferAttribute, basePositions: Float32Array) {
  const target = positions.array;
  for (let index = 0; index < basePositions.length; index += 1) {
    target[index] = basePositions[index] ?? 0;
  }
}

function colorAttributeForGeometry(geometry: THREE.BufferGeometry, vertexCount: number): THREE.BufferAttribute {
  const current = geometry.getAttribute("color");
  if (current instanceof THREE.BufferAttribute && current.array instanceof Float32Array && current.count === vertexCount) return current;
  return new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
}

function basePositionBounds(basePositions: Float32Array): THREE.Box3 {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset + 2 < basePositions.length; offset += 3) {
    const x = basePositions[offset] ?? 0;
    const y = basePositions[offset + 1] ?? 0;
    const z = basePositions[offset + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
  return new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
}

function basePositionBoundsForGeometry(geometry: THREE.BufferGeometry, basePositions: Float32Array): THREE.Box3 {
  const cached = geometry.userData.opencaeBasePositionBounds;
  if (cached instanceof THREE.Box3) return cached;
  const bounds = basePositionBounds(basePositions);
  geometry.userData.opencaeBasePositionBounds = bounds;
  return bounds;
}

function maxDisplacementMagnitude(field: ResultField | undefined): number {
  if (!field) return 0;
  const magnitudes = [
    Math.abs(Number(field.max)),
    Math.abs(Number(field.min)),
    ...field.values.map((value) => Math.abs(value)),
    ...(field.samples?.map((sample) => Math.abs(sample.value)) ?? []),
    ...(field.samples?.map((sample) => sample.vector ? Math.hypot(...sample.vector) : 0) ?? [])
  ].filter(Number.isFinite);
  return magnitudes.length ? Math.max(...magnitudes) : 0;
}

function interpolateResultSampleValue(point: THREE.Vector3, samples: NonNullable<ResultField["samples"]>, fallback: number): number {
  const neighbors = nearestResultSamples(point, samples, (sample) => Number.isFinite(sample.value));
  if (!neighbors.length) return fallback;
  const exact = neighbors.find((entry) => entry.distanceSq <= 1e-18);
  if (exact) return exact.sample.value;
  let weighted = 0;
  let totalWeight = 0;
  for (const neighbor of neighbors) {
    const weight = 1 / Math.max(neighbor.distanceSq, 1e-18);
    weighted += neighbor.sample.value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : fallback;
}

function interpolateResultSampleVector(point: THREE.Vector3, samples: NonNullable<ResultField["samples"]>): THREE.Vector3 {
  const neighbors = nearestResultSamples(point, samples, (sample) => Boolean(sample.vector?.every(Number.isFinite)));
  if (!neighbors.length) return new THREE.Vector3();
  const exact = neighbors.find((entry) => entry.distanceSq <= 1e-18);
  if (exact?.sample.vector) return new THREE.Vector3(...exact.sample.vector);
  const smoothInterpolator = smoothVectorInterpolatorForSamples(samples);
  if (smoothInterpolator) return smoothInterpolator.interpolate(point);
  const vector = new THREE.Vector3();
  let totalWeight = 0;
  for (const neighbor of neighbors) {
    if (!neighbor.sample.vector) continue;
    const weight = 1 / Math.max(neighbor.distanceSq, 1e-18);
    vector.addScaledVector(new THREE.Vector3(...neighbor.sample.vector), weight);
    totalWeight += weight;
  }
  return totalWeight > 0 ? vector.multiplyScalar(1 / totalWeight) : vector;
}

function squaredDistanceArrays(left: [number, number, number], right: [number, number, number]) {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return dx * dx + dy * dy + dz * dz;
}

type SmoothVectorInterpolator = {
  interpolate: (point: THREE.Vector3) => THREE.Vector3;
  interpolateComponents: (x: number, y: number, z: number) => [number, number, number];
};

const smoothVectorInterpolatorCache = new WeakMap<NonNullable<ResultField["samples"]>, SmoothVectorInterpolator | null>();

function smoothVectorInterpolatorForSamples(samples: NonNullable<ResultField["samples"]>): SmoothVectorInterpolator | null {
  if (smoothVectorInterpolatorCache.has(samples)) return smoothVectorInterpolatorCache.get(samples) ?? null;
  const interpolator = createSmoothVectorInterpolator(samples);
  smoothVectorInterpolatorCache.set(samples, interpolator);
  return interpolator;
}

function createSmoothVectorInterpolator(samples: NonNullable<ResultField["samples"]>): SmoothVectorInterpolator | null {
  const vectorSamples = samples
    .filter((sample) => sample.vector?.every(Number.isFinite) && sample.point.every(Number.isFinite))
    .map((sample) => ({ point: sample.point, vector: new THREE.Vector3(...sample.vector!) }));
  const nonzeroVectors = vectorSamples.filter((sample) => sample.vector.lengthSq() > 1e-18);
  if (nonzeroVectors.length < 4) return null;
  const averageDirection = nonzeroVectors.reduce((sum, sample) => sum.add(sample.vector), new THREE.Vector3());
  if (averageDirection.lengthSq() <= 1e-18) return null;
  averageDirection.normalize();
  const alignedCount = nonzeroVectors.filter((sample) => Math.abs(sample.vector.clone().normalize().dot(averageDirection)) > 0.92).length;
  if (alignedCount / nonzeroVectors.length < 0.82) return null;

  const bounds = new THREE.Box3();
  for (const sample of vectorSamples) bounds.expandByPoint(new THREE.Vector3(...sample.point));
  const size = bounds.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const span = [size.x, size.y, size.z][axis] ?? 0;
  if (!Number.isFinite(span) || span <= 1e-9) return null;

  const tolerance = Math.max(span * 1e-5, 1e-7);
  const buckets = new Map<number, { coordinate: number; vector: THREE.Vector3; count: number }>();
  for (const sample of vectorSamples) {
    const coordinate = sample.point[axis] ?? 0;
    const key = Math.round(coordinate / tolerance);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.coordinate += coordinate;
      bucket.vector.add(sample.vector);
      bucket.count += 1;
    } else {
      buckets.set(key, { coordinate, vector: sample.vector.clone(), count: 1 });
    }
  }
  const stations = [...buckets.values()]
    .map((bucket) => ({
      coordinate: bucket.coordinate / bucket.count,
      vector: bucket.vector.multiplyScalar(1 / bucket.count)
    }))
    .sort((left, right) => left.coordinate - right.coordinate);
  if (stations.length < 3) return null;

  const interpolateComponents = (x: number, y: number, z: number): [number, number, number] => {
    const coordinate = axis === 0 ? x : axis === 1 ? y : z;
    if (coordinate <= stations[0]!.coordinate) return vectorComponents(stations[0]!.vector);
    const last = stations[stations.length - 1]!;
    if (coordinate >= last.coordinate) return vectorComponents(last.vector);
      let upperIndex = 1;
      while (upperIndex < stations.length && coordinate > stations[upperIndex]!.coordinate) upperIndex += 1;
      const lower = stations[Math.max(0, upperIndex - 1)]!;
      const upper = stations[Math.min(stations.length - 1, upperIndex)]!;
      const width = Math.max(upper.coordinate - lower.coordinate, 1e-12);
      const t = Math.max(0, Math.min(1, (coordinate - lower.coordinate) / width));
    return [
      lower.vector.x + (upper.vector.x - lower.vector.x) * t,
      lower.vector.y + (upper.vector.y - lower.vector.y) * t,
      lower.vector.z + (upper.vector.z - lower.vector.z) * t
    ];
  };

  return {
    interpolate(point) {
      const [x, y, z] = interpolateComponents(point.x, point.y, point.z);
      return new THREE.Vector3(x, y, z);
    },
    interpolateComponents
  };
}

function vectorComponents(vector: THREE.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
    }

function nearestResultSamples(
  point: THREE.Vector3,
  samples: NonNullable<ResultField["samples"]>,
  predicate: (sample: NonNullable<ResultField["samples"]>[number]) => boolean
) {
  return samples
    .map((sample) => ({ sample, distanceSq: squaredDistanceToPointArray(point, sample.point) }))
    .filter((entry) => predicate(entry.sample) && Number.isFinite(entry.distanceSq))
    .sort((left, right) => left.distanceSq - right.distanceSq)
    .slice(0, Math.min(8, Math.max(3, samples.length)));
}

const loggedResultFieldDiagnostics = new Set<string>();

function logResultFieldDiagnostics(field: ResultField | undefined, resultMode: ResultMode) {
  if (!DEBUG_PERF && !DEBUG_RESULTS) return;
  if (!field) return;
  const finiteValues = field.values.filter(Number.isFinite);
  const finiteSamples = field.samples?.map((sample) => sample.value).filter(Number.isFinite) ?? [];
  const reasons: string[] = [];
  if (!finiteValues.length) reasons.push("no finite values");
  if (field.samples && !finiteSamples.length) reasons.push("no finite samples");
  if (field.min === field.max) reasons.push("min equals max");
  if (!reasons.length) return;
  const key = `${field.id}:${field.frameIndex ?? "static"}:${reasons.join(",")}`;
  if (loggedResultFieldDiagnostics.has(key)) return;
  loggedResultFieldDiagnostics.add(key);
  console.debug("[OpenCAE results] scalar field diagnostic", {
    resultMode,
    fieldId: field.id,
    frameIndex: field.frameIndex,
    type: field.type,
    location: field.location,
    min: field.min,
    max: field.max,
    reasons
  });
}

function resultValueRangeForGeometry(
  geometry: THREE.BufferGeometry,
  kind: SampleModelKind,
  resultMode: ResultMode,
  stressExaggeration: number,
  samples: FaceResultSample[],
  coordinateTransform?: ResultCoordinateTransform
): ResultValueRange {
  const positions = geometry.getAttribute("position");
  if (!(positions instanceof THREE.BufferAttribute)) return { min: 0, max: 1 };
  const basePositions = basePositionArrayForGeometry(geometry, positions);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.count; index += 1) {
    const offset = index * 3;
    const point = new THREE.Vector3(basePositions[offset] ?? 0, basePositions[offset + 1] ?? 0, basePositions[offset + 2] ?? 0);
    const resultPoint = coordinateTransform?.toResultPoint(point) ?? point;
    const value = resultValueForPoint(kind, resultMode, stressExaggeration, resultPoint, samples);
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : { min: 0, max: 1 };
}

export function colorizeSampleResultGeometry(
  geometry: THREE.BufferGeometry,
  kind: SampleModelKind,
  resultMode: ResultMode,
  showDeformed: boolean,
  stressExaggeration: number,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  deformationScale?: number,
  supportMarkers: ViewerSupportMarker[] = [],
  resultFields: ResultField[] = []
) {
  return colorizeResultGeometry(geometry, kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, undefined, undefined, supportMarkers, resultFields);
}

function usePackedPlaybackGeometry(
  geometry: THREE.BufferGeometry,
  options: {
    kind: SampleModelKind;
    resultMode: ResultMode;
    showDeformed: boolean;
    stressExaggeration: number;
    initialSamples: FaceResultSample[];
    resultFields?: ResultField[];
    loadMarkers: ViewerLoadMarker[];
    deformationScale?: number;
    supportMarkers: ViewerSupportMarker[];
    resultPlaybackFrameController?: ResultPlaybackFrameController;
  }
) {
  const { invalidate } = useThree();
  const optionsRef = useRef(options);
  const samplesRef = useRef<FaceResultSample[]>([]);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  useEffect(() => {
    samplesRef.current = reusablePackedSamples(options.initialSamples);
  }, [options.initialSamples]);
  useEffect(() => {
    const controller = options.resultPlaybackFrameController;
    if (!controller) return undefined;
    const applySnapshot = (snapshot: ResultPlaybackFrameSnapshot) => {
      const latest = optionsRef.current;
      const frameOrdinal = packedPreparedPlaybackFrameOrdinal(snapshot.cache, snapshot.framePosition);
      const fields = resultFieldsForPackedPreparedFrame(snapshot.cache, frameOrdinal);
      if (fields.length) {
        applyResultFrameToGeometry({
          geometry,
          fields,
          resultMode: latest.resultMode,
          showDeformed: latest.showDeformed,
          deformationScale: latest.deformationScale ?? 1,
          recomputeDerivedGeometry: false
        });
        invalidate();
        return;
      }
      const samples = updatePackedSamples(samplesRef.current, snapshot.cache, frameOrdinal, latest.resultMode);
      colorizeResultGeometry(
        geometry,
        latest.kind,
        latest.resultMode,
        latest.showDeformed,
        latest.stressExaggeration,
        samples,
        latest.loadMarkers,
        latest.deformationScale,
        undefined,
        undefined,
        latest.supportMarkers,
        [],
        false
      );
      invalidate();
    };
    const snapshot = controller.getSnapshot();
    if (snapshot) applySnapshot(snapshot);
    return controller.subscribe(applySnapshot);
  }, [
    geometry,
    invalidate,
    options.deformationScale,
    options.resultMode,
    options.resultPlaybackFrameController,
    options.showDeformed,
    options.stressExaggeration
  ]);
}

function reusablePackedSamples(samples: FaceResultSample[]): FaceResultSample[] {
  return samples.map((sample) => ({
    face: sample.face,
    value: sample.value,
    normalized: sample.normalized,
    ...(sample.fieldSamples ? { fieldSamples: sample.fieldSamples } : {})
  }));
}

export function updatePackedSamples(samples: FaceResultSample[], cache: PackedPreparedPlaybackCache, frameOrdinal: number, resultMode: ResultMode): FaceResultSample[] {
  const slot = packedPreparedPlaybackFieldSlot(cache, frameOrdinal, resultMode);
  if (!slot) return samples;
  const field = resultFieldForPackedSlot(slot);
  const mapped = resultSamplesForFaces(samples.map((sample) => sample.face), [field], resultMode);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const mappedSample = mapped[index];
    sample.value = mappedSample?.value ?? sample.value;
    sample.normalized = mappedSample?.normalized ?? sample.normalized;
    if (mappedSample?.diagnostic) sample.diagnostic = mappedSample.diagnostic;
  }
  updatePackedFieldSamples(samples, slot);
  return samples;
}

function resultFieldForPackedSlot(slot: NonNullable<ReturnType<typeof packedPreparedPlaybackFieldSlot>>): ResultField {
  return {
    ...slot.descriptor,
    id: `${slot.descriptor.id}-packed`,
    values: Array.from(slot.values.slice(slot.offset, slot.offset + slot.length)),
    min: slot.min,
    max: slot.max,
    samples: Array.from({ length: slot.sampleLength }, (_, index) => {
      const packedIndex = slot.sampleOffset + index;
      const pointOffset = packedIndex * 3;
      return {
        point: [
          slot.samplePoints[pointOffset] ?? 0,
          slot.samplePoints[pointOffset + 1] ?? 0,
          slot.samplePoints[pointOffset + 2] ?? 0
        ] as [number, number, number],
        normal: [
          slot.sampleNormals[pointOffset] ?? 0,
          slot.sampleNormals[pointOffset + 1] ?? 0,
          slot.sampleNormals[pointOffset + 2] ?? 0
        ] as [number, number, number],
        value: slot.sampleValues[packedIndex] ?? 0,
        vector: [
          slot.sampleVectors[pointOffset] ?? 0,
          slot.sampleVectors[pointOffset + 1] ?? 0,
          slot.sampleVectors[pointOffset + 2] ?? 0
        ] as [number, number, number]
      };
    })
  };
}

function resultFieldsForPackedPreparedFrame(cache: PackedPreparedPlaybackCache, frameOrdinal: number): ResultField[] {
  const clampedFrameOrdinal = Math.max(0, Math.min(cache.frameCount - 1, Math.floor(frameOrdinal)));
  const frameIndex = cache.frameIndexes[clampedFrameOrdinal] ?? clampedFrameOrdinal;
  const timeSeconds = cache.times[clampedFrameOrdinal] ?? 0;
  return cache.fieldDescriptors.map((descriptor, fieldOrdinal): ResultField => {
    const slot = clampedFrameOrdinal * cache.fieldCount + fieldOrdinal;
    const offset = cache.fieldOffsets[slot] ?? 0;
    const length = cache.fieldLengths[slot] ?? 0;
    const sampleOffset = cache.sampleOffsets[slot] ?? 0;
    const sampleLength = cache.sampleLengths[slot] ?? 0;
    return {
      ...descriptor,
      id: `${descriptor.id}-packed-${frameIndex}`,
      values: Array.from(cache.values.slice(offset, offset + length)),
      min: cache.fieldMins[slot] ?? 0,
      max: cache.fieldMaxes[slot] ?? 0,
      frameIndex,
      timeSeconds,
      samples: Array.from({ length: sampleLength }, (_, index) => {
        const packedIndex = sampleOffset + index;
        const pointOffset = packedIndex * 3;
        return {
          point: [
            cache.samplePoints[pointOffset] ?? 0,
            cache.samplePoints[pointOffset + 1] ?? 0,
            cache.samplePoints[pointOffset + 2] ?? 0
          ] as [number, number, number],
          normal: [
            cache.sampleNormals[pointOffset] ?? 0,
            cache.sampleNormals[pointOffset + 1] ?? 0,
            cache.sampleNormals[pointOffset + 2] ?? 0
          ] as [number, number, number],
          value: cache.sampleValues[packedIndex] ?? 0,
          vector: [
            cache.sampleVectors[pointOffset] ?? 0,
            cache.sampleVectors[pointOffset + 1] ?? 0,
            cache.sampleVectors[pointOffset + 2] ?? 0
          ] as [number, number, number]
        };
      })
    };
  });
}

function updatePackedFieldSamples(samples: FaceResultSample[], slot: NonNullable<ReturnType<typeof packedPreparedPlaybackFieldSlot>>) {
  if (!samples.length || slot.sampleLength <= 0) return;
  const owner = samples[0]!;
  if (!owner.fieldSamples || owner.fieldSamples.length !== slot.sampleLength) {
    owner.fieldSamples = Array.from({ length: slot.sampleLength }, (): FieldResultSample => ({
      point: [0, 0, 0],
      normal: [0, 1, 0],
      value: 0,
      normalized: 0.5
    }));
  }
  for (let index = 0; index < slot.sampleLength; index += 1) {
    const sample = owner.fieldSamples[index]!;
    const packedIndex = slot.sampleOffset + index;
    const pointOffset = packedIndex * 3;
    const value = slot.sampleValues[packedIndex] ?? 0;
    sample.value = value;
    sample.normalized = normalizeValueForRender(value, slot.min, slot.max);
    sample.point[0] = slot.samplePoints[pointOffset] ?? 0;
    sample.point[1] = slot.samplePoints[pointOffset + 1] ?? 0;
    sample.point[2] = slot.samplePoints[pointOffset + 2] ?? 0;
    sample.normal[0] = slot.sampleNormals[pointOffset] ?? 0;
    sample.normal[1] = slot.sampleNormals[pointOffset + 1] ?? 0;
    sample.normal[2] = slot.sampleNormals[pointOffset + 2] ?? 0;
    sample.vector = [
      slot.sampleVectors[pointOffset] ?? 0,
      slot.sampleVectors[pointOffset + 1] ?? 0,
      slot.sampleVectors[pointOffset + 2] ?? 0
    ];
  }
}

type ResultCoordinateTransform = {
  bounds?: THREE.Box3;
  toResultPoint: (point: THREE.Vector3) => THREE.Vector3;
  fromResultPoint: (point: THREE.Vector3) => THREE.Vector3;
};

type ResultValueRange = {
  min: number;
  max: number;
};

export type BeamDemoCoordinate = {
  fixedEnd: THREE.Vector3;
  beamFreeEnd: THREE.Vector3;
  beamAxis: THREE.Vector3;
  length: number;
  payloadStation: number;
  loadDirection: THREE.Vector3;
};

export function pointLoadCantileverShape(s: number, a: number): number {
  const ss = clamp01(s);
  const aa = Math.max(1e-6, Math.min(1, a));
  if (ss <= aa) {
    return ss * ss * (3 * aa - ss);
  }
  return aa * aa * (3 * ss - aa);
}

export function normalizedPointLoadCantileverShape(s: number, a: number): number {
  const aa = Math.max(1e-6, Math.min(1, a));
  const maxRaw = aa * aa * (3 - aa);
  return pointLoadCantileverShape(s, aa) / Math.max(maxRaw, 1e-9);
}

export function beamDemoStationForPoint(point: THREE.Vector3, coordinate: BeamDemoCoordinate): number {
  if (coordinate.length <= 1e-9) return 0;
  return clamp01(point.clone().sub(coordinate.fixedEnd).dot(coordinate.beamAxis) / coordinate.length);
}

export function beamDemoDisplacementAtStation(station: number, coordinate: BeamDemoCoordinate, maxDisplacement: number): THREE.Vector3 {
  const shape = normalizedPointLoadCantileverShape(station, coordinate.payloadStation);
  return coordinate.loadDirection.clone().multiplyScalar(maxDisplacement * shape);
}

export function beamDemoPayloadOffset(coordinate: BeamDemoCoordinate, maxDisplacement: number): THREE.Vector3 {
  return beamDemoDisplacementAtStation(coordinate.payloadStation, coordinate, maxDisplacement);
}

export function createBeamDemoCoordinate({
  bounds,
  samples,
  loadMarkers,
  supportMarkers
}: {
  bounds?: THREE.Box3;
  samples: FaceResultSample[];
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
}): BeamDemoCoordinate | null {
  const resolvedBounds = bounds && !bounds.isEmpty()
    ? bounds
    : new THREE.Box3(new THREE.Vector3(-1.9, 0, -BEAM_DEPTH / 2), new THREE.Vector3(1.9, BEAM_HEIGHT, BEAM_DEPTH / 2));
  const payloadPoint = averageMarkerReferencePoint(loadMarkers.filter((marker) => marker.payloadObject), samples)
    ?? averageMarkerReferencePoint(loadMarkers, samples);
  const fixedEnd = averageMarkerReferencePoint(supportMarkers, samples)
    ?? guessedBeamFixedEnd(resolvedBounds, payloadPoint);
  if (!fixedEnd) return null;
  const axisIndex = beamAxisIndex(resolvedBounds, fixedEnd, payloadPoint);
  const beamFreeEnd = farthestBeamExtentPoint(resolvedBounds, fixedEnd, axisIndex);
  const axisVector = beamFreeEnd.clone().sub(fixedEnd);
  const length = axisVector.length();
  if (!Number.isFinite(length) || length <= 1e-9) return null;
  const beamAxis = axisVector.clone().multiplyScalar(1 / length);
  const payloadStation = payloadPoint
    ? clamp01(payloadPoint.clone().sub(fixedEnd).dot(beamAxis) / length)
    : 1;
  const coordinate: BeamDemoCoordinate = {
    fixedEnd,
    beamFreeEnd,
    beamAxis,
    length,
    payloadStation,
    loadDirection: resultantLoadDirection(loadMarkers)
  };
  logBeamDemoCoordinateDebug(coordinate);
  return coordinate;
}

export function colorizeResultObject(
  object: THREE.Object3D,
  kind: SampleModelKind,
  resultMode: ResultMode,
  showDeformed: boolean,
  stressExaggeration: number,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  deformationScale?: number,
  supportMarkers: ViewerSupportMarker[] = [],
  resultFields: ResultField[] = []
) {
  object.updateMatrixWorld(true);
  const excludedPayloadObjects = resultPayloadObjectRefs(loadMarkers);
  const resultMeshes: THREE.Mesh<THREE.BufferGeometry>[] = [];
  const payloadMeshes: THREE.Mesh<THREE.BufferGeometry>[] = [];
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return;
    if (isResultPayloadObject(child, excludedPayloadObjects)) {
      child.visible = true;
      child.material = new THREE.MeshStandardMaterial({
        color: RESULT_PAYLOAD_MATERIAL_COLOR,
        metalness: 0.14,
        roughness: 0.58,
        side: THREE.DoubleSide
      });
      payloadMeshes.push(child as THREE.Mesh<THREE.BufferGeometry>);
      return;
    }
    child.visible = true;
    resultMeshes.push(child as THREE.Mesh<THREE.BufferGeometry>);
  });
  const bounds = resultBoundsForMeshes(resultMeshes);
  const values = resultMeshes.flatMap((mesh) => resultValuesForMesh(mesh, kind, resultMode, stressExaggeration, samples));
  const valueRange = resultValueRange(values, samples);
  for (const child of resultMeshes) {
    const toResultMatrix = child.matrixWorld.clone();
    const fromResultMatrix = toResultMatrix.clone().invert();
    colorizeResultGeometry(child.geometry, kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, {
      bounds,
      toResultPoint: (point) => point.clone().applyMatrix4(toResultMatrix),
      fromResultPoint: (point) => point.clone().applyMatrix4(fromResultMatrix)
    }, valueRange, supportMarkers, resultFields);
    child.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.18,
      roughness: 0.52,
      side: THREE.DoubleSide
    });
  }
  const displacementField = displacementFieldForResults(resultFields);
  const visualScale = showDeformed
    ? visualScaleForDisplacementField((bounds?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1)).length(), displacementField, deformationScale ?? 1)
    : 0;
  for (const payloadMesh of payloadMeshes) {
    translatePayloadObjectForDeformedResult(payloadMesh, loadMarkers, displacementField, visualScale, samples);
  }
  return object;
}

function translatePayloadObjectForDeformedResult(
  object: THREE.Object3D,
  loadMarkers: ViewerLoadMarker[],
  displacementField: ResultField | undefined,
  visualScale: number,
  samples: FaceResultSample[]
) {
  const basePosition = baseObjectPositionForResult(object);
  object.position.copy(basePosition);
  if (!displacementField || visualScale <= 0) return;
  const attachment = payloadAttachmentPoint(object, loadMarkers, samples);
  if (!attachment) return;
  const displacement = new THREE.Vector3(...interpolateDisplacementAtPoint(attachment, displacementField)).multiplyScalar(visualScale);
  if (displacement.lengthSq() <= 1e-18) return;
  object.position.add(parentLocalVector(object, displacement));
  object.updateMatrixWorld(true);
}

function baseObjectPositionForResult(object: THREE.Object3D): THREE.Vector3 {
  const existing = object.userData.opencaeResultBasePosition;
  if (existing instanceof THREE.Vector3) return existing;
  const base = object.position.clone();
  object.userData.opencaeResultBasePosition = base;
  return base;
}

function payloadAttachmentPoint(object: THREE.Object3D, loadMarkers: ViewerLoadMarker[], samples: FaceResultSample[]): [number, number, number] | null {
  const marker = loadMarkers.find((candidate) => candidate.payloadObject && isResultPayloadObject(object, resultPayloadObjectRefs([candidate])));
  const point = marker?.payloadObject?.center ?? marker?.point ?? (marker ? markerCenter(marker.faceId, samples)?.toArray() : undefined);
  return point && point.every(Number.isFinite) ? point as [number, number, number] : null;
}

function parentLocalVector(object: THREE.Object3D, vector: THREE.Vector3): THREE.Vector3 {
  const parent = object.parent;
  if (!parent) return vector;
  parent.updateMatrixWorld(true);
  const localOrigin = parent.worldToLocal(new THREE.Vector3(0, 0, 0));
  const localTip = parent.worldToLocal(vector.clone());
  return localTip.sub(localOrigin);
}

function resultPayloadOffsetForFields(
  attachmentPoint: [number, number, number],
  geometry: THREE.BufferGeometry,
  resultFields: ResultField[],
  showDeformed: boolean,
  deformationScale: number
): [number, number, number] {
  if (!showDeformed) return [0, 0, 0];
  const displacementField = displacementFieldForResults(resultFields);
  if (!displacementField) return [0, 0, 0];
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) return [0, 0, 0];
  const basePositions = basePositionArrayForGeometry(geometry, position);
  const modelExtent = basePositionBoundsForGeometry(geometry, basePositions).getSize(new THREE.Vector3()).length();
  const visualScale = visualScaleForDisplacementField(modelExtent, displacementField, deformationScale);
  if (visualScale <= 0) return [0, 0, 0];
  const displacement = interpolateDisplacementAtPoint(attachmentPoint, displacementField);
  return [
    displacement[0] * visualScale,
    displacement[1] * visualScale,
    displacement[2] * visualScale
  ];
}

function displacementFieldForResults(fields: ResultField[]): ResultField | undefined {
  return fields.find((field) => field.type === "displacement" && field.samples?.some((sample) => sample.vector?.every(Number.isFinite)));
}

type ResultPayloadObjectRefs = {
  ids: Set<string>;
  labels: Set<string>;
};

function resultPayloadObjectRefs(loadMarkers: ViewerLoadMarker[]): ResultPayloadObjectRefs {
  const refs: ResultPayloadObjectRefs = { ids: new Set(), labels: new Set() };
  for (const marker of loadMarkers) {
    addResultPayloadRef(refs.ids, marker.payloadObject?.id);
    addResultPayloadRef(refs.labels, marker.payloadObject?.label);
  }
  return refs;
}

function resultPayloadOffsetForBeamDemo(
  geometry: THREE.BufferGeometry,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  supportMarkers: ViewerSupportMarker[],
  resultFields: ResultField[],
  showDeformed: boolean,
  stressExaggeration: number,
  deformationScale: number
): [number, number, number] | null {
  if (!showDeformed || !shouldUseBeamDemoPayloadFallback("plate", loadMarkers, resultFields)) return null;
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) return null;
  const basePositions = basePositionArrayForGeometry(geometry, position);
  const bounds = basePositionBoundsForGeometry(geometry, basePositions);
  const coordinate = createBeamDemoCoordinate({ bounds, samples, loadMarkers, supportMarkers });
  if (!coordinate) return null;
  const maxDisplacement = beamDemoMaxDisplacementForLoads(stressExaggeration, loadMarkers, deformationScale, true);
  return beamDemoPayloadOffset(coordinate, maxDisplacement).toArray() as [number, number, number];
}

function shouldUseBeamDemoPayloadFallback(kind: SampleModelKind, loadMarkers: ViewerLoadMarker[], resultFields: ResultField[]) {
  void kind;
  void loadMarkers;
  void resultFields;
  return false;
}

function isResultPayloadObject(object: THREE.Object3D, refs: ResultPayloadObjectRefs) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (refs.ids.has(normalizedResultPayloadRef(current.userData.opencaeObjectId))) return true;
    if (refs.labels.has(normalizedResultPayloadRef(current.userData.opencaeObjectLabel))) return true;
    current = current.parent;
  }
  return false;
}

function addResultPayloadRef(refs: Set<string>, value: unknown) {
  const normalized = normalizedResultPayloadRef(value);
  if (normalized) refs.add(normalized);
}

function normalizedResultPayloadRef(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resultBoundsForMeshes(meshes: THREE.Mesh<THREE.BufferGeometry>[]) {
  const bounds = new THREE.Box3();
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    bounds.expandByObject(mesh);
  }
  return bounds.isEmpty() ? undefined : bounds;
}

function resultValuesForMesh(
  mesh: THREE.Mesh<THREE.BufferGeometry>,
  kind: SampleModelKind,
  resultMode: ResultMode,
  stressExaggeration: number,
  samples: FaceResultSample[]
) {
  const values: number[] = [];
  const positions = mesh.geometry.getAttribute("position");
  const toResultMatrix = mesh.matrixWorld;
  for (let index = 0; index < positions.count; index += 1) {
    const point = new THREE.Vector3(positions.getX(index), positions.getY(index), positions.getZ(index)).applyMatrix4(toResultMatrix);
    values.push(resultValueForPoint(kind, resultMode, stressExaggeration, point, samples));
  }
  return values;
}

function resultValueRange(values: number[], samples: FaceResultSample[] = []): ResultValueRange {
  if (hasSolvedResultSamples(samples)) return { min: 0, max: 1 };
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return { min: 0, max: 1 };
  return {
    min: Math.min(...finiteValues),
    max: Math.max(...finiteValues)
  };
}

function hasSolvedResultSamples(samples: FaceResultSample[]) {
  return samples.some((sample) => Number.isFinite(sample.normalized) || Boolean(sample.fieldSamples?.length));
}

function normalizeResultValue(value: number, range: ResultValueRange) {
  const span = range.max - range.min;
  if (!Number.isFinite(value) || !Number.isFinite(span) || Math.abs(span) < 1e-12) return 0;
  return Math.max(0, Math.min(1, (value - range.min) / span));
}

export function deformationScaleForResultFields(fields: ResultField[]): number | undefined {
  const displacementField = fields.find((field) => field.type === "displacement" && field.location === "face")
    ?? fields.find((field) => field.type === "displacement");
  if (!displacementField) return undefined;
  return resultFieldAbsMax(displacementField) > 0 ? 1 : 0;
}

function deformationScaleForSamples(resultMode: ResultMode, samples: FaceResultSample[]) {
  if (resultMode !== "displacement") return 1;
  return deformationScaleForMagnitude(Math.max(0, ...samples.map((sample) => Math.abs(sample.value))), "mm");
}

function resultFieldAbsMax(field: ResultField) {
  const activeValues = [
    Math.abs(Number(field.min) || 0),
    Math.abs(Number(field.max) || 0),
    ...field.values.map((value) => Math.abs(value)).filter(Number.isFinite),
    ...(field.samples?.map((sample) => Math.abs(sample.value)).filter(Number.isFinite) ?? [])
  ].filter(Number.isFinite);
  return activeValues.length ? Math.max(...activeValues) : 0;
}

function deformationScaleForMagnitude(magnitude: number, units: string) {
  if (!Number.isFinite(magnitude) || Math.abs(magnitude) <= 1e-9) return 0;
  const reference = units === "in" ? DEFAULT_DEFORMATION_REFERENCE_MM / 25.4 : DEFAULT_DEFORMATION_REFERENCE_MM;
  return Math.sign(magnitude) * Math.min(MAX_RESULT_DEFORMATION_SCALE, Math.abs(magnitude) / reference);
}

function deformedPointForResults(
  kind: SampleModelKind,
  point: THREE.Vector3,
  stressExaggeration: number,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  deformationScale: number,
  usesResultDeformationScale: boolean,
  bounds?: THREE.Box3,
  supportMarkers: ViewerSupportMarker[] = []
) {
  if (Math.abs(deformationScale) <= 1e-9) return point.clone();
  if (kind === "uploaded") return deformedUploadedPoint(point, stressExaggeration, samples, loadMarkers, supportMarkers, deformationScale, usesResultDeformationScale, bounds);
  const constrained = deformedPointFromSupportToLoad(point, samples, loadMarkers, supportMarkers, deformationScale, usesResultDeformationScale, stressExaggeration);
  if (constrained) return constrained;
  if (!loadMarkers.length) return deformedPointForKind(kind, point, stressExaggeration, deformationScale);
  const next = point.clone();
  const span = resultSampleSpan(samples);
  const scale = 0.045 + Math.max(0, stressExaggeration - 1) * 0.075;
  const deformation = new THREE.Vector3();
  for (const marker of loadMarkers) {
    const sample = samples.find((item) => item.face.id === marker.faceId);
    if (!sample) continue;
    const direction = markerDirectionInModelSpace(marker);
    const radius = Math.max(span * 0.48, 0.001);
    const weight = Math.exp(-0.5 * squaredDistanceToPointArray(point, sample.face.center) / (radius * radius));
    const magnitude = usesResultDeformationScale ? 1 : Math.max(0.35, marker.value / 500);
    deformation.addScaledVector(direction, weight * scale * magnitude * deformationScale);
  }
  return next.add(deformation);
}

function deformedPointFromSupportToLoad(
  point: THREE.Vector3,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  supportMarkers: ViewerSupportMarker[],
  deformationScale: number,
  usesResultDeformationScale: boolean,
  stressExaggeration: number
) {
  const supportCenters = markerCenters(supportMarkers, samples);
  const loadCenters = markerCenters(loadMarkers, samples);
  if (!supportCenters.length || !loadCenters.length) return null;
  const supportCenter = averageVector(supportCenters);
  const deformation = new THREE.Vector3();
  const scale = 0.045 + Math.max(0, stressExaggeration - 1) * 0.075;
  for (const marker of loadMarkers) {
    const loadCenter = markerCenter(marker.faceId, samples) ?? averageVector(loadCenters);
    const span = loadCenter.clone().sub(supportCenter);
    const spanLengthSq = Math.max(span.lengthSq(), 1e-9);
    const travel = Math.max(0, Math.min(1, point.clone().sub(supportCenter).dot(span) / spanLengthSq));
    const beamShape = cantileverDisplacementShape(travel);
    const magnitude = usesResultDeformationScale ? 1 : Math.max(0.35, marker.value / 500);
    deformation.addScaledVector(markerDirectionInModelSpace(marker), beamShape * scale * magnitude * deformationScale / Math.max(loadMarkers.length, 1));
  }
  return point.clone().add(deformation);
}

function deformedUploadedPoint(
  point: THREE.Vector3,
  stressExaggeration: number,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  supportMarkers: ViewerSupportMarker[],
  deformationScale: number,
  usesResultDeformationScale: boolean,
  bounds?: THREE.Box3
) {
  const next = point.clone();
  const size = bounds?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(2.4, 2.4, 2.4);
  const maxDimension = Math.max(size.x, size.y, size.z, 1);
  const magnitude = usesResultDeformationScale ? 1 : loadMarkers.length
    ? loadMarkers.reduce((total, marker) => total + Math.max(0.25, marker.value / 500), 0) / loadMarkers.length
    : 1;
  const scale = maxDimension * (0.012 + Math.max(0, stressExaggeration - 1) * 0.012) * magnitude * deformationScale;
  const supportCenters = markerCenters(supportMarkers, samples);
  const loadCenters = markerCenters(loadMarkers, samples);
  if (supportCenters.length && loadCenters.length) {
    const supportCenter = averageVector(supportCenters);
    const deformation = new THREE.Vector3();
    for (const marker of loadMarkers) {
      const loadCenter = markerCenter(marker.faceId, samples) ?? averageVector(loadCenters);
      const span = loadCenter.clone().sub(supportCenter);
      const spanLengthSq = Math.max(span.lengthSq(), 1e-9);
      const travel = Math.max(0, Math.min(1, point.clone().sub(supportCenter).dot(span) / spanLengthSq));
      const beamShape = cantileverDisplacementShape(travel);
      deformation.addScaledVector(markerDirectionInModelSpace(marker), beamShape * scale / Math.max(loadMarkers.length, 1));
    }
    return next.add(deformation);
  }
  return next.addScaledVector(resultantLoadDirection(loadMarkers), scale);
}

function markerCenters(markers: Array<{ faceId: string }>, samples: FaceResultSample[]) {
  return markers.map((marker) => markerCenter(marker.faceId, samples)).filter((center): center is THREE.Vector3 => Boolean(center));
}

function markerCenter(faceId: string, samples: FaceResultSample[]) {
  const sample = samples.find((candidate) => candidate.face.id === faceId);
  return sample ? new THREE.Vector3(...sample.face.center) : null;
}

function averageMarkerReferencePoint(
  markers: Array<{ faceId: string; point?: [number, number, number]; payloadObject?: PayloadObjectSelection }>,
  samples: FaceResultSample[]
) {
  const points = markers
    .map((marker) => markerReferencePoint(marker, samples))
    .filter((point): point is THREE.Vector3 => Boolean(point));
  return points.length ? averageVector(points) : null;
}

function markerReferencePoint(
  marker: { faceId: string; point?: [number, number, number]; payloadObject?: PayloadObjectSelection },
  samples: FaceResultSample[]
) {
  const point = marker.payloadObject?.center ?? marker.point;
  if (point?.every(Number.isFinite)) return new THREE.Vector3(...point);
  return markerCenter(marker.faceId, samples);
}

function guessedBeamFixedEnd(bounds: THREE.Box3, payloadPoint: THREE.Vector3 | null) {
  const size = bounds.getSize(new THREE.Vector3());
  const axisIndex = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const min = bounds.min.getComponent(axisIndex);
  const max = bounds.max.getComponent(axisIndex);
  const center = bounds.getCenter(new THREE.Vector3());
  const fixed = center.clone();
  const payloadCoordinate = payloadPoint?.getComponent(axisIndex) ?? min;
  fixed.setComponent(axisIndex, Math.abs(payloadCoordinate - min) > Math.abs(payloadCoordinate - max) ? min : max);
  return fixed;
}

function beamAxisIndex(bounds: THREE.Box3, fixedEnd: THREE.Vector3, payloadPoint: THREE.Vector3 | null) {
  const size = bounds.getSize(new THREE.Vector3());
  const geometryAxis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  if (!payloadPoint) return geometryAxis;
  const delta = payloadPoint.clone().sub(fixedEnd);
  const loadAxis = Math.abs(delta.x) >= Math.abs(delta.y) && Math.abs(delta.x) >= Math.abs(delta.z)
    ? 0
    : Math.abs(delta.y) >= Math.abs(delta.z)
      ? 1
      : 2;
  return size.getComponent(loadAxis) >= size.getComponent(geometryAxis) * 0.5 ? loadAxis : geometryAxis;
}

function farthestBeamExtentPoint(bounds: THREE.Box3, fixedEnd: THREE.Vector3, axisIndex: number) {
  const min = bounds.min.getComponent(axisIndex);
  const max = bounds.max.getComponent(axisIndex);
  const fixedCoordinate = fixedEnd.getComponent(axisIndex);
  const freeCoordinate = Math.abs(fixedCoordinate - min) >= Math.abs(fixedCoordinate - max) ? min : max;
  return fixedEnd.clone().setComponent(axisIndex, freeCoordinate);
}

const loggedBeamDemoCoordinateDebug = new Set<string>();

function logBeamDemoCoordinateDebug(coordinate: BeamDemoCoordinate) {
  if (!DEBUG_RESULTS) return;
  const key = [
    coordinate.fixedEnd.toArray().map((value) => value.toFixed(3)).join(","),
    coordinate.beamFreeEnd.toArray().map((value) => value.toFixed(3)).join(","),
    coordinate.payloadStation.toFixed(3)
  ].join("|");
  if (loggedBeamDemoCoordinateDebug.has(key)) return;
  loggedBeamDemoCoordinateDebug.add(key);
  const stations = Array.from({ length: 10 }, (_item, index) => index / 9);
  console.debug("[OpenCAE results] beam demo coordinate", {
    fixedEnd: coordinate.fixedEnd.toArray(),
    beamFreeEnd: coordinate.beamFreeEnd.toArray(),
    beamAxis: coordinate.beamAxis.toArray(),
    payloadStation: coordinate.payloadStation,
    loadDirection: coordinate.loadDirection.toArray(),
    stations,
    displacementMagnitudes: stations.map((station) => normalizedPointLoadCantileverShape(station, coordinate.payloadStation))
  });
}

function averageVector(points: THREE.Vector3[]) {
  const average = new THREE.Vector3();
  for (const point of points) average.add(point);
  return average.multiplyScalar(1 / Math.max(points.length, 1));
}

function resultantLoadDirection(loadMarkers: ViewerLoadMarker[]) {
  const direction = new THREE.Vector3();
  for (const marker of loadMarkers) {
    direction.add(markerDirectionInModelSpace(marker));
  }
  if (direction.lengthSq() < 0.0001) return new THREE.Vector3(0, 0, -1);
  return direction.normalize();
}

function cantileverDisplacementShape(travel: number) {
  const s = clamp01(travel);
  return 0.5 * s * s * (3 - s);
}

function deformedBeamDemoPayloadPoint(point: THREE.Vector3, coordinate: BeamDemoCoordinate, maxDisplacement: number) {
  const station = beamDemoStationForPoint(point, coordinate);
  return point.clone().add(beamDemoDisplacementAtStation(station, coordinate, maxDisplacement));
}

function beamDemoMaxDisplacementForLoads(
  stressExaggeration: number,
  loadMarkers: ViewerLoadMarker[],
  deformationScale: number,
  usesResultDeformationScale: boolean
) {
  const scale = 0.045 + Math.max(0, stressExaggeration - 1) * 0.075;
  const magnitude = usesResultDeformationScale ? 1 : loadMarkers.length
    ? loadMarkers.reduce((total, marker) => total + Math.max(0.35, marker.value / 500), 0) / loadMarkers.length
    : 1;
  return scale * magnitude * deformationScale;
}

function beamDemoFallbackValueForPoint(resultMode: ResultMode, point: THREE.Vector3, coordinate: BeamDemoCoordinate) {
  const station = beamDemoStationForPoint(point, coordinate);
  const displacement = normalizedPointLoadCantileverShape(station, coordinate.payloadStation);
  if (resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration") return displacement;
  const stress = beamDemoPayloadStressFraction(point, coordinate);
  if (resultMode === "safety_factor") return clamp01(1 - stress * 0.88);
  return stress;
}

function beamDemoPayloadStressFraction(point: THREE.Vector3, coordinate: BeamDemoCoordinate) {
  const station = beamDemoStationForPoint(point, coordinate);
  const payloadStation = Math.max(coordinate.payloadStation, 1e-6);
  const momentFactor = Math.max(payloadStation - station, 0) / payloadStation;
  const fiberY = clamp01(Math.abs(point.y - BEAM_CENTER_Y) / Math.max(BEAM_HEIGHT / 2, 1e-6));
  const fiberZ = clamp01(Math.abs(point.z) / Math.max(BEAM_DEPTH / 2, 1e-6));
  const fiberFactor = 0.36 + Math.max(fiberY, fiberZ) * 0.64;
  const bendingStress = 0.08 + 0.82 * momentFactor * fiberFactor;
  const contactWidth = 0.075;
  const contactStress = 0.25 * Math.exp(-0.5 * ((station - coordinate.payloadStation) / contactWidth) ** 2);
  return clamp01(Math.max(bendingStress, contactStress));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function deformedPointForKind(kind: SampleModelKind, point: THREE.Vector3, stressExaggeration: number, deformationScale: number) {
  const next = point.clone();
  const scale = (0.08 + Math.max(0, stressExaggeration - 1) * 0.12) * deformationScale;
  if (kind === "plate") {
    const span = Math.max(0, Math.min(1, (point.x + 1.9) / 3.8));
    next.y -= scale * 0.9 * cantileverDisplacementShape(span);
    next.z += scale * 0.22 * span * (point.z >= 0 ? 1 : -1);
  } else if (kind === "cantilever") {
    const span = Math.max(0, Math.min(1, (point.x + 1.9) / 3.8));
    next.y -= scale * 1.15 * cantileverDisplacementShape(span);
    next.z += scale * 0.28 * span * (point.z >= 0 ? 1 : -1);
  }
  return next;
}

function resultColorForPoint(kind: SampleModelKind, resultMode: ResultMode, stressExaggeration: number, point: THREE.Vector3, samples: FaceResultSample[]) {
  return resultColorForValue(resultMode, resultValueForPoint(kind, resultMode, stressExaggeration, point, samples));
}

export function resultValueForPoint(kind: SampleModelKind, resultMode: ResultMode, stressExaggeration: number, point: THREE.Vector3, samples: FaceResultSample[]) {
  const fieldSampleValue = resultFractionFromFieldSamples(point, samples);
  const sampleValue = fieldSampleValue ?? resultFractionFromSamples(point, samples);
  if (sampleValue !== null) return Math.max(0, Math.min(1, sampleValue));
  const stress = kind === "cantilever" ? cantileverBendingStressFraction(point) : stressFractionForPoint(kind, point);
  const displacement = displacementFractionForPoint(kind, point);
  return resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration"
    ? displacement
    : resultMode === "safety_factor"
      ? kind === "cantilever" ? Math.max(0, Math.min(1, 1 - stress * 0.88)) : sampleValue ?? (1 - stress * 0.88)
      : Math.max(0, Math.min(1, 0.5 + (stress - 0.5) * stressExaggeration));
}

function resultColorForValue(resultMode: ResultMode, t: number) {
  return new THREE.Color(interpolatedPaletteColor(resultPalette(resultMode).body, t));
}

function resultFractionFromSamples(point: THREE.Vector3, samples: FaceResultSample[]): number | null {
  if (!samples.length) return null;
  const span = resultSampleSpan(samples);
  let weighted = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const radius = Math.max(span * 0.28, 0.001);
    const weight = Math.exp(-0.5 * squaredDistanceToPointArray(point, sample.face.center) / (radius * radius)) + 0.015;
    weighted += sample.normalized * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.max(0, Math.min(1, weighted / totalWeight)) : null;
}

function resultFractionFromFieldSamples(point: THREE.Vector3, samples: FaceResultSample[]): number | null {
  const fieldSamples = samples.find((sample) => sample.fieldSamples?.length)?.fieldSamples;
  if (!fieldSamples?.length) return null;
  const span = resultFieldSampleSpan(fieldSamples);
  let weighted = 0;
  let totalWeight = 0;
  for (const sample of fieldSamples) {
    const radius = Math.max(span * 0.055, 0.001);
    const weight = Math.exp(-0.5 * squaredDistanceToPointArray(point, sample.point) / (radius * radius));
    weighted += sample.normalized * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 1e-9) {
    const nearest = fieldSamples.reduce<typeof fieldSamples[number] | undefined>((best, sample) => {
      if (!best) return sample;
      return squaredDistanceToPointArray(point, sample.point) < squaredDistanceToPointArray(point, best.point) ? sample : best;
    }, undefined);
    return nearest?.normalized ?? null;
  }
  return Math.max(0, Math.min(1, weighted / totalWeight));
}

function resultFieldSampleSpan(samples: NonNullable<FaceResultSample["fieldSamples"]>): number {
  const bounds = new THREE.Box3();
  for (const sample of samples) bounds.expandByPoint(new THREE.Vector3(...sample.point));
  const size = bounds.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z, 1);
}

function resultSampleSpan(samples: FaceResultSample[]): number {
  const bounds = new THREE.Box3();
  for (const sample of samples) bounds.expandByPoint(new THREE.Vector3(...sample.face.center));
  const size = bounds.getSize(new THREE.Vector3());
  return Math.max(size.length(), 1);
}

function squaredDistanceToPointArray(point: THREE.Vector3, target: [number, number, number]) {
  const dx = point.x - target[0];
  const dy = point.y - target[1];
  const dz = point.z - target[2];
  return dx * dx + dy * dy + dz * dz;
}

function stressFractionForPoint(kind: SampleModelKind, point: THREE.Vector3) {
  if (kind === "plate") {
    const fixedEnd = gaussian2d(point.x, point.y, -1.9, 0.14, 0.38, 0.36);
    const topFiber = gaussian2d(point.x, point.y, -0.55, 0.36, 1.35, 0.16);
    const payload = gaussian2d(point.x, point.y, BEAM_PAYLOAD_CENTER[0], BEAM_PAYLOAD_CENTER[1], 0.44, 0.3);
    return Math.max(0, Math.min(1, 0.08 + fixedEnd * 0.74 + topFiber * 0.3 + payload * 0.16));
  }
  if (kind === "cantilever") {
    return cantileverBendingStressFraction(point);
  }
  return 0.45;
}

function cantileverBendingStressFraction(point: THREE.Vector3) {
  const travel = Math.max(0, Math.min(1, (point.x + 1.9) / 3.8));
  const moment = (1 - travel) ** 0.85;
  const fiberY = Math.max(0, Math.min(1, Math.abs(point.y - BEAM_CENTER_Y) / (BEAM_HEIGHT / 2)));
  const fiberZ = Math.max(0, Math.min(1, Math.abs(point.z) / (BEAM_DEPTH / 2)));
  const fiber = 0.3 + Math.max(fiberY, fiberZ) * 0.7;
  const fixedRoot = gaussian2d(point.x, point.y, -1.9, BEAM_CENTER_Y, 0.32, 0.34);
  const banding = 0.035 * Math.sin((1 - travel) * Math.PI * 5) * moment;
  const localLoad = gaussian2d(point.x, point.y, 1.9, BEAM_CENTER_Y, 0.38, 0.34) * 0.06;
  return Math.max(0, Math.min(1, 0.08 + moment * (0.66 * fiber + 0.16) + fixedRoot * 0.18 + banding + localLoad));
}

function displacementFractionForPoint(kind: SampleModelKind, point: THREE.Vector3) {
  if (kind === "plate") return Math.max(0, Math.min(1, 0.08 + ((point.x + 1.9) / 3.8) * 0.84));
  if (kind === "cantilever") return Math.max(0, Math.min(1, 0.05 + ((point.x + 1.9) / 3.8) * 0.9));
  return 0.45;
}

function gaussian2d(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

function SmoothBracketBody({ resultMode, showDeformed, stressExaggeration }: { resultMode: ResultMode; showDeformed: boolean; stressExaggeration: number }) {
  const bodyGeometry = useMemo(() => createBracketBodyGeometry(), []);
  const ribGeometry = useMemo(() => createRibGeometry(), []);
  return (
    <group>
      <mesh>
        <primitive attach="geometry" object={bodyGeometry} />
        <ResultMaterial resultMode={resultMode} part="body" showDeformed={showDeformed} stressExaggeration={stressExaggeration} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
      <mesh>
        <primitive attach="geometry" object={ribGeometry} />
        <ResultMaterial resultMode={resultMode} part="rib" showDeformed={showDeformed} stressExaggeration={stressExaggeration} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
    </group>
  );
}

function ResultMaterial({ resultMode, part, showDeformed, stressExaggeration }: { resultMode: ResultMode; part: "body" | "rib"; showDeformed: boolean; stressExaggeration: number }) {
  const mode = resultMode === "stress" ? 0 : resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration" ? 1 : 2;
  const partValue = part === "body" ? 0 : 1;
  const uniforms = useMemo(
    () => ({
      uMode: { value: mode },
      uPart: { value: partValue },
      uShowDeformed: { value: showDeformed ? 1 : 0 },
      uStressExaggeration: { value: stressExaggeration }
    }),
    [mode, partValue, showDeformed, stressExaggeration]
  );

  return (
    <shaderMaterial
      key={`${part}-${resultMode}-${showDeformed}-${stressExaggeration}`}
      uniforms={uniforms}
      vertexShader={RESULT_VERTEX_SHADER}
      fragmentShader={RESULT_FRAGMENT_SHADER}
      side={THREE.DoubleSide}
    />
  );
}

const RESULT_VERTEX_SHADER = `
  varying vec3 vLocalPosition;
  varying vec3 vNormal;
  uniform int uShowDeformed;
  uniform float uStressExaggeration;

  float bracketSpan(vec3 p) {
    return clamp((p.x + 1.55) / 3.90, 0.0, 1.0);
  }

  void main() {
    vec3 deformed = position;
    if (uShowDeformed == 1) {
      float scale = 0.07 + max(uStressExaggeration - 1.0, 0.0) * 0.10;
      float upright = smoothstep(0.20, 2.62, position.y) * (1.0 - bracketSpan(position) * 0.35);
      float base = bracketSpan(position);
      deformed.y -= scale * (upright * upright + base * base * 0.55);
      deformed.x += scale * 0.22 * upright;
      deformed.z += scale * 0.28 * (position.z >= 0.0 ? 1.0 : -1.0) * max(upright, base * 0.55);
    }
    vLocalPosition = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(deformed, 1.0);
  }
`;

const RESULT_FRAGMENT_SHADER = `
  precision highp float;

  uniform int uMode;
  uniform int uPart;
  uniform float uStressExaggeration;
  varying vec3 vLocalPosition;
  varying vec3 vNormal;

  float gaussian2d(vec2 value, vec2 center, vec2 radius) {
    vec2 d = (value - center) / radius;
    return exp(-0.5 * dot(d, d));
  }

  float gaussian1d(float value, float center, float radius) {
    float d = (value - center) / radius;
    return exp(-0.5 * d * d);
  }

  float stressFraction(vec3 p) {
    if (uPart == 1) {
      float upperJoint = gaussian2d(p.xy, vec2(-0.74, 1.35), vec2(0.34, 0.38));
      float lowerToe = gaussian2d(p.xy, vec2(-0.24, 0.34), vec2(0.42, 0.18));
      float centerWeb = gaussian2d(p.xy, vec2(-0.34, 0.86), vec2(0.70, 0.55));
      float frontFace = 0.04 * gaussian1d(p.z, 0.19, 0.18);
      return clamp(0.04 + upperJoint * 0.50 + lowerToe * 0.40 + centerWeb * 0.22 + frontFace, 0.0, 1.0);
    }

    float loadHotSpot = gaussian2d(p.xy, vec2(-1.12, 2.50), vec2(0.28, 0.34));
    float innerCorner = gaussian2d(p.xy, vec2(-0.78, 0.28), vec2(0.44, 0.32));
    float uprightBending = gaussian2d(p.xy, vec2(-1.10, 1.55), vec2(0.34, 0.84));
    float supportLeft = gaussian2d(p.xy, vec2(0.24, 0.0), vec2(0.25, 0.22));
    float supportRight = gaussian2d(p.xy, vec2(1.20, 0.0), vec2(0.28, 0.22));
    float frontFace = 0.05 * gaussian1d(p.z, 0.55, 0.20);
    float freeBaseEnd = gaussian2d(p.xy, vec2(2.25, 0.0), vec2(0.28, 0.26));
    float stress = loadHotSpot * 0.92 + innerCorner * 0.48 + uprightBending * 0.26 + supportLeft * 0.24 + supportRight * 0.18 + frontFace;
    return clamp(stress - freeBaseEnd * 0.10, 0.0, 1.0);
  }

  float stressMpa(vec3 p) {
    return mix(28.0, 142.0, stressFraction(p));
  }

  float stressDisplayFraction(vec3 p) {
    float normalized = stressFraction(p);
    return clamp(0.5 + (normalized - 0.5) * uStressExaggeration, 0.0, 1.0);
  }

  vec3 resultPalette(float t) {
    if (uMode == 2) {
      vec3 s0 = vec3(0.92, 0.18, 0.24);
      vec3 s1 = vec3(0.96, 0.48, 0.20);
      vec3 s2 = vec3(0.92, 0.82, 0.23);
      vec3 s3 = vec3(0.64, 0.90, 0.21);
      vec3 s4 = vec3(0.29, 0.82, 0.45);
      vec3 s5 = vec3(0.13, 0.77, 0.37);
      float safeX = clamp(t, 0.0, 1.0) * 5.0;
      if (safeX < 1.0) return mix(s0, s1, safeX);
      if (safeX < 2.0) return mix(s1, s2, safeX - 1.0);
      if (safeX < 3.0) return mix(s2, s3, safeX - 2.0);
      if (safeX < 4.0) return mix(s3, s4, safeX - 3.0);
      return mix(s4, s5, safeX - 4.0);
    }

    vec3 c0 = vec3(0.04, 0.33, 0.78);
    vec3 c1 = vec3(0.06, 0.70, 0.88);
    vec3 c2 = vec3(0.20, 0.78, 0.42);
    vec3 c3 = vec3(0.92, 0.82, 0.23);
    vec3 c4 = vec3(0.96, 0.48, 0.20);
    vec3 c5 = vec3(0.92, 0.18, 0.24);
    float x = clamp(t, 0.0, 1.0) * 5.0;
    if (x < 1.0) return mix(c0, c1, x);
    if (x < 2.0) return mix(c1, c2, x - 1.0);
    if (x < 3.0) return mix(c2, c3, x - 2.0);
    if (x < 4.0) return mix(c3, c4, x - 3.0);
    return mix(c4, c5, x - 4.0);
  }

  void main() {
    float t;
    if (uMode == 1) {
      float topTravel = clamp((vLocalPosition.y + 0.24) / 2.86, 0.0, 1.0);
      float cantileverTravel = clamp((vLocalPosition.x + 1.55) / 3.9, 0.0, 1.0);
      t = clamp(0.12 + topTravel * 0.55 + cantileverTravel * 0.22, 0.0, 1.0);
    } else {
      t = uMode == 2 ? clamp(1.0 - stressFraction(vLocalPosition) * 0.88, 0.0, 1.0) : stressDisplayFraction(vLocalPosition);
    }

    vec3 color = resultPalette(t);
    float light = 0.72 + 0.28 * clamp(dot(normalize(vNormal), normalize(vec3(0.35, 0.65, 0.45))), 0.0, 1.0);
    gl_FragColor = vec4(color * light, 0.96);
  }
`;

function createBracketBodyGeometry() {
  const geometry = new THREE.ExtrudeGeometry(createBracketShape(), {
    depth: BRACKET_DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 56
  });
  geometry.translate(0, 0, -BRACKET_DEPTH / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function createBracketShape() {
  const shape = new THREE.Shape();
  const points: Array<[number, number]> = [
    [-1.55, -0.24],
    [2.35, -0.24],
    [2.35, 0.24],
    [-0.78, 0.24],
    [-0.78, 2.62],
    [-1.55, 2.62]
  ];

  const firstPoint = points[0] ?? [-1.55, -0.24];
  const remainingPoints = points.slice(1);
  shape.moveTo(firstPoint[0], firstPoint[1]);
  for (const [x, y] of remainingPoints) {
    shape.lineTo(x, y);
  }
  shape.closePath();

  for (const hole of BRACKET_HOLES) {
    const path = new THREE.Path();
    path.absellipse(hole.center[0], hole.center[1], hole.radius, hole.radius, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }

  return shape;
}

function createBeamGeometry() {
  const geometry = new THREE.BoxGeometry(3.8, BEAM_HEIGHT, BEAM_DEPTH, 64, 6, 8);
  geometry.translate(0, BEAM_CENTER_Y, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function createBeamPayloadGeometry() {
  const geometry = new THREE.BoxGeometry(0.58, BEAM_PAYLOAD_HEIGHT, 0.5, 8, 6, 8);
  geometry.translate(...BEAM_PAYLOAD_CENTER);
  geometry.computeVertexNormals();
  return geometry;
}

function createRibGeometry() {
  const geometry = new THREE.ExtrudeGeometry(createRibShape(), {
    depth: RIB_DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.01,
    bevelSize: 0.01,
    bevelSegments: 2,
    curveSegments: 8
  });
  geometry.translate(0, 0, -RIB_DEPTH / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function createRibShape() {
  const shape = new THREE.Shape();
  const points: Array<[number, number]> = [
    [-0.78, 0.24],
    [0.5, 0.24],
    [-0.78, 1.52]
  ];
  const firstPoint = points[0] ?? [-0.78, 0.24];
  shape.moveTo(firstPoint[0], firstPoint[1]);
  for (const [x, y] of points.slice(1)) {
    shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

type ResultProbeConfig = { label: string; anchor: [number, number, number]; labelPosition: [number, number, number]; tone: ResultProbeTone };

export function resultProbesForKind(kind: SampleModelKind, faces: DisplayFace[], resultMode: ResultMode, resultFields: ResultField[], unitSystem: UnitSystem): ResultProbeConfig[] {
  if (kind === "plate" || kind === "cantilever") {
    const dynamicProbes = resultProbeSamplesForFaces(faces, resultFields, resultMode);
    if (dynamicProbes.length) {
      return dynamicProbes.map((probe) => resultProbeForFace(kind, probe.face, probe.label, probe.tone));
    }
  }
  const labels = resultProbeLabels(resultMode, resultFields, unitSystem);
  if (kind === "plate") {
    return [
      { label: labels.max, anchor: [-1.78, 0.35, 0.18], labelPosition: [-1.22, 0.86, 0.72], tone: "max" },
      { label: labels.mid, anchor: [-0.22, 0.38, 0.18], labelPosition: [0.28, 0.86, 0.68], tone: "mid" },
      { label: labels.min, anchor: [1.48, 0.56, 0.3], labelPosition: [1.12, 1.04, 0.78], tone: "min" }
    ];
  }
  if (kind === "cantilever") {
    return [
      { label: labels.max, anchor: [-1.72, 0.48, 0.0], labelPosition: [-1.12, 0.88, 0.52], tone: "max" },
      { label: labels.mid, anchor: [-0.45, 0.44, 0.0], labelPosition: [0.08, 0.84, 0.52], tone: "mid" },
      { label: labels.min, anchor: [1.72, 0.12, 0.0], labelPosition: [1.18, -0.32, 0.52], tone: "min" }
    ];
  }
  if (kind === "uploaded" || kind === "blank") return [];
  return [
    { label: labels.max, anchor: [-1.18, 2.55, 0.62], labelPosition: [-0.45, 2.95, 1.05], tone: "max" },
    { label: labels.mid, anchor: [-0.34, 0.86, 0.48], labelPosition: [0.34, 1.24, 1.0], tone: "mid" },
    { label: labels.min, anchor: [2.25, 0.14, 0.62], labelPosition: [1.75, 0.54, 1.0], tone: "min" }
  ];
}

function resultProbeForFace(kind: SampleModelKind, face: DisplayFace, label: string, tone: ResultProbeTone): ResultProbeConfig {
  const { center, normal } = resultProbeSurfaceForFace(kind, face);
  const anchor = center.clone().add(normal.clone().multiplyScalar(0.06));
  const toneOffset = tone === "max"
    ? new THREE.Vector3(0.1, 0.34, 0.54)
    : tone === "mid"
      ? new THREE.Vector3(0.18, 0.34, 0.52)
      : new THREE.Vector3(-0.08, -0.34, 0.52);
  const labelPosition = anchor.clone().add(normal.clone().multiplyScalar(0.42)).add(toneOffset);
  return {
    label,
    anchor: anchor.toArray() as [number, number, number],
    labelPosition: labelPosition.toArray() as [number, number, number],
    tone
  };
}

function resultProbeSurfaceForFace(kind: SampleModelKind, face: DisplayFace): { center: THREE.Vector3; normal: THREE.Vector3 } {
  const center = new THREE.Vector3(...face.center);
  const normal = new THREE.Vector3(...face.normal).normalize();
  if (kind === "cantilever") {
    if (face.id === "face-base-left") {
      return {
        center: new THREE.Vector3(center.x, CANTILEVER_TOP_Y, CANTILEVER_OUTER_Z * 0.72),
        normal: new THREE.Vector3(0, 1, 0)
      };
    }
    if (face.id === "face-load-top" || face.id === "face-web-front") {
      return {
        center: new THREE.Vector3(center.x, CANTILEVER_TOP_Y, CANTILEVER_OUTER_Z * 0.55),
        normal: new THREE.Vector3(0, 1, 0)
      };
    }
    if (face.id === "face-base-bottom") {
      return {
        center: new THREE.Vector3(center.x, CANTILEVER_BOTTOM_Y, CANTILEVER_OUTER_Z * 0.55),
        normal: new THREE.Vector3(0, -1, 0)
      };
    }
    return { center, normal };
  }
  if (kind !== "plate") return { center, normal };

  if (face.id === "face-load-top") {
    return {
      center: new THREE.Vector3(center.x, BEAM_TOP_Y, center.z),
      normal: new THREE.Vector3(0, 1, 0)
    };
  }
  if (face.id === "face-web-front") {
    return {
      center: new THREE.Vector3(center.x, BEAM_TOP_Y, center.z),
      normal: new THREE.Vector3(0, 1, 0)
    };
  }
  if (face.id === "face-base-bottom") {
    return {
      center: new THREE.Vector3(center.x, center.y, BEAM_DEPTH / 2),
      normal: new THREE.Vector3(0, 0, 1)
    };
  }
  return { center, normal };
}

function resultProbeLabels(resultMode: ResultMode, resultFields: ResultField[], unitSystem: UnitSystem) {
  const field = selectedResultField(resultFields, resultMode);
  const values = field ? [
    ...field.values,
    ...(field.samples?.map((sample) => sample.value) ?? [])
  ].filter(Number.isFinite) : [];
  if (field && values.length) {
    const sorted = [...values].sort((left, right) => left - right);
    const min = sorted[0] ?? field.min;
    const mid = sorted[Math.floor(sorted.length / 2)] ?? (field.min + field.max) / 2;
    const max = sorted.at(-1) ?? field.max;
    const unit = field.units ? ` ${field.units}` : "";
    if (resultMode === "displacement") return { max: `Disp: ${formatResultValue(max)}${unit}`, mid: `Disp: ${formatResultValue(mid)}${unit}`, min: `Disp: ${formatResultValue(min)}${unit}` };
    if (resultMode === "velocity") return { max: `Vel: ${formatResultValue(max)}${unit}`, mid: `Vel: ${formatResultValue(mid)}${unit}`, min: `Vel: ${formatResultValue(min)}${unit}` };
    if (resultMode === "acceleration") return { max: `Accel: ${formatResultValue(max)}${unit}`, mid: `Accel: ${formatResultValue(mid)}${unit}`, min: `Accel: ${formatResultValue(min)}${unit}` };
    if (resultMode === "safety_factor") return { max: `FoS: ${formatResultValue(min)}`, mid: `FoS: ${formatResultValue(mid)}`, min: `FoS: ${formatResultValue(max)}` };
    return { max: `Stress: ${formatResultValue(max)}${unit}`, mid: `Stress: ${formatResultValue(mid)}${unit}`, min: `Stress: ${formatResultValue(min)}${unit}` };
  }
  if (resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration") {
    const max = lengthForUnits(0.184, "mm", unitSystem);
    const mid = lengthForUnits(0.092, "mm", unitSystem);
    const min = lengthForUnits(0.012, "mm", unitSystem);
    const prefix = resultMode === "velocity" ? "Vel" : resultMode === "acceleration" ? "Accel" : "Disp";
    return {
      max: `${prefix}: ${formatResultValue(max.value)} ${max.units}`,
      mid: `${prefix}: ${formatResultValue(mid.value)} ${mid.units}`,
      min: `${prefix}: ${formatResultValue(min.value)} ${min.units}`
    };
  }
  if (resultMode === "safety_factor") {
    return { max: "FoS: 1.8", mid: "FoS: 4.7", min: "FoS: 7.6" };
  }
  const max = stressForUnits(142, "MPa", unitSystem);
  const mid = stressForUnits(64, "MPa", unitSystem);
  const min = stressForUnits(28, "MPa", unitSystem);
  return {
    max: `Stress: ${formatResultValue(max.value)} ${max.units}`,
    mid: `Stress: ${formatResultValue(mid.value)} ${mid.units}`,
    min: `Stress: ${formatResultValue(min.value)} ${min.units}`
  };
}

function ResultProbe({ label, anchor, labelPosition, tone }: ResultProbeConfig) {
  return (
    <group>
      <Line points={[anchor, labelPosition]} color="#6d7480" transparent opacity={0.75} lineWidth={1} />
      <mesh position={anchor}>
        <sphereGeometry args={[0.045, 18, 18]} />
        <meshBasicMaterial color={tone === "max" ? "#ef4444" : tone === "mid" ? "#f59e0b" : "#2563eb"} />
      </mesh>
      <SceneLabel label={label} position={labelPosition} tone={tone} />
    </group>
  );
}

function ModelHitLabel({ hit, active }: { hit: ModelSelectionHit; active: boolean }) {
  const anchor = hit.payloadObject?.center ?? hit.point;
  const label = hit.payloadObject?.label ?? compactFaceLabel(hit.face.label);
  const labelPosition = new THREE.Vector3(...anchor).add(new THREE.Vector3(0, 0.12, 0.12));
  return (
    <group>
      {!hit.payloadObject && (
        <mesh position={hit.point}>
          <sphereGeometry args={[active ? 0.035 : 0.026, 18, 18]} />
          <meshBasicMaterial color={active ? "#4da3ff" : "#f8d77b"} depthTest={false} toneMapped={false} />
        </mesh>
      )}
      <SceneLabel label={label} position={labelPosition.toArray()} tone={active ? "active-load" : "load"} />
    </group>
  );
}

function SceneLabel({
  label,
  position,
  tone
}: {
  label: string;
  position: [number, number, number];
  tone: "max" | "mid" | "min" | "load" | "active-load" | "payload-mass" | "dimension" | "print";
}) {
  const labelWidth = Math.max(1.02, label.length * 0.098);
  const colors = sceneLabelColors(tone);
  return (
    <Billboard position={position} renderOrder={50}>
      <Text
        anchorX="center"
        anchorY="middle"
        color={colors.text}
        material-depthTest={false}
        material-depthWrite={false}
        material-toneMapped={false}
        fontSize={0.135}
        letterSpacing={0}
        maxWidth={labelWidth - 0.16}
        outlineColor={colors.outline}
        outlineOpacity={0.88}
        outlineWidth={0.018}
      >
        {label}
      </Text>
    </Billboard>
  );
}

function sceneLabelColors(tone: "max" | "mid" | "min" | "load" | "active-load" | "payload-mass" | "dimension" | "print") {
  if (tone === "max") return { outline: "#1f0707", text: "#fee2e2" };
  if (tone === "mid") return { outline: "#1f1300", text: "#fef3c7" };
  if (tone === "min") return { outline: "#06142a", text: "#dbeafe" };
  if (tone === "dimension") return { outline: "#03101d", text: "#8cc8ff" };
  if (tone === "print") return { outline: "#032018", text: "#a7f3d0" };
  if (tone === "active-load") return { outline: "#03101d", text: "#8cc8ff" };
  if (tone === "payload-mass") return { outline: "#032018", text: "#6ee7c8" };
  return { outline: "#1f1300", text: "#ffe6a3" };
}

function SupportGlyph({ kind, marker, face, active, labelPosition }: { kind: SampleModelKind; marker: ViewerSupportMarker; face: DisplayFace; active: boolean; labelPosition?: [number, number, number] }) {
  if (kind === "bracket" && face.id === "face-base-left") {
    const depthOffset = Math.min(marker.stackIndex, 2) * 0.05;
    const anchor: [number, number, number] = [0.72, 0, BRACKET_DEPTH / 2 + 0.065 + depthOffset];
    const position = labelPosition ?? [0.72, 0.38 + marker.stackIndex * 0.16, BRACKET_DEPTH / 2 + 0.2] as [number, number, number];
    return (
      <group position={[0, 0, depthOffset]}>
        {BRACKET_HOLES.filter((hole) => hole.supported).map((hole) => (
          <group key={`${marker.id}-${hole.id}`} position={[hole.center[0], hole.center[1], BRACKET_DEPTH / 2 + 0.065]}>
            <SupportBurst radius={hole.radius} active={active} />
          </group>
        ))}
        <BoundaryLabelLeader anchor={anchor} labelPosition={position} color={active ? "#4da3ff" : "#f59e0b"} />
        <SceneLabel
          label={supportLabel(marker)}
          position={position}
          tone={active ? "active-load" : "load"}
        />
      </group>
    );
  }

  const normal = new THREE.Vector3(...face.normal).normalize();
  const anchor = supportGlyphAnchor(kind, marker, face);
  const position = labelPosition ?? anchor.clone().add(normal.clone().multiplyScalar(0.32)).add(new THREE.Vector3(0, 0.14, 0)).toArray() as [number, number, number];
  return (
    <group>
      <mesh position={anchor.toArray()} rotation={rotationForNormal(face.normal)}>
        <circleGeometry args={[0.12, 36]} />
        <meshBasicMaterial color={active ? "#4da3ff" : "#f59e0b"} transparent opacity={0.88} side={THREE.DoubleSide} />
      </mesh>
      <SupportBurstAt position={anchor.toArray()} normal={normal} active={active} />
      <BoundaryLabelLeader anchor={anchor.toArray()} labelPosition={position} color={active ? "#4da3ff" : "#f59e0b"} />
      <SceneLabel label={supportLabel(marker)} position={position} tone={active ? "active-load" : "load"} />
    </group>
  );
}

function SupportBurstAt({ position, normal, active }: { position: [number, number, number]; normal: THREE.Vector3; active: boolean }) {
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
  return (
    <group position={position} quaternion={quaternion}>
      <SupportBurst radius={0.15} active={active} />
    </group>
  );
}

function supportLabel(marker: ViewerSupportMarker) {
  return marker.displayLabel;
}

export function legendTickLabels(minValue: number, maxValue: number) {
  return [0, 0.25, 0.5, 0.75, 1].map((tick) => formatResultValue(minValue + (maxValue - minValue) * tick));
}

export function displayedLegendTickLabels(minValue: number, maxValue: number) {
  const ticks = legendTickLabels(minValue, maxValue);
  return [ticks[0], ticks[2], ticks[4]];
}

export function legendMeshStats(meshSummary: MeshSummary | undefined) {
  return {
    nodes: (meshSummary?.nodes ?? 42381).toLocaleString(),
    elements: (meshSummary?.elements ?? 26944).toLocaleString()
  };
}

const RESULT_LEGEND_MIN_WIDTH = 280;
const RESULT_LEGEND_MIN_HEIGHT = 154;
const RESULT_LEGEND_DEFAULT_WIDTH = 360;
const RESULT_LEGEND_DEFAULT_HEIGHT = 154;
const RESULT_LEGEND_GROW_HEIGHT = 176;
const RESULT_LEGEND_MIN_CONTENT_SCALE = 0.72;
const RESULT_LEGEND_MAX_CONTENT_SCALE = 2.4;
const RESULT_LEGEND_VIEWPORT_INSET = 12;

type ResultLegendSize = { width: number; height: number };
type ResultLegendResizeDrag = ResultLegendSize & {
  maxHeight: number;
  maxWidth: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
};

export function resultLegendResizeDimensions({
  currentClientX,
  currentClientY,
  maxHeight,
  maxWidth,
  minHeight,
  minWidth,
  startClientX,
  startClientY,
  startHeight,
  startWidth
}: {
  currentClientX: number;
  currentClientY: number;
  maxHeight: number;
  maxWidth: number;
  minHeight: number;
  minWidth: number;
  startClientX: number;
  startClientY: number;
  startHeight: number;
  startWidth: number;
}): ResultLegendSize {
  return {
    width: Math.round(clampNumber(startWidth + currentClientX - startClientX, minWidth, maxWidth)),
    height: Math.round(clampNumber(startHeight + startClientY - currentClientY, minHeight, maxHeight))
  };
}

export function resultLegendContentScale(size: ResultLegendSize) {
  const widthScale = size.width / RESULT_LEGEND_DEFAULT_WIDTH;
  const compactHeightScale = size.height / RESULT_LEGEND_DEFAULT_HEIGHT;
  const growHeightScale = size.height / RESULT_LEGEND_GROW_HEIGHT;
  const scale = widthScale < 1 || compactHeightScale < 1
    ? Math.min(widthScale, compactHeightScale)
    : Math.max(1, Math.min(widthScale, growHeightScale));

  return Number(clampNumber(
    scale,
    RESULT_LEGEND_MIN_CONTENT_SCALE,
    RESULT_LEGEND_MAX_CONTENT_SCALE
  ).toFixed(2));
}

function ResultLegend({ resultMode, resultFields, unitSystem, meshSummary }: { resultMode: ResultMode; resultFields: ResultField[]; unitSystem: UnitSystem; meshSummary?: MeshSummary }) {
  const legendRef = useRef<HTMLDivElement | null>(null);
  const resizeDragRef = useRef<ResultLegendResizeDrag | null>(null);
  const [legendSize, setLegendSize] = useState<ResultLegendSize | null>(null);
  const title = resultMode === "stress" ? "Von Mises Stress" : resultMode === "displacement" ? "Displacement" : resultMode === "velocity" ? "Velocity" : resultMode === "acceleration" ? "Acceleration" : "Safety Factor";
  const field = selectedResultField(resultFields, resultMode);
  const fallbackMin = resultMode === "stress" ? stressForUnits(28, "MPa", unitSystem) : resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration" ? lengthForUnits(0, "mm", unitSystem) : { value: 1.8, units: "" };
  const fallbackMax = resultMode === "stress" ? stressForUnits(142, "MPa", unitSystem) : resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration" ? lengthForUnits(0.184, "mm", unitSystem) : { value: 7.6, units: "" };
  const unit = field?.units ?? fallbackMax.units;
  const minValue = field?.min ?? fallbackMin.value;
  const maxValue = field?.max ?? fallbackMax.value;
  const ticks = displayedLegendTickLabels(minValue, maxValue);
  const meshStats = legendMeshStats(meshSummary);
  const legendStyle = legendSize
    ? ({
        "--analysis-legend-scale": resultLegendContentScale(legendSize),
        height: `${legendSize.height}px`,
        width: `${legendSize.width}px`
      } as CSSProperties & { "--analysis-legend-scale": number })
    : undefined;
  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const legend = legendRef.current;
    if (!legend) return;
    const legendRect = legend.getBoundingClientRect();
    const viewportRect = legend.parentElement?.getBoundingClientRect();
    const maxWidth = Math.max(RESULT_LEGEND_MIN_WIDTH, (viewportRect?.width ?? window.innerWidth) - RESULT_LEGEND_VIEWPORT_INSET * 2);
    const maxHeight = Math.max(RESULT_LEGEND_MIN_HEIGHT, (viewportRect?.height ?? window.innerHeight) - RESULT_LEGEND_VIEWPORT_INSET * 2);

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDragRef.current = {
      height: legendRect.height,
      maxHeight,
      maxWidth,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      width: legendRect.width
    };
    setLegendSize({ width: Math.round(legendRect.width), height: Math.round(legendRect.height) });
  };
  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setLegendSize(resultLegendResizeDimensions({
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      maxHeight: drag.maxHeight,
      maxWidth: drag.maxWidth,
      minHeight: RESULT_LEGEND_MIN_HEIGHT,
      minWidth: RESULT_LEGEND_MIN_WIDTH,
      startClientX: drag.startClientX,
      startClientY: drag.startClientY,
      startHeight: drag.height,
      startWidth: drag.width
    }));
  };
  const handleResizePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeDragRef.current?.pointerId !== event.pointerId) return;
    resizeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  function resetResultLegendSize(event: ReactMouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    resizeDragRef.current = null;
    setLegendSize(null);
  }

  return (
    <div
      ref={legendRef}
      className={`analysis-legend ${resultMode === "safety_factor" ? "safety-scale" : ""}`}
      style={legendStyle}
      title="Double-click to reset legend size"
      onDoubleClick={resetResultLegendSize}
    >
      <button
        className="analysis-legend-resize"
        type="button"
        aria-label="Resize results legend"
        title="Resize results legend"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onLostPointerCapture={handleResizePointerEnd}
      />
      <strong>Nodes: {meshStats.nodes}</strong>
      <strong>Elements: {meshStats.elements}</strong>
      <span>Type: {title}</span>
      <span>Unit: {unit || "ratio"}</span>
      <div className="legend-scale" />
      <div className="legend-values">
        <span>{ticks[0]}</span>
        <span>{ticks[1]}</span>
        <span>{ticks[2]}</span>
      </div>
      <div className="legend-extrema">
        <span>Min</span>
        <span>Max</span>
      </div>
    </div>
  );
}

function selectedResultField(resultFields: ResultField[], resultMode: ResultMode): ResultField | undefined {
  return resultFields.find((candidate) => candidate.type === resultMode && candidate.location === "face")
    ?? resultFields.find((candidate) => candidate.type === resultMode && candidate.samples?.length)
    ?? resultFields.find((candidate) => candidate.type === resultMode);
}

function clampNumber(value: number, minValue: number, maxValue: number) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function LoadGlyph({ marker, face, active, labelPosition }: { marker: ViewerLoadMarker; face: DisplayFace; active: boolean; labelPosition?: [number, number, number] }) {
  const presentation = loadMarkerViewportPresentation(marker);
  const markerDirection = markerDirectionInModelSpace(marker);
  const isNormalDirection = marker.directionLabel === "Normal";
  const markerColor = marker.type === "gravity" ? presentation.color : active ? "#4da3ff" : presentation.color;
  const labelTone = marker.type === "gravity" ? presentation.tone : active ? "active-load" : presentation.tone;

  const normal = new THREE.Vector3(...face.normal).normalize();
  const center = new THREE.Vector3(...loadMarkerAnchor(marker, face));
  const tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0));
  if (tangent.lengthSq() < 0.001) tangent.set(1, 0, 0);
  tangent.normalize();
  const arrowDirection = isNormalDirection ? normal : markerDirection;
  const { start, end } = arrowPointsOutsideSurface(loadGlyphSurfacePoint(marker, face), normal, arrowDirection, 0.54);
  const payloadOffset = payloadMassLabelOffset(marker.labelIndex);
  const massLabelPosition = labelPosition ? new THREE.Vector3(...labelPosition) : center
    .clone()
    .add(tangent.clone().multiplyScalar(payloadOffset.tangent))
    .add(normal.clone().multiplyScalar(0.24))
    .add(new THREE.Vector3(0, payloadOffset.lift, 0));
  const forceLabelPosition = labelPosition ? new THREE.Vector3(...labelPosition) : loadGlyphLabelPosition(marker, face, start, normal, arrowDirection);
  const glyphAnchor = presentation.showArrow ? end.toArray() as [number, number, number] : center.toArray() as [number, number, number];
  if (DEBUG_RESULTS) {
    console.info("[OpenCAE debugResults] viewer load marker direction audit", {
      id: marker.id,
      type: marker.type,
      rawDirection: marker.direction,
      directionLabel: marker.directionLabel,
      modelDirection: markerDirection.toArray(),
      faceId: face.id,
      faceNormal: face.normal
    });
  }

  return (
    <group>
      {presentation.showArrow && <ArrowGlyph start={start} end={end} color={markerColor} />}
      {presentation.showLeader && (
        <PayloadMassLeader
          anchor={center}
          labelPosition={massLabelPosition}
          color={markerColor}
        />
      )}
      {labelPosition && <BoundaryLabelLeader anchor={glyphAnchor} labelPosition={labelPosition} color={markerColor} />}
      <SceneLabel
        label={presentation.label}
        position={(presentation.showArrow ? forceLabelPosition : massLabelPosition).toArray()}
        tone={labelTone}
      />
    </group>
  );
}

export function loadGlyphLabelPosition(
  marker: ViewerLoadMarker,
  face: DisplayFace,
  arrowStart?: THREE.Vector3,
  faceNormal?: THREE.Vector3,
  arrowDirection?: THREE.Vector3
) {
  const normal = faceNormal?.clone().normalize() ?? new THREE.Vector3(...face.normal).normalize();
  const direction = arrowDirection?.clone().normalize() ?? markerDirectionInModelSpace(marker);
  const start = arrowStart?.clone() ?? arrowPointsOutsideSurface(
    loadGlyphSurfacePoint(marker, face),
    normal,
    marker.directionLabel === "Normal" ? normal : direction,
    0.54
  ).start;
  const side = new THREE.Vector3().crossVectors(direction, normal);
  if (side.lengthSq() < 0.001) side.crossVectors(direction, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 0.001) side.set(1, 0, 0);
  side.normalize();
  const { lane, row } = labelLaneOffset(marker.labelIndex);
  return start
    .add(direction.clone().multiplyScalar(-0.18))
    .add(normal.clone().multiplyScalar(0.1 + row * 0.08))
    .add(side.multiplyScalar(lane * 0.22));
}

function PickedLoadLocationMarker({ marker, face, active }: { marker: ViewerLoadMarker; face: DisplayFace; active: boolean }) {
  const normal = new THREE.Vector3(...face.normal).normalize();
  const anchor = loadGlyphSurfacePoint(marker, face).clone().add(normal.multiplyScalar(0.035));
  const color = active ? "#4da3ff" : "#93c5fd";
  return (
    <Billboard position={anchor.toArray()} renderOrder={24}>
      <group>
        <mesh>
          <ringGeometry args={[0.055, 0.075, 36]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.96} toneMapped={false} />
        </mesh>
        <mesh>
          <circleGeometry args={[0.026, 28]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.72} toneMapped={false} />
        </mesh>
        <Line points={[[-0.105, 0, 0.002], [-0.078, 0, 0.002]]} color={color} transparent opacity={0.82} lineWidth={1.15} depthTest={false} />
        <Line points={[[0.078, 0, 0.002], [0.105, 0, 0.002]]} color={color} transparent opacity={0.82} lineWidth={1.15} depthTest={false} />
        <Line points={[[0, -0.105, 0.002], [0, -0.078, 0.002]]} color={color} transparent opacity={0.82} lineWidth={1.15} depthTest={false} />
        <Line points={[[0, 0.078, 0.002], [0, 0.105, 0.002]]} color={color} transparent opacity={0.82} lineWidth={1.15} depthTest={false} />
      </group>
    </Billboard>
  );
}

function BoundaryLabelLeader({ anchor, labelPosition, color }: { anchor: [number, number, number]; labelPosition: [number, number, number]; color: string }) {
  const anchorVector = new THREE.Vector3(...anchor);
  const labelVector = new THREE.Vector3(...labelPosition);
  const leaderEnd = labelVector.clone().add(anchorVector.clone().sub(labelVector).normalize().multiplyScalar(0.2));
  return <Line points={[anchor, leaderEnd.toArray()]} color={color} transparent opacity={0.62} lineWidth={1.2} />;
}

function PayloadMassLeader({ anchor, labelPosition, color }: { anchor: THREE.Vector3; labelPosition: THREE.Vector3; color: string }) {
  const labelAnchor = labelPosition.clone().add(anchor.clone().sub(labelPosition).normalize().multiplyScalar(0.16));
  return (
    <group>
      <Line points={[anchor.toArray(), labelAnchor.toArray()]} color={color} transparent opacity={0.82} lineWidth={1.4} />
      <Billboard position={anchor.toArray()}>
        <mesh>
          <ringGeometry args={[0.045, 0.072, 28]} />
          <meshBasicMaterial color={color} depthTest={false} toneMapped={false} transparent opacity={0.92} />
        </mesh>
      </Billboard>
    </group>
  );
}

function compactFaceLabel(label: string) {
  return label
    .replace(/\bmounting holes\b/i, "holes")
    .replace(/\bload face\b/i, "")
    .replace(/\bface\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function arrowPointsOutsideSurface(surfacePoint: THREE.Vector3, normal: THREE.Vector3, direction: THREE.Vector3, length: number) {
  const faceNormal = normal.clone().normalize();
  const arrowDirection = direction.clone().normalize();
  const rawStart = surfacePoint.clone().add(arrowDirection.clone().multiplyScalar(-length));
  const rawEnd = surfacePoint.clone();
  const minNormalDistance = Math.min(
    rawStart.clone().sub(surfacePoint).dot(faceNormal),
    rawEnd.clone().sub(surfacePoint).dot(faceNormal)
  );
  const clearance = 0.12;
  const outsideShift = faceNormal.multiplyScalar(clearance - minNormalDistance);
  return {
    start: rawStart.add(outsideShift),
    end: rawEnd.add(outsideShift)
  };
}

function ArrowGlyph({
  start,
  end,
  color,
  shaftRadius = 0.025,
  headRadius = 0.09,
  headLength = 0.22
}: {
  start: THREE.Vector3;
  end: THREE.Vector3;
  color: string;
  shaftRadius?: number;
  headRadius?: number;
  headLength?: number;
}) {
  const direction = end.clone().sub(start);
  const directionLength = direction.length();
  if (directionLength < 0.001) return null;
  const unitDirection = direction.clone().normalize();
  const shaftEnd = end.clone().add(unitDirection.clone().multiplyScalar(-headLength * 0.72));
  const shaftDirection = shaftEnd.clone().sub(start);
  const shaftLength = Math.max(0.001, shaftDirection.length());
  const midpoint = start.clone().add(shaftDirection.clone().multiplyScalar(0.5));
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), unitDirection);
  const conePosition = end.clone().add(unitDirection.clone().multiplyScalar(-headLength * 0.5));
  return (
    <>
      <mesh position={midpoint.toArray()} quaternion={quaternion}>
        <cylinderGeometry args={[shaftRadius, shaftRadius, shaftLength, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={conePosition.toArray()} quaternion={quaternion}>
        <coneGeometry args={[headRadius, headLength, 24]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </>
  );
}

function HoleRims({ kind }: { kind: SampleModelKind }) {
  if (kind === "blank") return null;
  return null;
}

function SupportBurst({ radius, active = false }: { radius: number; active?: boolean }) {
  return (
    <group>
      {[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((angle) => {
        const x = Math.cos(angle) * radius * 2.0;
        const y = Math.sin(angle) * radius * 2.0;
        return (
          <mesh key={angle} position={[x, y, 0.035]} rotation={[0, 0, angle - Math.PI / 2]}>
            <coneGeometry args={[0.045, 0.13, 3]} />
            <meshBasicMaterial color={active ? "#4da3ff" : "#f59e0b"} />
          </mesh>
        );
      })}
    </group>
  );
}

function MeshOverlay({ kind }: { kind: SampleModelKind }) {
  const bodyGeometry = useMemo(() => createBracketBodyGeometry(), []);
  const ribGeometry = useMemo(() => createRibGeometry(), []);
  const beamGeometry = useMemo(() => createBeamGeometry(), []);
  const beamPayloadGeometry = useMemo(() => createBeamPayloadGeometry(), []);
  if (kind === "blank") return null;

  if (kind === "plate") {
    return (
      <group>
        {[beamGeometry, beamPayloadGeometry].map((geometry, index) => (
          <mesh key={index} geometry={geometry}>
            <meshBasicMaterial color="#9ad1ff" wireframe transparent opacity={0.3} />
          </mesh>
        ))}
      </group>
    );
  }

  if (kind === "cantilever") {
    return (
      <mesh position={[0, 0.18, 0]}>
        <boxGeometry args={[3.8, 0.5, 0.72, 18, 4, 4]} />
        <meshBasicMaterial color="#9ad1ff" wireframe transparent opacity={0.3} />
      </mesh>
    );
  }

  if (kind === "uploaded") return null;

  return (
    <group>
      <mesh>
        <primitive attach="geometry" object={bodyGeometry} />
        <meshBasicMaterial color="#9ad1ff" wireframe transparent opacity={0.26} />
      </mesh>
      <mesh>
        <primitive attach="geometry" object={ribGeometry} />
        <meshBasicMaterial color="#9ad1ff" wireframe transparent opacity={0.3} />
      </mesh>
    </group>
  );
}

function BoundsCameraReset({ signal, viewAxis, viewAxisSignal, controlsRef }: { signal: number; viewAxis: RotationAxis | null; viewAxisSignal: number; controlsRef: MutableRefObject<ViewerOrbitControls | null> }) {
  const bounds = useBounds();
  const { camera, invalidate, size } = useThree();
  useEffect(() => {
    let cancelled = false;
    let frameId = 0;
    let retryFrameId = 0;
    const retryTimerId = window.setTimeout(() => {
      frameId = window.requestAnimationFrame(() => {
        retryFrameId = window.requestAnimationFrame(resetCamera);
      });
    }, VIEWER_FIT_RETRY_DELAY_MS);

    function resetCamera() {
      if (cancelled) return;
      const nextBounds = bounds.refresh().clip();
      const { box, center, distance } = nextBounds.getSize();
      const perspectiveCamera = camera as THREE.PerspectiveCamera;
      const pose = viewerCameraResetPose(
        box,
        center,
        distance,
        viewAxis,
        perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.fov : undefined,
        size.width / size.height
      );
      applyViewerCameraPose(camera, controlsRef.current, pose);
      invalidate();
    }

    resetCamera();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimerId);
      if (frameId) window.cancelAnimationFrame(frameId);
      if (retryFrameId) window.cancelAnimationFrame(retryFrameId);
    };
  }, [bounds, camera, controlsRef, invalidate, signal, size.height, size.width, viewAxis, viewAxisSignal]);
  return null;
}

function GizmoCameraReset({ view, signal, controlsRef }: { view: GizmoViewRequest | null; signal: number; controlsRef: MutableRefObject<ViewerOrbitControls | null> }) {
  const bounds = useBounds();
  const { camera, invalidate, size } = useThree();
  useEffect(() => {
    if (!view || signal === 0) return;
    const nextBounds = bounds.refresh().clip();
    const { box, center, distance } = nextBounds.getSize();
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    const pose = viewerCameraResetPose(
      box,
      center,
      distance,
      view === VIEWER_ISOMETRIC_GIZMO_VIEW ? null : view,
      perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.fov : undefined,
      size.width / size.height
    );
    applyViewerCameraPose(camera, controlsRef.current, pose);
    invalidate();
  }, [bounds, camera, controlsRef, invalidate, signal, size.height, size.width, view]);
  return null;
}

export type ViewerCameraResetPose = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
};

export function viewerCameraResetPose(
  box: THREE.Box3,
  center: THREE.Vector3,
  fallbackDistance: number,
  viewRequest: GizmoViewRequest | null,
  fov: number | undefined,
  aspect: number
): ViewerCameraResetPose {
  const view = cameraViewForRequest(viewRequest);
  const target = viewRequest ? center.clone() : defaultHomeViewTarget(box, view.direction, view.up);
  const fitMargin = viewRequest ? VIEWER_FIT_MARGIN : DEFAULT_HOME_FIT_MARGIN;
  const fitDistance = fov
    ? cameraDistanceForBounds(box, view.direction, view.up, fov, aspect, fitMargin)
    : fallbackDistance;
  return {
    position: target.clone().addScaledVector(view.direction, fitDistance),
    target,
    up: view.up.clone()
  };
}

function cameraViewForRequest(viewRequest: GizmoViewRequest | null): { direction: THREE.Vector3; up: THREE.Vector3 } {
  if (!viewRequest) return { direction: ISO_CAMERA_DIRECTION, up: ISO_CAMERA_UP };
  if (viewRequest === VIEWER_ISOMETRIC_GIZMO_VIEW) return { direction: ISO_CAMERA_DIRECTION, up: ISO_CAMERA_UP };
  if (isCornerGizmoViewRequest(viewRequest)) {
    const direction = new THREE.Vector3(...viewRequest.direction).normalize();
    return { direction, up: WORLD_UP.clone().projectOnPlane(direction).normalize() };
  }
  return cameraViewForAxis(viewRequest);
}

function isCornerGizmoViewRequest(viewRequest: GizmoViewRequest): viewRequest is { kind: "corner"; direction: ViewCubeCornerDirection } {
  return typeof viewRequest === "object" && viewRequest.kind === "corner";
}

function applyViewerCameraPose(camera: THREE.Camera, controls: ViewerOrbitControls | null, pose: ViewerCameraResetPose) {
  camera.position.copy(pose.position);
  camera.up.copy(pose.up);
  camera.lookAt(pose.target);
  camera.updateMatrixWorld();
  if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) camera.updateProjectionMatrix();
  if (controls) {
    const previousDamping = controls.enableDamping;
    controls.enableDamping = false;
    controls.target.copy(pose.target);
    controls.update();
    controls.enableDamping = previousDamping;
  }
}

export function axisLabelToViewAxis(label: "X" | "Y" | "Z"): RotationAxis {
  return label.toLowerCase() as RotationAxis;
}

function viewCubeFaceToGizmoTarget(label: ViewCubeFaceLabel): GizmoViewTarget {
  if (label === "Front" || label === "Back") return "front";
  if (label === "Right" || label === "Left") return "right";
  return "top";
}

export function viewCubeFaceToGizmoView(label: ViewCubeFaceLabel): RotationAxis {
  return gizmoViewTargetToRequest(viewCubeFaceToGizmoTarget(label)) as RotationAxis;
}

export function shouldShowViewCubeFaceLabel(
  faceNormalWorld: THREE.Vector3,
  toCameraWorld: THREE.Vector3,
  threshold = VIEWER_VIEW_CUBE_FACE_VISIBILITY_THRESHOLD
) {
  return faceNormalWorld.clone().normalize().dot(toCameraWorld.clone().normalize()) > threshold;
}

export function gizmoViewTargetToRequest(target: GizmoViewTarget): GizmoViewRequest {
  if (target === "+x" || target === "right") return "x";
  if (target === "+y" || target === "front") return "y";
  if (target === "+z" || target === "top") return "z";
  return VIEWER_ISOMETRIC_GIZMO_VIEW;
}

export function cameraViewForAxis(axis: RotationAxis): { direction: THREE.Vector3; up: THREE.Vector3 } {
  if (axis === "x") return { direction: new THREE.Vector3(1, 0, 0), up: WORLD_UP };
  if (axis === "y") return { direction: new THREE.Vector3(0, 1, 0), up: WORLD_UP };
  return { direction: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(-1, 0, 0) };
}

export function defaultHomeViewTarget(bounds: THREE.Box3, direction: THREE.Vector3, up: THREE.Vector3) {
  const center = bounds.getCenter(new THREE.Vector3());
  const viewDirection = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(viewDirection, up).normalize();
  const viewUp = new THREE.Vector3().crossVectors(right, viewDirection).normalize();
  const projectedHalfHeight = projectedBoundsHalfHeight(bounds, center, viewUp);
  return center.addScaledVector(viewUp, -projectedHalfHeight * 0.18);
}

function projectedBoundsHalfHeight(bounds: THREE.Box3, center: THREE.Vector3, viewUp: THREE.Vector3) {
  let halfHeight = 0;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        halfHeight = Math.max(halfHeight, Math.abs(new THREE.Vector3(x, y, z).sub(center).dot(viewUp)));
      }
    }
  }
  return halfHeight;
}

export function cameraDistanceForBounds(
  bounds: THREE.Box3,
  direction: THREE.Vector3,
  up: THREE.Vector3,
  fovDegrees: number,
  aspect: number,
  margin: number
) {
  const center = bounds.getCenter(new THREE.Vector3());
  const viewDirection = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(viewDirection, up).normalize();
  const viewUp = new THREE.Vector3().crossVectors(right, viewDirection).normalize();
  const corners = [
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z)
  ];
  const halfExtents = corners.reduce(
    (extents, corner) => {
      const offset = corner.clone().sub(center);
      extents.x = Math.max(extents.x, Math.abs(offset.dot(right)));
      extents.y = Math.max(extents.y, Math.abs(offset.dot(viewUp)));
      return extents;
    },
    new THREE.Vector2(0, 0)
  );
  const verticalFov = THREE.MathUtils.degToRad(fovDegrees);
  const verticalTan = Math.tan(verticalFov / 2);
  const horizontalTan = verticalTan * aspect;
  const fitDistance = corners.reduce((distance, corner) => {
    const offset = corner.clone().sub(center);
    const depthTowardCamera = offset.dot(viewDirection);
    const fitHeightDistance = Math.abs(offset.dot(viewUp)) / verticalTan;
    const fitWidthDistance = Math.abs(offset.dot(right)) / horizontalTan;
    return Math.max(distance, depthTowardCamera + Math.max(fitHeightDistance, fitWidthDistance));
  }, Math.max(halfExtents.y / verticalTan, halfExtents.x / horizontalTan));
  return fitDistance * margin;
}

export function rotatedCameraOrbit(position: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3, axis: RotationAxis, radians: number) {
  const rotation = new THREE.Quaternion().setFromAxisAngle(vectorForRotationAxis(axis), radians);
  return {
    position: target.clone().add(position.clone().sub(target).applyQuaternion(rotation)),
    up: up.clone().applyQuaternion(rotation).normalize()
  };
}

function vectorForRotationAxis(axis: RotationAxis) {
  if (axis === "x") return new THREE.Vector3(1, 0, 0);
  if (axis === "y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

function colorForResult(faces: DisplayFace[], viewMode: ViewMode, resultMode: ResultMode) {
  const byId = new Map(faces.map((face) => [face.id, face]));
  return (faceId: string) => {
    if (viewMode !== "results") return "#9aa7b4";
    const face = byId.get(faceId);
    const value = face?.stressValue ?? 60;
    if (resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration") return gradient(value, 28, 142, ["#2f80ed", "#4dd0e1", "#d7f75b"]);
    if (resultMode === "safety_factor") return gradient(142 - value, 0, 114, ["#ef4444", "#f59e0b", "#22c55e"]);
    return gradient(value, 28, 142, ["#2563eb", "#22c55e", "#f59e0b", "#ef4444"]);
  };
}

function resultPalette(resultMode: ResultMode): { body: string[] } {
  if (resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration") {
    return {
      body: ["#0759d6", "#0ea5e9", "#10b8f0", "#2ee875", "#f2e94e", "#ff8f1f", "#ef4444"]
    };
  }
  if (resultMode === "safety_factor") {
    return {
      body: ["#ef4444", "#fb923c", "#facc15", "#a3e635", "#4ade80", "#22c55e"]
    };
  }
  return {
    body: ["#0759d6", "#0ea5e9", "#22c55e", "#facc15", "#f97316", "#ef4444"]
  };
}

function interpolatedPaletteColor(colors: string[], value: number): string {
  const t = Math.max(0, Math.min(1, value));
  const index = Math.min(colors.length - 2, Math.floor(t * (colors.length - 1)));
  const localT = t * (colors.length - 1) - index;
  return new THREE.Color(colors[index] ?? colors[0]).lerp(new THREE.Color(colors[index + 1] ?? colors.at(-1)), localT).getStyle();
}

function gradient(value: number, min: number, max: number, colors: string[]): string {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return interpolatedPaletteColor(colors, t);
}

function rotationForNormal(normal: [number, number, number]): [number, number, number] {
  if (Math.abs(normal[0]) > 0.5) return [0, Math.PI / 2, 0];
  if (Math.abs(normal[1]) > 0.5) return [Math.PI / 2, 0, 0];
  return [0, 0, 0];
}
