import { normalizeModelJson, type NormalizedOpenCAEModel } from "@opencae/core";
import { computeTet4Geometry } from "./geometry";
import {
  computeTet10PhysicalGradients,
  computeTet10Volume,
  TET10_GAUSS_POINTS,
  TET10_GAUSS_WEIGHT,
  TET10_NODE_COUNT
} from "./element-tet10";
import { collectElementCoordinates, elementNodeCountForBlock } from "./solver";
import { addSparseEntry, createSparseMatrixBuilder, csrMatVec, estimateCsrMemoryBytes, reduceCsrSystem, solveConjugateGradient, toCsrMatrix } from "./sparse";
import type { CpuSolverError, CpuSolverInput, CpuSolverOptions } from "./types";

// Thermal has one scalar temperature DOF per node; this is intentionally
// separate from the structural translation-DOF product contract.
const DEFAULT_THERMAL_MAX_DOFS = 150_000;

export type SteadyStateThermalResult = {
  temperature: Float64Array;
  heatFlux: Float64Array;
  heatFluxMagnitude: Float64Array;
  reactionHeat: Float64Array;
  units: {
    temperature: "°C";
    heatFlux: "W/m^2" | "W/mm^2";
    heatRate: "W";
  };
};

export type SteadyStateThermalDiagnostics = {
  dofs: number;
  freeDofs: number;
  constrainedDofs: number;
  iterations: number;
  relativeResidual: number;
  matrixNonZeros: number;
  estimatedMatrixBytes: number;
  preconditioner: "ssor" | "jacobi" | "none";
  appliedSurfaceHeatW: number;
  generatedHeatW: number;
  reactionHeatW: number;
  energyBalanceRelativeError: number;
  solver: "opencae-core-steady-thermal-cg";
};

export type SteadyStateThermalSolveResult =
  | { ok: true; result: SteadyStateThermalResult; diagnostics: SteadyStateThermalDiagnostics }
  | { ok: false; error: CpuSolverError; diagnostics?: Partial<SteadyStateThermalDiagnostics> };

export function solveSteadyStateThermal(
  input: CpuSolverInput,
  options: CpuSolverOptions = {}
): SteadyStateThermalSolveResult {
  const normalized = isNormalized(input) ? { ok: true as const, model: input } : normalizeModelJson(input);
  if (!normalized.ok) return { ok: false, error: { code: "validation-failed", message: "Thermal model failed OpenCAE Core validation.", report: normalized.report } };
  const model = normalized.model;
  const nodeCount = model.counts.nodes;
  const maxDofs = options.maxDofs ?? DEFAULT_THERMAL_MAX_DOFS;
  if (nodeCount > maxDofs) return fail("max-dofs-exceeded", `Thermal model has ${nodeCount} DOFs, which exceeds maxDofs ${maxDofs}.`);
  const step = model.steps[options.stepIndex ?? 0];
  if (!step || step.type !== "steadyStateThermal") return fail("invalid-step", "Selected step must have type steadyStateThermal.");

  const assembled = assembleThermalConductivity(model, options);
  if (!assembled.ok) return assembled;
  const constraints = collectTemperatureConstraints(model, step.boundaryConditions);
  if (!constraints.ok) return constraints;
  if (constraints.values.size === 0) return fail("missing-thermal-temperature", "Steady thermal analysis requires at least one prescribed temperature.");
  const loads = assembleThermalLoads(model, step.loads);
  if (!loads.ok) return loads;

  const free = enumerateFreeNodes(nodeCount, constraints.values);
  const reduced = reduceCsrSystem(assembled.matrix, loads.vector, free, constraints.values);
  const preconditioner = options.preconditioner === "none" || options.preconditioner === "jacobi" ? options.preconditioner : "ssor";
  const solved = solveConjugateGradient(reduced.matrix, reduced.rhs, {
    tolerance: options.tolerance ?? 1e-10,
    maxIterations: options.maxIterations,
    preconditioner,
    ssorOmega: options.ssorOmega,
    hooks: options.hooks
  });
  if (!solved.ok) return fail(solved.error.code, solved.error.message, {
    dofs: nodeCount,
    freeDofs: free.length,
    constrainedDofs: constraints.values.size,
    iterations: solved.iterations,
    relativeResidual: solved.relativeResidual
  });

  const temperature = new Float64Array(nodeCount);
  for (const [node, value] of constraints.values) temperature[node] = value;
  for (let index = 0; index < free.length; index += 1) temperature[free[index]] = solved.solution[index];
  const internal = csrMatVec(assembled.matrix, temperature);
  const reactionHeat = new Float64Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) reactionHeat[node] = internal[node] - loads.vector[node];
  const flux = recoverNodalHeatFlux(model, temperature);
  if (!flux.ok) return flux;
  let reactionHeatW = 0;
  for (const node of constraints.values.keys()) reactionHeatW += reactionHeat[node];
  const appliedHeatW = loads.appliedSurfaceHeatW + loads.generatedHeatW;
  const balanceDenominator = Math.max(Math.abs(appliedHeatW), 1e-12);
  const units = model.coordinateSystem.solverUnits === "m-N-s-Pa" ? "W/m^2" as const : "W/mm^2" as const;
  return {
    ok: true,
    result: {
      temperature,
      heatFlux: flux.vectors,
      heatFluxMagnitude: flux.magnitude,
      reactionHeat,
      units: { temperature: "°C", heatFlux: units, heatRate: "W" }
    },
    diagnostics: {
      dofs: nodeCount,
      freeDofs: free.length,
      constrainedDofs: constraints.values.size,
      iterations: solved.iterations,
      relativeResidual: solved.relativeResidual,
      matrixNonZeros: assembled.matrix.values.length,
      estimatedMatrixBytes: estimateCsrMemoryBytes(assembled.matrix),
      preconditioner,
      appliedSurfaceHeatW: loads.appliedSurfaceHeatW,
      generatedHeatW: loads.generatedHeatW,
      reactionHeatW,
      energyBalanceRelativeError: Math.abs(reactionHeatW + appliedHeatW) / balanceDenominator,
      solver: "opencae-core-steady-thermal-cg"
    }
  };
}

