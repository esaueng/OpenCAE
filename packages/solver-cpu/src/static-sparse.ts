import type { CpuSolverInput, CpuSolverOptions, StaticLinearTet4CpuSolveResult } from "./types";
import { solveStaticLinearTet4Cpu } from "./solver";

export function solveStaticLinearTetSparse(
  input: CpuSolverInput,
  options: CpuSolverOptions = {}
): StaticLinearTet4CpuSolveResult {
  return solveStaticLinearTet4Cpu(input, {
    ...options,
    solverMode: "sparse"
  });
}
