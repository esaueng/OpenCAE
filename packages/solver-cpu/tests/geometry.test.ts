import { describe, expect, test } from "vitest";
import {
  computeLinearElasticDMatrix,
  computeTet4BMatrix,
  computeTet4ElementStiffness,
  computeTet4Geometry,
  computeVonMisesStress
} from "../src";

const unitTet = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);

describe("Tet4 reference math", () => {
  test("computes unit Tet4 volume and gradients", () => {
    const geometry = computeTet4Geometry(unitTet);

    expect(geometry.ok).toBe(true);
    if (!geometry.ok) return;
    expect(geometry.volume).toBeCloseTo(1 / 6, 14);
    expect(Array.from(geometry.gradients)).toEqual([
      -1, -1, -1,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1
    ]);
  });

  test("rejects degenerate Tet4 elements", () => {
    const geometry = computeTet4Geometry(new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]));

    expect(geometry).toEqual({
      ok: false,
      error: {
        code: "degenerate-element",
        message: "Tet4 element volume is too close to zero."
      }
    });
  });

  test("rejects inverted Tet4 elements", () => {
    const geometry = computeTet4Geometry(new Float64Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1]));

    expect(geometry.ok).toBe(false);
    expect(geometry.ok ? undefined : geometry.error.code).toBe("inverted-element");
  });

  test("computes symmetric isotropic D matrix entries", () => {
    const d = computeLinearElasticDMatrix({ youngModulus: 210, poissonRatio: 0.3 });

    expect(d[1]).toBeCloseTo(d[6], 14);
    expect(d[0]).toBeCloseTo(282.6923076923, 10);
    expect(d[1]).toBeCloseTo(121.1538461538, 10);
    expect(d[21]).toBeCloseTo(80.7692307692, 10);
  });

  test("computes B matrix dimensions and symmetric Tet4 stiffness", () => {
    const geometry = computeTet4Geometry(unitTet);
    expect(geometry.ok).toBe(true);
    if (!geometry.ok) return;

    const b = computeTet4BMatrix(geometry.gradients);
    const k = computeTet4ElementStiffness(
      geometry,
      computeLinearElasticDMatrix({ youngModulus: 100, poissonRatio: 0.25 })
    );

    expect(b.length).toBe(72);
    expect(k.ok).toBe(true);
    if (!k.ok) return;
    expect(k.stiffness.length).toBe(144);
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        expect(k.stiffness[row * 12 + col]).toBeCloseTo(k.stiffness[col * 12 + row], 10);
      }
    }
  });

  test("has zero rigid translation element energy", () => {
    const geometry = computeTet4Geometry(unitTet);
    expect(geometry.ok).toBe(true);
    if (!geometry.ok) return;

    const k = computeTet4ElementStiffness(
      geometry,
      computeLinearElasticDMatrix({ youngModulus: 100, poissonRatio: 0.25 })
    );
    expect(k.ok).toBe(true);
    if (!k.ok) return;

    const translation = new Float64Array([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
    const force = new Float64Array(12);
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        force[row] += k.stiffness[row * 12 + col] * translation[col];
      }
    }

    expect(Math.max(...Array.from(force).map(Math.abs))).toBeLessThan(1e-10);
  });

  test("computes von Mises uniaxial and hydrostatic sanity values", () => {
    expect(computeVonMisesStress([10, 0, 0, 0, 0, 0])).toBeCloseTo(10, 14);
    expect(computeVonMisesStress([8, 8, 8, 0, 0, 0])).toBeCloseTo(0, 14);
  });
});
