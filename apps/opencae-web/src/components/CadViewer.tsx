import { useEffect, useMemo, useState } from "react";
import { Billboard, Bounds, Edges, GizmoHelper, Grid, Html, Line, OrbitControls, Text, useBounds, useGizmoContext } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import type { DisplayFace, DisplayModel } from "@opencae/schema";
import { RotateCcw } from "lucide-react";
import * as THREE from "three";
import type { StepId } from "./StepBar";

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
type SampleModelKind = "blank" | "bracket" | "plate" | "cantilever";

export function CadViewer(props: CadViewerProps) {
  const effectiveViewMode: ViewMode = props.activeStep === "results" ? props.viewMode : props.viewMode === "mesh" ? "mesh" : "model";
  const isLightTheme = props.themeMode === "light";
  const viewportBackground = effectiveViewMode === "results" || isLightTheme ? "#f7f9fc" : "#070b10";
  const gridCellColor = effectiveViewMode === "results" || isLightTheme ? "#d9e0ea" : "#263140";
  const gridSectionColor = effectiveViewMode === "results" || isLightTheme ? "#c2ccd8" : "#3a4654";
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
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} target={[0, 1.05, 0]} />
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
      {effectiveViewMode === "results" && <ResultLegend resultMode={props.resultMode} />}
    </section>
  );
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

function BracketModel({ displayModel, activeStep, selectedFaceId, onSelectFace, viewMode, resultMode, showDeformed, stressExaggeration, loadMarkers, supportMarkers }: CadViewerProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const modelKind = modelKindForDisplayModel(displayModel);
  const groupScale: [number, number, number] = showDeformed && viewMode === "results" ? [1.02, 1.06, 1.01] : [1, 1, 1];
  const materialColor = useMemo(() => colorForResult(displayModel.faces, viewMode, resultMode), [displayModel.faces, resultMode, viewMode]);
  const showResultMarkers = viewMode === "results" && activeStep === "results";
  const isResultView = viewMode === "results";

  return (
    <group scale={groupScale}>
      {isResultView ? (
        <AnalysisResultModel kind={modelKind} resultMode={resultMode} stressExaggeration={stressExaggeration} />
      ) : (
        <SampleSolid kind={modelKind} color={materialColor("face-base-bottom")} />
      )}
      <HoleRims kind={modelKind} />
      {viewMode === "mesh" && <MeshOverlay kind={modelKind} />}
      {displayModel.faces.map((face) => (
        <FacePickTarget
          key={face.id}
          face={face}
          modelKind={modelKind}
          placementMode={activeStep === "loads" || activeStep === "supports"}
          selected={selectedFaceId === face.id}
          hovered={hovered === face.id}
          onHover={setHovered}
          onSelect={onSelectFace}
        />
      ))}
      {loadMarkers.map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        return face ? <LoadGlyph key={marker.id} kind={modelKind} marker={marker} face={face} active={activeStep === "loads"} /> : null;
      })}
      {supportMarkers.map((marker) => {
        const face = displayModel.faces.find((item) => item.id === marker.faceId);
        return face ? <SupportGlyph key={marker.id} kind={modelKind} marker={marker} face={face} active={activeStep === "supports"} /> : null;
      })}
      {showResultMarkers && (
        <>
          <ResultProbe label="Stress: 142 MPa" anchor={[-1.18, 2.55, 0.62]} labelPosition={[-0.45, 2.95, 1.05]} tone="max" />
          <ResultProbe label="Stress: 64 MPa" anchor={[-0.34, 0.86, 0.48]} labelPosition={[0.34, 1.24, 1.0]} tone="mid" />
          <ResultProbe label="Stress: 28 MPa" anchor={[2.25, 0.14, 0.62]} labelPosition={[1.75, 0.54, 1.0]} tone="min" />
        </>
      )}
    </group>
  );
}

function modelKindForDisplayModel(displayModel: DisplayModel): SampleModelKind {
  if (displayModel.bodyCount === 0 || displayModel.id.includes("blank")) return "blank";
  if (displayModel.id.includes("plate")) return "plate";
  if (displayModel.id.includes("cantilever")) return "cantilever";
  return "bracket";
}

function SampleSolid({ kind, color }: { kind: SampleModelKind; color: string }) {
  if (kind === "blank") return null;
  if (kind === "plate") return <PlateSolid color={color} />;
  if (kind === "cantilever") return <CantileverSolid color={color} />;
  return <BracketSolid color={color} />;
}

function BracketSolid({ color }: { color: string }) {
  const bodyGeometry = useMemo(() => createBracketBodyGeometry(), []);
  const ribGeometry = useMemo(() => createRibGeometry(), []);
  return (
    <group>
      <mesh>
        <primitive attach="geometry" object={bodyGeometry} />
        <meshStandardMaterial color={color} metalness={0.22} roughness={0.52} />
        <Edges color="#aebdca" threshold={15} />
      </mesh>
      <mesh>
        <primitive attach="geometry" object={ribGeometry} />
        <meshStandardMaterial color="#a8b8c6" metalness={0.18} roughness={0.5} />
        <Edges color="#c8d3df" threshold={15} />
      </mesh>
    </group>
  );
}

