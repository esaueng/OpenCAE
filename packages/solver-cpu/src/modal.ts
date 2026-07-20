import type { NormalizedOpenCAEModel } from "@opencae/core";
import { modalCoreResultFromSolve } from "./results";
import { boundedStructuralMaxDofs, structuralDofCount, structuralDofLimitError } from "./limits";
import { getNormalizedModel } from "./solver";
import { conjugateGradient, csrDiagonal, csrMatVec, norm } from "./sparse";
import { expandFreeVector, prepareStructuralSystem, type PreparedStructuralSystem } from "./structural-system";
import type {
  CpuSolverError,
  CpuSolverInput,
  ModalCpuDiagnostics,
  ModalCpuOptions,
  ModalCpuSolveResult,
  ModalMode
} from "./types";

const DEFAULT_MODE_COUNT = 6;
const DEFAULT_MODAL_TOLERANCE = 1e-6;
const DEFAULT_SUBSPACE_ITERATIONS = 30;
// Earlier subspace passes use a looser forcing term and are warm-started below.
// Keep the final inverse solves at 1e-9: the large-model Tet4 projection showed
// that 1e-8 can plateau just above the unchanged 1e-6 exported mode residual.
const DEFAULT_INNER_TOLERANCE = 1e-9;
const FREQUENCY_ESTIMATE_INNER_TOLERANCE = 1e-8;
const DEFAULT_FREQUENCY_ESTIMATE_ITERATIONS = 4;
const DEFAULT_TET10_PROJECTION_DOF_THRESHOLD = 50_000;

export type ModalMeshProjection = {
  sourceElementOrder: "Tet10";
  solveElementOrder: "Tet4";
  sourceDofs: number;
  solveDofs: number;
  reason: "local-modal-performance";
};

export type ModalSubspaceMode = {
  modeIndex: number;
  eigenvalue: number;
  frequencyHz: number;
  scaledResidual: number;
  vector: Float64Array;
};

export type ModalSubspaceResult =
  | {
      ok: true;
      modes: ModalSubspaceMode[];
      requestedModeCount: number;
      blockSize: number;
      subspaceIterations: number;
      warning?: string;
    }
  | { ok: false; error: CpuSolverError };

export function solveModalLinearTet(input: CpuSolverInput, options: ModalCpuOptions = {}): ModalCpuSolveResult {
  const normalized = getNormalizedModel(input);
  if (!normalized.ok) return normalized;
  const sourceModel = normalized.model;
  const sourceDofs = structuralDofCount(sourceModel);
  const projected = linearizeTet10ModelForModal(sourceModel);
  const model = projected.model;
  const dofs = structuralDofCount(model);
  const maxDofs = boundedStructuralMaxDofs(options.maxDofs);
  const limitError = structuralDofLimitError(dofs, maxDofs);
  const dofLimit = { maximum: maxDofs, appliedTo: "solve_model" as const, sourceDofs, solveDofs: dofs };
  if (limitError) {
    return failure(limitError.code, limitError.message, {
      dofs,
      sourceDofs,
      dofLimit,
      ...(projected.projection ? { meshProjection: projected.projection } : {})
    });
  }
  const step = model.steps[options.stepIndex ?? 0];
  if (!step || step.type !== "modal") {
    return failure("invalid-modal-step", "Selected modal solve requires a modal step.");
  }
  const requestedModeCount = clampModeCount(options.modeCount ?? step.modeCount);
  const prepared = prepareStructuralSystem(model, step.boundaryConditions, [], options.hooks, "Modal");
  if (!prepared.ok) return prepared;
  const tolerance = finitePositive(options.modalTolerance) ?? DEFAULT_MODAL_TOLERANCE;
  const subspace = solveModalSubspace(prepared.system, requestedModeCount, {
    tolerance,
    maxSubspaceIterations: positiveInteger(options.maxSubspaceIterations) ?? DEFAULT_SUBSPACE_ITERATIONS,
    maxCgIterations: options.maxIterations,
    preconditioner: modalPreconditioner(options.preconditioner),
    ssorOmega: options.ssorOmega,
    hooks: options.hooks
  });
  if (!subspace.ok) return subspace;
  const modes = subspace.modes.map((mode): ModalMode => ({
    modeIndex: mode.modeIndex,
    eigenvalue: mode.eigenvalue,
    frequencyHz: mode.frequencyHz,
    scaledResidual: mode.scaledResidual,
    shape: normalizedModeShape(model, prepared.system, mode.vector)
  }));
  const diagnostics: ModalCpuDiagnostics = {
    dofs,
    sourceDofs,
    dofLimit,
    freeDofs: prepared.system.free.length,
    constrainedDofs: prepared.system.constraints.size,
    requestedModeCount,
    convergedModeCount: modes.length,
    blockSize: subspace.blockSize,
    subspaceIterations: subspace.subspaceIterations,
    tolerance,
    totalMass: prepared.system.totalMass,
    ...(subspace.warning ? { partialConvergenceWarning: subspace.warning } : {}),
    ...(projected.projection ? {
      approximationWarning: modalProjectionWarning(projected.projection),
      meshProjection: projected.projection
    } : {}),
    solver: "opencae-core-block-shift-invert"
  };
  const result = { modes };
  return {
    ok: true,
    result: { ...result, coreResult: modalCoreResultFromSolve(model, result, diagnostics) },
    diagnostics
  };
}

