import {
  assembleNodalLoadVectorWithDiagnostics,
  normalizeModelJson,
  type BoundaryConditionJson,
  type NormalizedElementBlock,
  type NormalizedOpenCAEModel,
} from "@opencae/core";
import { collectTetCoordinates, recoverStress, recoverTet4Strain } from "./element";
import { computeTet4ElementStiffness, computeTet4Geometry, computeVonMisesStress } from "./element";
import { computeTet10ElementStiffness, computeTet10Volume, recoverTet10CentroidStrain, recoverTet10NodalStrains, TET10_NODE_COUNT } from "./element-tet10";
import { solveDenseLinearSystem } from "./linear-solve";
import { computeLinearElasticDMatrix } from "./material";
import { staticCoreResultFromSolve } from "./results";
import {
  addSparseEntry,
  conjugateGradient,
  createSparseMatrixBuilder,
  csrMatVec,
  reduceCsrSystem,
  toCsrMatrix,
  type CsrMatrix,
  type SparseMatrixBuilder
} from "./sparse";
import type {
  CpuSolverDiagnostics,
  CpuSolverError,
  CpuSolverInput,
  CpuSolverOptions,
  SolverHooks,
  StaticLinearTet4CpuResult,
  StaticLinearTet4CpuSolveResult
} from "./types";

const COMPONENT_INDEX = {
  x: 0,
  y: 1,
  z: 2
} as const;

export function solveStaticLinearTet4Cpu(
  input: CpuSolverInput,
  options: CpuSolverOptions = {}
): StaticLinearTet4CpuSolveResult {
  const modelResult = getNormalizedModel(input);
  if (!modelResult.ok) {
    return {
      ok: false,
      error: modelResult.error
    };
  }

  const model = modelResult.model;
  const dofs = model.counts.nodes * 3;
  const maxDofs = options.maxDofs ?? 30000;
  if (dofs > maxDofs) {
    return failure("max-dofs-exceeded", `Model has ${dofs} DOFs, which exceeds maxDofs ${maxDofs}.`, {
      dofs
    });
  }

  const step = model.steps[options.stepIndex ?? 0];
  if (!step || step.type !== "staticLinear") {
    return failure("invalid-step", "Selected step must exist and have type staticLinear.", { dofs });
  }

  const constraints = collectConstraints(model, step.boundaryConditions);
  if (!constraints.ok) {
    return failure(constraints.error.code, constraints.error.message, { dofs });
  }

  const constrainedDofs = constraints.values.size;
  const freeDofs = dofs - constrainedDofs;
  if (freeDofs <= 0) {
    return failure("no-free-dofs", "Model has no free DOFs to solve.", {
      dofs,
      constrainedDofs,
      freeDofs
    });
  }

  const free = enumerateFreeDofs(dofs, constraints.values);
  const loadAssembly = assembleNodalForcesWithDiagnostics(model, step.loads);
  if (!loadAssembly.ok) {
    return failure(loadAssembly.error.code, loadAssembly.error.message, {
      dofs,
      constrainedDofs,
      freeDofs
    });
  }
  const loads = loadAssembly.forces;
  const solverMode = selectSolverMode(dofs, options, model, step.loads);

  if (solverMode === "dense") {
    const assembly = assembleDenseStiffness(model, options.hooks);
    if (!assembly.ok) return failure(assembly.error.code, assembly.error.message, { dofs });
    return solveDenseSystem(model, assembly.stiffness, loads, constraints.values, free, options);
  }

  const assembly = assembleSparseStiffness(model, options.hooks);
  if (!assembly.ok) return failure(assembly.error.code, assembly.error.message, { dofs });
  return solveSparseSystem(model, assembly.stiffness, loads, constraints.values, free, options);
}

export function solveStaticLinearTet(
  input: CpuSolverInput,
  options: CpuSolverOptions = {}
): StaticLinearTet4CpuSolveResult {
  const method = options.method ?? options.solverMode ?? "auto";
  return solveStaticLinearTet4Cpu(input, {
    ...options,
    solverMode: method
  });
}

