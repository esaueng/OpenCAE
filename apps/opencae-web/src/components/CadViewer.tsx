import { useEffect, useMemo, useRef, useState } from "react";
import type { ElementRef, MutableRefObject } from "react";
import { Billboard, Bounds, Edges, GizmoHelper, Grid, Html, Line, OrbitControls, Text, useBounds, useGizmoContext } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import type { DisplayFace, DisplayModel, ResultField } from "@opencae/schema";
import { RotateCcw } from "lucide-react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { StepId } from "./StepBar";
import { faceForModelHit, type SampleModelKind } from "../modelSelection";
import { resultSamplesForFaces, type FaceResultSample } from "../resultFields";

export type ViewMode = "model" | "mesh" | "results";
export type ResultMode = "stress" | "displacement" | "safety_factor";
export type ThemeMode = "dark" | "light";
export interface ViewerLoadMarker {
  id: string;
  faceId: string;
  type: string;
  value: number;
  units: string;
  direction: [number, number, number];
  directionLabel: string;
  stackIndex: number;
  preview?: boolean;
}

export interface ViewerSupportMarker {
  id: string;
  faceId: string;
  type: string;
  label: string;
  stackIndex: number;
}

interface CadViewerProps {
  displayModel: DisplayModel;
  activeStep: StepId;
  selectedFaceId: string | null;
  onSelectFace: (face: DisplayFace) => void;
  viewMode: ViewMode;
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  themeMode: ThemeMode;
  fitSignal: number;
  loadMarkers: ViewerLoadMarker[];
  supportMarkers: ViewerSupportMarker[];
  onResetView: () => void;
}

const BRACKET_DEPTH = 1.1;
const RIB_DEPTH = 0.38;
const PLATE_DEPTH = 0.32;
const ISO_CAMERA_DIRECTION = new THREE.Vector3(1, 1, 1).normalize();
const ISO_CAMERA_UP = new THREE.Vector3(0, 1, 0).projectOnPlane(ISO_CAMERA_DIRECTION).normalize();
const BRACKET_HOLES = [
  { id: "upright-hole", center: [-1.2, 1.48] as [number, number], radius: 0.17, supported: false },
  { id: "base-hole-left", center: [0.24, 0] as [number, number], radius: 0.13, supported: true },
  { id: "base-hole-right", center: [1.2, 0] as [number, number], radius: 0.13, supported: true }
];
type ViewerOrbitControls = ElementRef<typeof OrbitControls>;
type ModelSelectionHit = { face: DisplayFace; point: [number, number, number] };
type ModelPickHandlers = {
  onPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: () => void;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
};

