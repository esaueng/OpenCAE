import type { ResultField } from "@opencae/schema";
import type { ResultMode, ViewMode } from "../workspaceViewTypes";

export interface ResultViewCaptures {
  stress?: CapturedResultView;
  displacement?: CapturedResultView;
  boundary?: CapturedBoundaryView;
}

export interface CapturedResultView {
  png: string;
  fieldId: string;
  selection: "peak" | "static";
  frameIndex?: number;
  timeSeconds?: number;
}

export interface CapturedBoundaryView {
  png: string;
}

export interface CaptureResultViewsOptions {
  getViewMode: () => ViewMode;
  getResultMode: () => ResultMode;
  setResultMode: (mode: ResultMode) => void;
  getResultFrameIndex: () => number;
  setResultFrameIndex: (frameIndex: number) => void;
  getPlaybackPlaying: () => boolean;
  setPlaybackPlaying: (playing: boolean) => void;
  resultFields: ResultField[];
  surfaceMeshRef?: string;
  capture: (() => string | Promise<string>) | null;
  isCurrent: () => boolean;
  waitForAnimationFrame?: () => Promise<void>;
  /** Switches the viewer between results and model view for the boundary-condition capture. */
  setViewMode?: (mode: ViewMode) => void;
  /** Capture a model-view snapshot of the support/load markers for the report's boundary-conditions figure. */
  captureBoundaryView?: boolean;
  /**
   * Resolves once the model view has real geometry to photograph. Uploaded
   * STEP previews remount and re-tessellate when leaving the results view, so
   * a fixed frame wait would capture an empty scene.
   */
  waitForBoundaryViewReady?: () => Promise<void>;
}

const REPORT_RESULT_MODES = ["stress", "displacement"] as const;

export async function captureResultViews(options: CaptureResultViewsOptions): Promise<ResultViewCaptures> {
  if (options.getViewMode() !== "results") {
    throw new Error("Open the Results view before generating a report.");
  }

  const availableModes = REPORT_RESULT_MODES.filter((mode) => options.resultFields.some((field) => field.type === mode));
  const captureBoundary = Boolean(options.captureBoundaryView && options.setViewMode);
  if ((availableModes.length || captureBoundary) && !options.capture) {
    throw new Error("The 3D result view is still loading. Wait for it to appear, then generate the report again.");
  }

  const originalMode = options.getResultMode();
  const originalFrameIndex = options.getResultFrameIndex();
  const originalPlaybackPlaying = options.getPlaybackPlaying();
  const waitForFrame = options.waitForAnimationFrame ?? nextAnimationFrame;
  const captures: ResultViewCaptures = {};

  try {
    if (originalPlaybackPlaying) options.setPlaybackPlaying(false);
    for (const mode of availableModes) {
      assertCurrent(options);
      const peakField = peakResultField(options.resultFields, mode, options.surfaceMeshRef);
      if (!peakField) continue;
      options.setResultMode(mode);
      if (peakField.frameIndex !== undefined) options.setResultFrameIndex(peakField.frameIndex);
      await waitForFrame();
      await waitForFrame();
      assertCurrent(options);
      captures[mode] = {
        png: await options.capture!(),
        fieldId: peakField.id,
        selection: peakField.frameIndex === undefined ? "static" : "peak",
        ...(peakField.frameIndex === undefined ? {} : { frameIndex: peakField.frameIndex }),
        ...(peakField.timeSeconds === undefined ? {} : { timeSeconds: peakField.timeSeconds })
      };
    }
    if (captureBoundary) {
      captures.boundary = await captureBoundaryView(options, waitForFrame);
    }
    return captures;
  } finally {
    options.setResultFrameIndex(originalFrameIndex);
    options.setResultMode(originalMode);
    if (originalPlaybackPlaying) options.setPlaybackPlaying(true);
  }
}

// The boundary markers (supports + loads) only render outside the results
// view, so flip the viewer to model view for the snapshot and restore it.
async function captureBoundaryView(options: CaptureResultViewsOptions, waitForFrame: () => Promise<void>): Promise<CapturedBoundaryView> {
  assertCurrent(options);
  options.setViewMode!("model");
  try {
    await options.waitForBoundaryViewReady?.();
    await waitForFrame();
    await waitForFrame();
    if (!options.isCurrent()) throw staleResultsError();
    return { png: await options.capture!() };
  } finally {
    options.setViewMode!("results");
  }
}

export function peakResultField(fields: ResultField[], mode: "stress" | "displacement", surfaceMeshRef?: string): ResultField | undefined {
  const modeFields = fields.filter((field) => field.type === mode);
  if (!modeFields.length) return undefined;

  const surfaceFields = surfaceMeshRef
    ? modeFields.filter((field) => field.location === "node" && field.surfaceMeshRef === surfaceMeshRef)
    : [];
  const faceFields = modeFields.filter((field) => field.location === "face");
  const sampledFields = modeFields.filter((field) => field.samples?.length);
  const candidates = surfaceFields.length
    ? surfaceFields
    : faceFields.length
      ? faceFields
      : sampledFields.length
        ? sampledFields
        : modeFields;

  return candidates
    .map((field) => ({ field, magnitude: fieldPeakMagnitude(field) }))
    .reduce((peak, candidate) => candidate.magnitude > peak.magnitude ? candidate : peak)
    .field;
}

function fieldPeakMagnitude(field: ResultField): number {
  let peak = Number.NEGATIVE_INFINITY;
  for (const value of field.values) {
    if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
  }
  for (const sample of field.samples ?? []) {
    if (Number.isFinite(sample.value)) peak = Math.max(peak, Math.abs(sample.value));
  }
  if (Number.isFinite(peak)) return peak;
  return Math.max(Math.abs(Number(field.min) || 0), Math.abs(Number(field.max) || 0));
}

function assertCurrent(options: Pick<CaptureResultViewsOptions, "getViewMode" | "isCurrent">): void {
  if (options.getViewMode() !== "results" || !options.isCurrent()) {
    throw staleResultsError();
  }
}

function staleResultsError(): Error {
  return new Error("Results changed while the report figures were being captured. Generate the report again from the current results.");
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
