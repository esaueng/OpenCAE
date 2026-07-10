import type { ResultField } from "@opencae/schema";
import type { ResultMode, ViewMode } from "../workspaceViewTypes";

export interface ResultViewCaptures {
  stress?: string;
  displacement?: string;
}

export interface CaptureResultViewsOptions {
  getViewMode: () => ViewMode;
  getResultMode: () => ResultMode;
  setResultMode: (mode: ResultMode) => void;
  resultFields: ResultField[];
  capture: (() => string) | null;
  isCurrent: () => boolean;
  waitForAnimationFrame?: () => Promise<void>;
}

const REPORT_RESULT_MODES = ["stress", "displacement"] as const;

export async function captureResultViews(options: CaptureResultViewsOptions): Promise<ResultViewCaptures> {
  if (options.getViewMode() !== "results") {
    throw new Error("Open the Results view before generating a report.");
  }

  const availableModes = REPORT_RESULT_MODES.filter((mode) => options.resultFields.some((field) => field.type === mode));
  if (availableModes.length && !options.capture) {
    throw new Error("The 3D result view is still loading. Wait for it to appear, then generate the report again.");
  }

  const originalMode = options.getResultMode();
  const waitForFrame = options.waitForAnimationFrame ?? nextAnimationFrame;
  const captures: ResultViewCaptures = {};

  try {
    for (const mode of availableModes) {
      assertCurrent(options);
      options.setResultMode(mode);
      await waitForFrame();
      await waitForFrame();
      assertCurrent(options);
      captures[mode] = options.capture!();
    }
    return captures;
  } finally {
    options.setResultMode(originalMode);
  }
}

function assertCurrent(options: Pick<CaptureResultViewsOptions, "getViewMode" | "isCurrent">): void {
  if (options.getViewMode() !== "results" || !options.isCurrent()) {
    throw new Error("Results changed while the report figures were being captured. Generate the report again from the current results.");
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
