import type { NormalizedOpenCAEModel } from "@opencae/core";
import { computeTet4Geometry } from "./geometry";
import {
  computeTet10Volume,
  TET10_HRZ_EDGE_MASS_FRACTION,
  TET10_HRZ_VERTEX_MASS_FRACTION,
  TET10_NODE_COUNT
} from "./element-tet10";
import {
  assembleNodalForces,
  assembleSparseStiffness,
  collectConstraints,
  collectElementCoordinates,
  elementNodeCountForBlock,
  enumerateFreeDofs
} from "./solver";
import { reduceCsrSystem, type CsrMatrix } from "./sparse";
import type { CpuSolverError, SolverHooks } from "./types";

export type PreparedStructuralSystem = {
  stiffness: CsrMatrix;
  fullStiffness: CsrMatrix;
  fullLoad: Float64Array;
  load: Float64Array;
  mass: Float64Array;
  fullMass: Float64Array;
  totalMass: number;
  free: Int32Array;
  constraints: Map<number, number>;
};

export function prepareStructuralSystem(
  model: NormalizedOpenCAEModel,
  boundaryConditionNames: string[],
  loadNames: string[] = [],
  hooks?: SolverHooks,
  analysisLabel: "Dynamic" | "Modal" = "Dynamic",
  massFloor = analysisLabel === "Dynamic" ? 1e-12 : 0
): { ok: true; system: PreparedStructuralSystem } | { ok: false; error: CpuSolverError } {
  const stiffness = assembleSparseStiffness(model, hooks);
  if (!stiffness.ok) return stiffness;
  const constraints = collectConstraints(model, boundaryConditionNames);
  if (!constraints.ok) return constraints;
  const free = enumerateFreeDofs(model.counts.nodes * 3, constraints.values);
  const fullLoad = assembleNodalForces(model, loadNames);
  const reduced = reduceCsrSystem(stiffness.stiffness, fullLoad, free, constraints.values);
  const lumpedMass = assembleLumpedMass(model, analysisLabel);
  if (!lumpedMass.ok) return lumpedMass;
  const reducedMass = new Float64Array(free.length);
  for (let index = 0; index < free.length; index += 1) {
    const mass = lumpedMass.dofMass[free[index]];
    if (!(mass > 0) || !Number.isFinite(mass)) {
      if (massFloor > 0 && Number.isFinite(mass)) {
        reducedMass[index] = massFloor;
        continue;
      }
      return {
        ok: false,
        error: {
          code: "invalid-lumped-mass",
          message: "Structural inertial analysis requires positive finite lumped mass at every free DOF."
        }
      };
    }
    reducedMass[index] = Math.max(mass, massFloor);
  }
  return {
    ok: true,
    system: {
      stiffness: reduced.matrix,
      fullStiffness: stiffness.stiffness,
      fullLoad,
      load: reduced.rhs,
      mass: reducedMass,
      fullMass: lumpedMass.dofMass,
      totalMass: lumpedMass.totalMass,
      free,
      constraints: constraints.values
    }
  };
}

export function assembleLumpedMass(model: NormalizedOpenCAEModel, analysisLabel: "Dynamic" | "Modal" = "Dynamic"):
  | { ok: true; dofMass: Float64Array; totalMass: number }
  | { ok: false; error: CpuSolverError } {
  const nodalMass = new Float64Array(model.counts.nodes);
  let totalMass = 0;
  for (const block of model.elementBlocks) {
    const nodeCount = elementNodeCountForBlock(block);
    if (nodeCount === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported-element-type",
          message: "Structural inertial analysis supports Tet4 and Tet10 element blocks."
        }
      };
    }
    const material = model.materials[block.materialIndex];
    if (!material?.density || !Number.isFinite(material.density)) {
      return {
        ok: false,
        error: {
          code: "missing-material-density",
          message: `${analysisLabel} solve requires material density.`
        }
      };
    }
    for (let offset = 0; offset < block.connectivity.length; offset += nodeCount) {
      let elementMass: number;
      if (block.type === "Tet4") {
        const coordinates = collectElementCoordinates(model.nodes.coordinates, block.connectivity, offset, 4);
        const geometry = computeTet4Geometry(coordinates);
        if (!geometry.ok) return geometry;
        elementMass = geometry.volume * material.density;
        for (let localNode = 0; localNode < 4; localNode += 1) {
          nodalMass[block.connectivity[offset + localNode]] += elementMass / 4;
        }
      } else {
        const coordinates = collectElementCoordinates(model.nodes.coordinates, block.connectivity, offset, nodeCount);
        const volume = computeTet10Volume(coordinates);
        if (!volume.ok) return volume;
        elementMass = volume.volume * material.density;
        // HRZ lumping preserves positive Tet10 nodal masses and exact total mass.
        for (let localNode = 0; localNode < TET10_NODE_COUNT; localNode += 1) {
          const fraction = localNode < 4 ? TET10_HRZ_VERTEX_MASS_FRACTION : TET10_HRZ_EDGE_MASS_FRACTION;
          nodalMass[block.connectivity[offset + localNode]] += elementMass * fraction;
        }
      }
      totalMass += elementMass;
    }
  }
  const dofMass = new Float64Array(model.counts.nodes * 3);
  for (let node = 0; node < nodalMass.length; node += 1) {
    dofMass[node * 3] = nodalMass[node];
    dofMass[node * 3 + 1] = nodalMass[node];
    dofMass[node * 3 + 2] = nodalMass[node];
  }
  return { ok: true, dofMass, totalMass };
}

export function expandFreeVector(
  dofs: number,
  free: Int32Array,
  reduced: Float64Array,
  constraints?: Map<number, number>
): Float64Array {
  const full = new Float64Array(dofs);
  for (const [dof, value] of constraints ?? []) full[dof] = value;
  for (let index = 0; index < free.length; index += 1) full[free[index]] = reduced[index];
  return full;
}
