import { StepGeometryError } from "@opencae/mesh-intake";
import { describe, expect, test } from "vitest";
import {
  createMeshWorkerRequest,
  normalizeMeshWorkerError,
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

  test("preserves StepGeometryError names across the worker boundary", () => {
    const error = new StepGeometryError("The STEP model contains an open surface.");

    expect(normalizeMeshWorkerError(error)).toMatchObject({
      name: "StepGeometryError",
      message: "The STEP model contains an open surface."
    });
  });
});