export function getNormalizedModel(input: CpuSolverInput):
  | { ok: true; model: NormalizedOpenCAEModel }
  | { ok: false; error: CpuSolverError } {
  if (isNormalizedModel(input)) {
    return { ok: true, model: input };
  }

  const result = normalizeModelJson(input);
  if (!result.ok) {
    const densityError = result.report.errors.find((issue) => issue.code === "missing-dynamic-material-density");
    return {
      ok: false,
      error: {
        code: "validation-failed",
        message: densityError ? "Dynamic solve requires material density." : "Input model failed OpenCAE Core validation.",
        report: result.report
      }
    };
  }

  return { ok: true, model: result.model };
}

export function assembleDenseStiffness(model: NormalizedOpenCAEModel, hooks?: SolverHooks):
  | { ok: true; stiffness: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const dofs = model.counts.nodes * 3;
  const stiffness = new Float64Array(dofs * dofs);

  const elementAssembly = assembleElementStiffnesses(model, {
    add(block, elementOffset, elementStiffness, nodeCount) {
      scatterDenseElementStiffness(stiffness, dofs, block, elementOffset, elementStiffness, nodeCount);
    }
  }, hooks);
  if (!elementAssembly.ok) return elementAssembly;

  return { ok: true, stiffness };
}

export function assembleSparseStiffness(model: NormalizedOpenCAEModel, hooks?: SolverHooks):
  | { ok: true; stiffness: CsrMatrix }
  | { ok: false; error: CpuSolverError } {
  const dofs = model.counts.nodes * 3;
  const builder = createSparseMatrixBuilder(dofs);

  const elementAssembly = assembleElementStiffnesses(model, {
    add(block, elementOffset, elementStiffness, nodeCount) {
      scatterSparseElementStiffness(builder, block, elementOffset, elementStiffness, nodeCount);
    }
  }, hooks);
  if (!elementAssembly.ok) return elementAssembly;

  return { ok: true, stiffness: toCsrMatrix(builder) };
}

export function assembleNodalForces(model: NormalizedOpenCAEModel, loadNames: string[]): Float64Array {
  const result = assembleNodalForcesWithDiagnostics(model, loadNames);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.forces;
}

function assembleNodalForcesWithDiagnostics(model: NormalizedOpenCAEModel, loadNames: string[]):
  | { ok: true; forces: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const result = assembleNodalLoadVectorWithDiagnostics(model, loadNames);
  if (result.diagnostics.errors.length > 0) {
    const firstError = result.diagnostics.errors[0];
    return {
      ok: false,
      error: {
        code: firstError.code,
        message: result.diagnostics.errors.map((error) => error.message).join("; ")
      }
    };
  }
  return { ok: true, forces: result.vector };
}

export function collectConstraints(model: NormalizedOpenCAEModel, boundaryConditionNames: string[]):
  | { ok: true; values: Map<number, number> }
  | { ok: false; error: CpuSolverError } {
  const values = new Map<number, number>();
  const activeBoundaryConditions = new Set(boundaryConditionNames);
  const nodeSets = new Map(model.nodeSets.map((nodeSet) => [nodeSet.name, nodeSet.nodes]));
  const surfaceSets = new Map(model.surfaceSets.map((surfaceSet) => [surfaceSet.name, surfaceSet]));
  const surfaceFacetById = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));

  for (const boundaryCondition of model.boundaryConditions) {
    if (!activeBoundaryConditions.has(boundaryCondition.name)) {
      continue;
    }
    const nodes = nodesForBoundaryCondition(boundaryCondition, nodeSets, surfaceSets, surfaceFacetById);

    if (boundaryCondition.type === "fixed") {
      for (const component of boundaryCondition.components) {
        for (const node of nodes) {
          const conflict = setConstraint(values, node * 3 + COMPONENT_INDEX[component], 0);
          if (conflict) return conflict;
        }
      }
    } else {
      for (const node of nodes) {
        const conflict = setConstraint(
          values,
          node * 3 + COMPONENT_INDEX[boundaryCondition.component],
          boundaryCondition.value
        );
        if (conflict) return conflict;
      }
    }
  }

  return { ok: true, values };
}