export function CadViewer(props: CadViewerProps) {
  const controlsRef = useRef<ViewerOrbitControls | null>(null);
  const effectiveViewMode: ViewMode = props.activeStep === "results" ? props.viewMode : props.viewMode === "mesh" ? "mesh" : "model";
  const isLightTheme = props.themeMode === "light";
  const viewportBackground = isLightTheme ? "#f7f9fc" : "#070b10";
  const gridCellColor = isLightTheme ? "#d9e0ea" : "#263140";
  const gridSectionColor = isLightTheme ? "#c2ccd8" : "#3a4654";
  return (
    <section className={`viewer-shell ${effectiveViewMode === "results" ? "results-view" : ""}`} aria-label="3D CAD viewer">
      <Canvas camera={{ position: [4.8, 4.8, 4.8], up: ISO_CAMERA_UP.toArray(), fov: 42 }}>
        <color attach="background" args={[viewportBackground]} />
        <ambientLight intensity={effectiveViewMode === "results" || isLightTheme ? 1.4 : 0.75} />
        <directionalLight position={[4, 6, 3]} intensity={effectiveViewMode === "results" || isLightTheme ? 1.45 : 2.2} />
        <Grid args={[8, 8]} cellColor={gridCellColor} sectionColor={gridSectionColor} fadeDistance={12} fadeStrength={1.2} position={[0, -0.27, 0]} />
        <Bounds fit clip observe margin={1.65}>
          <BracketModel {...props} viewMode={effectiveViewMode} />
          <BoundsCameraReset signal={props.fitSignal} />
        </Bounds>
        <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.08} target={[0, 1.05, 0]} />
        <ShiftPanControls controlsRef={controlsRef} />
        <GizmoHelper alignment="bottom-left" margin={[92, 92]}>
          <CleanAxisGizmo />
        </GizmoHelper>
      </Canvas>
      <div className="viewer-hud">
        <button className="viewer-reset" type="button" onClick={props.onResetView} title="Reset view">
          <RotateCcw size={15} aria-hidden="true" />
          Reset View
        </button>
      </div>
      {effectiveViewMode === "results" && <ResultLegend resultMode={props.resultMode} resultFields={props.resultFields} />}
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

function CleanAxisGizmo() {
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
          <AxisHead {...axis} />
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

function AxisHead({ label, color, position }: { label: "X" | "Y" | "Z"; color: string; position: [number, number, number] }) {
  const { tweenCamera } = useGizmoContext();
  return (
    <Billboard
      position={position}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        tweenCamera(new THREE.Vector3(...position));
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

function BracketModel({ displayModel, activeStep, selectedFaceId, onSelectFace, viewMode, resultMode, showDeformed, stressExaggeration, resultFields, loadMarkers, supportMarkers }: CadViewerProps) {
  const [hoveredHit, setHoveredHit] = useState<ModelSelectionHit | null>(null);
  const [selectedHit, setSelectedHit] = useState<ModelSelectionHit | null>(null);
  const modelKind = modelKindForDisplayModel(displayModel);
  const materialColor = useMemo(() => colorForResult(displayModel.faces, viewMode, resultMode), [displayModel.faces, resultMode, viewMode]);
  const showResultMarkers = viewMode === "results" && activeStep === "results";
  const isResultView = viewMode === "results";
  const showBoundaryMarkers = !isResultView;
  const placementMode = activeStep === "loads" || activeStep === "supports";
  const activeHit = hoveredHit ?? selectedHit;

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
    const face = faceForModelHit(modelKind, displayModel.faces, event.point);
    return face ? { face, point: event.point.toArray() as [number, number, number] } : null;
  }

  const pickHandlers: ModelPickHandlers = {
    onPointerMove: (event) => {
      const hit = hitFromEvent(event);
      setHoveredHit(hit);
    },
    onPointerOut: () => setHoveredHit(null),
    onClick: (event) => {
      const hit = hitFromEvent(event);
      if (!hit) return;
      event.stopPropagation();
      setSelectedHit(hit);
      onSelectFace(hit.face);
    }
  };

  return (
    <group>
      {isResultView ? (
        <AnalysisResultModel
          kind={modelKind}
          displayModel={displayModel}
          resultMode={resultMode}
          showDeformed={showDeformed}
          stressExaggeration={stressExaggeration}
          resultFields={resultFields}
          loadMarkers={loadMarkers.filter((marker) => !marker.preview)}
        />
      ) : (
        <SampleSolid kind={modelKind} displayModel={displayModel} color={materialColor("face-base-bottom")} pickHandlers={pickHandlers} />
      )}
      <HoleRims kind={modelKind} />
      {viewMode === "mesh" && <MeshOverlay kind={modelKind} />}
      {activeHit && <ModelHitLabel hit={activeHit} active={activeHit.face.id === selectedFaceId} />}
      {showBoundaryMarkers && loadMarkers.map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        return face ? <LoadGlyph key={marker.id} marker={marker} face={face} active={activeStep === "loads"} /> : null;
      })}
      {showBoundaryMarkers && supportMarkers.map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        return face ? <SupportGlyph key={marker.id} kind={modelKind} marker={marker} face={face} active={activeStep === "supports"} /> : null;
      })}
      {showResultMarkers && resultProbesForKind(modelKind, resultMode, resultFields).map((probe) => <ResultProbe key={`${probe.tone}-${probe.label}`} {...probe} />)}
    </group>
  );
}

