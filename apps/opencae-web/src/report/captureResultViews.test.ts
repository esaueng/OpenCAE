import { describe, expect, test, vi } from "vitest";
import type { ResultField } from "@opencae/schema";
import type { ResultMode } from "../workspaceViewTypes";
import { BOUNDARY_CAPTURE_REVISION, captureResultViews, createCaptureQueue, peakResultField } from "./captureResultViews";

const staticFields = [
  { id: "stress", runId: "run", type: "stress", location: "node", values: [1], min: 1, max: 1, units: "MPa" },
  { id: "displacement", runId: "run", type: "displacement", location: "node", values: [1], min: 1, max: 1, units: "mm" }
] satisfies ResultField[];

const dynamicFields = [
  { id: "stress-surface-0", runId: "run", type: "stress", location: "node", surfaceMeshRef: "surface", values: [0, 1], min: 0, max: 90, units: "MPa", frameIndex: 0, timeSeconds: 0 },
  { id: "stress-surface-1", runId: "run", type: "stress", location: "node", surfaceMeshRef: "surface", values: [0, 90], min: 0, max: 90, units: "MPa", frameIndex: 1, timeSeconds: 0.05 },
  { id: "stress-face-0", runId: "run", type: "stress", location: "face", values: [999], min: 0, max: 999, units: "MPa", frameIndex: 0, timeSeconds: 0 },
  { id: "displacement-surface-0", runId: "run", type: "displacement", location: "node", surfaceMeshRef: "surface", values: [0, 3], min: 0, max: 7, units: "mm", frameIndex: 0, timeSeconds: 0 },
  { id: "displacement-surface-1", runId: "run", type: "displacement", location: "node", surfaceMeshRef: "surface", values: [0, 5], min: 0, max: 7, units: "mm", frameIndex: 1, timeSeconds: 0.05 },
  { id: "displacement-surface-2", runId: "run", type: "displacement", location: "node", surfaceMeshRef: "surface", values: [0, 7], min: 0, max: 7, units: "mm", frameIndex: 2, timeSeconds: 0.1 }
] satisfies ResultField[];

const thermalFields = [
  { id: "temperature", runId: "run", type: "temperature", location: "node", values: [20, 85], min: 20, max: 85, units: "°C" },
  { id: "heat-flux", runId: "run", type: "heat_flux", location: "face", values: [0, 12], min: 0, max: 12, units: "W/m²" }
] satisfies ResultField[];

