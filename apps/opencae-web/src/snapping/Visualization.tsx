import { Billboard, Line, Text } from "@react-three/drei";
import * as THREE from "three";
import type { HoveredEntity, SnapMeasurement, SnapResult, Vec3 } from "./types";

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
        <Line key={`${guide.kind}-${index}`} points={guide.points} color={guide.color} lineWidth={guide.lineWidth} transparent opacity={guide.opacity} />
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
  const start = new THREE.Vector3(...measurement.start);
  const end = new THREE.Vector3(...measurement.end);
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const normalOffset = new THREE.Vector3(...normal).normalize().multiplyScalar(0.055);
  const labelPosition = midpoint.clone().add(normalOffset);
  return (
    <group>
      <Line points={[measurement.start, measurement.end]} color="#f8d77b" lineWidth={2.1} transparent opacity={0.88} />
      <Billboard position={labelPosition.toArray() as Vec3} renderOrder={52}>
        <Text
          anchorX="center"
          anchorY="middle"
          color="#fef3c7"
          material-depthTest={false}
          material-depthWrite={false}
          material-toneMapped={false}
          fontSize={0.105}
          letterSpacing={0}
          maxWidth={1.4}
          outlineColor="#1f1300"
          outlineOpacity={0.9}
          outlineWidth={0.015}
        >
          {measurement.label}
        </Text>
      </Billboard>
    </group>
  );
}

export function HoveredEntityHighlight({ entity }: { entity: HoveredEntity }) {
  const color = entity.type === "vertex" ? "#f8d77b" : entity.type === "edge" ? "#63e6be" : "#4da3ff";
  if (entity.type === "edge" && entity.endpoints) {
    return <Line points={entity.endpoints} color={color} lineWidth={3} transparent opacity={0.92} />;
  }
  return (
    <Billboard position={entity.position}>
      <mesh>
        <ringGeometry args={[0.05, 0.07, 28]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} transparent opacity={0.92} />
      </mesh>
    </Billboard>
  );
}

export function SnapIndicator({ result }: { result: SnapResult }) {
  const color = result.candidateKind === "edge-midpoint" ? "#63e6be" : result.candidateKind === "vertex" ? "#f8d77b" : "#4da3ff";
  return (
    <Billboard position={result.rawSnapPoint}>
      <group>
        <mesh>
          <ringGeometry args={[0.055, 0.083, 32]} />
          <meshBasicMaterial color={color} depthTest={false} toneMapped={false} transparent opacity={0.94} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.027, 18, 18]} />
          <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
        </mesh>
        <Line points={[[-0.115, 0, 0], [0.115, 0, 0]]} color={color} lineWidth={2} transparent opacity={0.9} />
        <Line points={[[0, -0.115, 0], [0, 0.115, 0]]} color={color} lineWidth={2} transparent opacity={0.9} />
      </group>
    </Billboard>
  );
}

export function SnapForcePreview({ result }: { result: SnapResult }) {
  const end = new THREE.Vector3(...result.rawSnapPoint);
  const direction = new THREE.Vector3(...result.direction).normalize();
  const start = end.clone().add(direction.clone().multiplyScalar(-0.42));
  return <PreviewArrow start={start.toArray() as Vec3} end={end.toArray() as Vec3} color="#f59e0b" />;
}

export function SnapSupportPreview({ result }: { result: SnapResult }) {
  const normal = new THREE.Vector3(...result.direction).normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  return (
    <group position={result.rawSnapPoint} quaternion={quaternion}>
      <mesh>
        <circleGeometry args={[0.095, 28]} />
        <meshBasicMaterial color="#4da3ff" transparent opacity={0.58} side={THREE.DoubleSide} depthTest={false} toneMapped={false} />
      </mesh>
      <Line points={[[-0.11, -0.11, 0.01], [0.11, 0.11, 0.01]]} color="#4da3ff" lineWidth={2} />
      <Line points={[[0.11, -0.11, 0.01], [-0.11, 0.11, 0.01]]} color="#4da3ff" lineWidth={2} />
    </group>
  );
}

function PreviewArrow({ start, end, color }: { start: Vec3; end: Vec3; color: string }) {
  const direction = new THREE.Vector3(...end).sub(new THREE.Vector3(...start)).normalize();
  const conePosition = new THREE.Vector3(...end).sub(direction.clone().multiplyScalar(0.035));
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  return (
    <group>
      <Line points={[start, end]} color={color} lineWidth={2.4} transparent opacity={0.86} />
      <mesh position={conePosition.toArray()} quaternion={quaternion}>
        <coneGeometry args={[0.055, 0.14, 18]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} transparent opacity={0.86} />
      </mesh>
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
