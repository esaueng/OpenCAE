import { describe, expect, test } from "vitest";
import type { Study } from "@opencae/schema";
import { isBeamDemoStudy, solveBeamDemoStudy } from "./beamDemoSolver";

describe("Beam Demo Euler-Bernoulli solver", () => {
  test("detects the Beam Demo named selections without using the generic surface heuristic", () => {
    expect(isBeamDemoStudy(beamPayloadStudy())).toBe(true);
    expect(isBeamDemoStudy(cantileverStudy())).toBe(false);
  });

  test("converts payload mass to Newtons and returns dense displacement vectors", () => {
    const result = solveBeamDemoStudy(beamPayloadStudy(), "run-beam-payload");
    const displacement = result.fields.find((field) => field.type === "displacement");
    const fixedSample = displacement?.samples?.find((sample) => sample.nodeId === "beam-node-0");
    const peakSample = [...(displacement?.samples ?? [])].sort((left, right) => right.value - left.value)[0];

    expect(result.solverBackend).toBe("local-beam-demo-euler-bernoulli");
    expect(result.summary.reactionForce).toBeCloseTo(4.9 * 9.80665, 5);
    expect(result.beamDemoDiagnostics.loadForceN).toBeCloseTo(4.9 * 9.80665, 5);
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
    const result = solveBeamDemoStudy(beamPayloadStudy(), "run-beam-smooth");
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

    expect(result.beamDemoDiagnostics.loadStation).toBeGreaterThan(0);
    expect(result.beamDemoDiagnostics.loadStation).toBeLessThan(1);
    expect(beyondLoad.length).toBeGreaterThan(2);
    expect(new Set(beyondLoad.map((value) => value.toFixed(8))).size).toBeGreaterThan(2);
    expect(fixedValue).toBeCloseTo(0, 8);
    expect(freeValue).toBeGreaterThan(nearFixed);
    expect(maxAdjacentJump).toBeLessThan(freeValue * 0.08);
  });

  test("computes physically coherent bending stress and safety factor", () => {
    const result = solveBeamDemoStudy(beamPayloadStudy(), "run-beam-stress");
    const stress = result.fields.find((field) => field.type === "stress");
    const safety = result.fields.find((field) => field.type === "safety_factor");
    const fixedStress = stress?.samples?.find((sample) => sample.nodeId === "beam-node-0")?.value ?? 0;
    const loadStress = stress?.samples?.find((sample) => sample.nodeId === `beam-node-${Math.round(result.beamDemoDiagnostics.loadStation * 64)}`)?.value ?? 0;
    const freeStress = stress?.samples?.find((sample) => sample.nodeId === "beam-node-64")?.value ?? 0;

    expect(stress?.samples?.length).toBeGreaterThan(64);
    expect(fixedStress).toBeGreaterThan(loadStress);
    expect(fixedStress).toBeGreaterThan(freeStress);
    expect(result.summary.maxStress).toBeCloseTo(stress?.max ?? 0, 4);
    expect(result.summary.safetyFactor).toBeCloseTo(safety?.min ?? 0, 4);
    expect(result.summary.safetyFactor).toBeCloseTo(result.beamDemoDiagnostics.yieldMPa / result.summary.maxStress, 3);
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
});

function station(nodeId: string | undefined): number {
  return Number(nodeId?.replace("beam-node-", "") ?? 0);
}

function beamPayloadStudy(): Study {
  return beamStudy("gravity", 4.9, "kg", [0, -1, 0], [1.48, 0.49, 0]);
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
