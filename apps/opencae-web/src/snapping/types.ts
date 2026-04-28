import type * as THREE from "three";

export type Vec3 = [number, number, number];
export type PlacementMode = "loads" | "supports";
export type EntityType = "face" | "edge" | "vertex";
export type SuggestionType = "force" | "fixed" | "distributed";
export type SnapCandidateKind =
  | "vertex"
  | "edge-endpoint"
  | "edge-midpoint"
  | "edge-closest"
  | "face-centroid"
  | "face-centerline"
  | "face-unit"
  | "face-projected"
  | "face-closest";

export interface CursorRay {
  origin: Vec3;
  direction: Vec3;
  cursorPoint: Vec3;
  screenPosition?: { x: number; y: number };
}

export interface HoveredEntity {
  type: EntityType;
  id: string;
  position: Vec3;
  normal?: Vec3;
  faceId?: string;
  endpoints?: [Vec3, Vec3];
  snapAxes?: FaceSnapAxis[];
}

export interface FaceSnapAxis {
  direction: Vec3;
  minPoint: Vec3;
  maxPoint: Vec3;
  unitsPerWorld: number;
  units: string;
  unitStep?: number;
}

export interface SnapMeasurement {
  kind: "edge-distance";
  start: Vec3;
  end: Vec3;
  label: string;
  value: number;
  units: string;
}

export interface SnapCandidate {
  kind: SnapCandidateKind;
  point: Vec3;
  priority: number;
  fallback?: boolean;
  measurements?: SnapMeasurement[];
}

export interface ScoredSnapCandidate {
  candidate: SnapCandidate;
  score: number;
  distanceToCursor: number;
}

export interface SnapResult {
  hovered: HoveredEntity;
  snapPoint: Vec3;
  rawSnapPoint: Vec3;
  direction: Vec3;
  suggestionType: SuggestionType;
  candidateKind: SnapCandidateKind;
  score: number;
  measurements?: SnapMeasurement[];
}

export interface SnapConfig {
  thresholdPixels?: number;
  thresholdWorld?: number;
  distanceWeight?: number;
  smoothingAlpha?: number;
  screenPosition?: { x: number; y: number };
  projectToScreen?: (point: Vec3) => { x: number; y: number };
}

export interface SnapQueryContext extends SnapConfig {
  objects: THREE.Object3D[];
  mode?: PlacementMode;
  ownerFace?: {
    id: string;
    position: Vec3;
    normal: Vec3;
    snapAxes?: FaceSnapAxis[];
  };
}

export const DEFAULT_SNAP_CONFIG = {
  thresholdPixels: 18,
  thresholdWorld: 0.08,
  distanceWeight: 1,
  smoothingAlpha: 0.35
} as const;

export const SNAP_PRIORITIES: Record<SnapCandidateKind, number> = {
  vertex: 0,
  "edge-endpoint": 0.005,
  "edge-midpoint": 0.01,
  "face-unit": 0.012,
  "face-centerline": 0.015,
  "face-centroid": 0.02,
  "edge-closest": 0.025,
  "face-projected": 0.03,
  "face-closest": 0.03
};