function nodesForBoundaryCondition(
  boundaryCondition: BoundaryConditionJson,
  nodeSets: Map<string, Uint32Array>,
  surfaceSets: Map<string, NormalizedOpenCAEModel["surfaceSets"][number]>,
  facetById: Map<number, NormalizedOpenCAEModel["surfaceFacets"][number]>
): number[] {
  if (boundaryCondition.type === "fixed" && "surfaceSet" in boundaryCondition && boundaryCondition.surfaceSet) {
    return nodesFromSurfaceSet(surfaceSets.get(boundaryCondition.surfaceSet), facetById);
  }
  if ("nodeSet" in boundaryCondition && boundaryCondition.nodeSet) {
    return Array.from(nodeSets.get(boundaryCondition.nodeSet) ?? []);
  }
  return [];
}

function nodesFromSurfaceSet(
  surfaceSet: NormalizedOpenCAEModel["surfaceSets"][number] | undefined,
  facetById: Map<number, NormalizedOpenCAEModel["surfaceFacets"][number]>
): number[] {
  const nodes = new Set<number>();
  if (!surfaceSet) return [];
  for (const facetId of surfaceSet.facets) {
    const facet = facetById.get(facetId);
    if (!facet) continue;
    for (const node of facet.nodes) nodes.add(node);
  }
  return [...nodes];
}

export function enumerateFreeDofs(dofs: number, constraints: Map<number, number>): Int32Array {
  const free = new Int32Array(dofs - constraints.size);
  let freeIndex = 0;
  for (let dof = 0; dof < dofs; dof += 1) {
    if (!constraints.has(dof)) {
      free[freeIndex] = dof;
      freeIndex += 1;
    }
  }
  return free;
}

function solveDenseSystem(
  model: NormalizedOpenCAEModel,
  stiffness: Float64Array,
  loads: Float64Array,
  constraints: Map<number, number>,
  free: Int32Array,
  options: CpuSolverOptions
): StaticLinearTet4CpuSolveResult {
  const dofs = model.counts.nodes * 3;
  const freeDofs = free.length;
  const singularTolerance = options.singularTolerance ?? 1e-12;
  const kff = new Float64Array(freeDofs * freeDofs);
  const rhs = new Float64Array(freeDofs);
  for (let rowIndex = 0; rowIndex < freeDofs; rowIndex += 1) {
    const rowDof = free[rowIndex];
    rhs[rowIndex] = loads[rowDof];
    for (const [constrainedDof, value] of constraints) {
      rhs[rowIndex] -= stiffness[rowDof * dofs + constrainedDof] * value;
    }
    for (let colIndex = 0; colIndex < freeDofs; colIndex += 1) {
      kff[rowIndex * freeDofs + colIndex] = stiffness[rowDof * dofs + free[colIndex]];
    }
  }

  const solve = solveDenseLinearSystem(kff, rhs, singularTolerance);
  if (!solve.ok) {
    return failure(solve.error.code, solve.error.message, {
      dofs,
      constrainedDofs: constraints.size,
      freeDofs,
      solverMode: "dense"
    });
  }

  return finishSolve(model, loads, constraints, free, solve.solution, multiplyDenseMatrixVector(stiffness, dofs), {
    solverMode: "dense",
    iterations: freeDofs,
    converged: true,
    matrixRows: dofs,
    matrixNonZeros: dofs * dofs,
    visualizationSmoothing: options.visualizationSmoothing
  });
}

function solveSparseSystem(
  model: NormalizedOpenCAEModel,
  stiffness: CsrMatrix,
  loads: Float64Array,
  constraints: Map<number, number>,
  free: Int32Array,
  options: CpuSolverOptions
): StaticLinearTet4CpuSolveResult {
  const reduced = reduceCsrSystem(stiffness, loads, free, constraints);
  const solve = conjugateGradient(reduced.matrix, reduced.rhs, {
    tolerance: options.tolerance ?? 1e-10,
    maxIterations: options.maxIterations,
    jacobi: true,
    hooks: options.hooks
  });
  if (!solve.ok) {
    return failure(solve.error.code, solve.error.message, {
      dofs: model.counts.nodes * 3,
      constrainedDofs: constraints.size,
      freeDofs: free.length,
      relativeResidual: solve.relativeResidual,
      solverMode: "sparse",
      iterations: solve.iterations,
      converged: false
    });
  }

  return finishSolve(model, loads, constraints, free, solve.solution, (displacement) => csrMatVec(stiffness, displacement), {
    solverMode: "sparse",
    iterations: solve.iterations,
    converged: true,
    matrixRows: model.counts.nodes * 3,
    matrixNonZeros: stiffness.values.length,
    visualizationSmoothing: options.visualizationSmoothing
  });
}

