import {
  OPENCAE_LEGACY_MODEL_SCHEMA_VERSION,
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION,
  type OpenCAEModelJson,
  type ElementType,
  type ValidationIssue,
  type ValidationReport
} from "./model-json";
import { assembleNodalLoadVectorWithDiagnostics } from "./loads";
import { elementFaces, extractBoundarySurfaceFacets, nodeSetFromSurfaceSet, orphanNodes } from "./mesh";
import { computeTet4SignedVolume, connectedComponents, nodesPerElement } from "./topology";

const COMPONENTS = new Set(["x", "y", "z"]);
const ELEMENT_TYPES = new Set(["Tet4", "Tet10"]);
const DYNAMIC_PROFILES = new Set(["step", "ramp", "quasi_static", "half_sine", "sinusoidal"]);

export function validateModelJson(input: unknown): ValidationReport {
  const errors: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return report([
      {
        code: "invalid-model",
        message: "Model must be an object.",
        path: "$"
      }
    ]);
  }

  if (input.schema !== OPENCAE_MODEL_SCHEMA) {
    errors.push(issue("invalid-schema", "Model schema must be opencae.model.", "$.schema"));
  }

  if (
    input.schemaVersion !== OPENCAE_MODEL_SCHEMA_VERSION &&
    input.schemaVersion !== OPENCAE_LEGACY_MODEL_SCHEMA_VERSION
  ) {
    errors.push(
      issue("invalid-schema-version", "Model schemaVersion must be 0.1.0 or 0.2.0.", "$.schemaVersion")
    );
  }

  const coordinates = isRecord(input.nodes) ? input.nodes.coordinates : undefined;
  const nodeCount = validateCoordinates(coordinates, errors);
  const materials = validateMaterials(input.materials, errors);
  const materialNames = new Set(materials.names);
  const elementValidation = validateElementBlocks(
    input.elementBlocks,
    coordinates,
    nodeCount,
    materialNames,
    errors
  );
  const nodeSetNames = validateNodeSets(input.nodeSets, nodeCount, errors);
  validateElementSets(input.elementSets, elementValidation.totalElements, errors);
  const surfaceFacetIds = validateSurfaceFacets(input.surfaceFacets, elementValidation.elements, nodeCount, errors);
  const surfaceSetNames = validateSurfaceSets(input.surfaceSets, surfaceFacetIds, errors);
  const boundaryConditionNames = validateBoundaryConditions(input.boundaryConditions, nodeSetNames, surfaceSetNames, errors);
  const loadNames = validateLoads(input.loads, nodeSetNames, surfaceSetNames, errors);
  validateSteps(input.steps, boundaryConditionNames, loadNames, errors);
  validateCoordinateSystem(input.coordinateSystem, errors);
  validateMeshProvenance(input.meshProvenance, errors);
  validateMeshConnections(input.meshConnections, errors);
  validateDynamicMaterialDensity(input.steps, input.elementBlocks, materials.densityByName, errors);

  if (
    elementValidation.connectivityOk &&
    elementValidation.totalElements > 1 &&
    (!Array.isArray(input.meshConnections) || input.meshConnections.length === 0)
  ) {
    const components = connectedComponents({ elementBlocks: elementValidation.blocks });
    if (components.componentCount > 1) {
      errors.push(
        issue(
          "disconnected-bodies-without-connections",
          "Geometry has disconnected bodies without contact/tie definitions.",
          "$.elementBlocks"
        )
      );
    }
  }

  return report(errors);
}

export type CoreModelPreflightOptions = {
  stepIndex?: number;
  requireSurfaceSelections?: boolean;
};

export type CoreModelPreflightDiagnostics = {
  nodeCount: number;
  elementCount: number;
  surfaceFacetCount: number;
  connectedComponentCount: number;
  orphanNodeCount: number;
  fixedNodeCount: number;
  loadNodeCount: number;
  totalLoadVectorN: [number, number, number];
};

