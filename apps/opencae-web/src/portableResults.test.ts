import { describe, expect, test, vi } from "vitest";
import type { RunVariantResult } from "@opencae/schema";
import { parseResultBundle } from "./appPersistence";
import { portableResultBundle, type LocalResultBundle } from "./projectFile";

function variant(id: string, value: number): RunVariantResult {
  return {
    id, name: id, kind: "case", caseId: id,
    summary: {
      maxStress: value, maxStressUnits: "MPa", maxDisplacement: 0.1, maxDisplacementUnits: "mm",
      safetyFactor: 2, reactionForce: 100, reactionForceUnits: "N",
      transient: {
        analysisType: "dynamic_structural", frameCount: 2, startTime: 0, endTime: 1,
        timeStep: 1, outputInterval: 1, peakDisplacement: 0.1, peakDisplacementTimeSeconds: 1
      }
    },
    fields: [0, 1].map((frameIndex) => ({
      id: `${id}-${frameIndex}`, runId: "run-local-portable", variantId: id,
      type: "stress", location: "node", values: [value], min: value, max: value,
      units: "MPa", frameIndex, timeSeconds: frameIndex
    }))
  };
}

function bundle(): LocalResultBundle {
  const active = variant("side", 20);
  return {
    completedRunId: "run-local-portable", summary: active.summary, fields: active.fields,
    activeVariantId: active.id, variants: [active],
    variantRefs: ["down", "side", "up"].map((id) => ({ id, name: id, kind: "case", caseId: id, persistedSeparately: true }))
  };
}

describe("portable dynamic result cases", () => {
  test("round-trips every frame of inactive cases without retaining browser-storage dependencies", async () => {
    const source = bundle();
    const load = vi.fn(async (_runId: string, id: string) => variant(id, id === "down" ? 10 : 30));
    const portable = await portableResultBundle(source, load);
    expect(load.mock.calls).toEqual([["run-local-portable", "down"], ["run-local-portable", "up"]]);
    const restored = parseResultBundle(JSON.parse(JSON.stringify(portable)));
    expect(restored?.activeVariantId).toBe("side");
    expect(restored?.variants?.map((entry) => [entry.id, entry.fields.map((field) => field.values)])).toEqual([
      ["side", [[20], [20]]], ["down", [[10], [10]]], ["up", [[30], [30]]]
    ]);
    expect(restored?.variantRefs?.every((reference) => !reference.persistedSeparately)).toBe(true);
    const unavailableStorage = vi.fn(async () => { throw new Error("Storage cleared"); });
    await expect(portableResultBundle(restored!, unavailableStorage)).resolves.toBeDefined();
    expect(unavailableStorage).not.toHaveBeenCalled();
    expect(source.variants).toHaveLength(1);
    expect(source.variantRefs?.every((reference) => reference.persistedSeparately)).toBe(true);
  });

  test("fails the save when an inactive case cannot be restored, without mutating the live bundle", async () => {
    const source = bundle();
    const before = JSON.stringify(source);
    await expect(portableResultBundle(source, async (_runId, id) => {
      if (id === "up") throw new Error("Case was pruned");
      return variant(id, 10);
    })).rejects.toThrow("Case was pruned");
    expect(JSON.stringify(source)).toBe(before);
  });

  test("rejects missing run ownership and a mismatched stored case", async () => {
    await expect(portableResultBundle({ ...bundle(), completedRunId: undefined }, vi.fn())).rejects.toThrow("result run is missing");
    await expect(portableResultBundle(bundle(), async () => variant("wrong", 10))).rejects.toThrow("different case");
  });

  test("leaves legacy single-result files unchanged", async () => {
    const source = { summary: variant("single", 10).summary, fields: variant("single", 10).fields };
    const load = vi.fn();
    await expect(portableResultBundle(source, load)).resolves.toBe(source);
    expect(load).not.toHaveBeenCalled();
  });
});
