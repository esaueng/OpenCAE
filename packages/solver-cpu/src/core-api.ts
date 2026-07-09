import { solvePreviewSdofTet4Cpu } from "./dynamic-preview-sdof";
import { solveDynamicLinearTetMDOF } from "./dynamic-mdof";
import { solveStaticLinearTet } from "./solver";
import { validateCoreResult } from "@opencae/core";
import type {
  CoreDynamicSolveResult,
  CoreStaticSolveResult,
  CpuSolverInput,
  CpuSolverOptions,
  DynamicTet4CpuOptions,
  PreviewDynamicResult,
  PreviewDynamicSolveResult
} from "./types";

export function solveCoreStatic(
  model: CpuSolverInput,
  options: CpuSolverOptions = {}
): CoreStaticSolveResult {
  const meshError = actualMeshError(model);
  if (meshError) return meshError;
  const result = solveStaticLinearTet(model, {
    ...options,
    method: "sparse",
    solverMode: "sparse"
  });
  if (!result.ok) return result;
  const coreResult = result.result.coreResult;
  if (!coreResult) {
    return {
      ok: false,
      error: {
        code: "missing-core-result",
        message: "Static solve completed without a CoreSolveResult."
      },
      diagnostics: result.diagnostics
    };
  }
  const validation = validateCoreResult(coreResult);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "result-validation-failed",
        message: "Static Core result failed surface field alignment validation.",
        report: validation
      },
      diagnostics: result.diagnostics
    };
  }
  return {
    ok: true,
    result: coreResult,
    diagnostics: result.diagnostics
  };
}

export function solveCoreDynamic(
  model: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): CoreDynamicSolveResult {
  const meshError = actualMeshError(model);
  if (meshError) return meshError;
  const step = model.steps[options.stepIndex ?? 0];
  if (!step || step.type !== "dynamicLinear") {
    return {
      ok: false,
      error: {
        code: "invalid-dynamic-step",
        message: "Production dynamic solves require a dynamicLinear step. No preview fallback was used."
      }
    };
  }
  const result = solveDynamicLinearTetMDOF(model, options);
  if (!result.ok) return result;
  const coreResult = result.result.coreResult;
  if (!coreResult) {
    return {
      ok: false,
      error: {
        code: "missing-core-result",
        message: "Dynamic MDOF solve completed without a CoreSolveResult."
      },
      diagnostics: result.diagnostics
    };
  }
  const validation = validateCoreResult(coreResult);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "result-validation-failed",
        message: "Dynamic Core result failed surface field alignment validation.",
        report: validation
      },
      diagnostics: result.diagnostics
    };
  }
  return {
    ok: true,
    result: coreResult,
    diagnostics: result.diagnostics
  };
}

export function solveCorePreviewDynamic(
  model: CpuSolverInput,
  options: DynamicTet4CpuOptions = {}
): PreviewDynamicSolveResult {
  const result = solvePreviewSdofTet4Cpu(model, options);
  if (!result.ok) return result;
  const provenance = result.result.staticResult.provenance ?? {
    kind: "local_estimate" as const,
    solver: "opencae-core-preview-sdof" as const,
    resultSource: "computed_preview" as const,
    meshSource: "structured_block_core" as const
  };
  const previewResult: PreviewDynamicResult = {
    ...result.result,
    preview: true,
    provenance
  };
  return {
    ok: true,
    result: previewResult,
    diagnostics: result.diagnostics
  };
}

function actualMeshError(
  model: CpuSolverInput
): { ok: false; error: { code: string; message: string } } | undefined {
  if (model.meshProvenance?.meshSource === "display_bounds_proxy") {
    return {
      ok: false,
      error: {
        code: "actual-volume-mesh-required",
        message: "OpenCAE Core requires an actual volume mesh for this solve. No estimate fallback was used."
      }
    };
  }
  if (
    model.meshProvenance?.kind === "local_estimate" ||
    model.meshProvenance?.resultSource === "computed_preview" ||
    model.meshProvenance?.solver === "opencae-core-preview-sdof"
  ) {
    return {
      ok: false,
      error: {
        code: "preview-provenance-not-allowed",
        message: "Production OpenCAE Core solves reject preview and local-estimate provenance. No preview fallback was used."
      }
    };
  }
  return undefined;
}
