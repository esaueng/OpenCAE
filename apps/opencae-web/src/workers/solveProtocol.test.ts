import { describe, expect, test } from "vitest";
import type { ResultSummary } from "@opencae/schema";
import {
  createSolveWorkerRequestId,
  isSolveWorkerProgress,
  isSolveWorkerResult,
  normalizeSolveWorkerError,
  transferablesForSolveResult
} from "./solveProtocol";
import type { LocalSolveResult } from "./performanceProtocol";

describe("solve worker protocol", () => {
  test("generates unique solve request ids", () => {
    const first = createSolveWorkerRequestId();
    const second = createSolveWorkerRequestId();
    expect(first).toMatch(/^solve-/);
    expect(second).not.toBe(first);
  });

  test("recognizes progress and result envelopes", () => {
    expect(isSolveWorkerProgress({ kind: "progress", id: "solve-1", event: { phase: "assemble", completed: 1, total: 2 } })).toBe(true);
    expect(isSolveWorkerProgress({ kind: "result", id: "solve-1" })).toBe(false);
    expect(isSolveWorkerResult({ kind: "result", id: "solve-1", ok: true, solverBackend: "opencae-core-sparse-tet", result: { summary: {}, fields: [] } })).toBe(true);
    expect(isSolveWorkerResult({ kind: "result", id: "solve-1", ok: false, error: { name: "Error", message: "nope" } })).toBe(true);
    expect(isSolveWorkerResult({ kind: "result", id: "solve-1", ok: false, error: {} })).toBe(false);
    expect(isSolveWorkerResult({ kind: "progress", id: "solve-1" })).toBe(false);
  });

  test("normalizes errors with optional machine-readable codes", () => {
    expect(normalizeSolveWorkerError(new Error("boom"), "cancelled")).toEqual({ name: "Error", message: "boom", code: "cancelled" });
    expect(normalizeSolveWorkerError("plain reason")).toEqual({ name: "Error", message: "plain reason" });
  });

  test("collects typed-array field buffers as transferables", () => {
    const typed = new Float64Array([1, 2, 3]);
    const result = {
      summary: {} as ResultSummary,
      fields: [
        { id: "a", values: [1, 2, 3] },
        { id: "b", values: typed }
      ]
    } as unknown as LocalSolveResult;
    expect(transferablesForSolveResult(result)).toEqual([typed.buffer]);
  });
});
