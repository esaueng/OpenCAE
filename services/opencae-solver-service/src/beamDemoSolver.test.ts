import { describe, expect, test } from "vitest";
import { estimateAllowableLoadForSafetyFactor } from "@opencae/schema";
import type { Study } from "@opencae/schema";
import {
  DEFAULT_BEAM_DEMO_PHYSICAL_MODEL,
  endLoadCantileverShape,
  endLoadCantileverSlope,
  isBeamDemoStudy,
  normalizedPointLoadCantileverShape,
  pointLoadCantileverShape,
  solveBeamDemoStudy
} from "./beamDemoSolver";

const EXPECTED_PAYLOAD_FORCE_N = 0.497664 * 9.80665;
const EXPECTED_I_M4 = (0.0151578947368 * 0.0117894736842 ** 3) / 12;
const EXPECTED_STRESS_MPA = EXPECTED_PAYLOAD_FORCE_N * 0.16 * (0.0117894736842 / 2) / EXPECTED_I_M4 / 1_000_000;
const EXPECTED_DISPLACEMENT_MM = EXPECTED_PAYLOAD_FORCE_N * 0.16 ** 3 / (3 * 68_900_000_000 * EXPECTED_I_M4) * 1000;

describe("Beam Demo Euler-Bernoulli solver", () => {
  test("detects the Beam Demo named selections without using the generic surface heuristic", () => {
    expect(isBeamDemoStudy(beamPayloadStudy())).toBe(true);
    expect(isBeamDemoStudy(cantileverStudy())).toBe(true);
  });

  test("converts payload mass to Newtons and returns dense displacement vectors", () => {
    const result = solveBeamDemoStudy(beamPayloadStudy(0.497664), "run-beam-payload");
    const displacement = result.fields.find((field) => field.type === "displacement");
    const fixedSample = displacement?.samples?.find((sample) => sample.nodeId === "beam-node-0");
    const peakSample = [...(displacement?.samples ?? [])].sort((left, right) => right.value - left.value)[0];

    expect(result.solverBackend).toBe("local-beam-demo-euler-bernoulli");
    expect(result.summary.provenance).toMatchObject({
      kind: "analytical_benchmark",
      solver: "opencae-euler-bernoulli",
      resultSource: "generated"
    });
    expect(result.fields.every((field) => field.provenance?.kind === "analytical_benchmark")).toBe(true);
    expect(result.summary.reactionForce).toBeCloseTo(EXPECTED_PAYLOAD_FORCE_N, 5);
    expect(result.beamDemoDiagnostics.loadForceN).toBeCloseTo(EXPECTED_PAYLOAD_FORCE_N, 5);
    expect(result.beamDemoDiagnostics.secondMomentM4).toBeCloseTo(EXPECTED_I_M4, 15);
    expect(result.beamDemoDiagnostics.elementCount).toBeGreaterThanOrEqual(64);
    expect(displacement?.location).toBe("node");
    expect(displacement?.samples?.length).toBeGreaterThan(64);
    expect(fixedSample?.value).toBeCloseTo(0, 8);
    expect(fixedSample?.vector).toEqual([0, 0, 0]);
    expect(peakSample?.vector?.every(Number.isFinite)).toBe(true);
    expect(peakSample?.vector?.[1]).toBeLessThan(0);
    expect(Math.hypot(...peakSample!.vector!)).toBeCloseTo(peakSample!.value, 5);
  });

  test("keeps payload displacement smooth across and beyond the load station", () => {
    const result = solveBeamDemoStudy(beamPayloadStudy(0.497664), "run-beam-smooth");
    const displacement = result.fields.find((field) => field.type === "displacement");
    const centerline = (displacement?.samples ?? [])
      .filter((sample) => sample.source === "beam-demo-centerline")
      .sort((left, right) => station(left.nodeId) - station(right.nodeId));
    const loadStation = result.beamDemoDiagnostics.loadStation;
    const beyondLoad = centerline.filter((sample) => station(sample.nodeId) / 64 > loadStation + 0.02).map((sample) => sample.value);
    const fixedValue = centerline[0]?.value ?? Number.NaN;
    const nearFixed = centerline[Math.max(1, Math.floor(centerline.length * 0.1))]?.value ?? Number.NaN;
    const freeValue = centerline.at(-1)?.value ?? Number.NaN;
    const maxAdjacentJump = centerline.slice(1).reduce((maxJump, sample, index) => {
      const previous = centerline[index]!;
      return Math.max(maxJump, Math.abs(sample.value - previous.value));
    }, 0);

    expect(result.beamDemoDiagnostics.loadStation).toBeCloseTo(1, 8);
    expect(beyondLoad.length).toBe(0);
    expect(fixedValue).toBeCloseTo(0, 8);
    expect(freeValue).toBeGreaterThan(nearFixed);
    expect(maxAdjacentJump).toBeLessThan(freeValue * 0.08);
  });

  test("computes physically coherent bending stress and safety factor", () => {
    const result = solveBeamDemoStudy(beamPayloadStudy(0.497664), "run-beam-stress");
    const stress = result.fields.find((field) => field.type === "stress");
    const safety = result.fields.find((field) => field.type === "safety_factor");
    const fixedStress = stress?.samples?.find((sample) => sample.nodeId === "beam-node-0")?.value ?? 0;
    const loadStress = stress?.samples?.find((sample) => sample.nodeId === `beam-node-${Math.round(result.beamDemoDiagnostics.loadStation * 64)}`)?.value ?? 0;
    const freeStress = stress?.samples?.find((sample) => sample.nodeId === "beam-node-64")?.value ?? 0;

    expect(stress?.samples?.length).toBeGreaterThan(64);
    expect(result.summary.maxStress).toBeCloseTo(EXPECTED_STRESS_MPA, 3);
    expect(result.summary.maxDisplacement).toBeCloseTo(EXPECTED_DISPLACEMENT_MM, 4);
    expect(fixedStress).toBeGreaterThan(loadStress);
    expect(fixedStress).toBeGreaterThan(freeStress);
    expect(result.summary.maxStress).toBeCloseTo(stress?.max ?? 0, 4);
    expect(result.summary.safetyFactor).toBeCloseTo(safety?.min ?? 0, 4);
    expect(result.summary.safetyFactor).toBeCloseTo(result.beamDemoDiagnostics.yieldMPa / result.summary.maxStress, 3);
  });

  test("scales linearly with force and with explicit beam section dimensions", () => {
    const base = solveBeamDemoStudy(beamPayloadStudy(0.497664), "run-beam-base");
    const doubledLoad = solveBeamDemoStudy(beamPayloadStudy(0.995328), "run-beam-double-load");
    const doubledHeight = solveBeamDemoStudy(beamPayloadStudy(0.497664), "run-beam-double-height", {
      beamModel: {
        ...DEFAULT_BEAM_DEMO_PHYSICAL_MODEL,
        beamHeightMm: DEFAULT_BEAM_DEMO_PHYSICAL_MODEL.beamHeightMm * 2
      }
    });

    expect(doubledLoad.summary.maxStress / base.summary.maxStress).toBeCloseTo(2, 3);
    expect(doubledLoad.summary.maxDisplacement / base.summary.maxDisplacement).toBeCloseTo(2, 3);
    expect(base.summary.maxStress / doubledHeight.summary.maxStress).toBeCloseTo(4, 1);
    expect(base.summary.maxDisplacement / doubledHeight.summary.maxDisplacement).toBeCloseTo(8, 1);
  });

  test("keeps reverse load capacity plausible after corrected Beam Demo stress", () => {
    const result = solveBeamDemoStudy(beamPayloadStudy(0.497664), "run-beam-capacity");
    const capacity = estimateAllowableLoadForSafetyFactor(result.summary, 1.5);

    expect(capacity.allowableLoad).toBeCloseTo(404, 0);
    expect(capacity.allowableLoad).toBeLessThan(1000);
  });

  test("treats an end force as a standard end-load cantilever", () => {
    const result = solveBeamDemoStudy(beamForceStudy(), "run-beam-force");
    const displacement = result.fields.find((field) => field.type === "displacement");
    const values = (displacement?.samples ?? [])
      .filter((sample) => sample.source === "beam-demo-centerline")
      .map((sample) => sample.value);

    expect(result.summary.reactionForce).toBeCloseTo(500, 5);
    expect(result.beamDemoDiagnostics.loadStation).toBeCloseTo(1, 5);
    expect(values.at(-1)).toBe(Math.max(...values));
  });

  test("exports standard end-load cantilever shape helpers", () => {
    expect(endLoadCantileverShape(0)).toBeCloseTo(0, 8);
    expect(endLoadCantileverSlope(0, 12, 160)).toBeCloseTo(0, 8);
    expect(endLoadCantileverShape(0.25)).toBeCloseTo(0.0859375, 8);
    expect(endLoadCantileverShape(0.5)).toBeCloseTo(0.3125, 8);
    expect(endLoadCantileverShape(1)).toBeCloseTo(1, 8);
  });

  test("uses cubic end-load vectors for the Cantilever Demo force direction", () => {
    const result = solveBeamDemoStudy(cantileverStudy(), "run-cantilever-force");
    const displacement = result.fields.find((field) => field.type === "displacement");
    const centerline = (displacement?.samples ?? [])
      .filter((sample) => sample.source === "beam-demo-centerline")
      .sort((left, right) => station(left.nodeId) - station(right.nodeId));
    const fixed = centerline[0]!;
    const quarter = centerline[16]!;
    const mid = centerline[32]!;
    const tip = centerline[64]!;

    expect(result.beamDemoDiagnostics.loadStation).toBeCloseTo(1, 8);
    expect(result.beamDemoDiagnostics.freeEnd).toEqual([1.9, 0.14, 0]);
    expect(displacement?.samples?.length).toBeGreaterThanOrEqual(65 * 5);
    expect(fixed.value).toBeCloseTo(0, 8);
    expect(fixed.vector).toEqual([0, 0, 0]);
    expect(tip.value).toBeCloseTo(result.summary.maxDisplacement, 6);
    expect(quarter.value / tip.value).toBeCloseTo(0.0859375, 5);
    expect(mid.value / tip.value).toBeCloseTo(0.3125, 5);
    expect(mid.value / tip.value).not.toBeCloseTo(0.5, 1);
    expect(tip.vector?.[2]).toBeLessThan(0);
    expect(Math.abs(tip.vector?.[2] ?? 0)).toBeGreaterThan(Math.abs(tip.vector?.[1] ?? 0) * 5);
  });

  test("normalizes point-load cantilever shape when load is not at the free end", () => {
    const loadStation = 0.75;
    const freeRaw = pointLoadCantileverShape(1, loadStation);

    expect(normalizedPointLoadCantileverShape(0, loadStation)).toBeCloseTo(0, 8);
    expect(normalizedPointLoadCantileverShape(1, loadStation)).toBeCloseTo(1, 8);
    expect(normalizedPointLoadCantileverShape(0.5, loadStation)).toBeCloseTo(pointLoadCantileverShape(0.5, loadStation) / freeRaw, 8);
    expect(normalizedPointLoadCantileverShape(0.5, loadStation)).not.toBeCloseTo(0.5, 1);
  });
});