/**
 * Reduce oversized quadratic meshes to their corner-node Tet4 topology for a
 * local modal solve. The source project and mesh are never mutated. A caller
 * receives structured projection diagnostics so the approximation cannot be
 * mistaken for a full quadratic solve.
 */
export function linearizeTet10ModelForModal(
  model: NormalizedOpenCAEModel,
  dofThreshold = DEFAULT_TET10_PROJECTION_DOF_THRESHOLD
): { model: NormalizedOpenCAEModel; projection?: ModalMeshProjection } {
  const sourceDofs = model.counts.nodes * 3;
  if (sourceDofs <= dofThreshold || !model.elementBlocks.some((block) => block.type === "Tet10")) {
    return { model };
  }

  const cornerNodes = new Set<number>();
  for (const block of model.elementBlocks) {
    const nodeCount = block.type === "Tet10" ? 10 : 4;
    for (let offset = 0; offset < block.connectivity.length; offset += nodeCount) {
      for (let local = 0; local < 4; local += 1) cornerNodes.add(block.connectivity[offset + local]);
    }
  }
  const sourceNodeIds = [...cornerNodes].sort((left, right) => left - right);
  const oldToNew = new Int32Array(model.counts.nodes);
  oldToNew.fill(-1);
  sourceNodeIds.forEach((node, index) => { oldToNew[node] = index; });
  const coordinates = new Float64Array(sourceNodeIds.length * 3);
  for (let index = 0; index < sourceNodeIds.length; index += 1) {
    const source = sourceNodeIds[index] * 3;
    coordinates[index * 3] = model.nodes.coordinates[source];
    coordinates[index * 3 + 1] = model.nodes.coordinates[source + 1];
    coordinates[index * 3 + 2] = model.nodes.coordinates[source + 2];
  }

  const elementBlocks = model.elementBlocks.map((block) => {
    const sourceNodeCount = block.type === "Tet10" ? 10 : 4;
    const elementCount = block.connectivity.length / sourceNodeCount;
    const connectivity = new Uint32Array(elementCount * 4);
    for (let element = 0; element < elementCount; element += 1) {
      for (let local = 0; local < 4; local += 1) {
        connectivity[element * 4 + local] = mappedNode(oldToNew, block.connectivity[element * sourceNodeCount + local]);
      }
    }
    return { ...block, type: "Tet4" as const, connectivity };
  });
  const nodeSets = model.nodeSets.map((nodeSet) => ({
    ...nodeSet,
    nodes: Uint32Array.from(new Set(Array.from(nodeSet.nodes)
      .map((node) => oldToNew[node])
      .filter((node) => node >= 0)))
  }));
  const surfaceFacets = model.surfaceFacets.map((facet) => ({
    ...facet,
    nodes: Uint32Array.from(Array.from(facet.nodes).slice(0, 3).map((node) => mappedNode(oldToNew, node)))
  }));
  const projectedModel: NormalizedOpenCAEModel = {
    ...model,
    nodes: { coordinates },
    elementBlocks,
    nodeSets,
    surfaceFacets,
    counts: { ...model.counts, nodes: sourceNodeIds.length }
  };
  const solveDofs = projectedModel.counts.nodes * 3;
  return {
    model: projectedModel,
    projection: {
      sourceElementOrder: "Tet10",
      solveElementOrder: "Tet4",
      sourceDofs,
      solveDofs,
      reason: "local-modal-performance"
    }
  };
}