export type CoreModelPreflightReport = {
  ok: boolean;
  diagnostics: CoreModelPreflightDiagnostics;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export function preflightCoreModel(
  model: OpenCAEModelJson,
  options: CoreModelPreflightOptions = {}
): CoreModelPreflightReport {
  const validation = validateModelJson(model);
  const errors: ValidationIssue[] = [...validation.errors];
  const warnings: ValidationIssue[] = [...validation.warnings];
  const elementCount = countElements(model.elementBlocks);
  const facets = model.surfaceFacets ?? extractBoundarySurfaceFacets(model);
  const components = connectedComponents(model);
  const orphans = orphanNodes(model);
  const step = model.steps[options.stepIndex ?? 0];
  const fixedNodes = step ? activeBoundaryNodes(model, step.boundaryConditions) : new Set<number>();
  const loadNodes = step ? activeLoadNodes(model, step.loads, facets) : new Set<number>();
  const loadDiagnostics = step ? assembleNodalLoadVectorWithDiagnostics({ ...model, surfaceFacets: facets }, step.loads).diagnostics : undefined;

  if (orphans.length > 0) {
    errors.push(issue("orphan-nodes", "Production preflight requires all nodes to belong to at least one element.", "$.nodes"));
  }
  if (components.componentCount > 1 && (!Array.isArray(model.meshConnections) || model.meshConnections.length === 0)) {
    errors.push(issue("disconnected-bodies-without-connections", "Production preflight requires one connected component unless mesh connections are defined.", "$.elementBlocks"));
  }
  if (facets.length === 0) {
    errors.push(issue("missing-surface-facets", "Production preflight requires solver surface facets.", "$.surfaceFacets"));
  }
  if (options.requireSurfaceSelections && step) {
    if (!hasBoundarySurfaceSelection(model, step.boundaryConditions, facets)) {
      errors.push(issue("missing-support-surface-set", "Production supports must map to a non-empty surface set.", "$.boundaryConditions"));
    }
    if (!hasLoadSurfaceSelection(model, step.loads)) {
      errors.push(issue("missing-load-surface-set", "Production loads must map to a non-empty surface set.", "$.loads"));
    }
  }
  for (const loadError of loadDiagnostics?.errors ?? []) {
    errors.push(issue(loadError.code, loadError.message, "$.loads"));
  }

  return {
    ok: errors.length === 0,
    diagnostics: {
      nodeCount: Math.floor(model.nodes.coordinates.length / 3),
      elementCount,
      surfaceFacetCount: facets.length,
      connectedComponentCount: components.componentCount,
      orphanNodeCount: orphans.length,
      fixedNodeCount: fixedNodes.size,
      loadNodeCount: loadNodes.size,
      totalLoadVectorN: loadDiagnostics?.totalAppliedForce ?? [0, 0, 0]
    },
    errors,
    warnings
  };
}

function validateCoordinates(coordinates: unknown, errors: ValidationIssue[]): number {
  if (!Array.isArray(coordinates)) {
    errors.push(issue("invalid-node-coordinates", "nodes.coordinates must be an array.", "$.nodes.coordinates"));
    return 0;
  }

  if (coordinates.length === 0) {
    errors.push(issue("invalid-node-count", "Model must contain at least one node.", "$.nodes.coordinates"));
  }

  if (coordinates.length % 3 !== 0) {
    errors.push(
      issue(
        "invalid-node-coordinate-length",
        "nodes.coordinates length must be divisible by 3.",
        "$.nodes.coordinates"
      )
    );
  }

  coordinates.forEach((coordinate, index) => {
    if (!isFiniteNumber(coordinate)) {
      errors.push(
        issue("invalid-node-coordinate", "Node coordinates must be finite numbers.", `$.nodes.coordinates[${index}]`)
      );
    }
  });

  return Math.floor(coordinates.length / 3);
}

function validateMaterials(materials: unknown, errors: ValidationIssue[]): { names: string[]; densityByName: Map<string, number | undefined> } {
  if (!Array.isArray(materials)) {
    errors.push(issue("invalid-materials", "materials must be an array.", "$.materials"));
    return { names: [], densityByName: new Map() };
  }

  const names = new Set<string>();
  const validNames: string[] = [];
  const densityByName = new Map<string, number | undefined>();
  materials.forEach((material, index) => {
    const path = `$.materials[${index}]`;
    if (!isRecord(material)) {
      errors.push(issue("invalid-material", "Material must be an object.", path));
      return;
    }

    if (!isNonEmptyString(material.name)) {
      errors.push(issue("invalid-material-name", "Material name must be a non-empty string.", `${path}.name`));
    } else {
      if (names.has(material.name)) {
        errors.push(issue("duplicate-material-name", "Material names must be unique.", `${path}.name`));
      }
      names.add(material.name);
      validNames.push(material.name);
      densityByName.set(material.name, typeof material.density === "number" ? material.density : undefined);
    }

    if (material.type !== "isotropicLinearElastic") {
      errors.push(issue("invalid-material-type", "Material type must be isotropicLinearElastic.", `${path}.type`));
    }

    if (!isFiniteNumber(material.youngModulus) || material.youngModulus <= 0) {
      errors.push(issue("invalid-young-modulus", "youngModulus must be a positive finite number.", `${path}.youngModulus`));
    }

    if (!isFiniteNumber(material.poissonRatio) || material.poissonRatio <= -1 || material.poissonRatio >= 0.5) {
      errors.push(
        issue(
          "invalid-poisson-ratio",
          "poissonRatio must be finite and greater than -1 and less than 0.5.",
          `${path}.poissonRatio`
        )
      );
    }

    if (material.yieldStrength !== undefined && (!isFiniteNumber(material.yieldStrength) || material.yieldStrength <= 0)) {
      errors.push(issue("invalid-yield-strength", "yieldStrength must be a positive finite number.", `${path}.yieldStrength`));
    }

    if (material.density !== undefined && (!isFiniteNumber(material.density) || material.density <= 0)) {
      errors.push(issue("invalid-density", "density must be a positive finite number.", `${path}.density`));
    }
  });

  return { names: validNames, densityByName };
}

function validateElementBlocks(
  elementBlocks: unknown,
  coordinates: unknown,
  nodeCount: number,
  materialNames: Set<string>,
  errors: ValidationIssue[]
): {
  totalElements: number;
  connectivityOk: boolean;
  blocks: { name: string; type: ElementType; material: string; connectivity: number[] }[];
  elements: { type: ElementType; nodes: number[] }[];
} {
  if (!Array.isArray(elementBlocks)) {
    errors.push(issue("invalid-element-blocks", "elementBlocks must be an array.", "$.elementBlocks"));
    return { totalElements: 0, connectivityOk: false, blocks: [], elements: [] };
  }

  const names = new Set<string>();
  const blocks: { name: string; type: ElementType; material: string; connectivity: number[] }[] = [];
  const elements: { type: ElementType; nodes: number[] }[] = [];
  let totalElements = 0;
  let connectivityOk = true;
  elementBlocks.forEach((block, blockIndex) => {
    const path = `$.elementBlocks[${blockIndex}]`;
    if (!isRecord(block)) {
      errors.push(issue("invalid-element-block", "Element block must be an object.", path));
      connectivityOk = false;
      return;
    }

    validateUniqueName(block.name, names, "element-block", `${path}.name`, errors);

    if (!isNonEmptyString(block.material) || !materialNames.has(block.material)) {
      errors.push(issue("missing-material-reference", "Element block material must reference an existing material.", `${path}.material`));
    }

    if (block.type !== "Tet4" && block.type !== "Tet10") {
      errors.push(issue("unsupported-element-type", "Element block type must be Tet4 or Tet10.", `${path}.type`));
      connectivityOk = false;
      return;
    }

    if (!Array.isArray(block.connectivity)) {
      errors.push(issue("invalid-connectivity", "Element connectivity must be an array.", `${path}.connectivity`));
      connectivityOk = false;
      return;
    }

    const elementType = block.type as ElementType;
    const nodesPer = nodesPerElement(elementType);
    if (block.connectivity.length % nodesPer !== 0) {
      errors.push(
        issue(
          "invalid-connectivity-length",
          `${elementType} connectivity length must be divisible by ${nodesPer}.`,
          `${path}.connectivity`
        )
      );
      connectivityOk = false;
    }

    for (let i = 0; i < block.connectivity.length; i += nodesPer) {
      const element = block.connectivity.slice(i, i + nodesPer);
      let elementIndicesOk = element.length === nodesPer;
      element.forEach((nodeIndex, localIndex) => {
        const nodePath = `${path}.connectivity[${i + localIndex}]`;
        if (!Number.isInteger(nodeIndex)) {
          errors.push(issue("node-index-not-integer", `${elementType} node indices must be integers.`, nodePath));
          elementIndicesOk = false;
          return;
        }
        if (nodeIndex < 0 || nodeIndex >= nodeCount) {
          errors.push(issue("node-index-out-of-range", `${elementType} node indices must reference existing nodes.`, nodePath));
          elementIndicesOk = false;
        }
      });
      if (element.length === nodesPer && new Set(element).size !== nodesPer) {
        errors.push(issue("duplicate-tet-node", `${elementType} elements cannot repeat a node index.`, `${path}.connectivity[${i}]`));
        elementIndicesOk = false;
      }
      if (elementType === "Tet4" && elementIndicesOk && Array.isArray(coordinates)) {
        const volume = computeTet4SignedVolume(coordinates, element);
        if (!Number.isFinite(volume) || volume <= 0) {
          errors.push(issue("non-positive-element-volume", "Tet4 element volume must be positive.", `${path}.connectivity[${i}]`));
          elementIndicesOk = false;
        }
      }
      connectivityOk = connectivityOk && elementIndicesOk;
      if (element.length === nodesPer) {
        elements.push({ type: elementType, nodes: element });
      }
    }

    totalElements += Math.floor(block.connectivity.length / nodesPer);
    blocks.push({
      name: isNonEmptyString(block.name) ? block.name : `block-${blockIndex}`,
      type: elementType,
      material: isNonEmptyString(block.material) ? block.material : "",
      connectivity: block.connectivity
    });
  });

  return { totalElements, connectivityOk, blocks, elements };
}

function validateNodeSets(nodeSets: unknown, nodeCount: number, errors: ValidationIssue[]): Set<string> {
  if (!Array.isArray(nodeSets)) {
    errors.push(issue("invalid-node-sets", "nodeSets must be an array.", "$.nodeSets"));
    return new Set();
  }

  const names = new Set<string>();
  nodeSets.forEach((nodeSet, index) => {
    const path = `$.nodeSets[${index}]`;
    if (!isRecord(nodeSet)) {
      errors.push(issue("invalid-node-set", "Node set must be an object.", path));
      return;
    }
    validateNamedIndexSet(nodeSet, "nodes", nodeCount, names, "node-set", path, errors);
  });
  return names;
}

function validateElementSets(elementSets: unknown, elementCount: number, errors: ValidationIssue[]): void {
  if (!Array.isArray(elementSets)) {
    errors.push(issue("invalid-element-sets", "elementSets must be an array.", "$.elementSets"));
    return;
  }

  const names = new Set<string>();
  elementSets.forEach((elementSet, index) => {
    const path = `$.elementSets[${index}]`;
    if (!isRecord(elementSet)) {
      errors.push(issue("invalid-element-set", "Element set must be an object.", path));
      return;
    }
    validateNamedIndexSet(elementSet, "elements", elementCount, names, "element-set", path, errors);
  });
}

function validateSurfaceFacets(
  surfaceFacets: unknown,
  elements: { type: ElementType; nodes: number[] }[],
  nodeCount: number,
  errors: ValidationIssue[]
): Set<number> {
  if (surfaceFacets === undefined) return new Set();
  if (!Array.isArray(surfaceFacets)) {
    errors.push(issue("invalid-surface-facets", "surfaceFacets must be an array.", "$.surfaceFacets"));
    return new Set();
  }

  const ids = new Set<number>();
  surfaceFacets.forEach((facet, index) => {
    const path = `$.surfaceFacets[${index}]`;
    if (!isRecord(facet)) {
      errors.push(issue("invalid-surface-facet", "Surface facet must be an object.", path));
      return;
    }
    const id = facet.id;
    if (!isInteger(id)) {
      errors.push(issue("invalid-surface-facet-id", "Surface facet id must be an integer.", `${path}.id`));
    } else {
      if (ids.has(id)) errors.push(issue("duplicate-surface-facet-id", "Surface facet ids must be unique.", `${path}.id`));
      ids.add(id);
    }
    const element = facet.element;
    const ownerElement = isInteger(element) && element >= 0 && element < elements.length ? elements[element] : undefined;
    if (!ownerElement) {
      errors.push(issue("surface-facet-element-out-of-range", "Surface facet element must reference an element.", `${path}.element`));
    }
    const elementFace = facet.elementFace;
    if (!isInteger(elementFace) || elementFace < 0) {
      errors.push(issue("invalid-surface-facet-face", "Surface facet elementFace must be a non-negative integer.", `${path}.elementFace`));
    } else if (ownerElement) {
      const faces = elementFaces(ownerElement.type, ownerElement.nodes);
      const ownerFace = faces[elementFace];
      if (!ownerFace) {
        errors.push(issue("surface-facet-face-out-of-range", "Surface facet elementFace must reference an element face.", `${path}.elementFace`));
      } else if (Array.isArray(facet.nodes)) {
        validateSurfaceFacetMatchesOwnerFace(facet.nodes, ownerFace.nodes, `${path}.nodes`, errors);
      }
    }
    if (!Array.isArray(facet.nodes) || facet.nodes.length < 3) {
      errors.push(issue("invalid-surface-facet-nodes", "Surface facet nodes must contain at least three nodes.", `${path}.nodes`));
    } else {
      facet.nodes.forEach((node, nodeIndex) => {
        if (!Number.isInteger(node)) {
          errors.push(issue("surface-facet-node-not-integer", "Surface facet node indices must be integers.", `${path}.nodes[${nodeIndex}]`));
        } else if (node < 0 || node >= nodeCount) {
          errors.push(issue("surface-facet-node-out-of-range", "Surface facet nodes must reference existing nodes.", `${path}.nodes[${nodeIndex}]`));
        }
      });
    }
    if (facet.area !== undefined && (!isFiniteNumber(facet.area) || facet.area <= 0)) {
      errors.push(issue("invalid-surface-facet-area", "Surface facet area must be positive when provided.", `${path}.area`));
    }
    validateOptionalVector3(facet.normal, `${path}.normal`, "invalid-surface-facet-normal", errors);
    validateOptionalVector3(facet.center, `${path}.center`, "invalid-surface-facet-center", errors);
  });
  return ids;
}

function validateSurfaceFacetMatchesOwnerFace(
  facetNodes: unknown[],
  ownerFaceNodes: number[],
  path: string,
  errors: ValidationIssue[]
): void {
  const facetNodeSet = new Set(facetNodes.filter(Number.isInteger) as number[]);
  const ownerFaceNodeSet = new Set(ownerFaceNodes);
  for (const node of facetNodeSet) {
    if (!ownerFaceNodeSet.has(node)) {
      errors.push(issue("surface-facet-node-not-on-element-face", "Surface facet nodes must belong to the referenced element face.", path));
      return;
    }
  }
  const requiredCornerNodes = ownerFaceNodes.slice(0, 3);
  if (!requiredCornerNodes.every((node) => facetNodeSet.has(node))) {
    errors.push(issue("surface-facet-node-mismatch", "Surface facet nodes must include the referenced element face corner nodes.", path));
  }
}

function validateSurfaceSets(
  surfaceSets: unknown,
  surfaceFacetIds: Set<number>,
  errors: ValidationIssue[]
): Set<string> {
  if (surfaceSets === undefined) return new Set();
  if (!Array.isArray(surfaceSets)) {
    errors.push(issue("invalid-surface-sets", "surfaceSets must be an array.", "$.surfaceSets"));
    return new Set();
  }
  const names = new Set<string>();
  surfaceSets.forEach((surfaceSet, index) => {
    const path = `$.surfaceSets[${index}]`;
    if (!isRecord(surfaceSet)) {
      errors.push(issue("invalid-surface-set", "Surface set must be an object.", path));
      return;
    }
    validateUniqueName(surfaceSet.name, names, "surface-set", `${path}.name`, errors);
    if (!Array.isArray(surfaceSet.facets)) {
      errors.push(issue("invalid-surface-set", "facets must be an array.", `${path}.facets`));
      return;
    }
    if (surfaceSet.facets.length === 0) {
      errors.push(issue("empty-surface-set", "Surface sets must contain at least one facet.", `${path}.facets`));
    }
    const seen = new Set<number>();
    surfaceSet.facets.forEach((facet, facetIndex) => {
      const facetPath = `${path}.facets[${facetIndex}]`;
      if (!Number.isInteger(facet)) {
        errors.push(issue("surface-set-facet-not-integer", "Surface set facet ids must be integers.", facetPath));
      } else if (!surfaceFacetIds.has(facet)) {
        errors.push(issue("surface-set-facet-missing", "Surface set facets must reference existing surface facets.", facetPath));
      }
      if (seen.has(facet)) errors.push(issue("duplicate-surface-set-facet", "Surface set facets must be unique.", facetPath));
      seen.add(facet);
    });
  });
  return names;
}

function validateBoundaryConditions(
  boundaryConditions: unknown,
  nodeSetNames: Set<string>,
  surfaceSetNames: Set<string>,
  errors: ValidationIssue[]
): Set<string> {
  if (!Array.isArray(boundaryConditions)) {
    errors.push(issue("invalid-boundary-conditions", "boundaryConditions must be an array.", "$.boundaryConditions"));
    return new Set();
  }

  const names = new Set<string>();
  boundaryConditions.forEach((bc, index) => {
    const path = `$.boundaryConditions[${index}]`;
    if (!isRecord(bc)) {
      errors.push(issue("invalid-boundary-condition", "Boundary condition must be an object.", path));
      return;
    }
    validateUniqueName(bc.name, names, "boundary-condition", `${path}.name`, errors);

    if (bc.type === "fixed") {
      validateBoundarySelection(bc, nodeSetNames, surfaceSetNames, path, errors);
      if (!Array.isArray(bc.components) || bc.components.length === 0) {
        errors.push(issue("invalid-components", "fixed components must be a non-empty array.", `${path}.components`));
      } else {
        validateComponents(bc.components, `${path}.components`, errors);
      }
      return;
    }

    if (bc.type === "prescribedDisplacement") {
      validateNodeSetReference(bc.nodeSet, nodeSetNames, `${path}.nodeSet`, errors);
      validateComponent(bc.component, `${path}.component`, errors);
      if (!isFiniteNumber(bc.value)) {
        errors.push(issue("invalid-prescribed-displacement-value", "prescribed displacement value must be finite.", `${path}.value`));
      }
      return;
    }

    errors.push(issue("invalid-boundary-condition-type", "Boundary condition type must be fixed or prescribedDisplacement.", `${path}.type`));
  });
  return names;
}

function validateBoundarySelection(
  bc: Record<string, unknown>,
  nodeSetNames: Set<string>,
  surfaceSetNames: Set<string>,
  path: string,
  errors: ValidationIssue[]
): void {
  const hasNodeSet = bc.nodeSet !== undefined;
  const hasSurfaceSet = bc.surfaceSet !== undefined;
  if (hasNodeSet && hasSurfaceSet) {
    errors.push(issue("exclusive-boundary-selection", "Fixed boundary conditions must reference either nodeSet or surfaceSet, not both.", path));
    return;
  }
  if (!hasNodeSet && !hasSurfaceSet) {
    errors.push(issue("missing-boundary-selection", "Fixed boundary conditions must reference nodeSet or surfaceSet.", path));
    return;
  }
  if (hasNodeSet) {
    validateNodeSetReference(bc.nodeSet, nodeSetNames, `${path}.nodeSet`, errors);
    return;
  }
  validateSurfaceSetReference(bc.surfaceSet, surfaceSetNames, `${path}.surfaceSet`, errors);
}

function validateLoads(
  loads: unknown,
  nodeSetNames: Set<string>,
  surfaceSetNames: Set<string>,
  errors: ValidationIssue[]
): Set<string> {
  if (!Array.isArray(loads)) {
    errors.push(issue("invalid-loads", "loads must be an array.", "$.loads"));
    return new Set();
  }

  const names = new Set<string>();
  loads.forEach((load, index) => {
    const path = `$.loads[${index}]`;
    if (!isRecord(load)) {
      errors.push(issue("invalid-load", "Load must be an object.", path));
      return;
    }
    validateUniqueName(load.name, names, "load", `${path}.name`, errors);
    if (load.type === "nodalForce") {
      validateNodeSetReference(load.nodeSet, nodeSetNames, `${path}.nodeSet`, errors);
      validateVector3(load.vector, `${path}.vector`, "invalid-load-vector", "Nodal force vector must contain three finite numbers.", errors);
      return;
    }
    if (load.type === "surfaceForce") {
      validateSurfaceSetReference(load.surfaceSet, surfaceSetNames, `${path}.surfaceSet`, errors);
      validateVector3(load.totalForce, `${path}.totalForce`, "invalid-load-vector", "Surface force totalForce must contain three finite numbers.", errors);
      return;
    }
    if (load.type === "pressure") {
      validateSurfaceSetReference(load.surfaceSet, surfaceSetNames, `${path}.surfaceSet`, errors);
      if (!isFiniteNumber(load.pressure)) {
        errors.push(issue("invalid-pressure", "Pressure load pressure must be finite.", `${path}.pressure`));
      }
      validateOptionalVector3(load.direction, `${path}.direction`, "invalid-pressure-direction", errors);
      return;
    }
    if (load.type === "bodyGravity") {
      validateVector3(load.acceleration, `${path}.acceleration`, "invalid-gravity-acceleration", "Body gravity acceleration must contain three finite numbers.", errors);
      return;
    }
    errors.push(issue("invalid-load-type", "Load type must be nodalForce, surfaceForce, pressure, or bodyGravity.", `${path}.type`));
  });
  return names;
}

function validateSteps(
  steps: unknown,
  boundaryConditionNames: Set<string>,
  loadNames: Set<string>,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(steps)) {
    errors.push(issue("invalid-steps", "steps must be an array.", "$.steps"));
    return;
  }

  const names = new Set<string>();
  steps.forEach((step, index) => {
    const path = `$.steps[${index}]`;
    if (!isRecord(step)) {
      errors.push(issue("invalid-step", "Step must be an object.", path));
      return;
    }
    validateUniqueName(step.name, names, "step", `${path}.name`, errors);
    if (step.type !== "staticLinear" && step.type !== "dynamicLinear") {
      errors.push(issue("invalid-step-type", "Step type must be staticLinear or dynamicLinear.", `${path}.type`));
    }
    validateNameReferenceArray(step.boundaryConditions, boundaryConditionNames, "missing-boundary-condition-reference", `${path}.boundaryConditions`, errors);
    validateNameReferenceArray(step.loads, loadNames, "missing-load-reference", `${path}.loads`, errors);
    if (step.type === "dynamicLinear") {
      validateFinite(step.startTime, `${path}.startTime`, "invalid-dynamic-time", errors);
      validateFinite(step.endTime, `${path}.endTime`, "invalid-dynamic-time", errors);
      validatePositive(step.timeStep, `${path}.timeStep`, "invalid-dynamic-time-step", errors);
      validatePositive(step.outputInterval, `${path}.outputInterval`, "invalid-dynamic-output-interval", errors);
      if (isFiniteNumber(step.startTime) && isFiniteNumber(step.endTime) && step.endTime <= step.startTime) {
        errors.push(issue("invalid-dynamic-time-range", "Dynamic step endTime must be greater than startTime.", `${path}.endTime`));
      }
      if (typeof step.loadProfile !== "string" || !DYNAMIC_PROFILES.has(step.loadProfile)) {
        errors.push(issue("invalid-dynamic-load-profile", "Dynamic loadProfile must be step, ramp, quasi_static, or half_sine.", `${path}.loadProfile`));
      }
      validateOptionalNonNegative(step.dampingRatio, `${path}.dampingRatio`, "invalid-damping-ratio", errors);
      validateOptionalNonNegative(step.rayleighAlpha, `${path}.rayleighAlpha`, "invalid-rayleigh-alpha", errors);
      validateOptionalNonNegative(step.rayleighBeta, `${path}.rayleighBeta`, "invalid-rayleigh-beta", errors);
    }
  });
}

