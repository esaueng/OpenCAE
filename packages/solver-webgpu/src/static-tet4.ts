import { normalizeModelJson, type CoreStructuralSolveResult, type OpenCAEModelJson } from "@opencae/core";
import {
  assembleNodalForcesWithDiagnostics,
  collectConstraints,
  recoverElementResults,
  staticCoreResultFromSolve,
  type CpuSolverDiagnostics,
  type SolverHooks,
  type StaticLinearTet4CpuResult
} from "@opencae/solver-cpu";
import {
  buildTet4DofAdjacency,
  buildTet4ElementData,
  solveTet4MatrixFreeWebGpu,
  tet4MatrixFreeInternalForce,
  type MatrixFreeCgOptions,
  type Tet4MatrixFreeData
} from "./matrix-free";

export type StaticTet4WebGpuOptions = MatrixFreeCgOptions & {
  hooks?: SolverHooks;
};

export type StaticTet4WebGpuResult =
  | { ok: true; result: CoreStructuralSolveResult; iterations: number; relativeResidual: number }
  | { ok: false; error: { code: string; message: string } };

/**
 * Solves one linear-static Tet4 step without assembling a global stiffness
 * matrix. The GPU operator currently supports zero-valued displacement
 * constraints; nonzero prescribed displacements and connection penalties are
 * rejected because both require an additional affine/operator contribution.
 */
