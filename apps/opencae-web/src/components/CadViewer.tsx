import { useEffect, useMemo, useRef, useState } from "react";
import type { ElementRef, MutableRefObject } from "react";
import { Billboard, Bounds, Edges, GizmoHelper, Html, Line, OrbitControls, Text, useBounds } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import type { DisplayFace, DisplayModel, MeshSummary, ResultField } from "@opencae/schema";
import { meshVolumeM3FromTriangles, type Triangle } from "@opencae/units";
import { House } from "lucide-react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import type { StepId } from "./StepBar";
import { faceForModelHit, type SampleModelKind } from "../modelSelection";
import { baseModelRotationRadians, modelRotationRadians, modelToViewerMatrix, viewerNormalToModelSpace, viewerPointToModelSpace, type RotationAxis } from "../modelOrientation";
import { dimensionValuesForDisplayModel } from "../modelDimensions";
import { formatResultValue, resultProbeSamplesForFaces, resultSamplesForFaces, type FaceResultSample, type ResultProbeTone } from "../resultFields";
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
  meshSummary?: MeshSummary;
  unitSystem: UnitSystem;
  themeMode: ThemeMode;
  fitSignal: number;
  viewAxis: RotationAxis | null;
  viewAxisSignal: number;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  printLayerOrientation: PrintLayerOrientation | null;
  onResetView: () => void;
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
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
type ModelSelectionHit = { face: DisplayFace; point: [number, number, number]; payloadObject?: PayloadObjectSelection; snapResult?: SnapResult | null };
type ModelPickHandlers = {
  onPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: () => void;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
};
export const VIEWER_GIZMO_ALIGNMENT = "bottom-right";
export const VIEWER_CREDIT_URL = "https://esauengineering.com/";
const VIEWER_FIT_MARGIN = 1.28;
const DEFAULT_HOME_FIT_MARGIN = 1.46;
const VIEWER_FIT_RETRY_DELAY_MS = 120;

export function CadViewer(props: CadViewerProps) {
  const controlsRef = useRef<ViewerOrbitControls | null>(null);
  const [uploadedPreviewBounds, setUploadedPreviewBounds] = useState<THREE.Box3 | null>(null);
  const [gizmoViewRequest, setGizmoViewRequest] = useState<{ axis: RotationAxis | null; signal: number }>({ axis: null, signal: 0 });
  const effectiveViewMode: ViewMode = props.activeStep === "results" ? props.viewMode : props.viewMode === "mesh" ? "mesh" : "model";
  const showDimensionOverlay = shouldShowDimensionOverlay(props.showDimensions, effectiveViewMode);
  const isLightTheme = props.themeMode === "light";
  const viewportBackground = isLightTheme ? "#f7f9fc" : "#070b10";
  const modelRotation = useMemo(() => modelRotationRadians(props.displayModel), [props.displayModel]);
  const baseModelRotation = useMemo(() => baseModelRotationRadians(props.displayModel), [props.displayModel]);
  useEffect(() => {
    setUploadedPreviewBounds(null);
  }, [props.displayModel.nativeCad?.contentBase64, props.displayModel.visualMesh?.contentBase64]);
  return (
    <section className={`viewer-shell ${effectiveViewMode === "results" ? "results-view" : ""}`} aria-label="3D CAD viewer">
      <Canvas camera={{ position: [4.8, 4.8, 4.8], up: ISO_CAMERA_UP.toArray(), fov: 42 }} onPointerMissed={props.onViewerMiss}>
        <color attach="background" args={[viewportBackground]} />
        <ambientLight intensity={effectiveViewMode === "results" || isLightTheme ? 1.4 : 0.75} />
        <directionalLight position={[4, 6, 3]} intensity={effectiveViewMode === "results" || isLightTheme ? 1.45 : 2.2} />
        <Bounds fit clip observe margin={VIEWER_FIT_MARGIN}>
          <group rotation={modelRotation}>
            <group rotation={baseModelRotation}>
              <BracketModel {...props} viewMode={effectiveViewMode} uploadedPreviewBounds={uploadedPreviewBounds} onUploadedPreviewBounds={setUploadedPreviewBounds} />
              {showDimensionOverlay && <ModelDimensionOverlay displayModel={props.displayModel} uploadedPreviewBounds={uploadedPreviewBounds} />}
            </group>
          </group>
          <BoundsCameraReset signal={props.fitSignal} viewAxis={props.viewAxis} viewAxisSignal={props.viewAxisSignal} controlsRef={controlsRef} />
          <GizmoCameraReset axis={gizmoViewRequest.axis} signal={gizmoViewRequest.signal} controlsRef={controlsRef} />
        </Bounds>
        <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.08} target={[0, 0, 0.75]} />
        <ShiftPanControls controlsRef={controlsRef} />
        <GizmoHelper alignment={VIEWER_GIZMO_ALIGNMENT} margin={[92, 92]}>
          <CleanAxisGizmo
            onSelectAxis={(axis) => setGizmoViewRequest((request) => ({ axis, signal: request.signal + 1 }))}
          />
        </GizmoHelper>
      </Canvas>
      <div className="viewer-hud">
        <button className="viewer-reset" type="button" onClick={props.onResetView} title="Reset view" aria-label="Reset view">
          <House size={14} aria-hidden="true" />
          <span className="visually-hidden">Reset view</span>
        </button>
      </div>
      <a className="viewer-watermark" href={VIEWER_CREDIT_URL} target="_blank" rel="noreferrer">Built by Esau Engineering</a>
      {effectiveViewMode === "results" && <ResultLegend resultMode={props.resultMode} resultFields={props.resultFields} unitSystem={props.unitSystem} meshSummary={props.meshSummary} />}
    </section>
  );
}