function PlateSolid({ color }: { color: string }) {
  const plateGeometry = useMemo(() => createPlateGeometry(), []);
  return (
    <mesh>
      <primitive attach="geometry" object={plateGeometry} />
      <meshStandardMaterial color={color} metalness={0.2} roughness={0.5} />
      <Edges color="#c8d3df" threshold={15} />
    </mesh>
  );
}

function CantileverSolid({ color }: { color: string }) {
  return (
    <mesh position={[0, 0.18, 0]}>
      <boxGeometry args={[3.8, 0.5, 0.72]} />
      <meshStandardMaterial color={color} metalness={0.2} roughness={0.5} />
      <Edges color="#c8d3df" threshold={15} />
    </mesh>
  );
}

function AnalysisResultModel({ kind, resultMode, stressExaggeration }: { kind: SampleModelKind; resultMode: ResultMode; stressExaggeration: number }) {
  if (kind === "blank") return null;
  if (kind !== "bracket") {
    return <SampleSolid kind={kind} color={resultPalette(resultMode).body[2] ?? "#9aa7b4"} />;
  }
  return (
    <group>
      <SmoothBracketBody resultMode={resultMode} stressExaggeration={stressExaggeration} />
      <HoleRims kind="bracket" />
    </group>
  );
}

function SmoothBracketBody({ resultMode, stressExaggeration }: { resultMode: ResultMode; stressExaggeration: number }) {
  const bodyGeometry = useMemo(() => createBracketBodyGeometry(), []);
  const ribGeometry = useMemo(() => createRibGeometry(), []);
  return (
    <group>
      <mesh>
        <primitive attach="geometry" object={bodyGeometry} />
        <ResultMaterial resultMode={resultMode} part="body" stressExaggeration={stressExaggeration} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
      <mesh>
        <primitive attach="geometry" object={ribGeometry} />
        <ResultMaterial resultMode={resultMode} part="rib" stressExaggeration={stressExaggeration} />
        <Edges color="#43556a" threshold={18} />
      </mesh>
    </group>
  );
}