function assembleThermalConductivity(model: NormalizedOpenCAEModel, options: CpuSolverOptions):
  | { ok: true; matrix: ReturnType<typeof toCsrMatrix> }
  | { ok: false; error: CpuSolverError } {
  const builder = createSparseMatrixBuilder(model.counts.nodes);
  let elementOrdinal = 0;
  const total = model.counts.elements;
  for (const block of model.elementBlocks) {
    const nodeCount = elementNodeCountForBlock(block);
    if (!nodeCount) return fail("unsupported-element-type", "Steady thermal analysis supports Tet4 and Tet10 elements.");
    const conductivity = model.materials[block.materialIndex]?.thermalConductivity;
    if (!(conductivity && conductivity > 0)) return fail("missing-thermal-conductivity", `Material ${block.material} requires positive thermalConductivity.`);
    for (let offset = 0; offset < block.connectivity.length; offset += nodeCount, elementOrdinal += 1) {
      if (options.hooks?.shouldCancel?.()) return fail("cancelled", "Thermal solve cancelled.");
      const coordinates = collectElementCoordinates(model.nodes.coordinates, block.connectivity, offset, nodeCount);
      const local = block.type === "Tet4"
        ? tet4Conductivity(coordinates, conductivity)
        : tet10Conductivity(coordinates, conductivity);
      if (!local.ok) return local;
      for (let row = 0; row < nodeCount; row += 1) {
        const globalRow = block.connectivity[offset + row];
        for (let col = 0; col < nodeCount; col += 1) {
          addSparseEntry(builder, globalRow, block.connectivity[offset + col], local.matrix[row * nodeCount + col]);
        }
      }
      if (elementOrdinal % 100 === 0 || elementOrdinal + 1 === total) options.hooks?.onProgress?.({ phase: "assemble", completed: elementOrdinal + 1, total });
    }
  }
  return { ok: true, matrix: toCsrMatrix(builder) };
}

function tet4Conductivity(coordinates: Float64Array, conductivity: number): { ok: true; matrix: Float64Array; volume: number } | { ok: false; error: CpuSolverError } {
  const geometry = computeTet4Geometry(coordinates);
  if (!geometry.ok) return geometry;
  const matrix = new Float64Array(16);
  for (let row = 0; row < 4; row += 1) for (let col = 0; col < 4; col += 1) {
    let dot = 0;
    for (let axis = 0; axis < 3; axis += 1) dot += geometry.gradients[row * 3 + axis] * geometry.gradients[col * 3 + axis];
    matrix[row * 4 + col] = conductivity * geometry.volume * dot;
  }
  return { ok: true, matrix, volume: geometry.volume };
}