function ShiftPanControls({ controlsRef }: { controlsRef: MutableRefObject<ViewerOrbitControls | null> }) {
  const { camera, gl } = useThree();

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
  }, [camera, controlsRef, gl]);

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

function CleanAxisGizmo({ onSelectAxis }: { onSelectAxis: (axis: RotationAxis) => void }) {
  const axes: Array<{ label: "X" | "Y" | "Z"; color: string; position: [number, number, number] }> = [
    { label: "X", color: "#ff4b7d", position: [0.92, 0, 0] },
    { label: "Y", color: "#2ddc94", position: [0, 0.92, 0] },
    { label: "Z", color: "#4da3ff", position: [0, 0, 0.92] }
  ];

  return (
    <group scale={38}>
      {axes.map((axis) => (
        <group key={axis.label}>
          <Line points={[[0, 0, 0], axis.position]} color={axis.color} lineWidth={4} />
          <AxisHead {...axis} onSelectAxis={onSelectAxis} />
          <AxisDot color={axis.color} position={axis.position.map((value) => -value * 0.72) as [number, number, number]} />
        </group>
      ))}
      <Billboard>
        <mesh>
          <sphereGeometry args={[0.065, 18, 18]} />
          <meshBasicMaterial color="#d9e8f6" toneMapped={false} />
        </mesh>
      </Billboard>
    </group>
  );
}

function AxisHead({ label, color, position, onSelectAxis }: { label: "X" | "Y" | "Z"; color: string; position: [number, number, number]; onSelectAxis: (axis: RotationAxis) => void }) {
  return (
    <Billboard
      position={position}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onSelectAxis(axisLabelToViewAxis(label));
      }}
    >
      <mesh>
        <circleGeometry args={[0.22, 36]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
      </mesh>
      <Text anchorX="center" anchorY="middle" color="#e6edf3" fontSize={0.21} letterSpacing={0} position={[0, 0, 0.01]}>
        {label}
      </Text>
    </Billboard>
  );
}