function mappedNode(oldToNew: Int32Array, sourceNode: number): number {
  const mapped = oldToNew[sourceNode];
  if (mapped < 0) throw new Error(`Modal Tet10 projection could not map corner node ${sourceNode}.`);
  return mapped;
}

function modalProjectionWarning(projection: ModalMeshProjection): string {
  return `Local modal analysis used a linear Tet4 projection (${projection.solveDofs.toLocaleString()} DOFs) of the ` +
    `${projection.sourceDofs.toLocaleString()}-DOF quadratic mesh to keep the browser solve tractable. ` +
    "Natural frequencies may differ from a full Tet10 solve.";
}

export function solveModalSubspace(
  system: PreparedStructuralSystem,
  requestedModeCount: number,
  options: {
    tolerance?: number;
    maxSubspaceIterations?: number;
    maxCgIterations?: number;
    preconditioner?: "none" | "jacobi" | "ssor";
    ssorOmega?: number;
    hooks?: ModalCpuOptions["hooks"];
    /**
     * Dynamic Rayleigh calibration compatibility path. Modal analysis never
     * supplies this seed and therefore always uses the block algorithm below.
     */
    frequencyEstimateSeed?: Float64Array;
    frequencyEstimateIterations?: number;
  } = {}
): ModalSubspaceResult {
  const size = system.free.length;
  if (size === 0) return insufficientConstraints();
  const diagonal = csrDiagonal(system.stiffness);
  let maxDiagonal = 0;
  for (const value of diagonal) maxDiagonal = Math.max(maxDiagonal, Math.abs(value));
  if (!(maxDiagonal > 0) || diagonal.some((value) => !Number.isFinite(value))) {
    return insufficientConstraints();
  }
  const target = Math.min(clampModeCount(requestedModeCount), size);
  if (options.frequencyEstimateSeed) {
    if (target !== 1 || options.frequencyEstimateSeed.length !== size) return insufficientConstraints();
    return solveFrequencyEstimate(system, options.frequencyEstimateSeed, {
      iterations: positiveInteger(options.frequencyEstimateIterations) ?? DEFAULT_FREQUENCY_ESTIMATE_ITERATIONS,
      maxCgIterations: options.maxCgIterations,
      hooks: options.hooks
    });
  }
  const blockSize = Math.min(target + 2, size);
  const tolerance = finitePositive(options.tolerance) ?? DEFAULT_MODAL_TOLERANCE;
  const maxSubspaceIterations = positiveInteger(options.maxSubspaceIterations) ?? DEFAULT_SUBSPACE_ITERATIONS;
  let basis = deterministicInitialBlock(size, blockSize);
  if (!massOrthonormalize(basis, system.mass)) return insufficientConstraints();
  let latestModes: ModalSubspaceMode[] = [];
  let completedIterations = 0;
  let basisEigenvalues: number[] | undefined;

  for (let iteration = 1; iteration <= maxSubspaceIterations; iteration += 1) {
    if (options.hooks?.shouldCancel?.()) return failureResult("cancelled", "Solve cancelled.");
    const inverseBlock: Float64Array[] = [];
    for (let blockIndex = 0; blockIndex < basis.length; blockIndex += 1) {
      const vector = basis[blockIndex];
      const rhs = massProduct(system.mass, vector);
      const solved = conjugateGradient(system.stiffness, rhs, {
        tolerance: modalInnerTolerance(iteration),
        maxIterations: options.maxCgIterations,
        preconditioner: options.preconditioner ?? "jacobi",
        ssorOmega: options.ssorOmega,
        initialGuess: modalInverseInitialGuess(vector, basisEigenvalues?.[blockIndex]),
        hooks: modalInnerSolveHooks(
          options.hooks,
          iteration,
          blockIndex,
          blockSize,
          maxSubspaceIterations
        )
      });
      if (!solved.ok) {
        if (solved.error.code === "cancelled") return { ok: false, error: solved.error };
        return insufficientConstraints();
      }
      inverseBlock.push(solved.solution);
    }
    if (!massOrthonormalize(inverseBlock, system.mass)) return insufficientConstraints();
    const projected = projectedStiffness(system, inverseBlock);
    const eigensystem = symmetricEigenDecomposition(projected, blockSize);
    basisEigenvalues = eigensystem.values;
    const ritzVectors = rotateBlock(inverseBlock, eigensystem.vectors);
    if (!massOrthonormalize(ritzVectors, system.mass)) return insufficientConstraints();
    latestModes = eigensystem.values.map((eigenvalue, index) => {
      const vector = ritzVectors[index];
      const residual = scaledModalResidual(system, vector, eigenvalue);
      return {
        modeIndex: index + 1,
        eigenvalue,
        frequencyHz: eigenvalue > 0 ? Math.sqrt(eigenvalue) / (2 * Math.PI) : 0,
        scaledResidual: residual,
        vector
      };
    }).slice(0, target);
    completedIterations = iteration;
    const converged = latestModes.filter((mode) => mode.eigenvalue > 0 && Number.isFinite(mode.frequencyHz) && mode.scaledResidual <= tolerance);
    options.hooks?.onProgress?.({
      phase: "solve",
      completed: iteration,
      total: maxSubspaceIterations,
      iteration,
      relativeResidual: latestModes.reduce((maximum, mode) => Math.max(maximum, mode.scaledResidual), 0)
    });
    if (converged.length === target) {
      return {
        ok: true,
        modes: converged,
        requestedModeCount: target,
        blockSize,
        subspaceIterations: iteration
      };
    }
    basis = ritzVectors;
  }

  const converged = latestModes.filter((mode) => mode.eigenvalue > 0 && Number.isFinite(mode.frequencyHz) && mode.scaledResidual <= tolerance);
  const residualSummary = latestModes
    .map((mode) => `mode ${mode.modeIndex}: ${mode.scaledResidual.toExponential(3)}`)
    .join(", ");
  const warning = `Modal analysis requested ${target} modes but only ${converged.length} converged to the scaled residual tolerance ${tolerance}.` +
    (residualSummary ? ` Latest scaled residuals: ${residualSummary}.` : "");
  return {
    ok: true,
    modes: converged,
    requestedModeCount: target,
    blockSize,
    subspaceIterations: completedIterations,
    warning
  };
}