function tet10Conductivity(coordinates: Float64Array, conductivity: number): { ok: true; matrix: Float64Array; volume: number } | { ok: false; error: CpuSolverError } {
  const matrix = new Float64Array(TET10_NODE_COUNT * TET10_NODE_COUNT);
  let volume = 0;
  for (const point of TET10_GAUSS_POINTS) {
    const local = computeTet10PhysicalGradients(coordinates, point);
    if (!local.ok) return local;
    const weight = local.detJ * TET10_GAUSS_WEIGHT;
    volume += weight;
    for (let row = 0; row < TET10_NODE_COUNT; row += 1) for (let col = 0; col < TET10_NODE_COUNT; col += 1) {
      let dot = 0;
      for (let axis = 0; axis < 3; axis += 1) dot += local.gradients[row * 3 + axis] * local.gradients[col * 3 + axis];
      matrix[row * TET10_NODE_COUNT + col] += conductivity * weight * dot;
    }
  }
  return { ok: true, matrix, volume };
}

function collectTemperatureConstraints(model: NormalizedOpenCAEModel, names: string[]):
  | { ok: true; values: Map<number, number> }
  | { ok: false; error: CpuSolverError } {
  const active = new Set(names);
  const nodeSets = new Map(model.nodeSets.map((set) => [set.name, set.nodes]));
  const surfaceSets = new Map(model.surfaceSets.map((set) => [set.name, set.facets]));
  const facets = new Map(model.surfaceFacets.map((facet) => [facet.id, facet.nodes]));
  const values = new Map<number, number>();
  for (const boundary of model.boundaryConditions) {
    if (!active.has(boundary.name) || boundary.type !== "prescribedTemperature") continue;
    const nodeSetName = "nodeSet" in boundary ? boundary.nodeSet : undefined;
    const surfaceSetName = "surfaceSet" in boundary ? boundary.surfaceSet : undefined;
    const nodes = nodeSetName
      ? nodeSets.get(nodeSetName) ?? []
      : nodesForSurface(surfaceSetName ? surfaceSets.get(surfaceSetName) : undefined, facets);
    for (const node of nodes) {
      const previous = values.get(node);
      if (previous !== undefined && Math.abs(previous - boundary.value) > 1e-9) return fail("conflicting-temperature", `Node ${node} has conflicting prescribed temperatures.`);
      values.set(node, boundary.value);
    }
  }
  return { ok: true, values };
}

function assembleThermalLoads(model: NormalizedOpenCAEModel, names: string[]):
  | { ok: true; vector: Float64Array; appliedSurfaceHeatW: number; generatedHeatW: number }
  | { ok: false; error: CpuSolverError } {
  const active = new Set(names);
  const vector = new Float64Array(model.counts.nodes);
  const surfaceSets = new Map(model.surfaceSets.map((set) => [set.name, set.facets]));
  const facets = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
  const elementSets = new Map(model.elementSets.map((set) => [set.name, new Set(set.elements)]));
  let appliedSurfaceHeatW = 0;
  let generatedHeatW = 0;
  for (const load of model.loads) {
    if (!active.has(load.name)) continue;
    if (load.type === "surfaceHeatFlux") {
      for (const facetId of surfaceSets.get(load.surfaceSet) ?? []) {
        const facet = facets.get(facetId);
        if (!facet) continue;
        const area = facet.area ?? triangleArea(model.nodes.coordinates, facet.nodes);
        const heat = load.flux * area;
        appliedSurfaceHeatW += heat;
        if (facet.nodes.length >= 6) {
          for (let local = 3; local < 6; local += 1) vector[facet.nodes[local]] += heat / 3;
        } else {
          for (let local = 0; local < 3; local += 1) vector[facet.nodes[local]] += heat / 3;
        }
      }
    } else if (load.type === "volumetricHeatGeneration") {
      const selected = elementSets.get(load.elementSet) ?? new Set<number>();
      let globalElement = 0;
      for (const block of model.elementBlocks) {
        const nodeCount = elementNodeCountForBlock(block)!;
        for (let offset = 0; offset < block.connectivity.length; offset += nodeCount, globalElement += 1) {
          if (!selected.has(globalElement)) continue;
          const coordinates = collectElementCoordinates(model.nodes.coordinates, block.connectivity, offset, nodeCount);
          const volumeResult = block.type === "Tet4" ? computeTet4Geometry(coordinates) : computeTet10Volume(coordinates);
          if (!volumeResult.ok) return volumeResult;
          const heat = load.generation * volumeResult.volume;
          generatedHeatW += heat;
          if (nodeCount === 4) {
            for (let local = 0; local < 4; local += 1) vector[block.connectivity[offset + local]] += heat / 4;
          } else {
            for (let local = 0; local < 4; local += 1) vector[block.connectivity[offset + local]] -= heat / 20;
            for (let local = 4; local < 10; local += 1) vector[block.connectivity[offset + local]] += heat / 5;
          }
        }
      }
    }
  }
  return { ok: true, vector, appliedSurfaceHeatW, generatedHeatW };
}