function AxisDot({ color, position }: { color: string; position: [number, number, number] }) {
  return (
    <Billboard position={position}>
      <mesh>
        <circleGeometry args={[0.11, 28]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.78} toneMapped={false} />
      </mesh>
    </Billboard>
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
          stressExaggeration={stressExaggeration}
          resultFields={resultFields}
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

export function shouldShowResultMarkers(viewMode: ViewMode, activeStep: StepId, resultPlaybackPlaying: boolean) {
  return viewMode === "results" && activeStep === "results" && !resultPlaybackPlaying;
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
  const direction = new THREE.Vector3(...marker.direction).normalize();
  return marker.directionLabel === "Normal" ? direction : worldNormalToModelSpace(direction);
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
  stressExaggeration,
  resultFields,
  loadMarkers,
  supportMarkers,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  kind: SampleModelKind;
  displayModel: DisplayModel;
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds: (bounds: THREE.Box3) => void;
}) {
  if (kind === "blank") return null;
  const samples = useMemo(
    () => resultSamplesForFaces(displayModel.faces, resultFields, resultMode),
    [displayModel.faces, resultFields, resultMode]
  );
  const deformationScale = useMemo(() => deformationScaleForResultFields(resultFields), [resultFields]);
  if (kind === "uploaded") {
    return (
      <UploadedResultSolid
        displayModel={displayModel}
        samples={samples}
        resultMode={resultMode}
        showDeformed={showDeformed}
        stressExaggeration={stressExaggeration}
        deformationScale={deformationScale}
        loadMarkers={loadMarkers}
        supportMarkers={supportMarkers}
        onMeasureDisplayModelDimensions={onMeasureDisplayModelDimensions}
        onUploadedPreviewBounds={onUploadedPreviewBounds}
      />
    );
  }
  if (kind === "bracket") {
    return <BracketResultSolid kind={kind} samples={samples} resultMode={resultMode} showDeformed={showDeformed} stressExaggeration={stressExaggeration} deformationScale={deformationScale} loadMarkers={loadMarkers} supportMarkers={supportMarkers} />;
  }
  return <SampleResultSolid kind={kind} samples={samples} resultMode={resultMode} showDeformed={showDeformed} stressExaggeration={stressExaggeration} deformationScale={deformationScale} loadMarkers={loadMarkers} supportMarkers={supportMarkers} />;
}

function UploadedResultSolid({
  displayModel,
  samples,
  resultMode,
  showDeformed,
  stressExaggeration,
  deformationScale,
  loadMarkers,
  supportMarkers,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  displayModel: DisplayModel;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  deformationScale?: number;
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
        stressExaggeration={stressExaggeration}
        deformationScale={deformationScale}
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
        stressExaggeration={stressExaggeration}
        deformationScale={deformationScale}
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
  stressExaggeration,
  deformationScale,
  loadMarkers,
  supportMarkers,
  onMeasureDisplayModelDimensions,
  onUploadedPreviewBounds
}: {
  displayModel: DisplayModel;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  deformationScale?: number;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  onMeasureDisplayModelDimensions?: (dimensions: NonNullable<DisplayModel["dimensions"]>) => void;
  onUploadedPreviewBounds: (bounds: THREE.Box3) => void;
}) {
  const filename = displayModel.nativeCad?.filename ?? displayModel.name;
  const contentBase64 = displayModel.nativeCad?.contentBase64 ?? "";
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
    stepPreviewFromBase64(contentBase64, "#63a9e5")
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
  }, [contentBase64]);

  useEffect(() => {
    if (preview.status !== "ready" || !preview.dimensions || !preview.normalizedBounds) return;
    onMeasureDisplayModelDimensions?.(preview.dimensions);
    onUploadedPreviewBounds(preview.normalizedBounds);
  }, [onMeasureDisplayModelDimensions, onUploadedPreviewBounds, preview.dimensions, preview.normalizedBounds, preview.status]);

  const renderedPreview = useMemo(() => {
    if (preview.status !== "ready" || !preview.sourceObject) return null;
    const object = cloneResultPreviewObject(preview.sourceObject);
    const outline = showDeformed ? createUndeformedResultOutlineObject(object) : undefined;
    colorizeResultObject(object, "uploaded", resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers);
    return { object, outline };
  }, [deformationScale, loadMarkers, preview.sourceObject, preview.status, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]);

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
  stressExaggeration,
  deformationScale,
  loadMarkers,
  supportMarkers
}: {
  displayModel: DisplayModel;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  deformationScale?: number;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
}) {
  const outlineGeometry = useMemo(() => normalizedStlGeometryFromBuffer(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? "")), [displayModel.visualMesh?.contentBase64]);
  const geometry = useMemo(() => {
    const parsed = normalizedStlGeometryFromBuffer(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? ""));
    return colorizeResultGeometry(parsed, "uploaded", resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, undefined, undefined, supportMarkers);
  }, [deformationScale, displayModel.visualMesh?.contentBase64, loadMarkers, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]);

  return (
    <group>
      {shouldShowUndeformedResultOutline(showDeformed) && <UndeformedGeometryOutline geometry={outlineGeometry} />}
      <mesh geometry={geometry}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
    </group>
  );
}

