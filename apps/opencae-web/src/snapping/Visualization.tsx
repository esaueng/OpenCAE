import { Billboard, Line, Text } from "@react-three/drei";
import * as THREE from "three";
import type { HoveredEntity, SnapMeasurement, SnapResult, Vec3 } from "./types";

export function disableSnapOverlayRaycast(_raycaster?: THREE.Raycaster, _intersections?: THREE.Intersection[]) {
  // Snap helpers are visual affordances only; model geometry must remain the pick target.
}

export function SnapVisualization({ result, mode }: { result: SnapResult | null; mode: "loads" | "supports" }) {
  if (!result) return null;
  return (
    <group renderOrder={40}>
      <HoveredEntityHighlight entity={result.hovered} />
      <SnapConstructionGuides result={result} />
      <SnapMeasurementGuides result={result} />
      <SnapIndicator result={result} />
      {mode === "loads" ? <SnapForcePreview result={result} /> : <SnapSupportPreview result={result} />}
    </group>
  );
}

export function snapMeasurementGuides(result: SnapResult): SnapMeasurement[] {
  return result.measurements ?? [];
}

export interface SnapMeasurementRuler {
  line: [Vec3, Vec3];
  ticks: Array<[Vec3, Vec3]>;
  labelPosition: Vec3;
  label: string;
  color: string;
  lineWidth: number;
  opacity: number;
  fontSize: number;
  outlineWidth: number;
  maxWidth: number;
}

export interface SnapConstructionGuide {
  kind: "centerline" | "alignment" | "midpoint-tick";
  points: [Vec3, Vec3];
  color: string;
  lineWidth: number;
  opacity: number;
}

export function snapConstructionGuides(result: SnapResult): SnapConstructionGuide[] {
  if (result.hovered.type === "edge" && result.hovered.endpoints) {
    return [
      { kind: "alignment", points: result.hovered.endpoints, color: "#63e6be", lineWidth: 3.4, opacity: 0.88 },
      { kind: "midpoint-tick", points: midpointTick(result), color: "#f8d77b", lineWidth: 3, opacity: 0.96 }
    ];
  }

  const [firstAxis, secondAxis] = faceGuideAxes(result.hovered.normal ?? result.direction);
  const origin = new THREE.Vector3(...result.hovered.position);
  const halfLength = 0.46;
  return [firstAxis, secondAxis].map((axis) => ({
    kind: "centerline" as const,
    points: [
      origin.clone().add(axis.clone().multiplyScalar(-halfLength)).toArray() as Vec3,
      origin.clone().add(axis.clone().multiplyScalar(halfLength)).toArray() as Vec3
    ],
    color: "#4da3ff",
    lineWidth: 2.2,
    opacity: 0.72
  }));
}

function SnapConstructionGuides({ result }: { result: SnapResult }) {
  return (
    <group>
      {snapConstructionGuides(result).map((guide, index) => (
        <Line key={`${guide.kind}-${index}`} points={guide.points} color={guide.color} lineWidth={guide.lineWidth} transparent opacity={guide.opacity} raycast={disableSnapOverlayRaycast} />
      ))}
    </group>
  );
}

function SnapMeasurementGuides({ result }: { result: SnapResult }) {
  return (
    <group>
      {snapMeasurementGuides(result).map((measurement, index) => (
        <EdgeDistanceGuide key={`${measurement.kind}-${index}`} measurement={measurement} normal={result.hovered.normal ?? result.direction} />
      ))}
    </group>
  );
}

function EdgeDistanceGuide({ measurement, normal }: { measurement: SnapMeasurement; normal: Vec3 }) {
  const ruler = snapMeasurementRuler(measurement, normal);
  return (
    <group>
      <Line points={ruler.line} color={ruler.color} lineWidth={ruler.lineWidth} transparent opacity={ruler.opacity} raycast={disableSnapOverlayRaycast} />
      {ruler.ticks.map((tick, index) => (
        <Line key={`tick-${index}`} points={tick} color={ruler.color} lineWidth={ruler.lineWidth} transparent opacity={ruler.opacity} raycast={disableSnapOverlayRaycast} />
      ))}
      <Billboard position={ruler.labelPosition} renderOrder={52}>
        <Text
          anchorX="center"
          anchorY="middle"
          color="#dbeafe"
          material-depthTest={false}
          material-depthWrite={false}
          material-toneMapped={false}
          fontSize={ruler.fontSize}
          letterSpacing={0}
          maxWidth={ruler.maxWidth}
          outlineColor="#03101d"
          outlineOpacity={0.74}
          outlineWidth={ruler.outlineWidth}
          raycast={disableSnapOverlayRaycast}
        >
          {ruler.label}
        </Text>
      </Billboard>
    </group>
  );
}

