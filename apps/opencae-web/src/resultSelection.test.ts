import type { ResultField } from "@opencae/schema";
import { describe, expect, test } from "vitest";
import {
  barycentricPoint,
  barycentricScalar,
  appendResultProbe,
  availableStressComponents,
  barycentricVector,
  governingVariantIdForProbe,
  interpolateScalarFromSamples,
  resolveResultProbe,
  resultProbeTopologySignature,
  selectActiveResultField,
  semanticResultFieldKey,
  stressComponentForField
} from "./resultSelection";

const surfaceMesh = {
  id: "surface-1",
  nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
  triangles: [[0, 1, 2]] as [number, number, number][],
  nodeMap: [0, 1, 2]
};

function field(overrides: Partial<ResultField> = {}): ResultField {
  return {
    id: "stress",
    runId: "run-1",
    type: "stress",
    location: "node",
    values: [10, 20, 40],
    min: 10,
    max: 40,
    units: "MPa",
    surfaceMeshRef: surfaceMesh.id,
    ...overrides
  };
}

describe("active result field selection", () => {
  test("treats legacy stress fields as von Mises and prefers aligned surface nodes", () => {
    const legacy = field();
    const sampled = field({ id: "sampled", location: "element", surfaceMeshRef: undefined, samples: [{ point: [0, 0, 0], normal: [0, 0, 1], value: 99 }] });
    expect(stressComponentForField(legacy)).toBe("von_mises");
    expect(selectActiveResultField({ fields: [sampled, legacy], resultMode: "stress", surfaceMesh }).scalarField).toBe(legacy);
  });

  test("separates stress components in semantic identities", () => {
    const vonMises = field();
    const principal = field({ component: "principal_max" });
    expect(semanticResultFieldKey(vonMises)).not.toBe(semanticResultFieldKey(principal));
    expect(selectActiveResultField({ fields: [vonMises, principal], resultMode: "stress", stressComponent: "principal_max", surfaceMesh }).scalarField).toBe(principal);
  });

  test("selects the requested dynamic frame", () => {
    const frame0 = field({ frameIndex: 0, timeSeconds: 0 });
    const frame1 = field({ id: "frame-1", frameIndex: 1, timeSeconds: 0.1 });
    expect(selectActiveResultField({ fields: [frame0, frame1], resultMode: "stress", frameIndex: 1, surfaceMesh }).scalarField).toBe(frame1);
  });

  test("lazily derives and memoizes principal and maximum-shear fields from nodal tensors", () => {
    const tensorField = field({
      component: "von_mises",
      tensorValues: [
        100, 0, 0, 0, 0, 0,
        -20, 40, 0, 0, 0, 0,
        0, 0, 0, 30, 0, 0
      ]
    });
    expect(availableStressComponents([tensorField])).toEqual(["von_mises", "principal_max", "principal_min", "max_shear"]);
    const first = selectActiveResultField({ fields: [tensorField], resultMode: "stress", stressComponent: "principal_min", surfaceMesh }).scalarField;
    const second = selectActiveResultField({ fields: [tensorField], resultMode: "stress", stressComponent: "principal_min", surfaceMesh }).scalarField;
    expect(first).toBe(second);
    expect(first?.values).toEqual([0, -20, -30]);
    const shear = selectActiveResultField({ fields: [tensorField], resultMode: "stress", stressComponent: "max_shear", surfaceMesh }).scalarField;
    expect(shear?.values).toEqual([50, 30, 30]);
  });

  test("hides principal measures for legacy tensor-free fields", () => {
    expect(availableStressComponents([field()])).toEqual(["von_mises"]);
    expect(selectActiveResultField({ fields: [field()], resultMode: "stress", stressComponent: "principal_max" }).scalarField).toBeUndefined();
  });

  test("separates modal identities and selects the requested mode", () => {
    const mode1 = field({ id: "mode-1", type: "mode_shape", units: "normalized", modeIndex: 1, vectors: [[1, 0, 0], [0, 0, 0], [0, 0, 0]] });
    const mode2 = field({ id: "mode-2", type: "mode_shape", units: "normalized", modeIndex: 2, vectors: [[0, 1, 0], [0, 0, 0], [0, 0, 0]] });
    expect(semanticResultFieldKey(mode1)).not.toBe(semanticResultFieldKey(mode2));
    const selected = selectActiveResultField({ fields: [mode1, mode2], resultMode: "mode_shape", modeIndex: 2, surfaceMesh });
    expect(selected.scalarField).toBe(mode2);
    expect(selected.displacementField).toBe(mode2);
  });

  test("separates active run variants in semantic identities", () => {
    expect(semanticResultFieldKey(field({ variantId: "case:a" }))).not.toBe(
      semanticResultFieldKey(field({ variantId: "case:b" }))
    );
  });
});

