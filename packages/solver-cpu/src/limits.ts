import type { CpuSolverError } from "./types";

export const DEFAULT_STRUCTURAL_MAX_DOFS = 150_000;

type StructuralNodeModel = {
  nodes: {
    coordinates: ArrayLike<number>;
  };
};

export function structuralDofCount(model: StructuralNodeModel): number {
  return Math.floor(model.nodes.coordinates.length / 3) * 3;
}

/** A caller may lower the structural cap but cannot raise the solver-owned product ceiling. */
export function boundedStructuralMaxDofs(
  requested: unknown
): number {
  const requestedLimit = positiveInteger(requested);
  return requestedLimit === undefined
    ? DEFAULT_STRUCTURAL_MAX_DOFS
    : Math.min(requestedLimit, DEFAULT_STRUCTURAL_MAX_DOFS);
}

export function structuralDofLimitError(dofs: number, maxDofs: number): CpuSolverError | undefined {
  return dofs > maxDofs
    ? { code: "max-dofs-exceeded", message: `Model has ${dofs} DOFs, which exceeds maxDofs ${maxDofs}.` }
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