export function snapMeasurementRuler(measurement: SnapMeasurement, normal: Vec3): SnapMeasurementRuler {
  const start = new THREE.Vector3(...measurement.start);
  const end = new THREE.Vector3(...measurement.end);
  const faceNormal = new THREE.Vector3(...normal).normalize();
  const lineDirection = end.clone().sub(start).normalize();
  const tickDirection = rulerTickDirection(faceNormal, lineDirection);
  const lift = faceNormal.clone().multiplyScalar(0.014);
  const labelOffset = tickDirection.clone().multiplyScalar(0.066).add(faceNormal.clone().multiplyScalar(0.022));
  const liftedStart = start.clone().add(lift);
  const liftedEnd = end.clone().add(lift);
  const midpoint = liftedStart.clone().add(liftedEnd).multiplyScalar(0.5);
  return {
    line: [liftedStart.toArray() as Vec3, liftedEnd.toArray() as Vec3],
    ticks: [
      rulerTick(liftedStart, tickDirection, 0.04),
      rulerTick(midpoint, tickDirection, 0.026),
      rulerTick(liftedEnd, tickDirection, 0.04)
    ],
    labelPosition: midpoint.add(labelOffset).toArray() as Vec3,
    label: measurement.label,
    color: "#8cc8ff",
    lineWidth: 1.15,
    opacity: 0.62,
    fontSize: 0.052,
    outlineWidth: 0.005,
    maxWidth: 0.8
  };
}

function rulerTick(origin: THREE.Vector3, direction: THREE.Vector3, halfLength: number): [Vec3, Vec3] {
  return [
    origin.clone().add(direction.clone().multiplyScalar(-halfLength)).toArray() as Vec3,
    origin.clone().add(direction.clone().multiplyScalar(halfLength)).toArray() as Vec3
  ];
}

function rulerTickDirection(normal: THREE.Vector3, lineDirection: THREE.Vector3) {
  const tickDirection = new THREE.Vector3().crossVectors(normal, lineDirection).normalize();
  if (tickDirection.lengthSq() < 0.001) return perpendicularAxis(lineDirection);
  return tickDirection;
}

export function HoveredEntityHighlight({ entity }: { entity: HoveredEntity }) {
  const color = entity.type === "vertex" ? "#f8d77b" : entity.type === "edge" ? "#63e6be" : "#4da3ff";
  if (entity.type === "edge" && entity.endpoints) {
    return <Line points={entity.endpoints} color={color} lineWidth={3} transparent opacity={0.92} raycast={disableSnapOverlayRaycast} />;
  }
  return (
    <Billboard position={entity.position}>
      <mesh raycast={disableSnapOverlayRaycast}>
        <ringGeometry args={[0.05, 0.07, 28]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} transparent opacity={0.92} />
      </mesh>
    </Billboard>
  );
}

export function SnapIndicator({ result }: { result: SnapResult }) {
  const style = snapIndicatorStyle(result);
  return (
    <Billboard position={result.rawSnapPoint}>
      <group>
        <mesh raycast={disableSnapOverlayRaycast}>
          <ringGeometry args={[style.ringInnerRadius, style.ringOuterRadius, 28]} />
          <meshBasicMaterial color={style.color} depthTest={false} toneMapped={false} transparent opacity={style.ringOpacity} />
        </mesh>
        <mesh raycast={disableSnapOverlayRaycast}>
          <sphereGeometry args={[style.dotRadius, 14, 14]} />
          <meshBasicMaterial color={style.color} depthTest={false} toneMapped={false} transparent opacity={style.dotOpacity} />
        </mesh>
      </group>
    </Billboard>
  );
}

export function SnapForcePreview({ result }: { result: SnapResult }) {
  const end = new THREE.Vector3(...result.rawSnapPoint);
  const direction = new THREE.Vector3(...result.direction).normalize();
  const style = snapPreviewArrowStyle();
  const start = end.clone().add(direction.clone().multiplyScalar(-style.length));
  return <PreviewArrow start={start.toArray() as Vec3} end={end.toArray() as Vec3} color={style.color} lineWidth={style.lineWidth} opacity={style.opacity} showHead={style.showHead} />;
}

