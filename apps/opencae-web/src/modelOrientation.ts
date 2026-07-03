import type { DisplayModel } from "@opencae/schema";
import * as THREE from "three";

export type RotationAxis = "x" | "y" | "z";

export interface ModelOrientation {
  x: number;
  y: number;
  z: number;
}

const DEFAULT_ORIENTATION: ModelOrientation = { x: 0, y: 0, z: 0 };
const LEGACY_SAMPLE_BASE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];
const NO_BASE_ROTATION: [number, number, number] = [0, 0, 0];

export function getModelOrientation(displayModel: DisplayModel): ModelOrientation {
  return {
    x: normalizeDegrees(displayModel.orientation?.x ?? 0),
    y: normalizeDegrees(displayModel.orientation?.y ?? 0),
    z: normalizeDegrees(displayModel.orientation?.z ?? 0)
  };
}

export function rotateDisplayModel(displayModel: DisplayModel, axis: RotationAxis, degrees = 90): DisplayModel {
  const orientation = getModelOrientation(displayModel);
  return {
    ...displayModel,
    orientation: {
      ...orientation,
      [axis]: normalizeDegrees(orientation[axis] + degrees)
    }
  };
}

export function resetDisplayModelOrientation(displayModel: DisplayModel): DisplayModel {
  return {
    ...displayModel,
    orientation: { ...DEFAULT_ORIENTATION }
  };
}

export function modelRotationRadians(displayModel: DisplayModel): [number, number, number] {
  const orientation = getModelOrientation(displayModel);
  return [
    THREE_DEG_TO_RAD * orientation.x,
    THREE_DEG_TO_RAD * orientation.y,
    THREE_DEG_TO_RAD * orientation.z
  ];
}

export function baseModelRotationRadians(displayModel: DisplayModel): [number, number, number] {
  return isUploadedDisplayModel(displayModel) || displayModel.bodyCount === 0 ? NO_BASE_ROTATION : LEGACY_SAMPLE_BASE_ROTATION;
}

export function modelToViewerMatrix(displayModel: DisplayModel): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(...modelRotationRadians(displayModel)))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...baseModelRotationRadians(displayModel))));
}

export function viewerPointToModelSpace(point: THREE.Vector3, displayModel: DisplayModel): THREE.Vector3 {
  return point.clone().applyMatrix4(modelToViewerMatrix(displayModel).invert());
}

export function viewerNormalToModelSpace(normal: THREE.Vector3, displayModel: DisplayModel): THREE.Vector3 {
  return normal.clone().transformDirection(modelToViewerMatrix(displayModel).invert()).normalize();
}

export function viewerDirectionToModelSpace(direction: THREE.Vector3, displayModel: DisplayModel): THREE.Vector3 {
  return direction.clone().transformDirection(modelToViewerMatrix(displayModel).invert()).normalize();
}

export function modelDirectionToViewerSpace(direction: THREE.Vector3, displayModel: DisplayModel): THREE.Vector3 {
  return direction.clone().transformDirection(modelToViewerMatrix(displayModel)).normalize();
}

// Sample display models store directions in viewer space (Y-up), while the cloud
// container meshes procedural/structured-block geometry in the user-facing global
// frame (Z-up). Solve requests must remap stored directions across that boundary,
// otherwise a "Global -Z" load reaches the solver pointing along the depth axis.
export function modelDirectionToGlobalCadFrame(direction: [number, number, number], displayModel: DisplayModel): [number, number, number] {
  if (isUploadedDisplayModel(displayModel)) return direction;
  const mapped = modelDirectionToViewerSpace(new THREE.Vector3(...direction), displayModel);
  return [snapAxisComponent(mapped.x), snapAxisComponent(mapped.y), snapAxisComponent(mapped.z)];
}

function snapAxisComponent(value: number): number {
  if (Math.abs(value) < 1e-9) return 0;
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-9 ? rounded : value;
}

export function formatModelOrientation(displayModel: DisplayModel): string {
  const orientation = getModelOrientation(displayModel);
  return `X ${orientation.x} deg / Y ${orientation.y} deg / Z ${orientation.z} deg`;
}

export function isUploadedDisplayModel(displayModel: DisplayModel): boolean {
  return Boolean(displayModel.nativeCad || displayModel.visualMesh || displayModel.id.includes("uploaded"));
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

const THREE_DEG_TO_RAD = Math.PI / 180;
