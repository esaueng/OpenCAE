import type { StressComponent } from "@opencae/schema";

export type SymmetricStressTensor = readonly [number, number, number, number, number, number];

const MAX_JACOBI_SWEEPS = 24;
const RELATIVE_TOLERANCE = 64 * Number.EPSILON;

/** Eigenvalues of a real symmetric 3x3 tensor, sorted in descending algebraic order. */
export function symmetricTensorEigenvalues(tensor: SymmetricStressTensor): [number, number, number] {
  const [xx, yy, zz, xy, yz, xz] = tensor;
  if (![xx, yy, zz, xy, yz, xz].every(Number.isFinite)) return [Number.NaN, Number.NaN, Number.NaN];
  const matrix = [xx, xy, xz, xy, yy, yz, xz, yz, zz];
  const scale = Math.max(...matrix.map(Math.abs), Number.MIN_VALUE);
  const tolerance = scale * RELATIVE_TOLERANCE;

  for (let sweep = 0; sweep < MAX_JACOBI_SWEEPS; sweep += 1) {
    const pairs = [[0, 1], [0, 2], [1, 2]] as const;
    let p = 0;
    let q = 1;
    let largest = Math.abs(matrix[1]!);
    for (const [candidateP, candidateQ] of pairs.slice(1)) {
      const magnitude = Math.abs(matrix[candidateP * 3 + candidateQ]!);
      if (magnitude > largest) {
        largest = magnitude;
        p = candidateP;
        q = candidateQ;
      }
    }
    if (largest <= tolerance) break;

    const apq = matrix[p * 3 + q]!;
    const delta = (matrix[q * 3 + q]! - matrix[p * 3 + p]!) / (2 * apq);
    const sign = delta < 0 ? -1 : 1;
    const tangent = sign / (Math.abs(delta) + Math.hypot(1, delta));
    const cosine = 1 / Math.hypot(1, tangent);
    const sine = tangent * cosine;
    const app = matrix[p * 3 + p]!;
    const aqq = matrix[q * 3 + q]!;
    matrix[p * 3 + p] = app - tangent * apq;
    matrix[q * 3 + q] = aqq + tangent * apq;
    matrix[p * 3 + q] = 0;
    matrix[q * 3 + p] = 0;
    for (let r = 0; r < 3; r += 1) {
      if (r === p || r === q) continue;
      const arp = matrix[r * 3 + p]!;
      const arq = matrix[r * 3 + q]!;
      const rotatedP = cosine * arp - sine * arq;
      const rotatedQ = sine * arp + cosine * arq;
      matrix[r * 3 + p] = rotatedP;
      matrix[p * 3 + r] = rotatedP;
      matrix[r * 3 + q] = rotatedQ;
      matrix[q * 3 + r] = rotatedQ;
    }
  }

  return [matrix[0]!, matrix[4]!, matrix[8]!].sort((left, right) => right - left) as [number, number, number];
}

export function scalarForStressComponent(tensor: SymmetricStressTensor, component: StressComponent): number {
  const [principalMax, , principalMin] = symmetricTensorEigenvalues(tensor);
  if (component === "principal_max") return principalMax;
  if (component === "principal_min") return principalMin;
  if (component === "max_shear") return (principalMax - principalMin) / 2;
  const [xx, yy, zz, xy, yz, xz] = tensor;
  return Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy ** 2 + yz ** 2 + xz ** 2));
}

export function deriveStressScalars(tensorValues: ArrayLike<number>, component: StressComponent): number[] {
  const count = Math.floor(tensorValues.length / 6);
  const values = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 6;
    values[index] = scalarForStressComponent([
      tensorValues[offset]!, tensorValues[offset + 1]!, tensorValues[offset + 2]!,
      tensorValues[offset + 3]!, tensorValues[offset + 4]!, tensorValues[offset + 5]!
    ], component);
  }
  return values;
}