function recoverNodalHeatFlux(model: NormalizedOpenCAEModel, temperature: Float64Array):
  | { ok: true; vectors: Float64Array; magnitude: Float64Array }
  | { ok: false; error: CpuSolverError } {
  const accumulated = new Float64Array(model.counts.nodes * 3);
  const weights = new Float64Array(model.counts.nodes);
  for (const block of model.elementBlocks) {
    const nodeCount = elementNodeCountForBlock(block)!;
    const conductivity = model.materials[block.materialIndex].thermalConductivity!;
    for (let offset = 0; offset < block.connectivity.length; offset += nodeCount) {
      const coordinates = collectElementCoordinates(model.nodes.coordinates, block.connectivity, offset, nodeCount);
      let gradients: Float64Array;
      let volume: number;
      if (block.type === "Tet4") {
        const geometry = computeTet4Geometry(coordinates);
        if (!geometry.ok) return geometry;
        gradients = geometry.gradients;
        volume = geometry.volume;
      } else {
        const geometry = computeTet10PhysicalGradients(coordinates, [0.25, 0.25, 0.25, 0.25]);
        if (!geometry.ok) return geometry;
        const volumeResult = computeTet10Volume(coordinates);
        if (!volumeResult.ok) return volumeResult;
        gradients = geometry.gradients;
        volume = volumeResult.volume;
      }
      const q = [0, 0, 0];
      for (let local = 0; local < nodeCount; local += 1) {
        const value = temperature[block.connectivity[offset + local]];
        for (let axis = 0; axis < 3; axis += 1) q[axis] -= conductivity * gradients[local * 3 + axis] * value;
      }
      for (let local = 0; local < nodeCount; local += 1) {
        const node = block.connectivity[offset + local];
        weights[node] += volume;
        for (let axis = 0; axis < 3; axis += 1) accumulated[node * 3 + axis] += q[axis] * volume;
      }
    }
  }
  const magnitude = new Float64Array(model.counts.nodes);
  for (let node = 0; node < model.counts.nodes; node += 1) {
    const weight = Math.max(weights[node], 1e-30);
    for (let axis = 0; axis < 3; axis += 1) accumulated[node * 3 + axis] /= weight;
    magnitude[node] = Math.hypot(accumulated[node * 3], accumulated[node * 3 + 1], accumulated[node * 3 + 2]);
  }
  return { ok: true, vectors: accumulated, magnitude };
}

function triangleArea(coordinates: Float64Array, nodes: Uint32Array): number {
  const a = nodes[0] * 3, b = nodes[1] * 3, c = nodes[2] * 3;
  const ab = [coordinates[b] - coordinates[a], coordinates[b + 1] - coordinates[a + 1], coordinates[b + 2] - coordinates[a + 2]];
  const ac = [coordinates[c] - coordinates[a], coordinates[c + 1] - coordinates[a + 1], coordinates[c + 2] - coordinates[a + 2]];
  return 0.5 * Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
}

function nodesForSurface(facetIds: Uint32Array | undefined, facets: Map<number, Uint32Array>): number[] {
  const nodes = new Set<number>();
  for (const id of facetIds ?? []) for (const node of facets.get(id) ?? []) nodes.add(node);
  return [...nodes];
}

function enumerateFreeNodes(count: number, constraints: Map<number, number>): Int32Array {
  const free = new Int32Array(count - constraints.size);
  let cursor = 0;
  for (let node = 0; node < count; node += 1) if (!constraints.has(node)) free[cursor++] = node;
  return free;
}

function isNormalized(input: CpuSolverInput): input is NormalizedOpenCAEModel {
  return input.nodes.coordinates instanceof Float64Array;
}

function fail(code: string, message: string, diagnostics?: Partial<SteadyStateThermalDiagnostics>): { ok: false; error: CpuSolverError; diagnostics?: Partial<SteadyStateThermalDiagnostics> } {
  return { ok: false, error: { code, message }, ...(diagnostics ? { diagnostics } : {}) };
}