export function SnapSupportPreview({ result }: { result: SnapResult }) {
  const normal = new THREE.Vector3(...result.direction).normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  return (
    <group position={result.rawSnapPoint} quaternion={quaternion}>
      <mesh raycast={disableSnapOverlayRaycast}>
        <circleGeometry args={[0.095, 28]} />
        <meshBasicMaterial color="#4da3ff" transparent opacity={0.58} side={THREE.DoubleSide} depthTest={false} toneMapped={false} />
      </mesh>
      <Line points={[[-0.11, -0.11, 0.01], [0.11, 0.11, 0.01]]} color="#4da3ff" lineWidth={2} raycast={disableSnapOverlayRaycast} />
      <Line points={[[0.11, -0.11, 0.01], [-0.11, 0.11, 0.01]]} color="#4da3ff" lineWidth={2} raycast={disableSnapOverlayRaycast} />
    </group>
  );
}

export function snapIndicatorStyle(result: Pick<SnapResult, "candidateKind">) {
  const color = result.candidateKind === "edge-midpoint" ? "#63e6be" : result.candidateKind === "vertex" ? "#f8d77b" : "#4da3ff";
  return {
    color,
    ringInnerRadius: 0.032,
    ringOuterRadius: 0.044,
    ringOpacity: 0.88,
    dotRadius: 0.013,
    dotOpacity: 0.95
  };
}

export function snapPreviewArrowStyle() {
  return {
    color: "#8cc8ff",
    length: 0.28,
    lineWidth: 1.45,
    opacity: 0.58,
    showHead: false
  };
}

function PreviewArrow({ start, end, color, lineWidth = 2.4, opacity = 0.86, showHead = true }: { start: Vec3; end: Vec3; color: string; lineWidth?: number; opacity?: number; showHead?: boolean }) {
  const direction = new THREE.Vector3(...end).sub(new THREE.Vector3(...start)).normalize();
  const conePosition = new THREE.Vector3(...end).sub(direction.clone().multiplyScalar(0.035));
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  return (
    <group>
      <Line points={[start, end]} color={color} lineWidth={lineWidth} transparent opacity={opacity} raycast={disableSnapOverlayRaycast} />
      {showHead && (
        <mesh position={conePosition.toArray()} quaternion={quaternion} raycast={disableSnapOverlayRaycast}>
          <coneGeometry args={[0.055, 0.14, 18]} />
          <meshBasicMaterial color={color} depthTest={false} toneMapped={false} transparent opacity={opacity} />
        </mesh>
      )}
    </group>
  );
}

function midpointTick(result: SnapResult): [Vec3, Vec3] {
  const endpoints = result.hovered.endpoints;
  if (!endpoints) return [result.rawSnapPoint, result.rawSnapPoint];
  const edgeDirection = new THREE.Vector3(...endpoints[1]).sub(new THREE.Vector3(...endpoints[0])).normalize();
  const faceNormal = new THREE.Vector3(...(result.hovered.normal ?? [0, 0, 1])).normalize();
  let tickDirection = new THREE.Vector3().crossVectors(faceNormal, edgeDirection).normalize();
  if (tickDirection.lengthSq() < 0.001) tickDirection = perpendicularAxis(edgeDirection);
  const origin = new THREE.Vector3(...result.rawSnapPoint);
  return [
    origin.clone().add(tickDirection.clone().multiplyScalar(-0.14)).toArray() as Vec3,
    origin.clone().add(tickDirection.clone().multiplyScalar(0.14)).toArray() as Vec3
  ];
}

function faceGuideAxes(normalValue: Vec3): [THREE.Vector3, THREE.Vector3] {
  const normal = new THREE.Vector3(...normalValue).normalize();
  const reference = Math.abs(normal.z) > 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const firstAxis = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const secondAxis = new THREE.Vector3().crossVectors(normal, firstAxis).normalize();
  return [firstAxis, secondAxis];
}

function perpendicularAxis(axis: THREE.Vector3) {
  const reference = Math.abs(axis.z) > 0.85 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3().crossVectors(axis, reference).normalize();
}