function validateCoordinateSystem(coordinateSystem: unknown, errors: ValidationIssue[]): void {
  if (coordinateSystem === undefined) return;
  if (!isRecord(coordinateSystem)) {
    errors.push(issue("invalid-coordinate-system", "coordinateSystem must be an object.", "$.coordinateSystem"));
    return;
  }
  if (coordinateSystem.solverUnits !== "m-N-s-Pa" && coordinateSystem.solverUnits !== "mm-N-s-MPa") {
    errors.push(issue("invalid-solver-units", "solverUnits must be m-N-s-Pa or mm-N-s-MPa.", "$.coordinateSystem.solverUnits"));
  }
  if (
    coordinateSystem.renderCoordinateSpace !== undefined &&
    coordinateSystem.renderCoordinateSpace !== "solver" &&
    coordinateSystem.renderCoordinateSpace !== "display_model"
  ) {
    errors.push(issue("invalid-render-coordinate-space", "renderCoordinateSpace must be solver or display_model.", "$.coordinateSystem.renderCoordinateSpace"));
  }
}

function validateMeshProvenance(meshProvenance: unknown, errors: ValidationIssue[]): void {
  if (meshProvenance === undefined) return;
  if (!isRecord(meshProvenance)) {
    errors.push(issue("invalid-mesh-provenance", "meshProvenance must be an object.", "$.meshProvenance"));
    return;
  }

  const meshSources = new Set([
    "actual_volume_mesh",
    "structured_block_core",
    "uploaded_volume_mesh",
    "gmsh_volume_mesh",
    "display_bounds_proxy"
  ]);
  if (typeof meshProvenance.meshSource !== "string" || !meshSources.has(meshProvenance.meshSource)) {
    errors.push(issue("invalid-mesh-source", "meshSource must be a supported OpenCAE Core mesh source.", "$.meshProvenance.meshSource"));
  }
  if (meshProvenance.meshSource === "display_bounds_proxy") {
    errors.push(
      issue(
        "display-bounds-proxy-not-production",
        "Production OpenCAE Core solves require an actual volume mesh, not display_bounds_proxy.",
        "$.meshProvenance.meshSource"
      )
    );
  }
  if (meshProvenance.kind === "local_estimate" || meshProvenance.resultSource === "computed_preview") {
    errors.push(
      issue(
        "preview-provenance-not-allowed",
        "Production OpenCAE Core models cannot use local_estimate or computed_preview provenance.",
        "$.meshProvenance"
      )
    );
  }
  for (const key of ["solver", "resultSource", "kind"] as const) {
    if (meshProvenance[key] !== undefined && typeof meshProvenance[key] !== "string") {
      errors.push(issue("invalid-mesh-provenance-field", `${key} must be a string when provided.`, `$.meshProvenance.${key}`));
    }
  }
}

