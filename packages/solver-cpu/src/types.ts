import type { CoreModalSolveResult as CoreModalFeaResult, CoreSolveResult, CoreStructuralSolveResult, LoadAssemblyDiagnostics, NormalizedOpenCAEModel, OpenCAEModelJson, ValidationReport } from "@opencae/core";

export type CpuSolverInput = OpenCAEModelJson | NormalizedOpenCAEModel;

export type SolveProgressEvent = {
  phase: "assemble" | "solve" | "recover" | "frames";
  completed: number;
  total: number;
  iteration?: number;
  relativeResidual?: number;
};

export type SolverHooks = {
  onProgress?: (event: SolveProgressEvent) => void;
  shouldCancel?: () => boolean;
};

export type CpuSolverOptions = {
  hooks?: SolverHooks;
  stepIndex?: number;
  maxDofs?: number;
  singularTolerance?: number;
  solverMode?: "auto" | "dense" | "sparse";
  method?: "auto" | "dense" | "sparse";
  tolerance?: number;
  maxIterations?: number;
  /** Symmetric preconditioners preserve CG's SPD requirement. Auto selects SSOR for sparse structural solves. */
  preconditioner?: "auto" | "none" | "jacobi" | "ssor";
  /** SSOR relaxation factor, constrained to 0 < omega < 2. */
  ssorOmega?: number;
  visualizationSmoothing?: {
    iterations?: number;
    alpha?: number;
  };
};

export type DynamicLoadProfile = "step" | "ramp" | "quasiStatic" | "quasi_static" | "half_sine" | "sinusoidal";

export type DynamicTet4CpuOptions = CpuSolverOptions & {
  startTime?: number;
  endTime?: number;
  timeStep?: number;
  outputInterval?: number;
  dampingRatio?: number;
  rayleighAlpha?: number;
  rayleighBeta?: number;
  loadProfile?: DynamicLoadProfile;
  massDensity?: number;
  maxFrames?: number;
};

export type ModalCpuOptions = CpuSolverOptions & {
  modeCount?: number;
  modalTolerance?: number;
  maxSubspaceIterations?: number;
};

export type ModalMode = {
  modeIndex: number;
  frequencyHz: number;
  eigenvalue: number;
  scaledResidual: number;
  shape: Float64Array;
};

export type ModalCpuDiagnostics = {
  dofs: number;
  freeDofs: number;
  constrainedDofs: number;
  requestedModeCount: number;
  convergedModeCount: number;
  blockSize: number;
  subspaceIterations: number;
  tolerance: number;
  totalMass: number;
  partialConvergenceWarning?: string;
  solver: "opencae-core-block-shift-invert";
};

export type ModalCpuResult = {
  modes: ModalMode[];
  coreResult?: CoreModalFeaResult;
};

export type ModalCpuSolveResult =
  | { ok: true; result: ModalCpuResult; diagnostics: ModalCpuDiagnostics }
  | { ok: false; error: CpuSolverError; diagnostics?: Partial<ModalCpuDiagnostics> };

export type CpuSolverError = {
  code: string;
  message: string;
  report?: ValidationReport;
};

export type CoreFeaResult = CoreSolveResult;

export type CpuSolverDiagnostics = {
  dofs: number;
  freeDofs: number;
  constrainedDofs: number;
  relativeResidual: number;
  residualNorm?: number;
  maxDisplacement: number;
  maxVonMisesStress: number;
  solverMode?: "dense" | "sparse";
  iterations?: number;
  converged?: boolean;
  matrixRows?: number;
  matrixNonZeros?: number;
  preconditioner?: "none" | "jacobi" | "ssor";
  estimatedMatrixBytes?: number;
  loadAssembly?: LoadAssemblyDiagnostics;
  reactionBalance?: {
    appliedLoad: [number, number, number];
    reaction: [number, number, number];
    imbalance: [number, number, number];
    relativeError: number;
  };
  visualizationSmoothing?: {
    iterations?: number;
    alpha?: number;
  };
};

