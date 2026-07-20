import type {
  BodyForceDensityLoadJson,
  BodyGravityLoadJson,
  EquivalentBoltPreloadLoadJson,
  LoadJson,
  NormalizedOpenCAEModel,
  NodalForceLoadJson,
  OpenCAEModelJson,
  PressureLoadJson,
  RemoteForceLoadJson,
  SurfaceFacetJson,
  SurfaceForceLoadJson,
  SurfaceTractionLoadJson,
  SurfaceSetJson
} from "./model-json";
import {
  connectedComponents,
  elementNodeCount,
  extractBoundarySurfaceFacets,
  TET10_HRZ_EDGE_MASS_FRACTION,
  TET10_HRZ_VERTEX_MASS_FRACTION,
  tet4Volume,
  tet10Volume
} from "./mesh";
import {
  centroidSeparationTolerance,
  LOAD_EQUILIBRIUM_POLICY,
  relativeBalanceError,
  remoteGramPivotTolerance
} from "./load-policy";

export type LoadAssemblyModel = OpenCAEModelJson | NormalizedOpenCAEModel;

type LoadSurfaceFacet = Omit<SurfaceFacetJson, "nodes"> & {
  nodes: ArrayLike<number> & Iterable<number>;
};

type LoadSurfaceSet = Omit<SurfaceSetJson, "facets"> & {
  facets: ArrayLike<number> & Iterable<number>;
};

export type LoadAssemblyError = {
  code: string;
  message: string;
  loadName?: string;
};

export type LoadAssemblyPerLoadDiagnostics = {
  name: string;
  type: LoadJson["type"];
  totalAppliedForce: [number, number, number];
  totalAppliedForceMagnitude: number;
  surfaceArea?: number;
  selectedArea?: number;
  loadCentroid?: [number, number, number];
  mass?: number;
  volume?: number;
  targetForce?: [number, number, number];
  targetMoment?: [number, number, number];
  totalAppliedMoment?: [number, number, number];
  forceBalanceError?: number;
  momentBalanceError?: number;
  distribution?: "consistent_surface" | "hrz_volume" | "area_weighted_minimum_norm" | "bonded_linear_preload";
  approximation?: string;
};

export type LoadAssemblyDiagnostics = {
  totalAppliedForce: [number, number, number];
  totalAppliedForceMagnitude: number;
  loadCentroid?: [number, number, number];
  fixedCentroid?: [number, number, number];
  perLoad: LoadAssemblyPerLoadDiagnostics[];
  loads: LoadAssemblyPerLoadDiagnostics[];
  errors: LoadAssemblyError[];
};

export type LoadAssemblyResult = {
  force: Float64Array;
  vector: Float64Array;
  diagnostics: LoadAssemblyDiagnostics;
};

export function assembleNodalLoadVector(model: LoadAssemblyModel, stepLoadNames: string[]): Float64Array {
  const result = assembleNodalLoadVectorWithDiagnostics(model, stepLoadNames);
  if (result.diagnostics.errors.length > 0) {
    throw new Error(
      `Load assembly failed: ${result.diagnostics.errors.map((error) => error.message).join("; ")}`
    );
  }
  return result.vector;
}