describe("captureResultViews", () => {
  test("serializes automatic and manual capture tasks and continues after failures", async () => {
    const queue = createCaptureQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const first = queue.enqueue(async () => {
      events.push("automatic-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("automatic-end");
    });
    const second = queue.enqueue(async () => {
      events.push("manual-start");
      throw new Error("capture failed");
    });
    const third = queue.enqueue(() => events.push("next-start"));

    await Promise.resolve();
    expect(events).toEqual(["automatic-start"]);
    releaseFirst!();
    await first;
    await expect(second).rejects.toThrow("capture failed");
    await third;
    expect(events).toEqual(["automatic-start", "automatic-end", "manual-start", "next-start"]);
  });

  test("captures each result at its rendered peak frame, then restores viewer state", async () => {
    let mode: ResultMode = "safety_factor";
    let frameIndex = 0;
    let playing = true;
    const setResultMode = vi.fn((next: ResultMode) => { mode = next; });
    const setResultFrameIndex = vi.fn((next: number) => { frameIndex = next; });
    const setPlaybackPlaying = vi.fn((next: boolean) => { playing = next; });
    const capture = vi.fn(async () => `data:image/png;base64,${mode}-${frameIndex}`);
    const waitForAnimationFrame = vi.fn(async () => undefined);

    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode,
      getResultFrameIndex: () => frameIndex,
      setResultFrameIndex,
      getPlaybackPlaying: () => playing,
      setPlaybackPlaying,
      resultFields: dynamicFields,
      surfaceMeshRef: "surface",
      capture,
      isCurrent: () => true,
      waitForAnimationFrame
    });

    expect(result).toEqual({
      stress: {
        png: "data:image/png;base64,stress-1",
        fieldId: "stress-surface-1",
        selection: "peak",
        frameIndex: 1,
        timeSeconds: 0.05
      },
      displacement: {
        png: "data:image/png;base64,displacement-2",
        fieldId: "displacement-surface-2",
        selection: "peak",
        frameIndex: 2,
        timeSeconds: 0.1
      }
    });
    expect(setResultMode.mock.calls.map(([next]) => next)).toEqual(["stress", "displacement", "safety_factor"]);
    expect(setResultFrameIndex.mock.calls.map(([next]) => next)).toEqual([1, 2, 0]);
    expect(setPlaybackPlaying.mock.calls.map(([next]) => next)).toEqual([false, true]);
    expect(waitForAnimationFrame).toHaveBeenCalledTimes(4);
  });

  test("skips absent fields and reports a stale result capture", async () => {
    let current = true;
    let mode: "stress" | "displacement" = "stress";
    let frameIndex = 4;
    await expect(captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next as typeof mode; },
      getResultFrameIndex: () => frameIndex,
      setResultFrameIndex: (next) => { frameIndex = next; },
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: staticFields.slice(0, 1),
      capture: () => "data:image/png;base64,stress",
      isCurrent: () => current,
      waitForAnimationFrame: async () => { current = false; }
    })).rejects.toThrow("Results changed while the report figures were being captured");
    expect(mode).toBe("stress");
    expect(frameIndex).toBe(4);
  });

  test("captures the boundary-condition view in model view and restores results view", async () => {
    let mode: ResultMode = "stress";
    const viewModes: string[] = [];
    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: staticFields,
      capture: () => `data:image/png;base64,${viewModes.at(-1) === "model" ? "boundary" : mode}`,
      isCurrent: () => true,
      waitForAnimationFrame: async () => undefined,
      setViewMode: (next) => { viewModes.push(next); },
      captureBoundaryView: true
    });

    expect(result.boundary).toEqual({ png: "data:image/png;base64,boundary", revision: BOUNDARY_CAPTURE_REVISION });
    expect(viewModes).toEqual(["model", "results"]);
  });

  test("restores results view when the boundary capture finds stale results", async () => {
    const viewModes: string[] = [];
    let framesWaited = 0;
    await expect(captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => "stress",
      setResultMode: () => undefined,
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: [],
      capture: () => "data:image/png;base64,unused",
      // Stale only after the boundary capture's frame waits begin.
      isCurrent: () => framesWaited < 1,
      waitForAnimationFrame: async () => { framesWaited += 1; },
      setViewMode: (next) => { viewModes.push(next); },
      captureBoundaryView: true
    })).rejects.toThrow("Results changed while the report figures were being captured");
    expect(viewModes).toEqual(["model", "results"]);
  });

  test("returns static capture metadata when the result has no transient frames", async () => {
    let mode: ResultMode = "stress";
    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: staticFields,
      capture: () => `data:image/png;base64,${mode}`,
      isCurrent: () => true,
      waitForAnimationFrame: async () => undefined
    });

    expect(result.stress).toMatchObject({ fieldId: "stress", selection: "static" });
    expect(result.displacement).toMatchObject({ fieldId: "displacement", selection: "static" });
  });

  test("captures thermal temperature and heat-flux figures into the report figure slots", async () => {
    let mode: ResultMode = "temperature";
    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: thermalFields,
      capture: () => `data:image/png;base64,${mode}`,
      isCurrent: () => true,
      waitForAnimationFrame: async () => undefined
    });

    expect(result.stress).toMatchObject({ fieldId: "temperature", png: "data:image/png;base64,temperature" });
    expect(result.displacement).toMatchObject({ fieldId: "heat-flux", png: "data:image/png;base64,heat_flux" });
  });
});

describe("peakResultField", () => {
  test("uses the field actually rendered on the solver surface and its active values", () => {
    expect(peakResultField(dynamicFields, "stress", "surface")?.id).toBe("stress-surface-1");
    expect(peakResultField(dynamicFields, "displacement", "surface")?.id).toBe("displacement-surface-2");
  });
});