export type StaticLinearTet4CpuResult = {
  displacement: Float64Array;
  reactionForce: Float64Array;
  strain: Float64Array;
  stress: Float64Array;
  vonMises: Float64Array;
  /** Volume-weighted nodal von Mises recovered from element node samples (Tet10: linear in-element field). */
  nodalVonMises?: Float64Array;
  /** Volume-weighted nodal stress tensors in [xx, yy, zz, xy, yz, xz] order. */
  nodalStress?: Float64Array;
  /** Per-element peak von Mises over the element's node samples; conservative basis for safety factors. */
  vonMisesPeak?: Float64Array;
  coreResult?: CoreStructuralSolveResult;
  provenance?: {
    kind: "opencae_core_fea" | "local_estimate";
    solver: "opencae-core-sparse-tet" | "opencae-core-preview-sdof";
    resultSource: "computed" | "computed_preview";
    meshSource: "actual_volume_mesh" | "structured_block_core";
  };
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

export type DynamicTet4CpuFrame = {
  frameIndex: number;
  timeSeconds: number;
  loadScale: number;
  displacement: DynamicResultField;
  velocity: DynamicResultField;
  acceleration: DynamicResultField;
  strain: DynamicResultField;
  stress: DynamicResultField;
  vonMises: DynamicResultField;
  nodalVonMises?: DynamicResultField;
  nodalStress?: DynamicResultField;
  vonMisesPeak?: DynamicResultField;
  safety_factor: DynamicResultField;
  reactionForce?: Float64Array;
};

export type DynamicResultField = {
  values: Float64Array;
  samples: number[];
  frameIndex: number;
  timeSeconds: number;
};

export type DynamicTet4CpuResult = {
  staticResult: StaticLinearTet4CpuResult;
  frames: DynamicTet4CpuFrame[];
  coreResult?: CoreStructuralSolveResult;
};

export type PreviewDynamicResult = DynamicTet4CpuResult & {
  preview: true;
  provenance: NonNullable<StaticLinearTet4CpuResult["provenance"]>;
};

export type DynamicTet4CpuDiagnostics = Omit<CpuSolverDiagnostics, "reactionBalance"> & {
  frameCount: number;
  startTime: number;
  endTime: number;
  timeStep: number;
  outputInterval: number;
  dampingRatio: number;
  rayleighAlpha: number;
  rayleighBeta: number;
  rayleighCalibration?: {
    method: "explicit" | "modal_estimate" | "static_estimate" | "undamped" | "uncalibrated";
    fundamentalFrequencyHz?: number;
    omega1?: number;
    omega2?: number;
  };
  newmarkGamma: 0.5;
  newmarkBeta: 0.25;
  loadProfile: Exclude<DynamicLoadProfile, "quasiStatic" | "sinusoidal">;
  equivalentMass: number;
  equivalentStiffness: number;
  peakDisplacement: number;
  peakStress: number;
  peakVelocity: number;
  peakAcceleration: number;
  minSafetyFactor?: number;
  convergence: {
    frameIndex: number;
    timeSeconds: number;
    iterations: number;
    residualNorm: number;
    relativeResidual: number;
  }[];
  totalMass: number;
  reactionBalance: {
    frameIndex: number;
    timeSeconds: number;
    loadScale: number;
    relativeImbalance: number;
  }[];
  solver: "opencae-core-mdof-newmark" | "opencae-core-preview-sdof";
};

export type DynamicTet4CpuSolveResult =
  | {
      ok: true;
      result: DynamicTet4CpuResult;
      diagnostics: DynamicTet4CpuDiagnostics;
    }
  | {
      ok: false;
      error: CpuSolverError;
      diagnostics?: Partial<DynamicTet4CpuDiagnostics>;
    };

export type CoreStaticSolveResult =
  | {
      ok: true;
      result: CoreStructuralSolveResult;
      diagnostics: CpuSolverDiagnostics;
    }
  | {
      ok: false;
      error: CpuSolverError;
      diagnostics?: Partial<CpuSolverDiagnostics>;
    };

export type CoreDynamicSolveResult =
  | {
      ok: true;
      result: CoreStructuralSolveResult;
      diagnostics: DynamicTet4CpuDiagnostics;
    }
  | {
      ok: false;
      error: CpuSolverError;
      diagnostics?: Partial<DynamicTet4CpuDiagnostics>;
    };

export type CoreModalSolveResult =
  | { ok: true; result: CoreModalFeaResult; diagnostics: ModalCpuDiagnostics }
  | { ok: false; error: CpuSolverError; diagnostics?: Partial<ModalCpuDiagnostics> };

export type PreviewDynamicSolveResult =
  | {
      ok: true;
      result: PreviewDynamicResult;
      diagnostics: DynamicTet4CpuDiagnostics;
    }
  | {
      ok: false;
      error: CpuSolverError;
      diagnostics?: Partial<DynamicTet4CpuDiagnostics>;
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