function validateDynamicMaterialDensity(
  steps: unknown,
  elementBlocks: unknown,
  densityByName: Map<string, number | undefined>,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(steps) || !steps.some((step) => isRecord(step) && step.type === "dynamicLinear")) return;
  if (!Array.isArray(elementBlocks)) return;
  elementBlocks.forEach((block, index) => {
    if (!isRecord(block) || typeof block.material !== "string") return;
    const density = densityByName.get(block.material);
    if (!isFiniteNumber(density) || density <= 0) {
      errors.push(
        issue(
          "missing-dynamic-material-density",
          "Dynamic linear steps require positive material density for every solved element block.",
          `$.elementBlocks[${index}].material`
        )
      );
    }
  });
}

function validateMeshConnections(meshConnections: unknown, errors: ValidationIssue[]): void {
  if (meshConnections === undefined) return;
  if (!Array.isArray(meshConnections)) {
    errors.push(issue("invalid-mesh-connections", "meshConnections must be an array.", "$.meshConnections"));
    return;
  }
  meshConnections.forEach((connection, index) => {
    const path = `$.meshConnections[${index}]`;
    if (!isRecord(connection)) {
      errors.push(issue("invalid-mesh-connection", "Mesh connection must be an object.", path));
      return;
    }
    if (connection.type !== "tie" && connection.type !== "contact" && connection.type !== "fuse") {
      errors.push(issue("invalid-mesh-connection-type", "Mesh connection type must be tie, contact, or fuse.", `${path}.type`));
    }
    if (!isNonEmptyString(connection.source)) errors.push(issue("invalid-mesh-connection-source", "Mesh connection source must be a string.", `${path}.source`));
    if (!isNonEmptyString(connection.target)) errors.push(issue("invalid-mesh-connection-target", "Mesh connection target must be a string.", `${path}.target`));
  });
}

