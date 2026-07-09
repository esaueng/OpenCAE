import { describe, expect, test } from "vitest";
import {
  solveCoreDynamic,
  solveCoreStatic,
  solveDynamicLinearTetMDOF,
  solveStaticLinearTet,
  type SolveProgressEvent
} from "../src";
import { createStructuredCantileverModel, dynamicLoadedModel } from "./helpers";

function cantileverModel() {
  return createStructuredCantileverModel({
    length: 0.18,
    width: 0.024,
    height: 0.024,
    force: 500,
    xDivisions: 16,
    yDivisions: 3,
    zDivisions: 3
  });
}

function expectMonotonicCompleted(events: SolveProgressEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    expect(events[index].completed).toBeGreaterThanOrEqual(events[index - 1].completed);
  }
}

describe("solver progress hooks", () => {
  test("static solve emits assemble then solve events with monotonic completed", () => {
    const events: SolveProgressEvent[] = [];
    const result = solveStaticLinearTet(cantileverModel(), {
      method: "sparse",
      tolerance: 1e-10,
      maxIterations: 20000,
      hooks: { onProgress: (event) => events.push(event) }
    });

    expect(result.ok).toBe(true);
    const assemble = events.filter((event) => event.phase === "assemble");
    const solve = events.filter((event) => event.phase === "solve");
    expect(assemble.length).toBeGreaterThan(0);
    expect(solve.length).toBeGreaterThan(0);
    expectMonotonicCompleted(assemble);
    expectMonotonicCompleted(solve);
    // Assembly completes fully and finishes before the first solve event.
    expect(assemble.at(-1)?.completed).toBe(assemble.at(-1)?.total);
    expect(events.findIndex((event) => event.phase === "solve")).toBeGreaterThan(
      events.map((event) => event.phase).lastIndexOf("assemble")
    );
    // Final solve event reports the converged iteration and residual.
    const finalSolve = solve.at(-1)!;
    expect(finalSolve.iteration).toBeGreaterThan(0);
    expect(finalSolve.relativeResidual).toBeLessThanOrEqual(1e-10);
    expect(finalSolve.completed).toBe(finalSolve.iteration);
    expect(finalSolve.total).toBeGreaterThanOrEqual(finalSolve.completed);
  });

  test("solveCoreStatic threads hooks through to assemble and solve phases", () => {
    const events: SolveProgressEvent[] = [];
    const result = solveCoreStatic(cantileverModel(), {
      tolerance: 1e-10,
      maxIterations: 20000,
      hooks: { onProgress: (event) => events.push(event) }
    });

    expect(result.ok).toBe(true);
    expect(events.some((event) => event.phase === "assemble")).toBe(true);
    expect(events.some((event) => event.phase === "solve")).toBe(true);
  });

  test("dynamic solve emits one frames event per output frame", () => {
    const events: SolveProgressEvent[] = [];
    const result = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"), {
      hooks: { onProgress: (event) => events.push(event) }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frames = events.filter((event) => event.phase === "frames");
    expect(frames.length).toBe(result.result.frames.length);
    expectMonotonicCompleted(frames);
    expect(frames[0]?.completed).toBe(1);
    expect(frames.at(-1)?.completed).toBe(result.result.frames.length);
    for (const event of frames) {
      expect(event.total).toBeGreaterThanOrEqual(event.completed);
    }
    expect(events.some((event) => event.phase === "assemble")).toBe(true);
  });

  test("solveCoreDynamic threads hooks through to frames events", () => {
    const events: SolveProgressEvent[] = [];
    const result = solveCoreDynamic(dynamicLoadedModel("ramp"), {
      hooks: { onProgress: (event) => events.push(event) }
    });

    expect(result.ok).toBe(true);
    expect(events.filter((event) => event.phase === "frames").length).toBeGreaterThan(1);
  });
});

describe("solver cancellation hooks", () => {
  test("static solve cancels cleanly after N shouldCancel calls without throwing", () => {
    let calls = 0;
    const result = solveStaticLinearTet(cantileverModel(), {
      method: "sparse",
      tolerance: 1e-10,
      maxIterations: 20000,
      hooks: {
        shouldCancel: () => {
          calls += 1;
          return calls > 5;
        }
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cancelled");
    expect(result.error.message).toBe("Solve cancelled.");
    expect(calls).toBeGreaterThan(5);
  });

  test("solveCoreStatic propagates the cancelled error code", () => {
    const result = solveCoreStatic(cantileverModel(), {
      hooks: { shouldCancel: () => true }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cancelled");
  });

  test("dynamic solve cancels cleanly at a time step without throwing", () => {
    let calls = 0;
    const result = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"), {
      hooks: {
        shouldCancel: () => {
          calls += 1;
          return calls > 2;
        }
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cancelled");
    expect(result.error.message).toBe("Solve cancelled.");
  });

  test("solveCoreDynamic propagates the cancelled error code", () => {
    const result = solveCoreDynamic(dynamicLoadedModel("ramp"), {
      hooks: { shouldCancel: () => true }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("cancelled");
  });

  test("absent hooks leave results identical to a hooked no-op run", () => {
    const plain = solveStaticLinearTet(cantileverModel(), { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });
    const hooked = solveStaticLinearTet(cantileverModel(), {
      method: "sparse",
      tolerance: 1e-10,
      maxIterations: 20000,
      hooks: { onProgress: () => undefined, shouldCancel: () => false }
    });

    expect(plain.ok).toBe(true);
    expect(hooked.ok).toBe(true);
    if (!plain.ok || !hooked.ok) return;
    expect(Array.from(hooked.result.displacement)).toEqual(Array.from(plain.result.displacement));
    expect(hooked.diagnostics.iterations).toBe(plain.diagnostics.iterations);
  });
});