function ResultMaterial({ resultMode, part, stressExaggeration }: { resultMode: ResultMode; part: "body" | "rib"; stressExaggeration: number }) {
  const mode = resultMode === "stress" ? 0 : resultMode === "displacement" ? 1 : 2;
  const partValue = part === "body" ? 0 : 1;
  const uniforms = useMemo(
    () => ({
      uMode: { value: mode },
      uPart: { value: partValue },
      uStressExaggeration: { value: stressExaggeration }
    }),
    [mode, partValue, stressExaggeration]
  );

  return (
    <shaderMaterial
      key={`${part}-${resultMode}-${stressExaggeration}`}
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

  void main() {
    vLocalPosition = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

function ResultProbe({ label, anchor, labelPosition, tone }: { label: string; anchor: [number, number, number]; labelPosition: [number, number, number]; tone: "max" | "mid" | "min" }) {
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

function ResultLegend({ resultMode }: { resultMode: ResultMode }) {
  const title = resultMode === "stress" ? "Von Mises Stress" : resultMode === "displacement" ? "Displacement" : "Safety Factor";
  const unit = resultMode === "stress" ? "MPa" : resultMode === "displacement" ? "mm" : "";
  const min = resultMode === "stress" ? "28 Min" : resultMode === "displacement" ? "0 Min" : "1.8 Min";
  const max = resultMode === "stress" ? "142 Max" : resultMode === "displacement" ? "0.184 Max" : "7.6 Max";
  const mid1 = resultMode === "stress" ? "106" : resultMode === "displacement" ? "0.138" : "6.2";
  const mid2 = resultMode === "stress" ? "85" : resultMode === "displacement" ? "0.092" : "4.7";
  const mid3 = resultMode === "stress" ? "57" : resultMode === "displacement" ? "0.046" : "3.2";
  return (
    <div className={`analysis-legend ${resultMode === "safety_factor" ? "safety-scale" : ""}`}>
      <strong>Nodes: 42,381</strong>
      <strong>Elements: 26,944</strong>
      <span>Type: {title}</span>
      <span>Unit: {unit || "ratio"}</span>
      <div className="legend-scale" />
      <div className="legend-values">
        <span>{min}</span>
        <span>{mid3}</span>
        <span>{mid2}</span>
        <span>{mid1}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function LoadGlyph({ kind, marker, face, active }: { kind: SampleModelKind; marker: ViewerLoadMarker; face: DisplayFace; active: boolean }) {
  const markerDirection = new THREE.Vector3(...marker.direction).normalize();
  const isNormalDirection = marker.directionLabel === "Normal";
  const markerColor = marker.preview ? "#7cc7ff" : active ? "#4da3ff" : "#f59e0b";
  const labelTone = active || marker.preview ? "active-load" : "load";
  if (kind === "bracket" && face.id === "face-load-top") {
    const center = new THREE.Vector3(...face.center);
    const loadOffset = new THREE.Vector3((marker.stackIndex - 0.5) * 0.24, marker.stackIndex * 0.08, 0);
    const faceNormal = new THREE.Vector3(...face.normal).normalize();
    const arrowDirection = isNormalDirection ? faceNormal : markerDirection;
    const tangent = new THREE.Vector3(0, 0, 1);
    const arrowOffsets = marker.type === "gravity" ? [0] : [-0.22, 0, 0.22];
    const arrowLength = marker.type === "pressure" ? 0.42 : marker.type === "gravity" ? 0.76 : 0.58;
    return (
      <group>
        {arrowOffsets.map((zOffset) => (
          <ArrowGlyph
            key={zOffset}
            {...arrowPointsOutsideSurface(center.clone().add(loadOffset).add(tangent.clone().multiplyScalar(zOffset)), faceNormal, arrowDirection, arrowLength)}
            color={markerColor}
            shaftRadius={0.026}
            headRadius={0.105}
            headLength={0.24}
          />
        ))}
        <SceneLabel
          label={loadLabel(marker)}
          position={center.clone().add(loadOffset).add(new THREE.Vector3(0.08, 0.34, 0.36)).toArray()}
          tone={labelTone}
        />
      </group>
    );
  }

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

  if (kind === "cantilever") return null;

  return (
    <>
      {BRACKET_HOLES.map((hole) => (
        <MountHole
          key={hole.id}
          position={[hole.center[0], hole.center[1], BRACKET_DEPTH / 2 + 0.025]}
          radius={hole.radius}
        />
      ))}
    </>
  );
}

function MountHole({ position, radius }: { position: [number, number, number]; radius: number }) {
  return (
    <group position={position}>
      <mesh>
        <torusGeometry args={[radius * 1.08, radius * 0.16, 10, 56]} />
        <meshStandardMaterial color="#b9c8d8" roughness={0.3} metalness={0.6} />
      </mesh>
    </group>
  );
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

function FacePickTarget({
  face,
  modelKind,
  selected,
  hovered,
  placementMode,
  onHover,
  onSelect
}: {
  face: DisplayFace;
  modelKind: SampleModelKind;
  selected: boolean;
  hovered: boolean;
  placementMode: boolean;
  onHover: (id: string | null) => void;
  onSelect: (face: DisplayFace) => void;
}) {
  const scale = selected ? 1.15 : hovered ? 1.08 : 1;
  const color = selected ? "#4da3ff" : hovered ? "#f8d77b" : face.color;
  const rotation = rotationForNormal(face.normal);
  const size = targetSizeForFace(face.id, modelKind, placementMode);
  const opacity = selected || hovered ? 0.5 : placementMode ? 0.26 : 0.18;
  return (
    <mesh
      position={face.center}
      rotation={rotation}
      scale={[scale, scale, scale]}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onHover(face.id);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelect(face);
      }}
    >
      <planeGeometry args={size} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} />
      {(selected || hovered) && <Html center className="face-label">{face.label}</Html>}
    </mesh>
  );
}

function targetSizeForFace(faceId: string, modelKind: SampleModelKind, placementMode: boolean): [number, number] {
  if (!placementMode) return [0.54, 0.42];
  if (modelKind === "plate") {
    if (faceId === "face-base-bottom") return [3.6, 1.35];
    if (faceId === "face-web-front") return [0.86, 0.86];
    return [0.92, 0.9];
  }
  if (modelKind === "cantilever") {
    if (faceId === "face-load-top" || faceId === "face-base-left") return [0.72, 0.72];
    return [2.9, 0.68];
  }
  if (faceId === "face-load-top") return [0.78, 1.08];
  if (faceId === "face-base-bottom") return [2.55, 0.92];
  if (faceId === "face-base-left") return [1.42, 0.5];
  if (faceId === "face-upright-front") return [0.82, 2.2];
  if (faceId === "face-upright-left" || faceId === "face-upright-right") return [1.05, 2.05];
  if (faceId === "face-base-front") return [2.8, 0.56];
  if (faceId === "face-base-end") return [0.74, 0.58];
  if (faceId === "face-rib-side") return [1.02, 0.92];
  return [1.0, 0.7];
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

function gradient(value: number, min: number, max: number, colors: string[]): string {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const index = Math.min(colors.length - 2, Math.floor(t * (colors.length - 1)));
  const localT = t * (colors.length - 1) - index;
  return new THREE.Color(colors[index] ?? colors[0]).lerp(new THREE.Color(colors[index + 1] ?? colors.at(-1)), localT).getStyle();
}

function rotationForNormal(normal: [number, number, number]): [number, number, number] {
  if (Math.abs(normal[0]) > 0.5) return [0, Math.PI / 2, 0];
  if (Math.abs(normal[1]) > 0.5) return [Math.PI / 2, 0, 0];
  return [0, 0, 0];
}