function countElements(elementBlocks: OpenCAEModelJson["elementBlocks"]): number {
  return elementBlocks.reduce((sum, block) => sum + Math.floor(block.connectivity.length / nodesPerElement(block.type)), 0);
}

function activeBoundaryNodes(model: OpenCAEModelJson, boundaryConditionNames: string[]): Set<number> {
  const active = new Set(boundaryConditionNames);
  const nodeSets = new Map(model.nodeSets.map((set) => [set.name, set.nodes]));
  const surfaceSets = new Map((model.surfaceSets ?? []).map((set) => [set.name, set]));
  const facetById = new Map((model.surfaceFacets ?? extractBoundarySurfaceFacets(model)).map((facet) => [facet.id, facet]));
  const nodes = new Set<number>();
  for (const condition of model.boundaryConditions) {
    if (!active.has(condition.name)) continue;
    if (condition.type === "fixed" && "surfaceSet" in condition && condition.surfaceSet) {
      const surfaceSet = surfaceSets.get(condition.surfaceSet);
      for (const facetId of surfaceSet?.facets ?? []) {
        for (const node of facetById.get(facetId)?.nodes ?? []) nodes.add(node);
      }
    } else if ("nodeSet" in condition && condition.nodeSet) {
      for (const node of nodeSets.get(condition.nodeSet) ?? []) nodes.add(node);
    }
  }
  return nodes;
}

