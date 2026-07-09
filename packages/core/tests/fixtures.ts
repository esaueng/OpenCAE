import type { OpenCAEModelJson } from "../src/model-json";

export function createSingleTetModel(): OpenCAEModelJson {
  return {
    schema: "opencae.model",
    schemaVersion: "0.1.0",
    nodes: {
      coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
    },
    materials: [
      {
        name: "steel",
        type: "isotropicLinearElastic",
        youngModulus: 210000000000,
        poissonRatio: 0.3
      }
    ],
    elementBlocks: [
      {
        name: "tetrahedra",
        type: "Tet4",
        material: "steel",
        connectivity: [0, 1, 2, 3]
      }
    ],
    nodeSets: [
      {
        name: "fixedNodes",
        nodes: [0]
      },
      {
        name: "loadNodes",
        nodes: [1]
      }
    ],
    elementSets: [
      {
        name: "allElements",
        elements: [0]
      }
    ],
    boundaryConditions: [
      {
        name: "fixedSupport",
        type: "fixed",
        nodeSet: "fixedNodes",
        components: ["x", "y", "z"]
      },
      {
        name: "settlement",
        type: "prescribedDisplacement",
        nodeSet: "fixedNodes",
        component: "z",
        value: 0
      }
    ],
    loads: [
      {
        name: "tipLoad",
        type: "nodalForce",
        nodeSet: "loadNodes",
        vector: [0, 0, -100]
      }
    ],
    steps: [
      {
        name: "loadStep",
        type: "staticLinear",
        boundaryConditions: ["fixedSupport", "settlement"],
        loads: ["tipLoad"]
      }
    ]
  };
}

export function createTwoTetModel(): OpenCAEModelJson {
  const model = createSingleTetModel();
  return {
    ...model,
    nodes: {
      coordinates: [...model.nodes.coordinates, 1, 1, 1]
    },
    materials: [
      ...model.materials,
      {
        name: "aluminum",
        type: "isotropicLinearElastic",
        youngModulus: 70000000000,
        poissonRatio: 0.33
      }
    ],
    elementBlocks: [
      model.elementBlocks[0],
      {
        name: "secondBlock",
        type: "Tet4",
        material: "aluminum",
        connectivity: [1, 2, 3, 4]
      }
    ],
    elementSets: [
      {
        name: "allElements",
        elements: [0, 1]
      }
    ]
  };
}