function finishSolve(
  model: NormalizedOpenCAEModel,
  loads: Float64Array,
  constraints: Map<number, number>,
  free: Int32Array,
  freeSolution: Float64Array,
  multiplyFull: (displacement: Float64Array) => Float64Array,
  diagnostics: Pick<CpuSolverDiagnostics, "solverMode" | "iterations" | "converged" | "matrixRows" | "matrixNonZeros" | "visualizationSmoothing">
): StaticLinearTet4CpuSolveResult {
  const dofs = model.counts.nodes * 3;
  const displacement = new Float64Array(dofs);
  for (const [dof, value] of constraints) displacement[dof] = value;
  for (let i = 0; i < free.length; i += 1) displacement[free[i]] = freeSolution[i];

  const internalForce = multiplyFull(displacement);
  const reactionForce = new Float64Array(dofs);
  for (let i = 0; i < dofs; i += 1) reactionForce[i] = internalForce[i] - loads[i];

  const residual = computeResidualStats(internalForce, loads, free);
  const recovery = recoverElementResults(model, displacement);
  if (!recovery.ok) {
    return failure(recovery.error.code, recovery.error.message, {
      dofs,
      constrainedDofs: constraints.size,
      freeDofs: free.length,
      residualNorm: residual.norm,
      relativeResidual: residual.relative,
      ...diagnostics
    });
  }

  const result: StaticLinearTet4CpuResult = {
    displacement,
    reactionForce,
    strain: recovery.strain,
    stress: recovery.stress,
    vonMises: recovery.vonMises,
    nodalVonMises: recovery.nodalVonMises,
    nodalStress: recovery.nodalStress,
    vonMisesPeak: recovery.vonMisesPeak,
    provenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-sparse-tet",
      resultSource: "computed",
      meshSource: model.meshProvenance?.meshSource === "actual_volume_mesh" ? "actual_volume_mesh" : "structured_block_core"
    }
  };

  const fullDiagnostics = {
    dofs,
    freeDofs: free.length,
    constrainedDofs: constraints.size,
    residualNorm: residual.norm,
    relativeResidual: residual.relative,
    maxDisplacement: maxNodeVectorNorm(displacement),
    maxVonMisesStress: maxAbs(recovery.vonMises),
    reactionBalance: computeReactionBalance(loads, reactionForce),
    ...diagnostics
  };
  result.coreResult = staticCoreResultFromSolve(model, result, fullDiagnostics);

  return {
    ok: true,
    result,
    diagnostics: fullDiagnostics
  };
}

export function elementNodeCountForBlock(block: NormalizedElementBlock): number | undefined {
  if (block.type === "Tet4") return 4;
  if (block.type === "Tet10") return TET10_NODE_COUNT;
  return undefined;
}

export function collectElementCoordinates(
  coordinates: Float64Array,
  connectivity: Uint32Array,
  elementOffset: number,
  nodeCount: number
): Float64Array {
  const elementCoordinates = new Float64Array(nodeCount * 3);
  for (let localNode = 0; localNode < nodeCount; localNode += 1) {
    const node = connectivity[elementOffset + localNode];
    elementCoordinates[localNode * 3] = coordinates[node * 3];
    elementCoordinates[localNode * 3 + 1] = coordinates[node * 3 + 1];
    elementCoordinates[localNode * 3 + 2] = coordinates[node * 3 + 2];
  }
  return elementCoordinates;
}