function modelKindForDisplayModel(displayModel: DisplayModel): SampleModelKind {
  if (displayModel.bodyCount === 0 || displayModel.id.includes("blank")) return "blank";
  if (displayModel.id.includes("uploaded")) return "uploaded";
  if (displayModel.id.includes("plate")) return "plate";
  if (displayModel.id.includes("cantilever")) return "cantilever";
  return "bracket";
}

function SampleSolid({ kind, color, displayModel, pickHandlers }: { kind: SampleModelKind; color: string; displayModel?: DisplayModel; pickHandlers?: ModelPickHandlers }) {
  if (kind === "blank") return null;
  if (kind === "uploaded") return <UploadedSolid displayModel={displayModel} color={color} pickHandlers={pickHandlers} />;
  if (kind === "plate") return <PlateSolid color={color} pickHandlers={pickHandlers} />;
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

function PlateSolid({ color, pickHandlers }: { color: string; pickHandlers?: ModelPickHandlers }) {
  const plateGeometry = useMemo(() => createPlateGeometry(), []);
  return (
    <mesh {...pickHandlers}>
      <primitive attach="geometry" object={plateGeometry} />
      <meshStandardMaterial color={color} metalness={0.2} roughness={0.5} />
      <Edges color="#c8d3df" threshold={15} />
    </mesh>
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

function UploadedSolid({ displayModel, color, pickHandlers }: { displayModel?: DisplayModel; color: string; pickHandlers?: ModelPickHandlers }) {
  if (!displayModel?.visualMesh) return <UnsupportedUploadedModelNotice filename={displayModel?.name ?? "Uploaded model"} />;
  if (displayModel.visualMesh.format === "obj") return <UploadedObjModel displayModel={displayModel} pickHandlers={pickHandlers} />;
  return <UploadedStlModel displayModel={displayModel} color={color} pickHandlers={pickHandlers} />;
}

function UploadedStlModel({ displayModel, color, pickHandlers }: { displayModel: DisplayModel; color: string; pickHandlers?: ModelPickHandlers }) {
  const geometry = useMemo(() => {
    const parsed = new STLLoader().parse(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? ""));
    normalizeGeometry(parsed);
    parsed.computeVertexNormals();
    return parsed;
  }, [displayModel.visualMesh?.contentBase64]);

  return (
    <mesh geometry={geometry} {...pickHandlers}>
      <meshStandardMaterial color={color} metalness={0.18} roughness={0.54} />
      <Edges color="#c8d3df" threshold={15} />
    </mesh>
  );
}

function UploadedObjModel({ displayModel, pickHandlers }: { displayModel: DisplayModel; pickHandlers?: ModelPickHandlers }) {
  const object = useMemo(() => {
    const text = new TextDecoder().decode(base64ToArrayBuffer(displayModel.visualMesh?.contentBase64 ?? ""));
    const parsed = new OBJLoader().parse(text);
    const box = new THREE.Box3().setFromObject(parsed);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
    parsed.position.sub(center);
    parsed.scale.setScalar(2.4 / maxDimension);
    parsed.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = new THREE.MeshStandardMaterial({ color: "#9aa7b4", metalness: 0.18, roughness: 0.54 });
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return parsed;
  }, [displayModel.visualMesh?.contentBase64]);

  return <primitive object={object} {...pickHandlers} />;
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
        <small>This local viewer can preview STL or OBJ meshes. Replace this model with a supported mesh file.</small>
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
  loadMarkers
}: {
  kind: SampleModelKind;
  displayModel: DisplayModel;
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  resultFields: ResultField[];
  loadMarkers: ViewerLoadMarker[];
}) {
  if (kind === "blank") return null;
  const samples = resultSamplesForFaces(displayModel.faces, resultFields, resultMode);
  if (kind === "bracket") {
    return <BracketResultSolid kind={kind} samples={samples} resultMode={resultMode} showDeformed={showDeformed} stressExaggeration={stressExaggeration} loadMarkers={loadMarkers} />;
  }
  return <SampleResultSolid kind={kind} samples={samples} resultMode={resultMode} showDeformed={showDeformed} stressExaggeration={stressExaggeration} loadMarkers={loadMarkers} />;
}

function BracketResultSolid({
  kind,
  samples,
  resultMode,
  showDeformed,
  stressExaggeration,
  loadMarkers
}: {
  kind: SampleModelKind;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  loadMarkers: ViewerLoadMarker[];
}) {
  const bodyGeometry = useMemo(
    () => colorizeResultGeometry(createBracketBodyGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers),
    [kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration]
  );
  const ribGeometry = useMemo(
    () => colorizeResultGeometry(createRibGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers),
    [kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration]
  );
  return (
    <group>
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
  loadMarkers
}: {
  kind: SampleModelKind;
  samples: FaceResultSample[];
  resultMode: ResultMode;
  showDeformed: boolean;
  stressExaggeration: number;
  loadMarkers: ViewerLoadMarker[];
}) {
  const plateGeometry = useMemo(
    () => colorizeResultGeometry(createPlateGeometry(), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers),
    [kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration]
  );
  const cantileverGeometry = useMemo(
    () => colorizeResultGeometry(new THREE.BoxGeometry(3.8, 0.5, 0.72, 40, 8, 8), kind, resultMode, showDeformed, stressExaggeration, samples, loadMarkers),
    [kind, loadMarkers, resultMode, samples, showDeformed, stressExaggeration]
  );
  if (kind === "plate") {
    return (
      <mesh geometry={plateGeometry}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} side={THREE.DoubleSide} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
    );
  }
  if (kind === "cantilever") {
    return (
      <mesh geometry={cantileverGeometry} position={[0, 0.18, 0]}>
        <meshStandardMaterial vertexColors metalness={0.18} roughness={0.52} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
    );
  }
  return <SampleSolid kind={kind} color={resultPalette(resultMode).body[2] ?? "#9aa7b4"} />;
}

