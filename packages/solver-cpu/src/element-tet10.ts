import type { CpuSolverError } from "./types";
import { elementVolumeTolerance } from "./geometry-policy";

export const TET10_NODE_COUNT = 10;
export const TET10_DOFS = TET10_NODE_COUNT * 3;

// Midside node a (4..9) sits between these two vertices (VTK ordering, matching TET10_FACES in @opencae/core).
export const TET10_EDGE_VERTICES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [0, 2],
  [0, 3],
  [1, 3],
  [2, 3]
];

// 4-point Gauss rule on the reference tetrahedron, exact for quadratic integrands.
const GAUSS_A = 0.5854101966249685;
const GAUSS_B = 0.13819660112501053;
export const TET10_GAUSS_POINTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [GAUSS_A, GAUSS_B, GAUSS_B, GAUSS_B],
  [GAUSS_B, GAUSS_A, GAUSS_B, GAUSS_B],
  [GAUSS_B, GAUSS_B, GAUSS_A, GAUSS_B],
  [GAUSS_B, GAUSS_B, GAUSS_B, GAUSS_A]
];
export const TET10_GAUSS_WEIGHT = 1 / 24;
const CENTROID: readonly [number, number, number, number] = [0.25, 0.25, 0.25, 0.25];

// Barycentric coordinates of each of the 10 nodes (4 vertices, then the 6 edge
// midpoints in TET10_EDGE_VERTICES order). Strain varies linearly inside a Tet10,
// so evaluating at the nodes recovers outer-fiber stress that centroid-only
// sampling systematically underestimates.
export const TET10_NODE_BARYCENTRIC: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [0.5, 0.5, 0, 0],
  [0, 0.5, 0.5, 0],
  [0.5, 0, 0.5, 0],
  [0.5, 0, 0, 0.5],
  [0, 0.5, 0, 0.5],
  [0, 0, 0.5, 0.5]
];

// Barycentric gradients with respect to reference coordinates (ξ, η, ζ); L0 = 1 - ξ - η - ζ.
const BARYCENTRIC_GRADIENTS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, -1],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];

export type Tet10StiffnessResult =
  | { ok: true; stiffness: Float64Array; volume: number }
  | { ok: false; error: CpuSolverError };

export type Tet10StrainResult =
  | { ok: true; strain: Float64Array }
  | { ok: false; error: CpuSolverError };

export type Tet10VolumeResult =
  | { ok: true; volume: number }
  | { ok: false; error: CpuSolverError };

function shapeDerivativesRef(barycentric: readonly [number, number, number, number]): Float64Array {
  const derivatives = new Float64Array(TET10_NODE_COUNT * 3);
  for (let vertex = 0; vertex < 4; vertex += 1) {
    const scale = 4 * barycentric[vertex] - 1;
    const gradient = BARYCENTRIC_GRADIENTS[vertex];
    derivatives[vertex * 3] = scale * gradient[0];
    derivatives[vertex * 3 + 1] = scale * gradient[1];
    derivatives[vertex * 3 + 2] = scale * gradient[2];
  }
  for (let edge = 0; edge < TET10_EDGE_VERTICES.length; edge += 1) {
    const [m, n] = TET10_EDGE_VERTICES[edge];
    const gm = BARYCENTRIC_GRADIENTS[m];
    const gn = BARYCENTRIC_GRADIENTS[n];
    const node = 4 + edge;
    derivatives[node * 3] = 4 * (barycentric[m] * gn[0] + barycentric[n] * gm[0]);
    derivatives[node * 3 + 1] = 4 * (barycentric[m] * gn[1] + barycentric[n] * gm[1]);
    derivatives[node * 3 + 2] = 4 * (barycentric[m] * gn[2] + barycentric[n] * gm[2]);
  }
  return derivatives;
}

export function computeTet10PhysicalGradients(
  coordinates: Float64Array,
  barycentric: readonly [number, number, number, number]
): { ok: true; gradients: Float64Array; detJ: number } | { ok: false; error: CpuSolverError } {
  const reference = shapeDerivativesRef(barycentric);
  const j = new Float64Array(9);
  for (let node = 0; node < TET10_NODE_COUNT; node += 1) {
    const x = coordinates[node * 3];
    const y = coordinates[node * 3 + 1];
    const z = coordinates[node * 3 + 2];
    for (let c = 0; c < 3; c += 1) {
      const dN = reference[node * 3 + c];
      j[c] += x * dN;
      j[3 + c] += y * dN;
      j[6 + c] += z * dN;
    }
  }
  const detJ = det3(j);
  const tolerance = elementVolumeTolerance(coordinates);
  if (!(detJ > tolerance)) {
    return {
      ok: false,
      error: {
        code: detJ < 0 ? "inverted-element" : "degenerate-element",
        message:
          detJ < 0
            ? "Tet10 element has negative Jacobian determinant."
            : "Tet10 element Jacobian is too close to singular."
      }
    };
  }
  const inverse = invert3(j, detJ);
  const gradients = new Float64Array(TET10_NODE_COUNT * 3);
  for (let node = 0; node < TET10_NODE_COUNT; node += 1) {
    const dx = reference[node * 3];
    const dy = reference[node * 3 + 1];
    const dz = reference[node * 3 + 2];
    // ∇N = J⁻ᵀ · dN/dξ
    gradients[node * 3] = inverse[0] * dx + inverse[3] * dy + inverse[6] * dz;
    gradients[node * 3 + 1] = inverse[1] * dx + inverse[4] * dy + inverse[7] * dz;
    gradients[node * 3 + 2] = inverse[2] * dx + inverse[5] * dy + inverse[8] * dz;
  }
  return { ok: true, gradients, detJ };
}