/**
 * Keep nested CG progress monotonic across all vectors and subspace passes.
 * The raw CG max-iteration fraction previously drove the whole run meter to
 * roughly 36%, then every new right-hand side restarted at zero. The run
 * stream clamps progress monotonically, so the UI appeared frozen even while
 * later inverse solves were active. The CG iteration/residual stay visible in
 * logs, while completed/total now describe the enclosing modal workload.
 */
function modalInnerSolveHooks(
  hooks: ModalCpuOptions["hooks"] | undefined,
  subspaceIteration: number,
  blockIndex: number,
  blockSize: number,
  maxSubspaceIterations: number
): ModalCpuOptions["hooks"] | undefined {
  if (!hooks) return undefined;
  return {
    shouldCancel: hooks.shouldCancel,
    onProgress: hooks.onProgress
      ? (event) => {
          const innerFraction = event.total > 0
            ? Math.min(Math.max(event.completed / event.total, 0), 1)
            : 0;
          hooks.onProgress?.({
            ...event,
            completed: (subspaceIteration - 1) + (blockIndex + innerFraction) / blockSize,
            total: maxSubspaceIterations
          });
        }
      : undefined
  };
}

function modalPreconditioner(value: ModalCpuOptions["preconditioner"]): "none" | "jacobi" | "ssor" {
  return value === "none" || value === "jacobi" || value === "ssor" ? value : "jacobi";
}

