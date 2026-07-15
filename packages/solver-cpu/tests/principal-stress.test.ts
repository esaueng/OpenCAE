import { describe, expect, test } from "vitest";
import { computePrincipalStressMeasures } from "../src";

describe("principal stress measures", () => {
  test("recovers uniaxial, hydrostatic, and pure-shear eigenvalues", () => {
    expect(computePrincipalStressMeasures([100, 0, 0, 0, 0, 0])).toEqual({
      principalMax: 100,
      principalMin: 0,
      maxShear: 50
    });
    expect(computePrincipalStressMeasures([-25, -25, -25, 0, 0, 0])).toEqual({
      principalMax: -25,
      principalMin: -25,
      maxShear: 0
    });
    const shear = computePrincipalStressMeasures([0, 0, 0, 30, 0, 0]);
    expect(shear.principalMax).toBeCloseTo(30, 12);
    expect(shear.principalMin).toBeCloseTo(-30, 12);
    expect(shear.maxShear).toBeCloseTo(30, 12);
  });

  test("handles a rotated uniaxial tensor without changing its principal values", () => {
    const measures = computePrincipalStressMeasures([50, 50, 0, 50, 0, 0]);

    expect(measures.principalMax).toBeCloseTo(100, 12);
    expect(measures.principalMin).toBeCloseTo(0, 12);
    expect(measures.maxShear).toBeCloseTo(50, 12);
  });
});
