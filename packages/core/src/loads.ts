import type {
  BodyGravityLoadJson,
  LoadJson,
  NormalizedOpenCAEModel,
  NodalForceLoadJson,
  OpenCAEModelJson,
  PressureLoadJson,
  SurfaceFacetJson,
  SurfaceForceLoadJson,
  SurfaceSetJson
} from "./model-json";
import { elementNodeCount, extractBoundarySurfaceFacets, tet4Volume } from "./mesh";

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
    diagnostics.loads.push(loadDiagnostics);
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

function coordinateAt(coordinates: ArrayLike<number>, node: number, component: number): number {
  return coordinates[node * 3 + component] ?? 0;
}