function modalInnerTolerance(subspaceIteration: number): number {
  if (subspaceIteration <= 1) return 1e-3;
  if (subspaceIteration === 2) return 1e-5;
  if (subspaceIteration === 3) return 1e-7;
  return DEFAULT_INNER_TOLERANCE;
}

function modalInverseInitialGuess(vector: Float64Array, eigenvalue: number | undefined): Float64Array | undefined {
  if (!(eigenvalue && eigenvalue > 0 && Number.isFinite(eigenvalue))) return undefined;
  const guess = new Float64Array(vector.length);
  const inverseEigenvalue = 1 / eigenvalue;
  for (let index = 0; index < vector.length; index += 1) guess[index] = vector[index] * inverseEigenvalue;
  return guess;
}

/**
 * Preserve the retired dynamic solver's four-step inverse estimate inside the
 * shared modal module. It is intentionally not used for exported modal modes:
 * its finite iteration count is load-seed dependent and may not meet the modal
 * residual tolerance, but it keeps established Rayleigh damping unchanged.
 */
function solveFrequencyEstimate(
  system: PreparedStructuralSystem,
  seed: Float64Array,
  options: { iterations: number; maxCgIterations?: number; hooks?: ModalCpuOptions["hooks"] }
): ModalSubspaceResult {
  const size = system.free.length;
  let vector = Float64Array.from(seed);
  let seeded = false;
  for (const value of vector) {
    if (value !== 0) {
      seeded = true;
      break;
    }
  }
  if (!seeded) vector.fill(1);

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    if (options.hooks?.shouldCancel?.()) return failureResult("cancelled", "Solve cancelled.");
    const massNorm = Math.sqrt(massDot(system.mass, vector, vector));
    if (!(massNorm > 0) || !Number.isFinite(massNorm)) return insufficientConstraints();
    const rhs = new Float64Array(size);
    for (let index = 0; index < size; index += 1) rhs[index] = (system.mass[index] * vector[index]) / massNorm;
    const solved = conjugateGradient(system.stiffness, rhs, {
      tolerance: FREQUENCY_ESTIMATE_INNER_TOLERANCE,
      maxIterations: options.maxCgIterations,
      jacobi: true,
      initialGuess: vector,
      hooks: options.hooks
    });
    if (!solved.ok) {
      if (solved.error.code === "cancelled") return { ok: false, error: solved.error };
      return insufficientConstraints();
    }
    vector = Float64Array.from(solved.solution);
  }

  const stiffnessProduct = csrMatVec(system.stiffness, vector);
  const numerator = dot(vector, stiffnessProduct);
  const denominator = massDot(system.mass, vector, vector);
  if (!(numerator > 0) || !(denominator > 0)) return insufficientConstraints();
  const eigenvalue = numerator / denominator;
  const frequencyHz = Math.sqrt(eigenvalue) / (2 * Math.PI);
  if (!Number.isFinite(frequencyHz) || !(frequencyHz > 0)) return insufficientConstraints();
  return {
    ok: true,
    modes: [{
      modeIndex: 1,
      eigenvalue,
      frequencyHz,
      scaledResidual: scaledModalResidual(system, vector, eigenvalue),
      vector
    }],
    requestedModeCount: 1,
    blockSize: 1,
    subspaceIterations: options.iterations
  };
}

