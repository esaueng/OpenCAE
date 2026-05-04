// @ts-nocheck
import type { Tet4GeometryResult } from "./types";

export function computeTet4Geometry(coordinates: Float64Array, tolerance = 1e-14): Tet4GeometryResult {
  if (coordinates.length !== 12) {
    return {
      ok: false,
      error: {
        code: "invalid-element-coordinates",
        message: "Tet4 geometry requires 12 coordinate values."
      }
    };
  }

  const x1 = coordinates[0] ?? 0;
  const y1 = coordinates[1] ?? 0;
  const z1 = coordinates[2] ?? 0;
  const x2 = coordinates[3] ?? 0;
  const y2 = coordinates[4] ?? 0;
  const z2 = coordinates[5] ?? 0;
  const x3 = coordinates[6] ?? 0;
  const y3 = coordinates[7] ?? 0;
  const z3 = coordinates[8] ?? 0;
  const x4 = coordinates[9] ?? 0;
  const y4 = coordinates[10] ?? 0;
  const z4 = coordinates[11] ?? 0;

  const j = new Float64Array([
    x2 - x1, x3 - x1, x4 - x1,
    y2 - y1, y3 - y1, y4 - y1,
    z2 - z1, z3 - z1, z4 - z1
  ]);
  const determinant = det3(j);
  const signedVolume = determinant / 6;

  if (Math.abs(signedVolume) <= tolerance) {
    return {
      ok: false,
      error: {
        code: "degenerate-element",
        message: "Tet4 element volume is too close to zero."
      }
    };
  }

  if (signedVolume < 0) {
    return {
      ok: false,
      error: {
        code: "inverted-element",
        message: "Tet4 element has negative signed volume."
      }
    };
  }

  const inverseTranspose = transpose(invert3(j));
  const gradients = new Float64Array(12);
  const referenceGradients = [
    [-1, -1, -1],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];

  for (let node = 0; node < 4; node += 1) {
    const grad = referenceGradients[node] ?? [0, 0, 0];
    gradients[node * 3] =
      (inverseTranspose[0] ?? 0) * grad[0] + (inverseTranspose[1] ?? 0) * grad[1] + (inverseTranspose[2] ?? 0) * grad[2];
    gradients[node * 3 + 1] =
      (inverseTranspose[3] ?? 0) * grad[0] + (inverseTranspose[4] ?? 0) * grad[1] + (inverseTranspose[5] ?? 0) * grad[2];
    gradients[node * 3 + 2] =
      (inverseTranspose[6] ?? 0) * grad[0] + (inverseTranspose[7] ?? 0) * grad[1] + (inverseTranspose[8] ?? 0) * grad[2];
  }

  return {
    ok: true,
    signedVolume,
    volume: signedVolume,
    gradients
  };
}

function det3(m: Float64Array): number {
  return (
    (m[0] ?? 0) * ((m[4] ?? 0) * (m[8] ?? 0) - (m[5] ?? 0) * (m[7] ?? 0)) -
    (m[1] ?? 0) * ((m[3] ?? 0) * (m[8] ?? 0) - (m[5] ?? 0) * (m[6] ?? 0)) +
    (m[2] ?? 0) * ((m[3] ?? 0) * (m[7] ?? 0) - (m[4] ?? 0) * (m[6] ?? 0))
  );
}

function invert3(m: Float64Array): Float64Array {
  const determinant = det3(m);
  return new Float64Array([
    ((m[4] ?? 0) * (m[8] ?? 0) - (m[5] ?? 0) * (m[7] ?? 0)) / determinant,
    ((m[2] ?? 0) * (m[7] ?? 0) - (m[1] ?? 0) * (m[8] ?? 0)) / determinant,
    ((m[1] ?? 0) * (m[5] ?? 0) - (m[2] ?? 0) * (m[4] ?? 0)) / determinant,
    ((m[5] ?? 0) * (m[6] ?? 0) - (m[3] ?? 0) * (m[8] ?? 0)) / determinant,
    ((m[0] ?? 0) * (m[8] ?? 0) - (m[2] ?? 0) * (m[6] ?? 0)) / determinant,
    ((m[2] ?? 0) * (m[3] ?? 0) - (m[0] ?? 0) * (m[5] ?? 0)) / determinant,
    ((m[3] ?? 0) * (m[7] ?? 0) - (m[4] ?? 0) * (m[6] ?? 0)) / determinant,
    ((m[1] ?? 0) * (m[6] ?? 0) - (m[0] ?? 0) * (m[7] ?? 0)) / determinant,
    ((m[0] ?? 0) * (m[4] ?? 0) - (m[1] ?? 0) * (m[3] ?? 0)) / determinant
  ]);
}

function transpose(m: Float64Array): Float64Array {
  return new Float64Array([
    m[0] ?? 0, m[3] ?? 0, m[6] ?? 0,
    m[1] ?? 0, m[4] ?? 0, m[7] ?? 0,
    m[2] ?? 0, m[5] ?? 0, m[8] ?? 0
  ]);
}
