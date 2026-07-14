import type { PackedPreparedPlaybackCache } from "./resultPlaybackCache";
export type { StressComponent } from "@opencae/schema";

export type ViewMode = "model" | "mesh" | "results";
export type ResultMode = "stress" | "displacement" | "safety_factor" | "velocity" | "acceleration" | "mode_shape";
export type ThemeMode = "dark" | "light";
export type PrintLayerOrientation = "x" | "y" | "z";
export type SectionPlaneAxis = "x" | "y" | "z";

export interface SectionPlaneState {
  enabled: boolean;
  axis: SectionPlaneAxis;
  /** Plane position from the selected model-bound minimum (0) to maximum (1). */
  offset: number;
  flipped: boolean;
}

export const DEFAULT_SECTION_PLANE: SectionPlaneState = {
  enabled: false,
  axis: "x",
  offset: 0.5,
  flipped: false
};

export interface PayloadObjectSelection {
  id: string;
  label: string;
  center: [number, number, number];
  volumeM3?: number;
  volumeSource?: "mesh" | "step" | "bounds-fallback" | "manual";
  volumeStatus?: "available" | "estimated" | "unknown";
}

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
