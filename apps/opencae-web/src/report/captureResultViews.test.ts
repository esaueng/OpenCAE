import { describe, expect, test, vi } from "vitest";
import type { ResultField } from "@opencae/schema";
import type { ResultMode } from "../workspaceViewTypes";
import { captureResultViews } from "./captureResultViews";

const fields = [
  { id: "stress", runId: "run", type: "stress", location: "node", values: [1], min: 1, max: 1, units: "MPa" },
  { id: "displacement", runId: "run", type: "displacement", location: "node", values: [1], min: 1, max: 1, units: "mm" }
] satisfies ResultField[];

describe("captureResultViews", () => {
  test("cycles through available fields and restores the original mode", async () => {
    let mode: ResultMode = "safety_factor";
    const setResultMode = vi.fn((next: ResultMode) => { mode = next; });
    const capture = vi.fn(() => `data:image/png;base64,${mode}`);
    const waitForAnimationFrame = vi.fn(async () => undefined);

    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode,
      resultFields: fields,
      capture,
      isCurrent: () => true,
      waitForAnimationFrame
    });

    expect(result).toEqual({
      stress: "data:image/png;base64,stress",
      displacement: "data:image/png;base64,displacement"
    });
    expect(setResultMode.mock.calls.map(([next]) => next)).toEqual(["stress", "displacement", "safety_factor"]);
    expect(waitForAnimationFrame).toHaveBeenCalledTimes(4);
  });

  test("skips absent fields and reports a stale result capture", async () => {
    let current = true;
    let mode: "stress" | "displacement" = "stress";
    await expect(captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next as typeof mode; },
      resultFields: fields.slice(0, 1),
      capture: () => "data:image/png;base64,stress",
      isCurrent: () => current,
      waitForAnimationFrame: async () => { current = false; }
    })).rejects.toThrow("Results changed while the report figures were being captured");
    expect(mode).toBe("stress");
  });
});