function projectedStiffness(system: PreparedStructuralSystem, basis: Float64Array[]): Float64Array {
  const size = basis.length;
  const projected = new Float64Array(size * size);
  const stiffnessProducts = basis.map((vector) => csrMatVec(system.stiffness, vector));
  for (let row = 0; row < size; row += 1) {
    for (let column = row; column < size; column += 1) {
      const value = dot(basis[row], stiffnessProducts[column]);
      projected[row * size + column] = value;
      projected[column * size + row] = value;
    }
  }
  return projected;
}

function scaledModalResidual(system: PreparedStructuralSystem, vector: Float64Array, eigenvalue: number): number {
  const stiffnessProduct = csrMatVec(system.stiffness, vector);
  const massProductVector = massProduct(system.mass, vector);
  const residual = new Float64Array(vector.length);
  for (let index = 0; index < residual.length; index += 1) {
    residual[index] = stiffnessProduct[index] - eigenvalue * massProductVector[index];
  }
  const scale = Math.max(norm(stiffnessProduct), Math.abs(eigenvalue) * norm(massProductVector));
  return scale > 0 && Number.isFinite(scale) ? norm(residual) / scale : Number.POSITIVE_INFINITY;
}

function massOrthonormalize(vectors: Float64Array[], mass: Float64Array): boolean {
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];
    for (let pass = 0; pass < 2; pass += 1) {
      for (let previous = 0; previous < index; previous += 1) {
        const projection = massDot(mass, vectors[previous], vector);
        for (let component = 0; component < vector.length; component += 1) {
          vector[component] -= projection * vectors[previous][component];
        }
      }
    }
    const vectorNorm = Math.sqrt(massDot(mass, vector, vector));
    if (!(vectorNorm > 1e-14) || !Number.isFinite(vectorNorm)) return false;
    for (let component = 0; component < vector.length; component += 1) vector[component] /= vectorNorm;
  }
  return true;
}

function deterministicInitialBlock(size: number, blockSize: number): Float64Array[] {
  return Array.from({ length: blockSize }, (_, column) => {
    const vector = new Float64Array(size);
    for (let row = 0; row < size; row += 1) {
      vector[row] = Math.sin((row + 1) * (column + 1) * 0.6180339887498948) +
        0.5 * Math.cos((row + 1) * (column + 2) * 0.414213562373095);
    }
    vector[column % size] += 1;
    return vector;
  });
}

function rotateBlock(basis: Float64Array[], eigenvectors: Float64Array): Float64Array[] {
  const size = basis.length;
  return Array.from({ length: size }, (_, outputColumn) => {
    const vector = new Float64Array(basis[0].length);
    for (let inputColumn = 0; inputColumn < size; inputColumn += 1) {
      const coefficient = eigenvectors[inputColumn * size + outputColumn];
      for (let row = 0; row < vector.length; row += 1) vector[row] += coefficient * basis[inputColumn][row];
    }
    return vector;
  });
}