function assembleElementStiffnesses(
  model: NormalizedOpenCAEModel,
  scatter: {
    add(block: NormalizedElementBlock, elementOffset: number, stiffness: Float64Array, nodeCount: number): void;
  },
  hooks?: SolverHooks
): { ok: true } | { ok: false; error: CpuSolverError } {
  const onProgress = hooks?.onProgress;
  const totalElements = model.counts.elements;
  // Emit roughly every 5% of elements (and always at completion).
  const progressInterval = Math.max(1, Math.ceil(totalElements / 20));
  let completedElements = 0;
  const noteElementDone = (): void => {
    completedElements += 1;
    if (onProgress && (completedElements % progressInterval === 0 || completedElements === totalElements)) {
      onProgress({ phase: "assemble", completed: completedElements, total: totalElements });
    }
  };
  for (const block of model.elementBlocks) {
    const nodeCount = elementNodeCountForBlock(block);
    if (nodeCount === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported-element-type",
          message: "CPU solver supports Tet4 and Tet10 element blocks."
        }
      };
    }
    const material = model.materials[block.materialIndex];
    if (!material || material.type !== "isotropicLinearElastic") {
      return {
        ok: false,
        error: {
          code: "unsupported-model",
          message: "CPU reference solver supports isotropicLinearElastic materials."
        }
      };
    }

    const d = computeLinearElasticDMatrix(material);
    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += nodeCount) {
      if (block.type === "Tet4") {
        const coordinates = collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset);
        const geometry = computeTet4Geometry(coordinates);
        if (!geometry.ok) return geometry;
        const elementStiffness = computeTet4ElementStiffness(geometry, d);
        if (!elementStiffness.ok) return elementStiffness;
        scatter.add(block, elementOffset, elementStiffness.stiffness, nodeCount);
      } else {
        const coordinates = collectElementCoordinates(model.nodes.coordinates, block.connectivity, elementOffset, nodeCount);
        const elementStiffness = computeTet10ElementStiffness(coordinates, d);
        if (!elementStiffness.ok) return elementStiffness;
        scatter.add(block, elementOffset, elementStiffness.stiffness, nodeCount);
      }
      noteElementDone();
    }
  }
  return { ok: true };
}

function scatterDenseElementStiffness(
  global: Float64Array,
  dofs: number,
  block: NormalizedElementBlock,
  elementOffset: number,
  element: Float64Array,
  nodeCount: number
): void {
  const elementDofs = nodeCount * 3;
  for (let localRowNode = 0; localRowNode < nodeCount; localRowNode += 1) {
    const rowNode = block.connectivity[elementOffset + localRowNode];
    for (let rowComponent = 0; rowComponent < 3; rowComponent += 1) {
      const globalRow = rowNode * 3 + rowComponent;
      const localRow = localRowNode * 3 + rowComponent;
      for (let localColNode = 0; localColNode < nodeCount; localColNode += 1) {
        const colNode = block.connectivity[elementOffset + localColNode];
        for (let colComponent = 0; colComponent < 3; colComponent += 1) {
          const globalCol = colNode * 3 + colComponent;
          const localCol = localColNode * 3 + colComponent;
          global[globalRow * dofs + globalCol] += element[localRow * elementDofs + localCol];
        }
      }
    }
  }
}

function scatterSparseElementStiffness(
  builder: SparseMatrixBuilder,
  block: NormalizedElementBlock,
  elementOffset: number,
  element: Float64Array,
  nodeCount: number
): void {
  const elementDofs = nodeCount * 3;
  for (let localRowNode = 0; localRowNode < nodeCount; localRowNode += 1) {
    const rowNode = block.connectivity[elementOffset + localRowNode];
    for (let rowComponent = 0; rowComponent < 3; rowComponent += 1) {
      const globalRow = rowNode * 3 + rowComponent;
      const localRow = localRowNode * 3 + rowComponent;
      for (let localColNode = 0; localColNode < nodeCount; localColNode += 1) {
        const colNode = block.connectivity[elementOffset + localColNode];
        for (let colComponent = 0; colComponent < 3; colComponent += 1) {
          const globalCol = colNode * 3 + colComponent;
          const localCol = localColNode * 3 + colComponent;
          addSparseEntry(builder, globalRow, globalCol, element[localRow * elementDofs + localCol]);
        }
      }
    }
  }
}

function setConstraint(
  values: Map<number, number>,
  dof: number,
  value: number
): { ok: false; error: CpuSolverError } | undefined {
  const existing = values.get(dof);
  if (existing !== undefined && Math.abs(existing - value) > 1e-12) {
    return {
      ok: false,
      error: {
        code: "conflicting-prescribed-displacement",
        message: "A constrained DOF has conflicting prescribed displacement values."
      }
    };
  }
  values.set(dof, value);
  return undefined;
}