export function computeTet10BMatrix(gradients: Float64Array): Float64Array {
  const cols = TET10_DOFS;
  const b = new Float64Array(6 * cols);
  for (let node = 0; node < TET10_NODE_COUNT; node += 1) {
    const gx = gradients[node * 3];
    const gy = gradients[node * 3 + 1];
    const gz = gradients[node * 3 + 2];
    const col = node * 3;

    b[col] = gx;
    b[cols + col + 1] = gy;
    b[2 * cols + col + 2] = gz;
    b[3 * cols + col] = gy;
    b[3 * cols + col + 1] = gx;
    b[4 * cols + col + 1] = gz;
    b[4 * cols + col + 2] = gy;
    b[5 * cols + col] = gz;
    b[5 * cols + col + 2] = gx;
  }
  return b;
}

export function computeTet10ElementStiffness(
  coordinates: Float64Array,
  dMatrix: Float64Array
): Tet10StiffnessResult {
  if (coordinates.length !== TET10_DOFS) {
    return {
      ok: false,
      error: {
        code: "invalid-element-coordinates",
        message: "Tet10 stiffness requires 30 coordinate values."
      }
    };
  }
  const cols = TET10_DOFS;
  const stiffness = new Float64Array(cols * cols);
  let volume = 0;

  for (const point of TET10_GAUSS_POINTS) {
    const local = computeTet10PhysicalGradients(coordinates, point);
    if (!local.ok) return local;
    const weight = TET10_GAUSS_WEIGHT * local.detJ;
    volume += weight;
    const b = computeTet10BMatrix(local.gradients);
    const db = new Float64Array(6 * cols);
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        let value = 0;
        for (let k = 0; k < 6; k += 1) {
          value += dMatrix[row * 6 + k] * b[k * cols + col];
        }
        db[row * cols + col] = value;
      }
    }
    for (let row = 0; row < cols; row += 1) {
      for (let col = row; col < cols; col += 1) {
        let value = 0;
        for (let k = 0; k < 6; k += 1) {
          value += b[k * cols + row] * db[k * cols + col];
        }
        stiffness[row * cols + col] += value * weight;
      }
    }
  }
  for (let row = 1; row < cols; row += 1) {
    for (let col = 0; col < row; col += 1) {
      stiffness[row * cols + col] = stiffness[col * cols + row];
    }
  }

  if (!(volume > elementVolumeTolerance(coordinates))) {
    return {
      ok: false,
      error: {
        code: "degenerate-element",
        message: "Tet10 element volume is too close to zero."
      }
    };
  }
  return { ok: true, stiffness, volume };
}

export function computeTet10Volume(coordinates: Float64Array): Tet10VolumeResult {
  let volume = 0;
  for (const point of TET10_GAUSS_POINTS) {
    const local = computeTet10PhysicalGradients(coordinates, point);
    if (!local.ok) return local;
    volume += TET10_GAUSS_WEIGHT * local.detJ;
  }
  if (!(volume > elementVolumeTolerance(coordinates))) {
    return {
      ok: false,
      error: {
        code: "degenerate-element",
        message: "Tet10 element volume is too close to zero."
      }
    };
  }
  return { ok: true, volume };
}

// Strains at all 10 node locations (10 x 6 values, node-major). Used for nodal
// stress recovery; falls back element-by-element to the caller on degenerate Jacobians.
export function recoverTet10NodalStrains(
  coordinates: Float64Array,
  elementDisplacement: Float64Array
): { ok: true; strains: Float64Array } | { ok: false; error: CpuSolverError } {
  const strains = new Float64Array(TET10_NODE_COUNT * 6);
  for (let node = 0; node < TET10_NODE_COUNT; node += 1) {
    const local = computeTet10PhysicalGradients(coordinates, TET10_NODE_BARYCENTRIC[node]);
    if (!local.ok) return local;
    const b = computeTet10BMatrix(local.gradients);
    for (let row = 0; row < 6; row += 1) {
      let value = 0;
      for (let col = 0; col < TET10_DOFS; col += 1) {
        value += b[row * TET10_DOFS + col] * elementDisplacement[col];
      }
      strains[node * 6 + row] = value;
    }
  }
  return { ok: true, strains };
}

export function recoverTet10CentroidStrain(
  coordinates: Float64Array,
  elementDisplacement: Float64Array
): Tet10StrainResult {
  const local = computeTet10PhysicalGradients(coordinates, CENTROID);
  if (!local.ok) return local;
  const b = computeTet10BMatrix(local.gradients);
  const strain = new Float64Array(6);
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < TET10_DOFS; col += 1) {
      strain[row] += b[row * TET10_DOFS + col] * elementDisplacement[col];
    }
  }
  return { ok: true, strain };
}

function det3(m: Float64Array): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function invert3(m: Float64Array, determinant: number): Float64Array {
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
