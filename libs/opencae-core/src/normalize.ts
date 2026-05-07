import type {
  ModelNormalizationResult,
  NormalizedOpenCAEModel,
  OpenCAEModelJson
} from "./model-json";
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

  const normalized: NormalizedOpenCAEModel = {
    schema: model.schema,
    schemaVersion: model.schemaVersion,
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
    boundaryConditions: model.boundaryConditions.map((boundaryCondition) => ({ ...boundaryCondition })),
    loads: model.loads.map((load) => ({ ...load })),
    steps: model.steps.map((step) => ({ ...step })),
    counts: {
      nodes: model.nodes.coordinates.length / 3,
      elements: model.elementBlocks.reduce(
        (elementCount, block) => elementCount + block.connectivity.length / 4,
        0
      ),
      materials: model.materials.length,
      nodeSets: model.nodeSets.length,
      elementSets: model.elementSets.length,
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