function BracketResultSolid({
  kind,
  samples,
  resultMode,
  showDeformed,
  stressExaggeration,
  deformationScale,
  loadMarkers,
  supportMarkers
}: {
  kind: SampleModelKind;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  deformationScale?: number;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
}) {
  const outlineBodyGeometry = useMemo(() => createBracketBodyGeometry(), []);
  const outlineRibGeometry = useMemo(() => createRibGeometry(), []);
  const bodyGeometry = useMemo(
    () => colorizeSampleResultGeometry(createBracketBodyGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers),
    [deformationScale, kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  const ribGeometry = useMemo(
    () => colorizeSampleResultGeometry(createRibGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers),
    [deformationScale, kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  return (
    <group>
      {shouldShowUndeformedResultOutline(showDeformed) && (
        <>
          <UndeformedGeometryOutline geometry={outlineBodyGeometry} />
          <UndeformedGeometryOutline geometry={outlineRibGeometry} />
        </>
      )}
      <mesh geometry={bodyGeometry}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
      <mesh geometry={ribGeometry}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
      <HoleRims kind="bracket" />
    </group>
  );
}

function SampleResultSolid({
  kind,
  samples,
  resultMode,
  showDeformed,
  stressExaggeration,
  deformationScale,
  loadMarkers,
  supportMarkers
}: {
  kind: SampleModelKind;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  deformationScale?: number;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
}) {
  const outlineBeamGeometry = useMemo(() => createBeamGeometry(), []);
  const outlineBeamPayloadGeometry = useMemo(() => createBeamPayloadGeometry(), []);
  const outlineCantileverGeometry = useMemo(() => new THREE.BoxGeometry(3.8, 0.5, 0.72, 40, 8, 8), []);
  const beamGeometry = useMemo(
    () => colorizeSampleResultGeometry(createBeamGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers),
    [deformationScale, kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  const beamPayloadGeometry = useMemo(() => createBeamPayloadGeometry(), []);
  const cantileverGeometry = useMemo(
    () => colorizeSampleResultGeometry(new THREE.BoxGeometry(3.8, 0.5, 0.72, 40, 8, 8), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, supportMarkers),
    [deformationScale, kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration, supportMarkers]
  );
  if (kind === "plate") {
    return (
      <group>
        {shouldShowUndeformedResultOutline(showDeformed) && (
          <>
            <UndeformedGeometryOutline geometry={outlineBeamGeometry} />
            <UndeformedGeometryOutline geometry={outlineBeamPayloadGeometry} />
          </>
        )}
        <mesh geometry={beamGeometry}>
          <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
          <Edges color="#43556a" threshold={18} />
        </mesh>
        <mesh geometry={beamPayloadGeometry}>
          <meshStandardMaterial color={RESULT_PAYLOAD_MATERIAL_COLOR} metalness={0.12} roughness={0.58} />
          <Edges color="#596472" threshold={18} />
        </mesh>
      </group>
    );
  }
  if (kind === "cantilever") {
    return (
      <group>
        {shouldShowUndeformedResultOutline(showDeformed) && <UndeformedGeometryOutline geometry={outlineCantileverGeometry} position={[0, 0.18, 0]} />}
        <mesh geometry={cantileverGeometry} position={[0, 0.18, 0]}>
          <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} />
          <Edges color="#43556a" threshold={18} />
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
  supportMarkers: ViewerSupportMarker[] = []
) {
  const colors: number[] = [];
  const positions = geometry.getAttribute("position");
  const color = new THREE.Color();
  const resultPoints: THREE.Vector3[] = [];
  const values: number[] = [];
  const resolvedDeformationScale = deformationScale ?? deformationScaleForSamples(resultMode, samples);
  const usesResultDeformationScale = typeof deformationScale === "number";
  geometry.computeBoundingBox();
  const bounds = coordinateTransform?.bounds ?? geometry.boundingBox?.clone();
  for (let index = 0; index < positions.count; index += 1) {
    const point = new THREE.Vector3(positions.getX(index), positions.getY(index), positions.getZ(index));
    const resultPoint = coordinateTransform?.toResultPoint(point) ?? point;
    resultPoints.push(resultPoint);
    values.push(resultValueForPoint(kind, resultMode, stressExaggeration, resultPoint, samples));
  }
  const range = valueRange ?? resultValueRange(values, samples);
  for (let index = 0; index < positions.count; index += 1) {
    const point = new THREE.Vector3(positions.getX(index), positions.getY(index), positions.getZ(index));
    const resultPoint = resultPoints[index] ?? point;
    color.copy(resultColorForValue(resultMode, normalizeResultValue(values[index] ?? 0.5, range)));
    colors.push(color.r, color.g, color.b);
    if (showDeformed) {
      const deformed = deformedPointForResults(kind, resultPoint, stressExaggeration, samples, loadMarkers, resolvedDeformationScale, usesResultDeformationScale, bounds, supportMarkers);
      const localDeformed = coordinateTransform?.fromResultPoint(deformed) ?? deformed;
      positions.setXYZ(index, localDeformed.x, localDeformed.y, localDeformed.z);
    }
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
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
  supportMarkers: ViewerSupportMarker[] = []
) {
  return colorizeResultGeometry(geometry, kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers, deformationScale, undefined, undefined, supportMarkers);
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

export function colorizeResultObject(
  object: THREE.Object3D,
  kind: SampleModelKind,
  resultMode: ResultMode,
  showDeformed: boolean,
  stressExaggeration: number,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[],
  deformationScale?: number,
  supportMarkers: ViewerSupportMarker[] = []
) {
  object.updateMatrixWorld(true);
  const excludedPayloadObjects = resultPayloadObjectRefs(loadMarkers);
  const resultMeshes: THREE.Mesh<THREE.BufferGeometry>[] = [];
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
    }, valueRange, supportMarkers);
    child.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.18,
      roughness: 0.52,
      side: THREE.DoubleSide
    });
  }
  return object;
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
  if (!Number.isFinite(span) || Math.abs(span) < 1e-9) return 0.5;
  return Math.max(0, Math.min(1, (value - range.min) / span));
}

export function deformationScaleForResultFields(fields: ResultField[]): number | undefined {
  const displacementField = fields.find((field) => field.type === "displacement" && field.location === "face")
    ?? fields.find((field) => field.type === "displacement");
  if (!displacementField) return undefined;
  return deformationScaleForMagnitude(resultFieldAbsMax(displacementField), displacementField.units);
}

function deformationScaleForSamples(resultMode: ResultMode, samples: FaceResultSample[]) {
  if (resultMode !== "displacement") return 1;
  return deformationScaleForMagnitude(Math.max(0, ...samples.map((sample) => Math.abs(sample.value))), "mm");
}

function resultFieldAbsMax(field: ResultField) {
  return Math.max(
    Math.abs(Number(field.min) || 0),
    Math.abs(Number(field.max) || 0),
    ...field.values.map((value) => Math.abs(value)).filter(Number.isFinite),
    ...(field.samples?.map((sample) => Math.abs(sample.value)).filter(Number.isFinite) ?? [])
  );
}

function deformationScaleForMagnitude(magnitude: number, units: string) {
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) return 0;
  const reference = units === "in" ? DEFAULT_DEFORMATION_REFERENCE_MM / 25.4 : DEFAULT_DEFORMATION_REFERENCE_MM;
  return Math.max(0, Math.min(MAX_RESULT_DEFORMATION_SCALE, magnitude / reference));
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
  if (deformationScale <= 1e-9) return point.clone();
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
    const center = new THREE.Vector3(...sample.face.center);
    const direction = markerDirectionInModelSpace(marker);
    const weight = Math.exp(-0.5 * (point.distanceTo(center) / Math.max(span * 0.48, 0.001)) ** 2);
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
    const beamShape = travel * travel * (3 - 2 * travel);
    const magnitude = usesResultDeformationScale ? 1 : Math.max(0.35, marker.value / 500);
    deformation.addScaledVector(markerDirectionInModelSpace(marker), beamShape * scale * magnitude / Math.max(loadMarkers.length, 1));
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
      const beamShape = travel * travel * (3 - 2 * travel);
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

function deformedPointForKind(kind: SampleModelKind, point: THREE.Vector3, stressExaggeration: number, deformationScale: number) {
  const next = point.clone();
  const scale = (0.08 + Math.max(0, stressExaggeration - 1) * 0.12) * deformationScale;
  if (kind === "plate") {
    const span = Math.max(0, Math.min(1, (point.x + 1.9) / 3.8));
    next.y -= scale * 0.9 * span * span;
    next.z += scale * 0.22 * span * (point.z >= 0 ? 1 : -1);
  } else if (kind === "cantilever") {
    const span = Math.max(0, Math.min(1, (point.x + 1.9) / 3.8));
    next.y -= scale * 1.15 * span * span;
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
    const center = new THREE.Vector3(...sample.face.center);
    const weight = Math.exp(-0.5 * (point.distanceTo(center) / Math.max(span * 0.28, 0.001)) ** 2) + 0.015;
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
    const center = new THREE.Vector3(...sample.point);
    const distance = point.distanceTo(center);
    const radius = Math.max(span * 0.055, 0.001);
    const weight = Math.exp(-0.5 * (distance / radius) ** 2);
    weighted += sample.normalized * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 1e-9) {
    const nearest = fieldSamples.reduce<typeof fieldSamples[number] | undefined>((best, sample) => {
      if (!best) return sample;
      return point.distanceTo(new THREE.Vector3(...sample.point)) < point.distanceTo(new THREE.Vector3(...best.point)) ? sample : best;
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
  let span = 1;
  for (const left of samples) {
    for (const right of samples) {
      span = Math.max(span, new THREE.Vector3(...left.face.center).distanceTo(new THREE.Vector3(...right.face.center)));
    }
  }
  return span;
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
  const geometry = new THREE.BoxGeometry(3.8, BEAM_HEIGHT, BEAM_DEPTH, 40, 6, 8);
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
  const field = resultFields.find((candidate) => candidate.type === resultMode && candidate.location === "face");
  if (field?.values.length) {
    const sorted = [...field.values].sort((left, right) => left - right);
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

function ResultLegend({ resultMode, resultFields, unitSystem, meshSummary }: { resultMode: ResultMode; resultFields: ResultField[]; unitSystem: UnitSystem; meshSummary?: MeshSummary }) {
  const title = resultMode === "stress" ? "Von Mises Stress" : resultMode === "displacement" ? "Displacement" : resultMode === "velocity" ? "Velocity" : resultMode === "acceleration" ? "Acceleration" : "Safety Factor";
  const field = resultFields.find((candidate) => candidate.type === resultMode && candidate.location === "face");
  const fallbackMin = resultMode === "stress" ? stressForUnits(28, "MPa", unitSystem) : resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration" ? lengthForUnits(0, "mm", unitSystem) : { value: 1.8, units: "" };
  const fallbackMax = resultMode === "stress" ? stressForUnits(142, "MPa", unitSystem) : resultMode === "displacement" || resultMode === "velocity" || resultMode === "acceleration" ? lengthForUnits(0.184, "mm", unitSystem) : { value: 7.6, units: "" };
  const unit = field?.units ?? fallbackMax.units;
  const minValue = field?.min ?? fallbackMin.value;
  const maxValue = field?.max ?? fallbackMax.value;
  const ticks = displayedLegendTickLabels(minValue, maxValue);
  const meshStats = legendMeshStats(meshSummary);
  return (
    <div className={`analysis-legend ${resultMode === "safety_factor" ? "safety-scale" : ""}`}>
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
  const { camera, size } = useThree();
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
    }

    resetCamera();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimerId);
      if (frameId) window.cancelAnimationFrame(frameId);
      if (retryFrameId) window.cancelAnimationFrame(retryFrameId);
    };
  }, [bounds, camera, controlsRef, signal, size.height, size.width, viewAxis, viewAxisSignal]);
  return null;
}

function GizmoCameraReset({ axis, signal, controlsRef }: { axis: RotationAxis | null; signal: number; controlsRef: MutableRefObject<ViewerOrbitControls | null> }) {
  const bounds = useBounds();
  const { camera, size } = useThree();
  useEffect(() => {
    if (!axis) return;
    const nextBounds = bounds.refresh().clip();
    const { box, center, distance } = nextBounds.getSize();
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    const pose = viewerCameraResetPose(
      box,
      center,
      distance,
      axis,
      perspectiveCamera.isPerspectiveCamera ? perspectiveCamera.fov : undefined,
      size.width / size.height
    );
    applyViewerCameraPose(camera, controlsRef.current, pose);
  }, [axis, bounds, camera, controlsRef, signal, size.height, size.width]);
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
  viewAxis: RotationAxis | null,
  fov: number | undefined,
  aspect: number
): ViewerCameraResetPose {
  const view = viewAxis ? cameraViewForAxis(viewAxis) : { direction: ISO_CAMERA_DIRECTION, up: ISO_CAMERA_UP };
  const target = viewAxis ? center.clone() : defaultHomeViewTarget(box, view.direction, view.up);
  const fitMargin = viewAxis ? VIEWER_FIT_MARGIN : DEFAULT_HOME_FIT_MARGIN;
  const fitDistance = fov
    ? cameraDistanceForBounds(box, view.direction, view.up, fov, aspect, fitMargin)
    : fallbackDistance;
  return {
    position: target.clone().addScaledVector(view.direction, fitDistance),
    target,
    up: view.up.clone()
  };
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
