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

  const x1 = coordinates[0];
  const y1 = coordinates[1];
  const z1 = coordinates[2];
  const x2 = coordinates[3];
  const y2 = coordinates[4];
  const z2 = coordinates[5];
  const x3 = coordinates[6];
  const y3 = coordinates[7];
  const z3 = coordinates[8];
  const x4 = coordinates[9];
  const y4 = coordinates[10];
  const z4 = coordinates[11];

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
    const grad = referenceGradients[node];
    gradients[node * 3] =
      inverseTranspose[0] * grad[0] + inverseTranspose[1] * grad[1] + inverseTranspose[2] * grad[2];
    gradients[node * 3 + 1] =
      inverseTranspose[3] * grad[0] + inverseTranspose[4] * grad[1] + inverseTranspose[5] * grad[2];
    gradients[node * 3 + 2] =
      inverseTranspose[6] * grad[0] + inverseTranspose[7] * grad[1] + inverseTranspose[8] * grad[2];
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
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function invert3(m: Float64Array): Float64Array {
  const determinant = det3(m);
  return new Float64Array([
    (m[4] * m[8] - m[5] * m[7]) / determinant,
    (m[2] * m[7] - m[1] * m[8]) / determinant,
    (m[1] * m[5] - m[2] * m[4]) / determinant,
    (m[5] * m[6] - m[3] * m[8]) / determinant,
    (m[0] * m[8] - m[2] * m[6]) / determinant,
    (m[2] * m[3] - m[0] * m[5]) / determinant,
    (m[3] * m[7] - m[4] * m[6]) / determinant,
    (m[1] * m[6] - m[0] * m[7]) / determinant,
    (m[0] * m[4] - m[1] * m[3]) / determinant
  ]);
}

function transpose(m: Float64Array): Float64Array {
  return new Float64Array([
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8]
  ]);
}