export function assembleNodalLoadVectorWithDiagnostics(
  model: LoadAssemblyModel,
  stepLoadNames: string[]
): LoadAssemblyResult {
  const vector = new Float64Array((model.nodes.coordinates.length / 3) * 3);
  const perLoad: LoadAssemblyPerLoadDiagnostics[] = [];
  const diagnostics: LoadAssemblyDiagnostics = {
    totalAppliedForce: [0, 0, 0],
    totalAppliedForceMagnitude: 0,
    perLoad,
    loads: perLoad,
    errors: []
  };
  const loadByName = new Map(model.loads.map((load) => [load.name, load]));

  for (const loadName of stepLoadNames) {
    const load = loadByName.get(loadName);
    if (!load) {
      diagnostics.errors.push({
        code: "missing-load",
        loadName,
        message: `Load ${loadName} was not found.`
      });
      continue;
    }
    const loadTotal: [number, number, number] = [0, 0, 0];
    const loadDiagnostics: LoadAssemblyPerLoadDiagnostics = {
      name: load.name,
      type: load.type,
      totalAppliedForce: loadTotal,
      totalAppliedForceMagnitude: 0
    };

    if (load.type === "nodalForce") {
      assembleNodalForce(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.loadCentroid = nodeSetCentroid(model, load.nodeSet);
    } else if (load.type === "surfaceForce") {
      loadDiagnostics.surfaceArea = assembleSurfaceForce(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.selectedArea = loadDiagnostics.surfaceArea;
      loadDiagnostics.loadCentroid = surfaceSetCentroid(model, load.surfaceSet);
    } else if (load.type === "pressure") {
      loadDiagnostics.surfaceArea = assemblePressure(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.selectedArea = loadDiagnostics.surfaceArea;
      loadDiagnostics.loadCentroid = surfaceSetCentroid(model, load.surfaceSet);
    } else if (load.type === "bodyGravity") {
      loadDiagnostics.mass = assembleBodyGravity(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.loadCentroid = modelCentroid(model);
    } else if (load.type === "surfaceTraction") {
      loadDiagnostics.surfaceArea = assembleSurfaceTraction(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.selectedArea = loadDiagnostics.surfaceArea;
      loadDiagnostics.loadCentroid = surfaceSetCentroid(model, load.surfaceSet);
      loadDiagnostics.distribution = "consistent_surface";
    } else if (load.type === "bodyForceDensity") {
      const assembled = assembleBodyForceDensity(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.volume = assembled.volume;
      loadDiagnostics.loadCentroid = assembled.centroid;
      loadDiagnostics.distribution = "hrz_volume";
    } else if (load.type === "remoteForce") {
      const assembled = assembleRemoteForce(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.surfaceArea = assembled.area;
      loadDiagnostics.selectedArea = assembled.area;
      loadDiagnostics.loadCentroid = assembled.centroid;
      loadDiagnostics.targetForce = [...load.totalForce];
      loadDiagnostics.targetMoment = assembled.targetMoment;
      loadDiagnostics.totalAppliedMoment = assembled.appliedMoment;
      loadDiagnostics.forceBalanceError = assembled.forceBalanceError;
      loadDiagnostics.momentBalanceError = assembled.momentBalanceError;
      loadDiagnostics.distribution = "area_weighted_minimum_norm";
      loadDiagnostics.approximation = "Distributed wrench only; no rigid MPC coupling.";
    } else if (load.type === "equivalentBoltPreload") {
      const assembled = assembleEquivalentBoltPreload(model, vector, load, loadTotal, diagnostics);
      loadDiagnostics.surfaceArea = assembled.area;
      loadDiagnostics.selectedArea = assembled.area;
      loadDiagnostics.loadCentroid = assembled.centroid;
      loadDiagnostics.totalAppliedMoment = assembled.appliedMoment;
      loadDiagnostics.forceBalanceError = assembled.forceBalanceError;
      loadDiagnostics.momentBalanceError = assembled.momentBalanceError;
      loadDiagnostics.distribution = "bonded_linear_preload";
      loadDiagnostics.approximation = "Bonded-linear approximation without contact, slip, or fastener stiffness.";
    } else {
      const unsupportedLoad = load as unknown as { name?: string; type?: string };
      diagnostics.errors.push({
        code: "unsupported-load-type",
        loadName: unsupportedLoad.name,
        message: `Load ${unsupportedLoad.name ?? "unknown"} has unsupported type ${unsupportedLoad.type ?? "unknown"}.`
      });
    }

    addVector(diagnostics.totalAppliedForce, loadTotal);
    loadDiagnostics.totalAppliedForceMagnitude = vectorMagnitude(loadTotal);
    diagnostics.perLoad.push(loadDiagnostics);
  }

  diagnostics.totalAppliedForceMagnitude = vectorMagnitude(diagnostics.totalAppliedForce);
  diagnostics.loadCentroid = combinedLoadCentroid(model, diagnostics.perLoad);

  return { force: vector, vector, diagnostics };
}

function assembleNodalForce(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: NodalForceLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): void {
  const nodeSet = model.nodeSets.find((set) => set.name === load.nodeSet);
  if (!nodeSet) {
    diagnostics.errors.push({
      code: "missing-node-set",
      loadName: load.name,
      message: `Load ${load.name} references missing node set ${load.nodeSet}.`
    });
    return;
  }

  for (const node of nodeSet.nodes) {
    addToNode(vector, node, load.vector);
    addVector(loadTotal, load.vector);
  }
}

function assembleSurfaceForce(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: SurfaceForceLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): number {
  const selection = resolveSurfaceSelection(model, load.surfaceSet, load.name, diagnostics);
  if (!selection) return 0;
  if (selection.area <= 0) {
    diagnostics.errors.push({
      code: "zero-surface-area",
      loadName: load.name,
      message: `Load ${load.name} references zero surface area set ${load.surfaceSet}.`
    });
    return selection.area;
  }

  for (const facet of selection.facets) {
    const area = facetArea(model, facet);
    if (area <= 0) continue;
    const facetForce = scaleVector(load.totalForce, area / selection.area);
    distributeToFacet(vector, facet, facetForce, loadTotal);
  }
  return selection.area;
}

function assemblePressure(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: PressureLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): number {
  const selection = resolveSurfaceSelection(model, load.surfaceSet, load.name, diagnostics);
  if (!selection) return 0;
  if (selection.area <= 0) {
    diagnostics.errors.push({
      code: "zero-surface-area",
      loadName: load.name,
      message: `Load ${load.name} references zero surface area set ${load.surfaceSet}.`
    });
    return selection.area;
  }

  for (const facet of selection.facets) {
    const geometry = facetGeometry(model, facet);
    if (geometry.area <= 0) {
      diagnostics.errors.push({
        code: "zero-surface-facet-area",
        loadName: load.name,
        message: `Load ${load.name} references zero area surface facet ${facet.id}.`
      });
      continue;
    }
    const direction = load.direction ?? geometry.normal;
    const facetForce = scaleVector(direction, load.pressure * geometry.area);
    distributeToFacet(vector, facet, facetForce, loadTotal);
  }
  return selection.area;
}

function assembleSurfaceTraction(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: SurfaceTractionLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): number {
  const selection = resolveSurfaceSelection(model, load.surfaceSet, load.name, diagnostics);
  if (!selection) return 0;
  if (!(selection.area > 0)) {
    diagnostics.errors.push({
      code: "zero-surface-area",
      loadName: load.name,
      message: `Load ${load.name} references zero surface area set ${load.surfaceSet}.`
    });
    return selection.area;
  }
  for (const facet of selection.facets) {
    const area = facetArea(model, facet);
    if (!(area > 0)) {
      diagnostics.errors.push({
        code: "zero-surface-facet-area",
        loadName: load.name,
        message: `Load ${load.name} references zero area surface facet ${facet.id}.`
      });
      continue;
    }
    distributeToFacet(vector, facet, scaleVector(load.traction, area), loadTotal);
  }
  return selection.area;
}

function assembleBodyGravity(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: BodyGravityLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): number {
  const materialByName = new Map(model.materials.map((material) => [material.name, material]));
  let massTotal = 0;

  for (const block of model.elementBlocks) {
    if (block.type !== "Tet4") {
      diagnostics.errors.push({
        code: "unsupported-element-type",
        loadName: load.name,
        message: `Load ${load.name} bodyGravity only supports Tet4 elements; ${block.type} is unsupported.`
      });
      continue;
    }
    const material = materialByName.get(block.material);
    if (!material?.density || !Number.isFinite(material.density)) {
      diagnostics.errors.push({
        code: "missing-material-density",
        loadName: load.name,
        message: `Load ${load.name} requires density on material ${block.material}.`
      });
      continue;
    }

    const nodesPerElement = elementNodeCount(block.type);
    for (let offset = 0; offset + nodesPerElement <= block.connectivity.length; offset += nodesPerElement) {
      const nodes = block.connectivity.slice(offset, offset + nodesPerElement);
      const volume = tet4Volume(model.nodes.coordinates, nodes);
      if (!Number.isFinite(volume) || volume <= 0) {
        diagnostics.errors.push({
          code: "non-positive-element-volume",
          loadName: load.name,
          message: `Load ${load.name} cannot assemble bodyGravity for non-positive Tet4 volume.`
        });
        continue;
      }
      const mass = material.density * volume;
      const elementForce = scaleVector(load.acceleration, mass);
      const nodalForce = scaleVector(elementForce, 1 / nodes.length);
      massTotal += mass;
      for (const node of nodes) {
        addToNode(vector, node, nodalForce);
      }
      addVector(loadTotal, elementForce);
    }
  }

  return massTotal;
}

function assembleBodyForceDensity(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: BodyForceDensityLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): { volume: number; centroid?: [number, number, number] } {
  const elementSet = model.elementSets.find((set) => set.name === load.elementSet);
  if (!elementSet) {
    diagnostics.errors.push({
      code: "missing-element-set",
      loadName: load.name,
      message: `Load ${load.name} references missing element set ${load.elementSet}.`
    });
    return { volume: 0 };
  }
  const selected = new Set(elementSet.elements);
  if (!selected.size) {
    diagnostics.errors.push({
      code: "empty-element-set",
      loadName: load.name,
      message: `Load ${load.name} references empty element set ${load.elementSet}.`
    });
    return { volume: 0 };
  }

  let globalElement = 0;
  let volumeTotal = 0;
  const weightedCentroid: [number, number, number] = [0, 0, 0];
  for (const block of model.elementBlocks) {
    const nodesPerElement = elementNodeCount(block.type);
    for (let offset = 0; offset + nodesPerElement <= block.connectivity.length; offset += nodesPerElement, globalElement += 1) {
      if (!selected.has(globalElement)) continue;
      const nodes = block.connectivity.slice(offset, offset + nodesPerElement);
      const volume = block.type === "Tet10"
        ? tet10Volume(model.nodes.coordinates, nodes)
        : tet4Volume(model.nodes.coordinates, nodes);
      if (!Number.isFinite(volume) || volume <= 0) {
        diagnostics.errors.push({
          code: "non-positive-element-volume",
          loadName: load.name,
          message: `Load ${load.name} cannot assemble body force density for non-positive ${block.type} volume at element ${globalElement}.`
        });
        continue;
      }
      const elementForce = scaleVector(load.forceDensity, volume);
      for (let localNode = 0; localNode < nodes.length; localNode += 1) {
        const fraction = block.type === "Tet10"
          ? localNode < 4 ? TET10_HRZ_VERTEX_MASS_FRACTION : TET10_HRZ_EDGE_MASS_FRACTION
          : 1 / 4;
        addToNode(vector, nodes[localNode], scaleVector(elementForce, fraction));
      }
      addVector(loadTotal, elementForce);
      const centroid = centroidForNodes(model, Array.from(nodes).slice(0, 4));
      if (centroid) {
        weightedCentroid[0] += centroid[0] * volume;
        weightedCentroid[1] += centroid[1] * volume;
        weightedCentroid[2] += centroid[2] * volume;
      }
      volumeTotal += volume;
    }
  }
  return {
    volume: volumeTotal,
    ...(volumeTotal > 0 ? {
      centroid: [weightedCentroid[0] / volumeTotal, weightedCentroid[1] / volumeTotal, weightedCentroid[2] / volumeTotal] as [number, number, number]
    } : {})
  };
}

function assembleRemoteForce(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: RemoteForceLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): {
  area: number;
  centroid?: [number, number, number];
  targetMoment?: [number, number, number];
  appliedMoment?: [number, number, number];
  forceBalanceError?: number;
  momentBalanceError?: number;
} {
  const selection = resolveSurfaceSelection(model, load.surfaceSet, load.name, diagnostics);
  if (!selection) return { area: 0 };
  const geometry = surfaceSelectionGeometry(model, selection.facets);
  if (!(geometry.area > 0) || !geometry.centroid || !(geometry.characteristicLength > 0)) {
    diagnostics.errors.push({
      code: "degenerate-remote-selection",
      loadName: load.name,
      message: `Load ${load.name} requires a non-degenerate surface selection with positive area and spatial extent.`
    });
    return { area: geometry.area, centroid: geometry.centroid };
  }
  const nodeWeights = consistentSurfaceNodeWeights(model, selection.facets);
  const active = [...nodeWeights].filter((entry) => entry[1] > 0);
  if (active.length < 3) {
    diagnostics.errors.push({
      code: "degenerate-remote-selection",
      loadName: load.name,
      message: `Load ${load.name} requires at least three independently positioned weighted surface nodes.`
    });
    return { area: geometry.area, centroid: geometry.centroid };
  }

  const columns = active.length * 3;
  const constraint = new Float64Array(6 * columns);
  for (let entry = 0; entry < active.length; entry += 1) {
    const node = active[entry]![0];
    const q: [number, number, number] = [
      (coordinateAt(model.nodes.coordinates, node, 0) - geometry.centroid[0]) / geometry.characteristicLength,
      (coordinateAt(model.nodes.coordinates, node, 1) - geometry.centroid[1]) / geometry.characteristicLength,
      (coordinateAt(model.nodes.coordinates, node, 2) - geometry.centroid[2]) / geometry.characteristicLength
    ];
    const column = entry * 3;
    constraint[column] = 1;
    constraint[columns + column + 1] = 1;
    constraint[2 * columns + column + 2] = 1;
    constraint[3 * columns + column + 1] = -q[2];
    constraint[3 * columns + column + 2] = q[1];
    constraint[4 * columns + column] = q[2];
    constraint[4 * columns + column + 2] = -q[0];
    constraint[5 * columns + column] = -q[1];
    constraint[5 * columns + column + 1] = q[0];
  }
  const targetMomentAtCentroid = crossVector(subtractVector(load.remotePoint, geometry.centroid), load.totalForce);
  const rightHandSide = new Float64Array([
    ...load.totalForce,
    targetMomentAtCentroid[0] / geometry.characteristicLength,
    targetMomentAtCentroid[1] / geometry.characteristicLength,
    targetMomentAtCentroid[2] / geometry.characteristicLength
  ]);
  const gram = new Float64Array(36);
  for (let row = 0; row < 6; row += 1) {
    for (let column = row; column < 6; column += 1) {
      let value = 0;
      for (let entry = 0; entry < active.length; entry += 1) {
        const normalizedWeight = active[entry]![1] / geometry.area;
        for (let component = 0; component < 3; component += 1) {
          const dof = entry * 3 + component;
          value += constraint[row * columns + dof] * normalizedWeight * constraint[column * columns + dof];
        }
      }
      gram[row * 6 + column] = value;
      gram[column * 6 + row] = value;
    }
  }
  const multipliers = solveRankChecked6x6(gram, rightHandSide);
  if (!multipliers) {
    diagnostics.errors.push({
      code: "rank-deficient-remote-selection",
      loadName: load.name,
      message: `Load ${load.name} surface selection cannot transmit an independent six-component wrench.`
    });
    return { area: geometry.area, centroid: geometry.centroid };
  }

  const appliedMoment: [number, number, number] = [0, 0, 0];
  for (let entry = 0; entry < active.length; entry += 1) {
    const [node, areaWeight] = active[entry]!;
    const normalizedWeight = areaWeight / geometry.area;
    const nodalForce: [number, number, number] = [0, 0, 0];
    for (let component = 0; component < 3; component += 1) {
      const dof = entry * 3 + component;
      for (let row = 0; row < 6; row += 1) {
        nodalForce[component] += normalizedWeight * constraint[row * columns + dof] * multipliers[row];
      }
    }
    addToNode(vector, node, nodalForce);
    addVector(loadTotal, nodalForce);
    addVector(appliedMoment, crossVector(nodePoint(model, node), nodalForce));
  }
  const targetMoment = crossVector(load.remotePoint, load.totalForce);
  const forceBalanceError = relativeVectorError(loadTotal, load.totalForce, vectorMagnitude(load.totalForce));
  const momentScale = Math.max(vectorMagnitude(load.totalForce) * geometry.characteristicLength, vectorMagnitude(targetMoment));
  const momentBalanceError = relativeVectorError(appliedMoment, targetMoment, momentScale);
  if (
    forceBalanceError > LOAD_EQUILIBRIUM_POLICY.forceBalanceRelativeTolerance ||
    momentBalanceError > LOAD_EQUILIBRIUM_POLICY.remoteMomentBalanceRelativeTolerance
  ) {
    diagnostics.errors.push({
      code: "remote-wrench-imbalance",
      loadName: load.name,
      message: `Load ${load.name} distributed wrench failed force/moment balance (force ${forceBalanceError.toExponential(3)}, moment ${momentBalanceError.toExponential(3)}).`
    });
  }
  return { area: geometry.area, centroid: geometry.centroid, targetMoment, appliedMoment, forceBalanceError, momentBalanceError };
}

function assembleEquivalentBoltPreload(
  model: LoadAssemblyModel,
  vector: Float64Array,
  load: EquivalentBoltPreloadLoadJson,
  loadTotal: [number, number, number],
  diagnostics: LoadAssemblyDiagnostics
): {
  area: number;
  centroid?: [number, number, number];
  appliedMoment?: [number, number, number];
  forceBalanceError?: number;
  momentBalanceError?: number;
} {
  if (connectedComponents(model).componentCount !== 1) {
    diagnostics.errors.push({
      code: "disconnected-bolt-preload",
      loadName: load.name,
      message: `Load ${load.name} requires one connected structure.`
    });
    return { area: 0 };
  }
  const selectionA = resolveSurfaceSelection(model, load.surfaceSetA, load.name, diagnostics);
  const selectionB = resolveSurfaceSelection(model, load.surfaceSetB, load.name, diagnostics);
  if (!selectionA || !selectionB) return { area: (selectionA?.area ?? 0) + (selectionB?.area ?? 0) };
  const geometryA = surfaceSelectionGeometry(model, selectionA.facets);
  const geometryB = surfaceSelectionGeometry(model, selectionB.facets);
  const axis = normalizeVector(load.axis);
  if (!(geometryA.area > 0) || !(geometryB.area > 0) || !geometryA.centroid || !geometryB.centroid || !geometryA.normal || !geometryB.normal || !axis) {
    diagnostics.errors.push({
      code: "degenerate-bolt-preload-selection",
      loadName: load.name,
      message: `Load ${load.name} requires two nonzero-area faces with valid normals and a nonzero axis.`
    });
    return { area: geometryA.area + geometryB.area };
  }
  if (dotVector(geometryA.normal, geometryB.normal) > -0.5) {
    diagnostics.errors.push({
      code: "bolt-preload-normals-not-opposed",
      loadName: load.name,
      message: `Load ${load.name} requires opposed face normals.`
    });
    return { area: geometryA.area + geometryB.area };
  }
  const separation = subtractVector(geometryB.centroid, geometryA.centroid);
  const separationLength = vectorMagnitude(separation);
  const separationDirection = normalizeVector(separation);
  const separationTolerance = centroidSeparationTolerance(geometryA.characteristicLength, geometryB.characteristicLength);
  if (!(separationLength > separationTolerance) || !separationDirection || dotVector(separationDirection, axis) <= 0.5) {
    diagnostics.errors.push({
      code: "invalid-bolt-preload-axis",
      loadName: load.name,
      message: `Load ${load.name} requires separated centroids and an axis pointing from surface A toward surface B.`
    });
    return { area: geometryA.area + geometryB.area };
  }
  const appliedMoment: [number, number, number] = [0, 0, 0];
  distributeTotalSurfaceForce(model, vector, selectionA.facets, scaleVector(axis, load.preloadForce), loadTotal, appliedMoment);
  distributeTotalSurfaceForce(model, vector, selectionB.facets, scaleVector(axis, -load.preloadForce), loadTotal, appliedMoment);
  const forceBalanceError = relativeBalanceError(vectorMagnitude(loadTotal), 2 * load.preloadForce);
  const momentBalanceError = relativeBalanceError(vectorMagnitude(appliedMoment), load.preloadForce * separationLength);
  if (
    forceBalanceError > LOAD_EQUILIBRIUM_POLICY.forceBalanceRelativeTolerance ||
    momentBalanceError > LOAD_EQUILIBRIUM_POLICY.preloadMomentBalanceRelativeTolerance
  ) {
    diagnostics.errors.push({
      code: "bolt-preload-imbalance",
      loadName: load.name,
      message: `Load ${load.name} preload pair failed force/moment balance.`
    });
  }
  return {
    area: geometryA.area + geometryB.area,
    centroid: scaleVector(addVectors(geometryA.centroid, geometryB.centroid), 0.5),
    appliedMoment,
    forceBalanceError,
    momentBalanceError
  };
}

function resolveSurfaceSelection(
  model: LoadAssemblyModel,
  surfaceSetName: string,
  loadName: string,
  diagnostics: LoadAssemblyDiagnostics
): { surfaceSet: LoadSurfaceSet; facets: LoadSurfaceFacet[]; area: number } | undefined {
  const surfaceSet = model.surfaceSets?.find((set) => set.name === surfaceSetName) as LoadSurfaceSet | undefined;
  if (!surfaceSet) {
    diagnostics.errors.push({
      code: "missing-surface-set",
      loadName,
      message: `Load ${loadName} references missing surface set ${surfaceSetName}.`
    });
    return undefined;
  }

  const surfaceFacets = (model.surfaceFacets ?? extractBoundarySurfaceFacets(model as OpenCAEModelJson)) as LoadSurfaceFacet[];
  const facetById = new Map(surfaceFacets.map((facet) => [facet.id, facet]));
  const facets: LoadSurfaceFacet[] = [];
  let area = 0;

  for (const facetId of surfaceSet.facets) {
    const facet = facetById.get(facetId);
    if (!facet) {
      diagnostics.errors.push({
        code: "missing-surface-facet",
        loadName,
        message: `Load ${loadName} references missing surface facet ${facetId}.`
      });
      continue;
    }
    facets.push(facet);
    area += facetArea(model, facet);
  }

  return { surfaceSet, facets, area };
}

function surfaceSelectionGeometry(
  model: LoadAssemblyModel,
  facets: LoadSurfaceFacet[]
): { area: number; centroid?: [number, number, number]; normal?: [number, number, number]; characteristicLength: number } {
  let area = 0;
  const centroidAccumulator: [number, number, number] = [0, 0, 0];
  const normalAccumulator: [number, number, number] = [0, 0, 0];
  const nodes = new Set<number>();
  for (const facet of facets) {
    const facetGeometryResult = facetGeometry(model, facet);
    if (!(facetGeometryResult.area > 0)) continue;
    const center = facet.center ?? centroidForNodes(model, Array.from(facet.nodes).slice(0, 3));
    if (!center) continue;
    area += facetGeometryResult.area;
    centroidAccumulator[0] += center[0] * facetGeometryResult.area;
    centroidAccumulator[1] += center[1] * facetGeometryResult.area;
    centroidAccumulator[2] += center[2] * facetGeometryResult.area;
    normalAccumulator[0] += facetGeometryResult.normal[0] * facetGeometryResult.area;
    normalAccumulator[1] += facetGeometryResult.normal[1] * facetGeometryResult.area;
    normalAccumulator[2] += facetGeometryResult.normal[2] * facetGeometryResult.area;
    for (const node of facet.nodes) nodes.add(node);
  }
  if (!(area > 0)) return { area, characteristicLength: 0 };
  const centroid: [number, number, number] = [
    centroidAccumulator[0] / area,
    centroidAccumulator[1] / area,
    centroidAccumulator[2] / area
  ];
  let characteristicLength = 0;
  for (const node of nodes) {
    characteristicLength = Math.max(characteristicLength, vectorMagnitude(subtractVector(nodePoint(model, node), centroid)));
  }
  const normal = normalizeVector(normalAccumulator);
  return { area, centroid, ...(normal ? { normal } : {}), characteristicLength };
}

/** Tributary areas matching the uniform Tri3/Tri6 consistent surface vector. */
function consistentSurfaceNodeWeights(model: LoadAssemblyModel, facets: LoadSurfaceFacet[]): Map<number, number> {
  const weights = new Map<number, number>();
  for (const facet of facets) {
    const area = facetArea(model, facet);
    if (!(area > 0)) continue;
    if (facet.nodes.length === 6) {
      for (let local = 3; local < 6; local += 1) {
        const node = facet.nodes[local];
        weights.set(node, (weights.get(node) ?? 0) + area / 3);
      }
      continue;
    }
    const weight = area / facet.nodes.length;
    for (const node of facet.nodes) weights.set(node, (weights.get(node) ?? 0) + weight);
  }
  return weights;
}

function distributeTotalSurfaceForce(
  model: LoadAssemblyModel,
  vector: Float64Array,
  facets: LoadSurfaceFacet[],
  totalForce: [number, number, number],
  loadTotal: [number, number, number],
  appliedMoment: [number, number, number]
): void {
  const weights = consistentSurfaceNodeWeights(model, facets);
  let area = 0;
  for (const weight of weights.values()) area += weight;
  if (!(area > 0)) return;
  for (const [node, weight] of weights) {
    const nodalForce = scaleVector(totalForce, weight / area);
    addToNode(vector, node, nodalForce);
    addVector(loadTotal, nodalForce);
    addVector(appliedMoment, crossVector(nodePoint(model, node), nodalForce));
  }
}

function solveRankChecked6x6(matrix: Float64Array, rightHandSide: Float64Array): Float64Array | null {
  const size = 6;
  const a = new Float64Array(matrix);
  const b = new Float64Array(rightHandSide);
  let matrixScale = 0;
  for (const value of a) matrixScale = Math.max(matrixScale, Math.abs(value));
  const pivotTolerance = remoteGramPivotTolerance(matrixScale);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let pivotMagnitude = Math.abs(a[column * size + column] ?? 0);
    for (let row = column + 1; row < size; row += 1) {
      const candidate = Math.abs(a[row * size + column] ?? 0);
      if (candidate > pivotMagnitude) {
        pivotMagnitude = candidate;
        pivotRow = row;
      }
    }
    if (!(pivotMagnitude > pivotTolerance)) return null;
    if (pivotRow !== column) {
      for (let entry = column; entry < size; entry += 1) {
        const current = a[column * size + entry] ?? 0;
        a[column * size + entry] = a[pivotRow * size + entry] ?? 0;
        a[pivotRow * size + entry] = current;
      }
      const current = b[column] ?? 0;
      b[column] = b[pivotRow] ?? 0;
      b[pivotRow] = current;
    }
    const pivot = a[column * size + column] ?? 0;
    for (let row = column + 1; row < size; row += 1) {
      const factor = (a[row * size + column] ?? 0) / pivot;
      a[row * size + column] = 0;
      for (let entry = column + 1; entry < size; entry += 1) {
        a[row * size + entry] = (a[row * size + entry] ?? 0) - factor * (a[column * size + entry] ?? 0);
      }
      b[row] = (b[row] ?? 0) - factor * (b[column] ?? 0);
    }
  }
  const solution = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = b[row] ?? 0;
    for (let column = row + 1; column < size; column += 1) {
      value -= (a[row * size + column] ?? 0) * (solution[column] ?? 0);
    }
    const pivot = a[row * size + row] ?? 0;
    if (!(Math.abs(pivot) > pivotTolerance)) return null;
    solution[row] = value / pivot;
  }
  return [...solution].every(Number.isFinite) ? solution : null;
}

function distributeToFacet(
  vector: Float64Array,
  facet: LoadSurfaceFacet,
  facetForce: [number, number, number],
  loadTotal: [number, number, number]
): void {
  if (facet.nodes.length === 6) {
    // Consistent load vector for a quadratic (Tri6) face under uniform traction:
    // corner nodes receive zero, midside nodes receive one third each.
    const midsideForce = scaleVector(facetForce, 1 / 3);
    for (let local = 3; local < 6; local += 1) {
      addToNode(vector, facet.nodes[local], midsideForce);
    }
    addVector(loadTotal, facetForce);
    return;
  }
  const nodalForce = scaleVector(facetForce, 1 / facet.nodes.length);
  for (const node of facet.nodes) {
    addToNode(vector, node, nodalForce);
  }
  addVector(loadTotal, facetForce);
}

function facetArea(model: LoadAssemblyModel, facet: LoadSurfaceFacet): number {
  return facet.area ?? facetGeometry(model, facet).area;
}

function facetGeometry(
  model: LoadAssemblyModel,
  facet: LoadSurfaceFacet
): { area: number; normal: [number, number, number] } {
  const normal = facet.normal;
  const area = facet.area;
  if (area !== undefined && normal !== undefined) {
    return { area, normal };
  }

  const coordinates = model.nodes.coordinates;
  const ax = coordinateAt(coordinates, facet.nodes[0], 0);
  const ay = coordinateAt(coordinates, facet.nodes[0], 1);
  const az = coordinateAt(coordinates, facet.nodes[0], 2);
  const bx = coordinateAt(coordinates, facet.nodes[1], 0);
  const by = coordinateAt(coordinates, facet.nodes[1], 1);
  const bz = coordinateAt(coordinates, facet.nodes[1], 2);
  const cx = coordinateAt(coordinates, facet.nodes[2], 0);
  const cy = coordinateAt(coordinates, facet.nodes[2], 1);
  const cz = coordinateAt(coordinates, facet.nodes[2], 2);
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return {
    area: area ?? length / 2,
    normal: normal ?? (length > 0 ? [nx / length, ny / length, nz / length] : [0, 0, 0])
  };
}

function addToNode(vector: Float64Array, node: number, force: [number, number, number]): void {
  vector[node * 3] += force[0];
  vector[node * 3 + 1] += force[1];
  vector[node * 3 + 2] += force[2];
}

function addVector(target: [number, number, number], value: [number, number, number]): void {
  target[0] += value[0];
  target[1] += value[1];
  target[2] += value[2];
}

function nodeSetCentroid(model: LoadAssemblyModel, nodeSetName: string): [number, number, number] | undefined {
  const nodeSet = model.nodeSets.find((set) => set.name === nodeSetName);
  return nodeSet ? centroidForNodes(model, Array.from(nodeSet.nodes)) : undefined;
}

function surfaceSetCentroid(model: LoadAssemblyModel, surfaceSetName: string): [number, number, number] | undefined {
  const surfaceSet = model.surfaceSets?.find((set) => set.name === surfaceSetName);
  if (!surfaceSet) return undefined;
  const surfaceFacets = (model.surfaceFacets ?? extractBoundarySurfaceFacets(model as OpenCAEModelJson)) as LoadSurfaceFacet[];
  const facetById = new Map(surfaceFacets.map((facet) => [facet.id, facet]));
  const nodes = new Set<number>();
  for (const facetId of surfaceSet.facets) {
    for (const node of facetById.get(facetId)?.nodes ?? []) nodes.add(node);
  }
  return centroidForNodes(model, [...nodes]);
}

function modelCentroid(model: LoadAssemblyModel): [number, number, number] {
  return centroidForNodes(
    model,
    Array.from({ length: model.nodes.coordinates.length / 3 }, (_value, node) => node)
  ) ?? [0, 0, 0];
}

function combinedLoadCentroid(
  model: LoadAssemblyModel,
  perLoad: LoadAssemblyPerLoadDiagnostics[]
): [number, number, number] | undefined {
  let totalWeight = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const load of perLoad) {
    if (!load.loadCentroid) continue;
    const weight = Math.max(load.totalAppliedForceMagnitude, 1);
    x += load.loadCentroid[0] * weight;
    y += load.loadCentroid[1] * weight;
    z += load.loadCentroid[2] * weight;
    totalWeight += weight;
  }
  if (totalWeight > 0) return [x / totalWeight, y / totalWeight, z / totalWeight];
  return model.nodes.coordinates.length > 0 ? modelCentroid(model) : undefined;
}

function centroidForNodes(model: LoadAssemblyModel, nodes: number[]): [number, number, number] | undefined {
  if (nodes.length === 0) return undefined;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const node of nodes) {
    x += coordinateAt(model.nodes.coordinates, node, 0);
    y += coordinateAt(model.nodes.coordinates, node, 1);
    z += coordinateAt(model.nodes.coordinates, node, 2);
  }
  return [x / nodes.length, y / nodes.length, z / nodes.length];
}

function vectorMagnitude(vector: [number, number, number]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function scaleVector(vector: [number, number, number], scale: number): [number, number, number] {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function addVectors(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtractVector(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function crossVector(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function dotVector(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function normalizeVector(vector: [number, number, number]): [number, number, number] | undefined {
  const magnitude = vectorMagnitude(vector);
  return magnitude > 0 && Number.isFinite(magnitude) ? scaleVector(vector, 1 / magnitude) : undefined;
}

function nodePoint(model: LoadAssemblyModel, node: number): [number, number, number] {
  return [
    coordinateAt(model.nodes.coordinates, node, 0),
    coordinateAt(model.nodes.coordinates, node, 1),
    coordinateAt(model.nodes.coordinates, node, 2)
  ];
}

function relativeVectorError(
  actual: [number, number, number],
  expected: [number, number, number],
  scale: number
): number {
  return relativeBalanceError(vectorMagnitude(subtractVector(actual, expected)), scale);
}

function coordinateAt(coordinates: ArrayLike<number>, node: number, component: number): number {
  return coordinates[node * 3 + component] ?? 0;
}
