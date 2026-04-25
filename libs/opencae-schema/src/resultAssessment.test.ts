import { describe, expect, test } from "vitest";
import { assessResultFailure, estimateAllowableLoadForSafetyFactor } from "./index";

describe("assessResultFailure", () => {
  test("marks a result as failed when factor of safety is below one", () => {
    expect(assessResultFailure({ safetyFactor: 0.82, maxStress: 338, maxStressUnits: "MPa" })).toMatchObject({
      status: "fail",
      title: "Likely to fail"
    });
  });

  test("warns when the factor of safety has little margin", () => {
    expect(assessResultFailure({ safetyFactor: 1.2, maxStress: 210, maxStressUnits: "MPa" })).toMatchObject({
      status: "warning",
      title: "Low safety margin"
    });
  });

  test("passes when the factor of safety has usable margin", () => {
    expect(assessResultFailure({ safetyFactor: 1.8, maxStress: 142, maxStressUnits: "MPa" })).toMatchObject({
      status: "pass",
      title: "Unlikely to yield"
    });
  });

  test("estimates max load for a target factor of safety by linear scaling", () => {
    expect(estimateAllowableLoadForSafetyFactor({ safetyFactor: 0.75, reactionForce: 500, reactionForceUnits: "N" }, 1.5)).toMatchObject({
      status: "available",
      allowableLoad: 250,
      loadScale: 0.5,
      loadUnits: "N"
    });
  });

  test("does not estimate max load when the current result is invalid", () => {
    expect(estimateAllowableLoadForSafetyFactor({ safetyFactor: 0, reactionForce: 500, reactionForceUnits: "N" }, 1.5)).toMatchObject({
      status: "unknown",
      allowableLoad: 0
    });
  });
});
