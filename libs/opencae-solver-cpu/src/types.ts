import type { NormalizedOpenCAEModel, OpenCAEModelJson, ValidationReport } from "@opencae/core";

export type CpuSolverInput = OpenCAEModelJson | NormalizedOpenCAEModel;

export type CpuSolverOptions = {
  stepIndex?: number;
  maxDofs?: number;
  singularTolerance?: number;
};

export type CpuSolverError = {
  code: string;
  message: string;
  report?: ValidationReport;
};

export type CpuSolverDiagnostics = {
  dofs: number;
  freeDofs: number;
  constrainedDofs: number;
  relativeResidual: number;
  maxDisplacement: number;
  maxVonMisesStress: number;
};

export type StaticLinearTet4CpuResult = {
  displacement: Float64Array;
  reactionForce: Float64Array;
  strain: Float64Array;
  stress: Float64Array;
  vonMises: Float64Array;
};

export type StaticLinearTet4CpuSolveResult =
  | {
      ok: true;
      result: StaticLinearTet4CpuResult;
      diagnostics: CpuSolverDiagnostics;
    }
  | {
      ok: false;
      error: CpuSolverError;
      diagnostics?: Partial<CpuSolverDiagnostics>;
    };

export type Tet4GeometryResult =
  | {
      ok: true;
      signedVolume: number;
      volume: number;
      gradients: Float64Array;
    }
  | {
      ok: false;
      error: CpuSolverError;
    };

export type Tet4ElementStiffnessResult =
  | {
      ok: true;
      stiffness: Float64Array;
    }
  | {
      ok: false;
      error: CpuSolverError;
    };

export type DenseLinearSolveResult =
  | {
      ok: true;
      solution: Float64Array;
    }
  | {
      ok: false;
      error: CpuSolverError;
    };
