import {
  normalizeModelJson,
  type NormalizedOpenCAEModel,
  type NormalizedTet4ElementBlock
} from "@opencae/core";
import { collectTetCoordinates, recoverStress, recoverTet4Strain } from "./element";
import { computeTet4ElementStiffness, computeTet4Geometry, computeVonMisesStress } from "./element";
import { solveDenseLinearSystem } from "./linear-solve";
import { computeLinearElasticDMatrix } from "./material";
import type {
  CpuSolverDiagnostics,
  CpuSolverError,
  CpuSolverInput,
  CpuSolverOptions,
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
  const maxDofs = options.maxDofs ?? 300;
  const singularTolerance = options.singularTolerance ?? 1e-12;
  if (dofs > maxDofs) {
    return failure("max-dofs-exceeded", `Model has ${dofs} DOFs, which exceeds maxDofs ${maxDofs}.`, {
      dofs
    });
  }

  const step = model.steps[options.stepIndex ?? 0];
  if (!step || step.type !== "staticLinear") {
    return failure("invalid-step", "Selected step must exist and have type staticLinear.", { dofs });
  }

  const assembly = assembleGlobalSystem(model);
  if (!assembly.ok) {
    return failure(assembly.error.code, assembly.error.message, { dofs });
  }

  const loads = assembleNodalForces(model, step.loads);
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

  const free = new Int32Array(freeDofs);
  let freeIndex = 0;
  for (let dof = 0; dof < dofs; dof += 1) {
    if (!constraints.values.has(dof)) {
      free[freeIndex] = dof;
      freeIndex += 1;
    }
  }

  const kff = new Float64Array(freeDofs * freeDofs);
  const rhs = new Float64Array(freeDofs);
  for (let rowIndex = 0; rowIndex < freeDofs; rowIndex += 1) {
    const rowDof = free[rowIndex];
    rhs[rowIndex] = loads[rowDof];
    for (const [constrainedDof, value] of constraints.values) {
      rhs[rowIndex] -= assembly.stiffness[rowDof * dofs + constrainedDof] * value;
    }
    for (let colIndex = 0; colIndex < freeDofs; colIndex += 1) {
      kff[rowIndex * freeDofs + colIndex] = assembly.stiffness[rowDof * dofs + free[colIndex]];
    }
  }

  const solve = solveDenseLinearSystem(kff, rhs, singularTolerance);
  if (!solve.ok) {
    return failure(solve.error.code, solve.error.message, {
      dofs,
      constrainedDofs,
      freeDofs
    });
  }

  const displacement = new Float64Array(dofs);
  for (const [dof, value] of constraints.values) {
    displacement[dof] = value;
  }
  for (let i = 0; i < freeDofs; i += 1) {
    displacement[free[i]] = solve.solution[i];
  }

  const internalForce = multiplyMatrixVector(assembly.stiffness, displacement, dofs);
  const reactionForce = new Float64Array(dofs);
  for (let i = 0; i < dofs; i += 1) {
    reactionForce[i] = internalForce[i] - loads[i];
  }

  const relativeResidual = computeRelativeResidual(internalForce, loads, free, rhs);
  const recovery = recoverElementResults(model, displacement);
  if (!recovery.ok) {
    return failure(recovery.error.code, recovery.error.message, {
      dofs,
      constrainedDofs,
      freeDofs,
      relativeResidual
    });
  }

  const maxDisplacement = maxNodeVectorNorm(displacement);
  const maxVonMisesStress = maxAbs(recovery.vonMises);

  return {
    ok: true,
    result: {
      displacement,
      reactionForce,
      strain: recovery.strain,
      stress: recovery.stress,
      vonMises: recovery.vonMises
    },
    diagnostics: {
      dofs,
      freeDofs,
      constrainedDofs,
      relativeResidual,
      maxDisplacement,
      maxVonMisesStress
    }
  };
}

function getNormalizedModel(input: CpuSolverInput):
  | { ok: true; model: NormalizedOpenCAEModel }
  | { ok: false; error: CpuSolverError } {
  if (isNormalizedModel(input)) {
    return { ok: true, model: input };
  }

  const result = normalizeModelJson(input);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: "validation-failed",
        message: "Input model failed OpenCAE Core validation.",
        report: result.report
      }
    };
  }

  return { ok: true, model: result.model };
}

function assembleGlobalSystem(model: NormalizedOpenCAEModel):
  | { ok: true; stiffness: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const dofs = model.counts.nodes * 3;
  const stiffness = new Float64Array(dofs * dofs);

  for (const block of model.elementBlocks) {
    const material = model.materials[block.materialIndex];
    if (!material || material.type !== "isotropicLinearElastic" || block.type !== "Tet4") {
      return {
        ok: false,
        error: {
          code: "unsupported-model",
          message: "CPU reference solver supports only Tet4 and isotropicLinearElastic materials."
        }
      };
    }

    const d = computeLinearElasticDMatrix(material);
    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += 4) {
      const coordinates = collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset);
      const geometry = computeTet4Geometry(coordinates);
      if (!geometry.ok) {
        return geometry;
      }

      const elementStiffness = computeTet4ElementStiffness(geometry, d);
      if (!elementStiffness.ok) {
        return elementStiffness;
      }

      scatterElementStiffness(stiffness, dofs, block, elementOffset, elementStiffness.stiffness);
    }
  }

  return { ok: true, stiffness };
}

