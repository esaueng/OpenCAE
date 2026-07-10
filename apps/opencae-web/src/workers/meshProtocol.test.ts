import { STEP_GEOMETRY_REPAIR_LOST_VOLUME_ERROR_NAME, stepGeometryNoRepairedVolumeError, StepGeometryError } from "@opencae/mesh-intake";
import { describe, expect, test } from "vitest";
import {
  createMeshWorkerRequest,
  normalizeMeshWorkerError,
  shouldProbeStepRepair,
  transferablesForMeshWorkerRequest,
  transferablesForMeshWorkerResult
} from "./meshProtocol";

describe("mesh worker protocol", () => {
  test.each(["inspectStepFile", "repairStepFile"] as const)(
    "transfers the STEP buffer for %s requests",
    (operation) => {
      const stepContent = new ArrayBuffer(16);
      const request = createMeshWorkerRequest(operation, { stepContent });

      expect(transferablesForMeshWorkerRequest(request)).toEqual([stepContent]);
    }
  );

  test("transfers repaired STEP byte buffers in worker results", () => {
    const stepContent = new Uint8Array([1, 2, 3, 4]);

    expect(transferablesForMeshWorkerResult({ stepContent })).toEqual([stepContent.buffer]);
  });

  test("carries the forced solid-repair probe flag to the worker", () => {
    const request = createMeshWorkerRequest("inspectStepFile", {
      stepContent: new ArrayBuffer(16),
      probeRepairEvenIfSolid: true
    });

    expect(request.payload.probeRepairEvenIfSolid).toBe(true);
  });

  test("only probes nominal solids when the caller explicitly requests it", () => {
    const inspection = {
      status: "solid" as const,
      volumeCount: 1,
      surfaceCount: 6,
      orphanSurfaceCount: 0,
      openBoundaryCurveCount: 2,
      surfaceMeshValid: true,
      repairable: false
    };

    expect(shouldProbeStepRepair(inspection)).toBe(false);
    expect(shouldProbeStepRepair(inspection, true)).toBe(true);
    expect(shouldProbeStepRepair({ ...inspection, status: "invalid" }, true)).toBe(false);
  });

  test("preserves StepGeometryError names across the worker boundary", () => {
    const error = new StepGeometryError("The STEP model contains an open surface.");

    expect(normalizeMeshWorkerError(error)).toMatchObject({
      name: "StepGeometryError",
      message: "The STEP model contains an open surface."
    });
  });

  test("preserves the repair-lost-volume marker across the worker boundary", () => {
    const error = stepGeometryNoRepairedVolumeError(1, 0.05);

    expect(normalizeMeshWorkerError(error)).toMatchObject({
      name: STEP_GEOMETRY_REPAIR_LOST_VOLUME_ERROR_NAME,
      message: expect.stringContaining("repaired attempt was discarded")
    });
  });
});