function symmetricEigenDecomposition(matrix: Float64Array, size: number): { values: number[]; vectors: Float64Array } {
  const a = Float64Array.from(matrix);
  const vectors = new Float64Array(size * size);
  for (let index = 0; index < size; index += 1) vectors[index * size + index] = 1;
  const limit = Math.max(32, size * size * 100);
  for (let sweep = 0; sweep < limit; sweep += 1) {
    let p = 0;
    let q = 0;
    let maximum = 0;
    let diagonalScale = 0;
    for (let row = 0; row < size; row += 1) {
      diagonalScale = Math.max(diagonalScale, Math.abs(a[row * size + row]));
      for (let column = row + 1; column < size; column += 1) {
        const value = Math.abs(a[row * size + column]);
        if (value > maximum) {
          maximum = value;
          p = row;
          q = column;
        }
      }
    }
    if (maximum <= Math.max(diagonalScale, 1) * 1e-14) break;
    const app = a[p * size + p];
    const aqq = a[q * size + q];
    const apq = a[p * size + q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let row = 0; row < size; row += 1) {
      if (row === p || row === q) continue;
      const arp = a[row * size + p];
      const arq = a[row * size + q];
      const nextP = cosine * arp - sine * arq;
      const nextQ = sine * arp + cosine * arq;
      a[row * size + p] = nextP;
      a[p * size + row] = nextP;
      a[row * size + q] = nextQ;
      a[q * size + row] = nextQ;
    }
    a[p * size + p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    a[q * size + q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    a[p * size + q] = 0;
    a[q * size + p] = 0;
    for (let row = 0; row < size; row += 1) {
      const vrp = vectors[row * size + p];
      const vrq = vectors[row * size + q];
      vectors[row * size + p] = cosine * vrp - sine * vrq;
      vectors[row * size + q] = sine * vrp + cosine * vrq;
    }
  }
  const order = Array.from({ length: size }, (_, index) => index)
    .sort((left, right) => a[left * size + left] - a[right * size + right] || left - right);
  const sortedVectors = new Float64Array(size * size);
  const values = order.map((sourceColumn, outputColumn) => {
    for (let row = 0; row < size; row += 1) {
      sortedVectors[row * size + outputColumn] = vectors[row * size + sourceColumn];
    }
    return a[sourceColumn * size + sourceColumn];
  });
  return { values, vectors: sortedVectors };
}

function normalizedModeShape(
  model: NormalizedOpenCAEModel,
  system: PreparedStructuralSystem,
  reduced: Float64Array
): Float64Array {
  const full = expandFreeVector(model.counts.nodes * 3, system.free, reduced);
  let maximumVectorMagnitude = 0;
  let signComponent = 0;
  let signMagnitude = 0;
  for (let node = 0; node < model.counts.nodes; node += 1) {
    maximumVectorMagnitude = Math.max(maximumVectorMagnitude, Math.hypot(full[node * 3], full[node * 3 + 1], full[node * 3 + 2]));
  }
  for (const component of full) {
    if (Math.abs(component) > signMagnitude) {
      signMagnitude = Math.abs(component);
      signComponent = component;
    }
  }
  const scale = maximumVectorMagnitude > 0 ? (signComponent < 0 ? -1 : 1) / maximumVectorMagnitude : 1;
  for (let index = 0; index < full.length; index += 1) full[index] *= scale;
  return full;
}

function massProduct(mass: Float64Array, vector: Float64Array): Float64Array {
  const result = new Float64Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) result[index] = mass[index] * vector[index];
  return result;
}

function massDot(mass: Float64Array, left: Float64Array, right: Float64Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += mass[index] * left[index] * right[index];
  return result;
}

function dot(left: Float64Array, right: Float64Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}

function clampModeCount(value: number): number {
  return Math.min(10, Math.max(1, Math.floor(Number.isFinite(value) ? value : DEFAULT_MODE_COUNT)));
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function insufficientConstraints(): ModalSubspaceResult {
  return failureResult(
    "insufficient-modal-constraints",
    "Model is insufficiently constrained for modal analysis. Add or revise supports in the Supports step."
  );
}

function failureResult(code: string, message: string): ModalSubspaceResult {
  return { ok: false, error: { code, message } };
}

function failure(code: string, message: string, diagnostics?: Partial<ModalCpuDiagnostics>): ModalCpuSolveResult {
  return { ok: false, error: { code, message }, ...(diagnostics ? { diagnostics } : {}) };
}
