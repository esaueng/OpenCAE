import { Billboard, Line } from "@react-three/drei";
import * as THREE from "three";
import type { HoveredEntity, SnapResult, Vec3 } from "./types";

export function SnapVisualization({ result, mode }: { result: SnapResult | null; mode: "loads" | "supports" }) {
  if (!result) return null;
  return (
    <group renderOrder={40}>
      <HoveredEntityHighlight entity={result.hovered} />
      <SnapIndicator result={result} />
      {mode === "loads" ? <SnapForcePreview result={result} /> : <SnapSupportPreview result={result} />}
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
      <mesh>
        <sphereGeometry args={[0.038, 18, 18]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
      </mesh>
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