function activeLoadNodes(model: OpenCAEModelJson, loadNames: string[], facets = model.surfaceFacets ?? []): Set<number> {
  const active = new Set(loadNames);
  const nodeSets = new Map(model.nodeSets.map((set) => [set.name, set.nodes]));
  const surfaceSets = new Map((model.surfaceSets ?? []).map((set) => [set.name, set]));
  const facetById = new Map(facets.map((facet) => [facet.id, facet]));
  const nodes = new Set<number>();
  for (const load of model.loads) {
    if (!active.has(load.name)) continue;
    if (load.type === "nodalForce") {
      for (const node of nodeSets.get(load.nodeSet) ?? []) nodes.add(node);
    } else if (load.type === "surfaceForce" || load.type === "pressure") {
      const surfaceSet = surfaceSets.get(load.surfaceSet);
      for (const facetId of surfaceSet?.facets ?? []) {
        for (const node of facetById.get(facetId)?.nodes ?? []) nodes.add(node);
      }
    } else if (load.type === "bodyGravity") {
      for (let node = 0; node < Math.floor(model.nodes.coordinates.length / 3); node += 1) nodes.add(node);
    }
  }
  return nodes;
}

function hasBoundarySurfaceSelection(model: OpenCAEModelJson, boundaryConditionNames: string[], facets: OpenCAEModelJson["surfaceFacets"] = []): boolean {
  const boundaryNodes = activeBoundaryNodes(model, boundaryConditionNames);
  if (boundaryNodes.size === 0) return false;
  for (const surfaceSet of model.surfaceSets ?? []) {
    const surfaceNodes = new Set(nodeSetFromSurfaceSet(surfaceSet, facets));
    if (surfaceNodes.size > 0 && isSubset(boundaryNodes, surfaceNodes)) return true;
  }
  return false;
}

