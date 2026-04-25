import { describe, expect, test } from "vitest";
import { assessResultFailure } from "./index";

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
});
