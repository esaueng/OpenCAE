import { describe, expect, it } from "vitest";
import { scalarForStressComponent, symmetricTensorEigenvalues } from "./stressTensor";

describe("symmetricTensorEigenvalues", () => {
  it.each([
    ["uniaxial", [100, 0, 0, 0, 0, 0], [100, 0, 0]],
    ["hydrostatic", [-25, -25, -25, 0, 0, 0], [-25, -25, -25]],
    ["pure shear", [0, 0, 0, 40, 0, 0], [40, 0, -40]],
    ["rotated", [50, 50, 0, 50, 0, 0], [100, 0, 0]],
    ["repeated", [12, 12, -3, 0, 0, 0], [12, 12, -3]]
  ] as const)("solves %s tensors", (_name, tensor, expected) => {
    expect(symmetricTensorEigenvalues(tensor)).toEqual(expect.arrayContaining(expected.map((value) => expect.closeTo(value, 10))));
  });

  it("uses a scaled tolerance for near-degenerate tensors", () => {
    const values = symmetricTensorEigenvalues([1e12, 1e12 + 1e-3, 1e12, 1e-8, 0, 0]);
    expect(values.every(Number.isFinite)).toBe(true);
    expect(values[0]).toBeGreaterThanOrEqual(values[1]);
    expect(values[1]).toBeGreaterThanOrEqual(values[2]);
  });

  it("derives signed principals and nonnegative maximum shear", () => {
    const tensor = [-30, 10, 0, 0, 0, 0] as const;
    expect(scalarForStressComponent(tensor, "principal_max")).toBeCloseTo(10);
    expect(scalarForStressComponent(tensor, "principal_min")).toBeCloseTo(-30);
    expect(scalarForStressComponent(tensor, "max_shear")).toBeCloseTo(20);
  });
});
