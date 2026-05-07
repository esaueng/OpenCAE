import {
  OPENCAE_MODEL_SCHEMA,
  OPENCAE_MODEL_SCHEMA_VERSION,
  type ValidationIssue,
  type ValidationReport
} from "./model-json";

const COMPONENTS = new Set(["x", "y", "z"]);

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

  if (input.schemaVersion !== OPENCAE_MODEL_SCHEMA_VERSION) {
    errors.push(
      issue("invalid-schema-version", "Model schemaVersion must be 0.1.0.", "$.schemaVersion")
    );
  }

  const coordinates = isRecord(input.nodes) ? input.nodes.coordinates : undefined;
  const nodeCount = validateCoordinates(coordinates, errors);
  const materials = validateMaterials(input.materials, errors);
  const materialNames = new Set(materials.names);
  const totalElements = validateElementBlocks(input.elementBlocks, nodeCount, materialNames, errors);
  const nodeSetNames = validateNodeSets(input.nodeSets, nodeCount, errors);
  validateElementSets(input.elementSets, totalElements, errors);
  const boundaryConditionNames = validateBoundaryConditions(
    input.boundaryConditions,
    nodeSetNames,
    errors
  );
  const loadNames = validateLoads(input.loads, nodeSetNames, errors);
  validateSteps(input.steps, boundaryConditionNames, loadNames, errors);

  return report(errors);
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

function validateMaterials(materials: unknown, errors: ValidationIssue[]): { names: string[] } {
  if (!Array.isArray(materials)) {
    errors.push(issue("invalid-materials", "materials must be an array.", "$.materials"));
    return { names: [] };
  }

  const names = new Set<string>();
  const validNames: string[] = [];
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
    }

    if (material.type !== "isotropicLinearElastic") {
      errors.push(
        issue("invalid-material-type", "Material type must be isotropicLinearElastic.", `${path}.type`)
      );
    }

    if (!isFiniteNumber(material.youngModulus) || material.youngModulus <= 0) {
      errors.push(
        issue("invalid-young-modulus", "youngModulus must be a positive finite number.", `${path}.youngModulus`)
      );
    }

    if (
      !isFiniteNumber(material.poissonRatio) ||
      material.poissonRatio <= -1 ||
      material.poissonRatio >= 0.5
    ) {
      errors.push(
        issue(
          "invalid-poisson-ratio",
          "poissonRatio must be finite and greater than -1 and less than 0.5.",
          `${path}.poissonRatio`
        )
      );
    }
  });

  return { names: validNames };
}

function validateElementBlocks(
  elementBlocks: unknown,
  nodeCount: number,
  materialNames: Set<string>,
  errors: ValidationIssue[]
): number {
  if (!Array.isArray(elementBlocks)) {
    errors.push(issue("invalid-element-blocks", "elementBlocks must be an array.", "$.elementBlocks"));
    return 0;
  }

  const names = new Set<string>();
  let totalElements = 0;
  elementBlocks.forEach((block, blockIndex) => {
    const path = `$.elementBlocks[${blockIndex}]`;
    if (!isRecord(block)) {
      errors.push(issue("invalid-element-block", "Element block must be an object.", path));
      return;
    }

    if (!isNonEmptyString(block.name)) {
      errors.push(issue("invalid-element-block-name", "Element block name must be a non-empty string.", `${path}.name`));
    } else {
      if (names.has(block.name)) {
        errors.push(issue("duplicate-element-block-name", "Element block names must be unique.", `${path}.name`));
      }
      names.add(block.name);
    }

    if (block.type !== "Tet4") {
      errors.push(issue("invalid-element-block-type", "Element block type must be Tet4.", `${path}.type`));
    }

    if (!isNonEmptyString(block.material) || !materialNames.has(block.material)) {
      errors.push(
        issue("missing-material-reference", "Element block material must reference an existing material.", `${path}.material`)
      );
    }

    if (!Array.isArray(block.connectivity)) {
      errors.push(issue("invalid-connectivity", "Tet4 connectivity must be an array.", `${path}.connectivity`));
      return;
    }

    if (block.connectivity.length % 4 !== 0) {
      errors.push(
        issue("invalid-connectivity-length", "Tet4 connectivity length must be divisible by 4.", `${path}.connectivity`)
      );
    }

    for (let i = 0; i < block.connectivity.length; i += 4) {
      const tet = block.connectivity.slice(i, i + 4);
      validateTetNodeIndices(tet, nodeCount, `${path}.connectivity`, i, errors);
      if (tet.length === 4 && new Set(tet).size !== 4) {
        errors.push(
          issue("duplicate-tet-node", "Tet4 elements cannot repeat a node index.", `${path}.connectivity[${i}]`)
        );
      }
    }

    totalElements += Math.floor(block.connectivity.length / 4);
  });

  return totalElements;
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

function validateBoundaryConditions(
  boundaryConditions: unknown,
  nodeSetNames: Set<string>,
  errors: ValidationIssue[]
): Set<string> {
  if (!Array.isArray(boundaryConditions)) {
    errors.push(
      issue("invalid-boundary-conditions", "boundaryConditions must be an array.", "$.boundaryConditions")
    );
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
    validateNodeSetReference(bc.nodeSet, nodeSetNames, `${path}.nodeSet`, errors);

    if (bc.type === "fixed") {
      if (!Array.isArray(bc.components) || bc.components.length === 0) {
        errors.push(issue("invalid-components", "fixed components must be a non-empty array.", `${path}.components`));
      } else {
        validateComponents(bc.components, `${path}.components`, errors);
      }
      return;
    }

    if (bc.type === "prescribedDisplacement") {
      validateComponent(bc.component, `${path}.component`, errors);
      if (!isFiniteNumber(bc.value)) {
        errors.push(
          issue(
            "invalid-prescribed-displacement-value",
            "prescribed displacement value must be finite.",
            `${path}.value`
          )
        );
      }
      return;
    }

    errors.push(
      issue(
        "invalid-boundary-condition-type",
        "Boundary condition type must be fixed or prescribedDisplacement.",
        `${path}.type`
      )
    );
  });
  return names;
}