function scatterElementStiffness(
  global: Float64Array,
  dofs: number,
  block: NormalizedTet4ElementBlock,
  elementOffset: number,
  element: Float64Array
): void {
  for (let localRowNode = 0; localRowNode < 4; localRowNode += 1) {
    const rowNode = block.connectivity[elementOffset + localRowNode];
    for (let rowComponent = 0; rowComponent < 3; rowComponent += 1) {
      const globalRow = rowNode * 3 + rowComponent;
      const localRow = localRowNode * 3 + rowComponent;
      for (let localColNode = 0; localColNode < 4; localColNode += 1) {
        const colNode = block.connectivity[elementOffset + localColNode];
        for (let colComponent = 0; colComponent < 3; colComponent += 1) {
          const globalCol = colNode * 3 + colComponent;
          const localCol = localColNode * 3 + colComponent;
          global[globalRow * dofs + globalCol] += element[localRow * 12 + localCol];
        }
      }
    }
  }
}

function assembleNodalForces(model: NormalizedOpenCAEModel, loadNames: string[]): Float64Array {
  const forces = new Float64Array(model.counts.nodes * 3);
  const activeLoads = new Set(loadNames);
  const nodeSets = new Map(model.nodeSets.map((nodeSet) => [nodeSet.name, nodeSet.nodes]));
  for (const load of model.loads) {
    if (!activeLoads.has(load.name)) {
      continue;
    }
    const nodes = nodeSets.get(load.nodeSet);
    if (!nodes) {
      continue;
    }
    for (const node of nodes) {
      forces[node * 3] += load.vector[0];
      forces[node * 3 + 1] += load.vector[1];
      forces[node * 3 + 2] += load.vector[2];
    }
  }
  return forces;
}

function collectConstraints(model: NormalizedOpenCAEModel, boundaryConditionNames: string[]):
  | { ok: true; values: Map<number, number> }
  | { ok: false; error: CpuSolverError } {
  const values = new Map<number, number>();
  const activeBoundaryConditions = new Set(boundaryConditionNames);
  const nodeSets = new Map(model.nodeSets.map((nodeSet) => [nodeSet.name, nodeSet.nodes]));

  for (const boundaryCondition of model.boundaryConditions) {
    if (!activeBoundaryConditions.has(boundaryCondition.name)) {
      continue;
    }
    const nodes = nodeSets.get(boundaryCondition.nodeSet);
    if (!nodes) {
      continue;
    }

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

function recoverElementResults(model: NormalizedOpenCAEModel, displacement: Float64Array):
  | { ok: true; strain: Float64Array; stress: Float64Array; vonMises: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const strain = new Float64Array(model.counts.elements * 6);
  const stress = new Float64Array(model.counts.elements * 6);
  const vonMises = new Float64Array(model.counts.elements);
  let globalElement = 0;

  for (const block of model.elementBlocks) {
    const material = model.materials[block.materialIndex];
    const d = computeLinearElasticDMatrix(material);
    for (let elementOffset = 0; elementOffset < block.connectivity.length; elementOffset += 4) {
      const geometry = computeTet4Geometry(
        collectTetCoordinates(model.nodes.coordinates, block.connectivity, elementOffset)
      );
      if (!geometry.ok) {
        return geometry;
      }

      const elementDisplacement = new Float64Array(12);
      for (let localNode = 0; localNode < 4; localNode += 1) {
        const node = block.connectivity[elementOffset + localNode];
        elementDisplacement[localNode * 3] = displacement[node * 3];
        elementDisplacement[localNode * 3 + 1] = displacement[node * 3 + 1];
        elementDisplacement[localNode * 3 + 2] = displacement[node * 3 + 2];
      }

      const elementStrain = recoverTet4Strain(geometry.gradients, elementDisplacement);
      const elementStress = recoverStress(d, elementStrain);
      strain.set(elementStrain, globalElement * 6);
      stress.set(elementStress, globalElement * 6);
      vonMises[globalElement] = computeVonMisesStress(elementStress);
      globalElement += 1;
    }
  }

  return { ok: true, strain, stress, vonMises };
}

function multiplyMatrixVector(matrix: Float64Array, vector: Float64Array, size: number): Float64Array {
  const result = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      result[row] += matrix[row * size + col] * vector[col];
    }
  }
  return result;
}

function computeRelativeResidual(
  internalForce: Float64Array,
  externalForce: Float64Array,
  free: Int32Array,
  rhs: Float64Array
): number {
  let residualNormSquared = 0;
  let referenceNormSquared = 0;
  for (let i = 0; i < free.length; i += 1) {
    const residual = internalForce[free[i]] - externalForce[free[i]];
    residualNormSquared += residual * residual;
    referenceNormSquared += rhs[i] * rhs[i];
  }
  const reference = Math.sqrt(referenceNormSquared);
  return Math.sqrt(residualNormSquared) / Math.max(reference, 1);
}

function maxNodeVectorNorm(displacement: Float64Array): number {
  let max = 0;
  for (let node = 0; node < displacement.length / 3; node += 1) {
    const ux = displacement[node * 3];
    const uy = displacement[node * 3 + 1];
    const uz = displacement[node * 3 + 2];
    max = Math.max(max, Math.sqrt(ux * ux + uy * uy + uz * uz));
  }
  return max;
}

function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) {
    max = Math.max(max, Math.abs(value));
  }
  return max;
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