function station(nodeId: string | undefined): number {
  return Number(nodeId?.replace("beam-node-", "") ?? 0);
}

function beamPayloadStudy(massKg = 0.497664): Study {
  return beamStudy("gravity", massKg, "kg", [0, -1, 0], [1.48, 0.49, 0]);
}

function beamForceStudy(): Study {
  return beamStudy("force", 500, "N", [0, -1, 0], [1.9, 0.18, 0]);
}

function beamStudy(type: "force" | "gravity", value: number, units: string, direction: [number, number, number], applicationPoint: [number, number, number]): Study {
  return {
    id: "study-beam",
    projectId: "project-beam",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId: "mat-aluminum-6061", selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      {
        id: "selection-fixed-face",
        name: "Fixed end face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-left", label: "Fixed end face" }],
        fingerprint: "face-base-left-beam"
      },
      {
        id: "selection-load-face",
        name: "End payload mass",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load-top", label: "End payload mass" }],
        fingerprint: "face-load-top-beam"
      },
      {
        id: "selection-web-face",
        name: "Beam top face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-web-front", label: "Beam top face" }],
        fingerprint: "face-web-front-beam"
      },
      {
        id: "selection-base-face",
        name: "Beam body",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-bottom", label: "Beam body" }],
        fingerprint: "face-base-bottom-beam"
      }
    ],
    contacts: [],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
    loads: [{
      id: "load-beam",
      type,
      selectionRef: "selection-load-face",
      parameters: {
        value,
        units,
        direction,
        applicationPoint,
        ...(type === "gravity" ? { payloadObject: { id: "payload-display-plate", label: "end payload mass", center: applicationPoint } } : {})
      },
      status: "complete"
    }],
    meshSettings: { preset: "medium", status: "complete", meshRef: "mesh", summary: { nodes: 10, elements: 4, warnings: [] } },
    solverSettings: {},
    validation: [],
    runs: []
  };
}

function cantileverStudy(): Study {
  return {
    ...beamPayloadStudy(),
    id: "study-cantilever",
    projectId: "project-cantilever",
    namedSelections: beamPayloadStudy().namedSelections.map((selection) => ({
      ...selection,
      name: selection.name.replace("End payload mass", "Free end load face").replace("Beam body", "Beam bottom face"),
      geometryRefs: selection.geometryRefs.map((ref) => ({
        ...ref,
        label: ref.label.replace("End payload mass", "Free end load face").replace("Beam body", "Beam bottom face")
      }))
    })),
    loads: [{
      id: "load-free-end",
      type: "force",
      selectionRef: "selection-load-face",
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    }]
  };
}