export async function solveStaticTet4ModelWebGpu(
  input: OpenCAEModelJson,
  stepIndex: number,
  options: StaticTet4WebGpuOptions = {}
): Promise<StaticTet4WebGpuResult> {
  const normalized = normalizeModelJson(input);
  if (!normalized.ok) return { ok: false, error: { code: "validation-failed", message: "WebGPU input model failed Core validation." } };
  const model = normalized.model;
  const step = model.steps[stepIndex];
  if (!step || step.type !== "staticLinear") return { ok: false, error: { code: "unsupported-step", message: "WebGPU matrix-free execution requires a staticLinear step." } };
  if (model.elementBlocks.some((block) => block.type !== "Tet4")) return { ok: false, error: { code: "unsupported-element-type", message: "WebGPU matrix-free execution supports Tet4 elements only." } };
  if (model.meshConnections.length) return { ok: false, error: { code: "unsupported-connections", message: "WebGPU matrix-free execution does not yet include tie/contact penalty operators; use the CPU route." } };

  const constraints = collectConstraints(model, step.boundaryConditions);
  if (!constraints.ok) return { ok: false, error: constraints.error };
  for (const value of constraints.values.values()) {
    if (Math.abs(value) > 1e-14) return { ok: false, error: { code: "unsupported-prescribed-displacement", message: "WebGPU matrix-free execution currently requires zero-valued displacement constraints." } };
  }
  const loadAssembly = assembleNodalForcesWithDiagnostics(model, step.loads);
  if (!loadAssembly.ok) return { ok: false, error: loadAssembly.error };

  const dofs = model.counts.nodes * 3;
  const connectivity = flattenConnectivity(model.elementBlocks.map((block) => block.connectivity));
  const youngModulus = new Float64Array(model.counts.elements);
  const poissonRatio = new Float64Array(model.counts.elements);
  let element = 0;
  for (const block of model.elementBlocks) {
    const material = model.materials[block.materialIndex];
    if (!material) return { ok: false, error: { code: "missing-material", message: `Element block ${block.name} has no resolved material.` } };
    const count = block.connectivity.length / 4;
    for (let local = 0; local < count; local += 1) {
      youngModulus[element] = material.youngModulus;
      poissonRatio[element] = material.poissonRatio;
      element += 1;
    }
  }

  options.hooks?.onProgress?.({ phase: "assemble", completed: 0, total: model.counts.elements });
  let elementData: ReturnType<typeof buildTet4ElementData>;
  try {
    elementData = buildTet4ElementData({ coordinates: model.nodes.coordinates, connectivity, youngModulus, poissonRatio });
  } catch (error) {
    return { ok: false, error: { code: "element-assembly-failed", message: error instanceof Error ? error.message : "WebGPU Tet4 element assembly failed." } };
  }
  const adjacency = buildTet4DofAdjacency(connectivity, dofs);
  const constrained = new Uint32Array(dofs);
  for (const dof of constraints.values.keys()) constrained[dof] = 1;
  const diagonal = elementData.diagonal.length === dofs ? elementData.diagonal : copyToLength(elementData.diagonal, dofs);
  const operatorData: Tet4MatrixFreeData = { dofs, connectivity, elementData: elementData.elementData, diagonal, constrained, ...adjacency };
  const rhs = Float32Array.from(loadAssembly.forces, (value, index) => constrained[index] ? 0 : value);
  options.hooks?.onProgress?.({ phase: "assemble", completed: model.counts.elements, total: model.counts.elements });

  const solved = await solveTet4MatrixFreeWebGpu(operatorData, rhs, {
    ...options,
    shouldCancel: () => Boolean(options.shouldCancel?.() || options.hooks?.shouldCancel?.()),
    onProgress: (iteration, relativeResidual) => {
      options.onProgress?.(iteration, relativeResidual);
      options.hooks?.onProgress?.({ phase: "solve", completed: iteration, total: options.maxIterations ?? Math.max(200, dofs), iteration, relativeResidual });
    }
  });
  if (!solved.ok) return { ok: false, error: solved.error };

  const displacement = Float64Array.from(solved.solution);
  const internal = tet4MatrixFreeInternalForce(operatorData, solved.solution);
  const reactionForce = new Float64Array(dofs);
  for (let dof = 0; dof < dofs; dof += 1) reactionForce[dof] = internal[dof] - loadAssembly.forces[dof];
  options.hooks?.onProgress?.({ phase: "recover", completed: 0, total: model.counts.elements });
  const recovery = recoverElementResults(model, displacement);
  if (!recovery.ok) return { ok: false, error: recovery.error };

  const raw: StaticLinearTet4CpuResult = {
    displacement,
    reactionForce,
    strain: recovery.strain,
    stress: recovery.stress,
    vonMises: recovery.vonMises,
    nodalVonMises: recovery.nodalVonMises,
    nodalStress: recovery.nodalStress,
    vonMisesPeak: recovery.vonMisesPeak
  };
  const diagnostics: CpuSolverDiagnostics = {
    dofs,
    freeDofs: dofs - constraints.values.size,
    constrainedDofs: constraints.values.size,
    residualNorm: solved.relativeResidual * Math.max(vectorNorm(rhs), 1),
    relativeResidual: solved.relativeResidual,
    maxDisplacement: maxNodeVectorNorm(displacement),
    maxVonMisesStress: maxAbs(recovery.vonMisesPeak),
    solverMode: "sparse",
    iterations: solved.iterations,
    converged: true,
    matrixRows: dofs,
    matrixNonZeros: 0,
    preconditioner: "jacobi",
    estimatedMatrixBytes: matrixFreeBytes(operatorData),
    loadAssembly: loadAssembly.diagnostics
  };
  const core = staticCoreResultFromSolve(model, raw, diagnostics);
  const provenance = {
    ...core.provenance,
    solver: "opencae-core-webgpu-matrix-free-tet4" as const,
    coreSolver: "matrix_free_tet4_cg_jacobi"
  };
  options.hooks?.onProgress?.({ phase: "recover", completed: model.counts.elements, total: model.counts.elements });
  return {
    ok: true,
    iterations: solved.iterations,
    relativeResidual: solved.relativeResidual,
    result: {
      ...core,
      provenance,
      summary: { ...core.summary, provenance },
      diagnostics: [...core.diagnostics, {
        id: "webgpu-matrix-free-diagnostics",
        backend: "webgpu-matrix-free-tet4",
        iterations: solved.iterations,
        relativeResidual: solved.relativeResidual,
        matrixFreeBytes: matrixFreeBytes(operatorData)
      }]
    }
  };
}

function flattenConnectivity(blocks: Uint32Array[]): Uint32Array {
  const length = blocks.reduce((sum, block) => sum + block.length, 0);
  const output = new Uint32Array(length);
  let offset = 0;
  for (const block of blocks) { output.set(block, offset); offset += block.length; }
  return output;
}

function copyToLength(source: Float32Array, length: number): Float32Array {
  const output = new Float32Array(length);
  output.set(source.subarray(0, length));
  return output;
}

function vectorNorm(values: Float32Array): number {
  let squared = 0;
  for (const value of values) squared += value * value;
  return Math.sqrt(squared);
}

function maxNodeVectorNorm(values: Float64Array): number {
  let maximum = 0;
  for (let offset = 0; offset < values.length; offset += 3) maximum = Math.max(maximum, Math.hypot(values[offset], values[offset + 1], values[offset + 2]));
  return maximum;
}

function maxAbs(values: Float64Array): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

function matrixFreeBytes(data: Tet4MatrixFreeData): number {
  return data.connectivity.byteLength + data.elementData.byteLength + data.rowPtr.byteLength + data.adjacencyElements.byteLength + data.adjacencyLocalRows.byteLength + data.diagonal.byteLength + data.constrained.byteLength;
}