export function recoverElementResults(model: NormalizedOpenCAEModel, displacement: Float64Array):
  | { ok: true; strain: Float64Array; stress: Float64Array; vonMises: Float64Array; nodalVonMises: Float64Array; nodalStress: Float64Array; vonMisesPeak: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const strain = new Float64Array(model.counts.elements * 6);
  const stress = new Float64Array(model.counts.elements * 6);
  const vonMises = new Float64Array(model.counts.elements);
  const vonMisesPeak = new Float64Array(model.counts.elements);
  const nodalSum = new Float64Array(model.counts.nodes);
  const nodalStressSum = new Float64Array(model.counts.nodes * 6);
  const nodalWeight = new Float64Array(model.counts.nodes);
  let globalElement = 0;

  for (const block of model.elementBlocks) {
    const nodeCount = elementNodeCountForBlock(block);
    if (nodeCount === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported-element-type",
          message: "CPU solver supports Tet4 and Tet10 element blocks."
        }
      };
    }
    const material = model.materials[block.materialIndex];
    const d = computeLinearElasticDMatrix(material);
    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += nodeCount) {
      const elementDisplacement = new Float64Array(nodeCount * 3);
      for (let localNode = 0; localNode < nodeCount; localNode += 1) {
        const node = block.connectivity[elementOffset + localNode];
        elementDisplacement[localNode * 3] = displacement[node * 3];
        elementDisplacement[localNode * 3 + 1] = displacement[node * 3 + 1];
        elementDisplacement[localNode * 3 + 2] = displacement[node * 3 + 2];
      }

      let elementStrain: Float64Array;
      let elementVolume = 1;
      // Von Mises at each element node: constant for Tet4, linearly varying for Tet10,
      // where node sampling recovers the outer-fiber stress that centroid sampling clips.
      const nodalValues = new Float64Array(nodeCount);
      const nodalStresses = new Float64Array(nodeCount * 6);
      if (block.type === "Tet4") {
        const geometry = computeTet4Geometry(
          collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset)
        );
        if (!geometry.ok) return geometry;
        elementStrain = recoverTet4Strain(geometry.gradients, elementDisplacement);
        elementVolume = geometry.volume;
        const constantStress = recoverStress(d, elementStrain);
        nodalValues.fill(computeVonMisesStress(constantStress));
        for (let localNode = 0; localNode < nodeCount; localNode += 1) nodalStresses.set(constantStress, localNode * 6);
      } else {
        const coordinates = collectElementCoordinates(model.nodes.coordinates, block.connectivity, elementOffset, nodeCount);
        const recovered = recoverTet10CentroidStrain(coordinates, elementDisplacement);
        if (!recovered.ok) return recovered;
        elementStrain = recovered.strain;
        const volume = computeTet10Volume(coordinates);
        if (volume.ok) elementVolume = volume.volume;
        const nodalStrains = recoverTet10NodalStrains(coordinates, elementDisplacement);
        if (nodalStrains.ok) {
          for (let localNode = 0; localNode < nodeCount; localNode += 1) {
            const nodalStress = recoverStress(d, nodalStrains.strains.subarray(localNode * 6, localNode * 6 + 6));
            nodalStresses.set(nodalStress, localNode * 6);
            nodalValues[localNode] = computeVonMisesStress(nodalStress);
          }
        } else {
          const constantStress = recoverStress(d, elementStrain);
          nodalValues.fill(computeVonMisesStress(constantStress));
          for (let localNode = 0; localNode < nodeCount; localNode += 1) nodalStresses.set(constantStress, localNode * 6);
        }
      }
      const elementStress = recoverStress(d, elementStrain);
      strain.set(elementStrain, globalElement * 6);
      stress.set(elementStress, globalElement * 6);
      vonMises[globalElement] = computeVonMisesStress(elementStress);
      let peak = vonMises[globalElement];
      for (let localNode = 0; localNode < nodeCount; localNode += 1) {
        peak = Math.max(peak, nodalValues[localNode]);
        const node = block.connectivity[elementOffset + localNode];
        nodalSum[node] += nodalValues[localNode] * elementVolume;
        nodalWeight[node] += elementVolume;
        for (let component = 0; component < 6; component += 1) {
          nodalStressSum[node * 6 + component] += nodalStresses[localNode * 6 + component] * elementVolume;
        }
      }
      vonMisesPeak[globalElement] = peak;
      globalElement += 1;
    }
  }

  const nodalVonMises = new Float64Array(model.counts.nodes);
  const nodalStress = new Float64Array(model.counts.nodes * 6);
  for (let node = 0; node < nodalVonMises.length; node += 1) {
    nodalVonMises[node] = nodalWeight[node] > 0 ? nodalSum[node] / nodalWeight[node] : 0;
    for (let component = 0; component < 6; component += 1) {
      nodalStress[node * 6 + component] = nodalWeight[node] > 0
        ? nodalStressSum[node * 6 + component] / nodalWeight[node]
        : 0;
    }
  }
  return { ok: true, strain, stress, vonMises, nodalVonMises, nodalStress, vonMisesPeak };
}