function validateLoads(loads: unknown, nodeSetNames: Set<string>, errors: ValidationIssue[]): Set<string> {
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
    if (load.type !== "nodalForce") {
      errors.push(issue("invalid-load-type", "Load type must be nodalForce.", `${path}.type`));
    }
    validateNodeSetReference(load.nodeSet, nodeSetNames, `${path}.nodeSet`, errors);
    if (!Array.isArray(load.vector) || load.vector.length !== 3 || !load.vector.every(isFiniteNumber)) {
      errors.push(issue("invalid-load-vector", "Nodal force vector must contain three finite numbers.", `${path}.vector`));
    }
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
    if (step.type !== "staticLinear") {
      errors.push(issue("invalid-step-type", "Step type must be staticLinear.", `${path}.type`));
    }
    validateNameReferenceArray(
      step.boundaryConditions,
      boundaryConditionNames,
      "missing-boundary-condition-reference",
      `${path}.boundaryConditions`,
      errors
    );
    validateNameReferenceArray(step.loads, loadNames, "missing-load-reference", `${path}.loads`, errors);
  });
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

function validateTetNodeIndices(
  tet: unknown[],
  nodeCount: number,
  path: string,
  offset: number,
  errors: ValidationIssue[]
): void {
  tet.forEach((nodeIndex, localIndex) => {
    const nodePath = `${path}[${offset + localIndex}]`;
    if (!Number.isInteger(nodeIndex)) {
      errors.push(issue("node-index-not-integer", "Tet4 node indices must be integers.", nodePath));
      return;
    }
    if ((nodeIndex as number) < 0 || (nodeIndex as number) >= nodeCount) {
      errors.push(issue("node-index-out-of-range", "Tet4 node indices must reference existing nodes.", nodePath));
    }
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

function validateNodeSetReference(
  nodeSet: unknown,
  nodeSetNames: Set<string>,
  path: string,
  errors: ValidationIssue[]
): void {
  if (!isNonEmptyString(nodeSet) || !nodeSetNames.has(nodeSet)) {
    errors.push(issue("missing-node-set-reference", "Reference must point to an existing node set.", path));
  }
}

function validateUniqueName(
  name: unknown,
  names: Set<string>,
  prefix: string,
  path: string,
  errors: ValidationIssue[]
): void {
  if (!isNonEmptyString(name)) {
    errors.push(issue(`invalid-${prefix}-name`, "Name must be a non-empty string.", path));
    return;
  }
  if (names.has(name)) {
    errors.push(issue(`duplicate-${prefix}-name`, "Names must be unique.", path));
  }
  names.add(name);
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