function hasLoadSurfaceSelection(model: OpenCAEModelJson, loadNames: string[]): boolean {
  const active = new Set(loadNames);
  const surfaceSets = new Map((model.surfaceSets ?? []).map((set) => [set.name, set]));
  let sawLoad = false;
  for (const load of model.loads) {
    if (!active.has(load.name)) continue;
    sawLoad = true;
    if ((load.type === "surfaceForce" || load.type === "pressure") && (surfaceSets.get(load.surfaceSet)?.facets.length ?? 0) > 0) {
      return true;
    }
  }
  return !sawLoad;
}

function isSubset(candidate: Set<number>, container: Set<number>): boolean {
  for (const value of candidate) {
    if (!container.has(value)) return false;
  }
  return true;
}

function validateNamedIndexSet(
  set: Record<string, unknown>,
  property: "nodes" | "elements",
  maxExclusive: number,
  names: Set<string>,
  prefix: "node-set" | "element-set",
  path: string,
  errors: ValidationIssue[]
): void {
  validateUniqueName(set.name, names, prefix, `${path}.name`, errors);
  const values = set[property];
  if (!Array.isArray(values)) {
    errors.push(issue(`invalid-${prefix}`, `${property} must be an array.`, `${path}.${property}`));
    return;
  }
  if (values.length === 0) {
    errors.push(issue(`empty-${prefix}`, `${property} must contain at least one index.`, `${path}.${property}`));
  }
  const seen = new Set<number>();
  values.forEach((value, valueIndex) => {
    const valuePath = `${path}.${property}[${valueIndex}]`;
    if (!Number.isInteger(value)) {
      errors.push(issue(`${prefix}-index-not-integer`, "Set indices must be integers.", valuePath));
      return;
    }
    if (value < 0 || value >= maxExclusive) {
      errors.push(issue(`${prefix}-index-out-of-range`, "Set indices must be in range.", valuePath));
    }
    if (seen.has(value)) {
      errors.push(issue(`duplicate-${prefix}-index`, "Set indices must be unique.", valuePath));
    }
    seen.add(value);
  });
}