describe("result probes", () => {
  test("interpolates aligned nodal values with retained barycentric weights", () => {
    const weights: [number, number, number] = [0.2, 0.3, 0.5];
    expect(barycentricScalar([10, 20, 40], [0, 1, 2], weights)).toBeCloseTo(28, 12);
    expect(barycentricVector([[0, 0, 0], [1, 2, 3], [2, 4, 6]], [0, 1, 2], weights)).toEqual([1.3, 2.6, 3.9]);
    expect(barycentricPoint(surfaceMesh.nodes, [0, 1, 2], weights)).toEqual([0.3, 0.5, 0]);
    expect(resolveResultProbe({ id: "probe-1", anchor: { kind: "surface", surfaceMeshId: surfaceMesh.id, triangle: [0, 1, 2], barycentric: weights } }, field(), surfaceMesh)).toMatchObject({ value: 28, point: [0.3, 0.5, 0] });
  });

  test("maps compact envelope indices to the barycentrically governing variant", () => {
    const pin = {
      id: "probe-envelope",
      anchor: { kind: "surface" as const, surfaceMeshId: surfaceMesh.id, triangle: [0, 1, 2] as [number, number, number], barycentric: [0.2, 0.3, 0.5] as [number, number, number] }
    };
    const governing = {
      variantIds: ["case:service", "combination:reverse"],
      stress: [0, 1, 1],
      displacement: [0, 0, 1]
    };

    expect(governingVariantIdForProbe(pin, governing, "stress")).toBe("combination:reverse");
    expect(governingVariantIdForProbe(pin, governing, "displacement")).toBe("case:service");
  });
  test("uses exact and inverse-distance sampled interpolation without display rounding", () => {
    const samples = [
      { point: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], value: 0.000_456_789 },
      { point: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], value: 10 },
      { point: [0, 1, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], value: 20 }
    ];
    expect(interpolateScalarFromSamples([0, 0, 0], samples)).toBe(0.000_456_789);
    expect(interpolateScalarFromSamples([0.5, 0, 0], samples)).toBeGreaterThan(0.000_456_789);
  });

  test("caps user pins at twenty", () => {
    const anchor = { kind: "sample" as const, point: [0, 0, 0] as [number, number, number] };
    let pins = Array.from({ length: 20 }, (_, index) => ({ id: `probe-${index}`, anchor }));
    const capped = appendResultProbe(pins, anchor, "probe-20");
    expect(capped.limitReached).toBe(true);
    expect(capped.pins).toBe(pins);
    pins = pins.slice(0, 19);
    expect(appendResultProbe(pins, anchor, "probe-19").pins).toHaveLength(20);
  });

  test("changes the clear signature for a new run, variant, project, model, or surface topology", () => {
    const baseline = resultProbeTopologySignature("project-1", "run-1", "model-1", surfaceMesh, "case:a");
    expect(resultProbeTopologySignature("project-2", "run-1", "model-1", surfaceMesh)).not.toBe(baseline);
    expect(resultProbeTopologySignature("project-1", "run-2", "model-1", surfaceMesh)).not.toBe(baseline);
    expect(resultProbeTopologySignature("project-1", "run-1", "model-2", surfaceMesh)).not.toBe(baseline);
    expect(resultProbeTopologySignature("project-1", "run-1", "model-1", surfaceMesh, "case:b")).not.toBe(baseline);
    expect(resultProbeTopologySignature("project-1", "run-1", "model-1", { ...surfaceMesh, triangles: [...surfaceMesh.triangles, [0, 2, 1]] })).not.toBe(baseline);
  });
});
