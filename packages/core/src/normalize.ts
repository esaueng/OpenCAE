import {
  OPENCAE_MODEL_SCHEMA_VERSION,
  type CoordinateSystemJson,
  type ModelNormalizationResult,
  type NormalizedOpenCAEModel,
  type OpenCAEModelJson
} from "./model-json";
import { nodesPerElement } from "./topology";
import { validateModelJson } from "./validation";

export function normalizeModelJson(input: unknown): ModelNormalizationResult {
  const report = validateModelJson(input);
  if (!report.ok) {
    return {
      ok: false,
      report
    };
  }

  const model = input as OpenCAEModelJson;
  const materialIndexByName = new Map(
    model.materials.map((material, materialIndex) => [material.name, materialIndex])
  );
  const coordinateSystem: CoordinateSystemJson = model.coordinateSystem ?? {
    solverUnits: "m-N-s-Pa",
    renderCoordinateSpace: "solver"
  };

  const normalized: NormalizedOpenCAEModel = {
    schema: model.schema,
    schemaVersion: OPENCAE_MODEL_SCHEMA_VERSION,
    nodes: {
      coordinates: new Float64Array(model.nodes.coordinates)
    },
    materials: model.materials.map((material) => ({ ...material })),
    elementBlocks: model.elementBlocks.map((block) => ({
      name: block.name,
      type: block.type,
      material: block.material,
      materialIndex: materialIndexByName.get(block.material) ?? -1,
      connectivity: new Uint32Array(block.connectivity)
    })),
    nodeSets: model.nodeSets.map((nodeSet) => ({
      name: nodeSet.name,
      nodes: new Uint32Array(nodeSet.nodes)
    })),
    elementSets: model.elementSets.map((elementSet) => ({
      name: elementSet.name,
      elements: new Uint32Array(elementSet.elements)
    })),
    surfaceFacets: (model.surfaceFacets ?? []).map((facet) => ({
      ...facet,
      nodes: new Uint32Array(facet.nodes)
    })),
    surfaceSets: (model.surfaceSets ?? []).map((surfaceSet) => ({
      name: surfaceSet.name,
      facets: new Uint32Array(surfaceSet.facets)
    })),
    boundaryConditions: model.boundaryConditions.map((boundaryCondition) => ({ ...boundaryCondition })),
    loads: model.loads.map((load) => ({ ...load })),
    steps: model.steps.map((step) =>
      step.type === "dynamicLinear"
        ? { ...step, loadProfile: canonicalDynamicLoadProfile(step.loadProfile) }
        : { ...step }
    ),
    coordinateSystem,
    meshProvenance: model.meshProvenance ? { ...model.meshProvenance } : undefined,
    meshConnections: (model.meshConnections ?? []).map((connection) => ({ ...connection })),
    counts: {
      nodes: model.nodes.coordinates.length / 3,
      elements: model.elementBlocks.reduce(
        (elementCount, block) => elementCount + block.connectivity.length / nodesPerElement(block.type),
        0
      ),
      materials: model.materials.length,
      nodeSets: model.nodeSets.length,
      elementSets: model.elementSets.length,
      surfaceFacets: model.surfaceFacets?.length ?? 0,
      surfaceSets: model.surfaceSets?.length ?? 0,
      loads: model.loads.length,
      boundaryConditions: model.boundaryConditions.length,
      steps: model.steps.length
    }
  };

  return {
    ok: true,
    report,
    model: normalized
  };
}

function canonicalDynamicLoadProfile(loadProfile: string): "step" | "ramp" | "quasi_static" | "half_sine" {
  return loadProfile === "sinusoidal" ? "half_sine" : loadProfile as "step" | "ramp" | "quasi_static" | "half_sine";
}