function validateNameReferenceArray(
  value: unknown,
  names: Set<string>,
  missingCode: string,
  path: string,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    errors.push(issue("invalid-reference-list", "References must be an array.", path));
    return;
  }
  value.forEach((name, index) => {
    if (!isNonEmptyString(name) || !names.has(name)) {
      errors.push(issue(missingCode, "Reference must point to an existing name.", `${path}[${index}]`));
    }
  });
}

function validateComponents(components: unknown[], path: string, errors: ValidationIssue[]): void {
  const seen = new Set<string>();
  components.forEach((component, index) => {
    validateComponent(component, `${path}[${index}]`, errors);
    if (typeof component === "string") {
      if (seen.has(component)) {
        errors.push(issue("duplicate-component", "Components must be unique.", `${path}[${index}]`));
      }
      seen.add(component);
    }
  });
}

function validateComponent(component: unknown, path: string, errors: ValidationIssue[]): void {
  if (typeof component !== "string" || !COMPONENTS.has(component)) {
    errors.push(issue("invalid-component", "Component must be x, y, or z.", path));
  }
}

function validateNodeSetReference(nodeSet: unknown, nodeSetNames: Set<string>, path: string, errors: ValidationIssue[]): void {
  if (!isNonEmptyString(nodeSet) || !nodeSetNames.has(nodeSet)) {
    errors.push(issue("missing-node-set-reference", "Reference must point to an existing node set.", path));
  }
}

function validateSurfaceSetReference(surfaceSet: unknown, surfaceSetNames: Set<string>, path: string, errors: ValidationIssue[]): void {
  if (!isNonEmptyString(surfaceSet) || !surfaceSetNames.has(surfaceSet)) {
    errors.push(issue("missing-surface-set-reference", "Reference must point to an existing surface set.", path));
  }
}

function validateUniqueName(name: unknown, names: Set<string>, prefix: string, path: string, errors: ValidationIssue[]): void {
  if (!isNonEmptyString(name)) {
    errors.push(issue(`invalid-${prefix}-name`, "Name must be a non-empty string.", path));
    return;
  }
  if (names.has(name)) {
    errors.push(issue(`duplicate-${prefix}-name`, "Names must be unique.", path));
  }
  names.add(name);
}

function validateVector3(
  value: unknown,
  path: string,
  code: string,
  message: string,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    errors.push(issue(code, message, path));
  }
}

function validateOptionalVector3(value: unknown, path: string, code: string, errors: ValidationIssue[]): void {
  if (value !== undefined) {
    validateVector3(value, path, code, "Vector must contain three finite numbers.", errors);
  }
}

function validateFinite(value: unknown, path: string, code: string, errors: ValidationIssue[]): void {
  if (!isFiniteNumber(value)) errors.push(issue(code, "Value must be finite.", path));
}

function validatePositive(value: unknown, path: string, code: string, errors: ValidationIssue[]): void {
  if (!isFiniteNumber(value) || value <= 0) errors.push(issue(code, "Value must be positive.", path));
}

function validateOptionalNonNegative(value: unknown, path: string, code: string, errors: ValidationIssue[]): void {
  if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
    errors.push(issue(code, "Value must be non-negative.", path));
  }
}

function report(errors: ValidationIssue[]): ValidationReport {
  return {
    ok: errors.length === 0,
    errors,
    warnings: []
  };
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