function colorizeResultGeometry(
  geometry: THREE.BufferGeometry,
  kind: SampleModelKind,
  resultMode: ResultMode,
  showDeformed: boolean,
  stressExaggeration: number,
  samples: FaceResultSample[],
  loadMarkers: ViewerLoadMarker[]
) {
  const colors: number[] = [];
  const positions = geometry.getAttribute("position");
  const color = new THREE.Color();
  for (let index = 0; index < positions.count; index += 1) {
    const point = new THREE.Vector3(positions.getX(index), positions.getY(index), positions.getZ(index));
    color.copy(resultColorForPoint(kind, resultMode, stressExaggeration, point, samples));
    colors.push(color.r, color.g, color.b);
    if (showDeformed) {
      const deformed = deformedPointForResults(kind, point, stressExaggeration, samples, loadMarkers);
      positions.setXYZ(index, deformed.x, deformed.y, deformed.z);
    }
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function deformedPointForResults(kind: SampleModelKind, point: THREE.Vector3, stressExaggeration: number, samples: FaceResultSample[], loadMarkers: ViewerLoadMarker[]) {
  if (!loadMarkers.length) return deformedPointForKind(kind, point, stressExaggeration);
  const next = point.clone();
  const span = resultSampleSpan(samples);
  const scale = 0.045 + Math.max(0, stressExaggeration - 1) * 0.075;
  const deformation = new THREE.Vector3();
  for (const marker of loadMarkers) {
    const sample = samples.find((item) => item.face.id === marker.faceId);
    if (!sample) continue;
    const center = new THREE.Vector3(...sample.face.center);
    const direction = new THREE.Vector3(...marker.direction).normalize();
    const weight = Math.exp(-0.5 * (point.distanceTo(center) / Math.max(span * 0.48, 0.001)) ** 2);
    deformation.addScaledVector(direction, weight * scale * Math.max(0.35, marker.value / 500));
  }
  return next.add(deformation);
}

function deformedPointForKind(kind: SampleModelKind, point: THREE.Vector3, stressExaggeration: number) {
  const next = point.clone();
  const scale = 0.08 + Math.max(0, stressExaggeration - 1) * 0.12;
  if (kind === "plate") {
    const span = Math.max(0, Math.min(1, (point.x + 1.9) / 3.8));
    const holeInfluence = gaussian2d(point.x, point.y, 0, 0, 0.58, 0.58);
    next.y -= scale * span * span;
    next.z += scale * 0.52 * span * (point.y >= 0 ? 1 : -1) + holeInfluence * scale * 0.18;
  } else if (kind === "cantilever") {
    const span = Math.max(0, Math.min(1, (point.x + 1.9) / 3.8));
    next.y -= scale * 1.15 * span * span;
    next.z += scale * 0.28 * span * (point.z >= 0 ? 1 : -1);
  }
  return next;
}

function resultColorForPoint(kind: SampleModelKind, resultMode: ResultMode, stressExaggeration: number, point: THREE.Vector3, samples: FaceResultSample[]) {
  const sampleValue = resultFractionFromSamples(point, samples);
  const stress = sampleValue ?? stressFractionForPoint(kind, point);
  const displacement = sampleValue ?? displacementFractionForPoint(kind, point);
  const t = resultMode === "displacement"
    ? displacement
    : resultMode === "safety_factor"
      ? sampleValue ?? (1 - stress * 0.88)
      : Math.max(0, Math.min(1, 0.5 + (stress - 0.5) * stressExaggeration));
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
    const hole = gaussian2d(point.x, point.y, 0.02, 0.31, 0.54, 0.34);
    const clamp = gaussian2d(point.x, point.y, -1.55, 0, 0.42, 0.76);
    const load = gaussian2d(point.x, point.y, 1.42, 0, 0.48, 0.46);
    return Math.max(0, Math.min(1, 0.12 + hole * 0.72 + clamp * 0.26 + load * 0.22));
  }
  if (kind === "cantilever") {
    const fixedEnd = gaussian2d(point.x, point.y, -1.8, 0, 0.38, 0.42);
    const topFiber = gaussian2d(point.x, point.y, -1.0, 0.25, 1.2, 0.16);
    const loadEnd = gaussian2d(point.x, point.y, 1.65, -0.05, 0.5, 0.32);
    return Math.max(0, Math.min(1, 0.08 + fixedEnd * 0.78 + topFiber * 0.28 + loadEnd * 0.16));
  }
  return 0.45;
}

function displacementFractionForPoint(kind: SampleModelKind, point: THREE.Vector3) {
  if (kind === "plate") return Math.max(0, Math.min(1, 0.12 + ((point.x + 1.9) / 3.8) * 0.82));
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
  const mode = resultMode === "stress" ? 0 : resultMode === "displacement" ? 1 : 2;
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

function createPlateGeometry() {
  const geometry = new THREE.ExtrudeGeometry(createPlateShape(), {
    depth: PLATE_DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.01,
    bevelSize: 0.01,
    bevelSegments: 2,
    curveSegments: 64
  });
  geometry.translate(0, 0, -PLATE_DEPTH / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function createPlateShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-1.9, -0.75);
  shape.lineTo(1.9, -0.75);
  shape.lineTo(1.9, 0.75);
  shape.lineTo(-1.9, 0.75);
  shape.closePath();

  const hole = new THREE.Path();
  hole.absellipse(0, 0, 0.3, 0.3, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return shape;
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

function normalizeGeometry(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(2.4 / maxDimension, 2.4 / maxDimension, 2.4 / maxDimension);
  geometry.computeBoundingBox();
}

type ResultProbeConfig = { label: string; anchor: [number, number, number]; labelPosition: [number, number, number]; tone: "max" | "mid" | "min" };

function resultProbesForKind(kind: SampleModelKind, resultMode: ResultMode, resultFields: ResultField[]): ResultProbeConfig[] {
  const labels = resultProbeLabels(resultMode, resultFields);
  if (kind === "plate") {
    return [
      { label: labels.max, anchor: [0.08, 0.3, PLATE_DEPTH / 2 + 0.07], labelPosition: [-0.55, 0.78, 0.62], tone: "max" },
      { label: labels.mid, anchor: [-1.46, 0, PLATE_DEPTH / 2 + 0.06], labelPosition: [-1.1, -0.62, 0.58], tone: "mid" },
      { label: labels.min, anchor: [1.72, -0.48, PLATE_DEPTH / 2 + 0.06], labelPosition: [1.22, -0.96, 0.58], tone: "min" }
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

function resultProbeLabels(resultMode: ResultMode, resultFields: ResultField[]) {
  const field = resultFields.find((candidate) => candidate.type === resultMode && candidate.location === "face");
  if (field?.values.length) {
    const sorted = [...field.values].sort((left, right) => left - right);
    const min = sorted[0] ?? field.min;
    const mid = sorted[Math.floor(sorted.length / 2)] ?? (field.min + field.max) / 2;
    const max = sorted.at(-1) ?? field.max;
    const unit = field.units ? ` ${field.units}` : "";
    if (resultMode === "displacement") return { max: `Disp: ${formatResultValue(max)}${unit}`, mid: `Disp: ${formatResultValue(mid)}${unit}`, min: `Disp: ${formatResultValue(min)}${unit}` };
    if (resultMode === "safety_factor") return { max: `FoS: ${formatResultValue(min)}`, mid: `FoS: ${formatResultValue(mid)}`, min: `FoS: ${formatResultValue(max)}` };
    return { max: `Stress: ${formatResultValue(max)}${unit}`, mid: `Stress: ${formatResultValue(mid)}${unit}`, min: `Stress: ${formatResultValue(min)}${unit}` };
  }
  if (resultMode === "displacement") {
    return { max: "Disp: 0.184 mm", mid: "Disp: 0.092 mm", min: "Disp: 0.012 mm" };
  }
  if (resultMode === "safety_factor") {
    return { max: "FoS: 1.8", mid: "FoS: 4.7", min: "FoS: 7.6" };
  }
  return { max: "Stress: 142 MPa", mid: "Stress: 64 MPa", min: "Stress: 28 MPa" };
}

function formatResultValue(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
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
  const labelPosition = new THREE.Vector3(...hit.point).add(new THREE.Vector3(0, 0.12, 0.12));
  return (
    <group>
      <mesh position={hit.point}>
        <sphereGeometry args={[active ? 0.035 : 0.026, 18, 18]} />
        <meshBasicMaterial color={active ? "#4da3ff" : "#f8d77b"} depthTest={false} toneMapped={false} />
      </mesh>
      <SceneLabel label={hit.face.label} position={labelPosition.toArray()} tone={active ? "active-load" : "load"} />
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
  tone: "max" | "mid" | "min" | "load" | "active-load";
}) {
  const labelWidth = Math.max(0.58, label.length * 0.052);
  const colors = sceneLabelColors(tone);
  return (
    <Billboard position={position}>
      <mesh position={[0, 0, -0.012]}>
        <planeGeometry args={[labelWidth, 0.18]} />
        <meshBasicMaterial color={colors.background} transparent opacity={0.94} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments position={[0, 0, -0.008]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(labelWidth, 0.18)]} />
        <lineBasicMaterial color={colors.border} />
      </lineSegments>
      <Text
        anchorX="center"
        anchorY="middle"
        color={colors.text}
        fontSize={0.062}
        letterSpacing={0}
        maxWidth={labelWidth - 0.08}
        outlineColor={colors.background}
        outlineWidth={0.002}
      >
        {label}
      </Text>
    </Billboard>
  );
}

function sceneLabelColors(tone: "max" | "mid" | "min" | "load" | "active-load") {
  if (tone === "max") return { background: "#fee2e2", border: "#ef4444", text: "#111827" };
  if (tone === "mid") return { background: "#fef3c7", border: "#f59e0b", text: "#111827" };
  if (tone === "min") return { background: "#dbeafe", border: "#2563eb", text: "#111827" };
  if (tone === "active-load") return { background: "#071525", border: "#4da3ff", text: "#e6edf3" };
  return { background: "#201809", border: "#f59e0b", text: "#e6edf3" };
}

function SupportGlyph({ kind, marker, face, active }: { kind: SampleModelKind; marker: ViewerSupportMarker; face: DisplayFace; active: boolean }) {
  if (kind === "bracket" && face.id === "face-base-left") {
    const depthOffset = Math.min(marker.stackIndex, 2) * 0.05;
    return (
      <group position={[0, 0, depthOffset]}>
        {BRACKET_HOLES.filter((hole) => hole.supported).map((hole) => (
          <group key={`${marker.id}-${hole.id}`} position={[hole.center[0], hole.center[1], BRACKET_DEPTH / 2 + 0.065]}>
            <SupportBurst radius={hole.radius} active={active} />
          </group>
        ))}
        <SceneLabel
          label={supportLabel(marker)}
          position={[0.72, 0.38 + marker.stackIndex * 0.16, BRACKET_DEPTH / 2 + 0.2]}
          tone={active ? "active-load" : "load"}
        />
      </group>
    );
  }

  const normal = new THREE.Vector3(...face.normal).normalize();
  const center = new THREE.Vector3(...face.center);
  const tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0));
  if (tangent.lengthSq() < 0.001) tangent.set(1, 0, 0);
  tangent.normalize();
  const offset = tangent.multiplyScalar((marker.stackIndex - 0.5) * 0.22);
  const anchor = center.clone().add(offset).add(normal.clone().multiplyScalar(0.04));
  const labelPosition = anchor.clone().add(normal.clone().multiplyScalar(0.32)).add(new THREE.Vector3(0, 0.14, 0));
  return (
    <group>
      <mesh position={anchor.toArray()} rotation={rotationForNormal(face.normal)}>
        <circleGeometry args={[0.12, 36]} />
        <meshBasicMaterial color={active ? "#4da3ff" : "#f59e0b"} transparent opacity={0.88} side={THREE.DoubleSide} />
      </mesh>
      <SupportBurstAt position={anchor.toArray()} normal={normal} active={active} />
      <SceneLabel label={supportLabel(marker)} position={labelPosition.toArray()} tone={active ? "active-load" : "load"} />
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
  const kind = marker.type === "fixed" ? "Fixed" : "Prescribed";
  return `${kind} ${marker.stackIndex + 1}: ${marker.label}`;
}

function ResultLegend({ resultMode, resultFields }: { resultMode: ResultMode; resultFields: ResultField[] }) {
  const title = resultMode === "stress" ? "Von Mises Stress" : resultMode === "displacement" ? "Displacement" : "Safety Factor";
  const field = resultFields.find((candidate) => candidate.type === resultMode && candidate.location === "face");
  const unit = field?.units ?? (resultMode === "stress" ? "MPa" : resultMode === "displacement" ? "mm" : "");
  const minValue = field?.min ?? (resultMode === "stress" ? 28 : resultMode === "displacement" ? 0 : 1.8);
  const maxValue = field?.max ?? (resultMode === "stress" ? 142 : resultMode === "displacement" ? 0.184 : 7.6);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((tick) => formatResultValue(minValue + (maxValue - minValue) * tick));
  const min = `${ticks[0]} Min`;
  const max = `${ticks[4]} Max`;
  return (
    <div className={`analysis-legend ${resultMode === "safety_factor" ? "safety-scale" : ""}`}>
      <strong>Nodes: 42,381</strong>
      <strong>Elements: 26,944</strong>
      <span>Type: {title}</span>
      <span>Unit: {unit || "ratio"}</span>
      <div className="legend-scale" />
      <div className="legend-values">
        <span>{min}</span>
        <span>{ticks[1]}</span>
        <span>{ticks[2]}</span>
        <span>{ticks[3]}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function LoadGlyph({ marker, face, active }: { marker: ViewerLoadMarker; face: DisplayFace; active: boolean }) {
  const markerDirection = new THREE.Vector3(...marker.direction).normalize();
  const isNormalDirection = marker.directionLabel === "Normal";
  const markerColor = marker.preview ? "#7cc7ff" : active ? "#4da3ff" : "#f59e0b";
  const labelTone = active || marker.preview ? "active-load" : "load";

  const normal = new THREE.Vector3(...face.normal).normalize();
  const center = new THREE.Vector3(...face.center);
  const tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0));
  if (tangent.lengthSq() < 0.001) tangent.set(1, 0, 0);
  tangent.normalize();
  const loadOffset = tangent.multiplyScalar((marker.stackIndex - 0.5) * 0.22);
  const arrowDirection = isNormalDirection ? normal : markerDirection;
  const { start, end } = arrowPointsOutsideSurface(center.clone().add(loadOffset), normal, arrowDirection, 0.54);

  return (
    <group>
      <ArrowGlyph start={start} end={end} color={markerColor} />
      <SceneLabel
        label={loadLabel(marker)}
        position={end.clone().add(new THREE.Vector3(0, 0.2, 0)).toArray()}
        tone={labelTone}
      />
    </group>
  );
}

function loadLabel(marker: ViewerLoadMarker) {
  const prefix = marker.preview ? "Preview" : `Load ${marker.stackIndex + 1}`;
  return `${prefix}: ${marker.type} ${marker.value} ${marker.units} ${marker.directionLabel}`;
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
  if (kind === "plate") {
    return (
      <mesh position={[0, 0, PLATE_DEPTH / 2 + 0.025]}>
        <torusGeometry args={[0.31, 0.028, 12, 72]} />
        <meshStandardMaterial color="#b9c8d8" roughness={0.3} metalness={0.6} />
      </mesh>
    );
  }

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
  const plateGeometry = useMemo(() => createPlateGeometry(), []);
  if (kind === "blank") return null;

  if (kind === "plate") {
    return (
      <mesh>
        <primitive attach="geometry" object={plateGeometry} />
        <meshBasicMaterial color="#9ad1ff" wireframe transparent opacity={0.3} />
      </mesh>
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

function BoundsCameraReset({ signal }: { signal: number }) {
  const bounds = useBounds();
  useEffect(() => {
    const nextBounds = bounds.refresh().clip();
    const { center, distance } = nextBounds.getSize();
    const cameraPosition = center.clone().addScaledVector(ISO_CAMERA_DIRECTION, distance * 1.08);
    nextBounds.moveTo(cameraPosition).lookAt({ target: center, up: ISO_CAMERA_UP });
  }, [bounds, signal]);
  return null;
}

function colorForResult(faces: DisplayFace[], viewMode: ViewMode, resultMode: ResultMode) {
  const byId = new Map(faces.map((face) => [face.id, face]));
  return (faceId: string) => {
    if (viewMode !== "results") return "#9aa7b4";
    const face = byId.get(faceId);
    const value = face?.stressValue ?? 60;
    if (resultMode === "displacement") return gradient(value, 28, 142, ["#2f80ed", "#4dd0e1", "#d7f75b"]);
    if (resultMode === "safety_factor") return gradient(142 - value, 0, 114, ["#ef4444", "#f59e0b", "#22c55e"]);
    return gradient(value, 28, 142, ["#2563eb", "#22c55e", "#f59e0b", "#ef4444"]);
  };
}

function resultPalette(resultMode: ResultMode): { body: string[] } {
  if (resultMode === "displacement") {
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