function multiplyDenseMatrixVector(matrix: Float64Array, size: number): (vector: Float64Array) => Float64Array {
  return (vector) => {
    const result = new Float64Array(size);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        result[row] += matrix[row * size + col] * vector[col];
      }
    }
    return result;
  };
}

function computeResidualStats(
  internalForce: Float64Array,
  externalForce: Float64Array,
  free: Int32Array
): { norm: number; relative: number } {
  let residualNormSquared = 0;
  let referenceNormSquared = 0;
  for (let i = 0; i < free.length; i += 1) {
    const residual = internalForce[free[i]] - externalForce[free[i]];
    residualNormSquared += residual * residual;
    referenceNormSquared += externalForce[free[i]] * externalForce[free[i]];
  }
  const residualNorm = Math.sqrt(residualNormSquared);
  const reference = Math.sqrt(referenceNormSquared);
  return {
    norm: residualNorm,
    relative: reference === 0 && residualNorm === 0 ? 0 : residualNorm / Math.max(reference, 1)
  };
}

function computeReactionBalance(
  loads: Float64Array,
  reactionForce: Float64Array
): NonNullable<CpuSolverDiagnostics["reactionBalance"]> {
  const appliedLoad = sumVectorDofs(loads);
  const reaction = sumVectorDofs(reactionForce);
  const imbalance: [number, number, number] = [
    appliedLoad[0] + reaction[0],
    appliedLoad[1] + reaction[1],
    appliedLoad[2] + reaction[2]
  ];
  const reference = Math.max(Math.hypot(appliedLoad[0], appliedLoad[1], appliedLoad[2]), 1);
  return {
    appliedLoad,
    reaction,
    imbalance,
    relativeError: Math.hypot(imbalance[0], imbalance[1], imbalance[2]) / reference
  };
}

function sumVectorDofs(values: Float64Array): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < values.length; index += 3) {
    sum[0] += values[index];
    sum[1] += values[index + 1];
    sum[2] += values[index + 2];
  }
  return sum;
}

export function maxNodeVectorNorm(displacement: Float64Array): number {
  let max = 0;
  for (let node = 0; node < displacement.length / 3; node += 1) {
    const ux = displacement[node * 3];
    const uy = displacement[node * 3 + 1];
    const uz = displacement[node * 3 + 2];
    max = Math.max(max, Math.sqrt(ux * ux + uy * uy + uz * uz));
  }
  return max;
}

export function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}

function selectSolverMode(
  dofs: number,
  options: CpuSolverOptions,
  model: NormalizedOpenCAEModel,
  activeLoadNames: string[]
): "dense" | "sparse" {
  if (options.solverMode === "dense" || options.solverMode === "sparse") return options.solverMode;
  if (activeLoadsRequireSparse(model, activeLoadNames)) return "sparse";
  return dofs <= 300 ? "dense" : "sparse";
}

function activeLoadsRequireSparse(model: NormalizedOpenCAEModel, activeLoadNames: string[]): boolean {
  const active = new Set(activeLoadNames);
  return model.loads.some((load) => active.has(load.name) && (load.type === "surfaceForce" || load.type === "pressure"));
}

function failure(
  code: string,
  message: string,
  diagnostics?: Partial<CpuSolverDiagnostics>
): StaticLinearTet4CpuSolveResult {
  return {
    ok: false,
    error: { code, message },
    diagnostics
  };
}

function isNormalizedModel(input: CpuSolverInput): input is NormalizedOpenCAEModel {
  return (
    typeof input === "object" &&
    input !== null &&
    "nodes" in input &&
    input.nodes.coordinates instanceof Float64Array &&
    "counts" in input
  );
}
