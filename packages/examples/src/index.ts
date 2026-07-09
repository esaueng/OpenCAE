export const PLACEHOLDER_MODEL_FIXTURE = "fixtures/placeholder-model.json";
import {
  deriveFixedSupportNodeSetFromSurface,
  volumeMeshToModelJson,
  type OpenCAEModelJson
} from "@opencae/core";

export const singleTetStaticFixture = {
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
      nodes: [3]
    },
    {
      name: "supportYNodes",
      nodes: [1]
    },
    {
      name: "supportZNodes",
      nodes: [2]
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
    },
    {
      name: "supportY",
      type: "fixed",
      nodeSet: "supportYNodes",
      components: ["y", "z"]
    },
    {
      name: "supportZ",
      type: "fixed",
      nodeSet: "supportZNodes",
      components: ["z"]
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
      boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
      loads: ["tipLoad"]
    }
  ]
} satisfies OpenCAEModelJson;

export const twoTetStaticFixture = {
  ...singleTetStaticFixture,
  nodes: {
    coordinates: [...singleTetStaticFixture.nodes.coordinates, 1, 1, 1]
  },
  materials: [
    ...singleTetStaticFixture.materials,
    {
      name: "aluminum",
      type: "isotropicLinearElastic",
      youngModulus: 70000000000,
      poissonRatio: 0.33
    }
  ],
  elementBlocks: [
    {
      name: "firstBlock",
      type: "Tet4",
      material: "steel",
      connectivity: [0, 1, 2, 3]
    },
    {
      name: "secondBlock",
      type: "Tet4",
      material: "aluminum",
      connectivity: [1, 2, 3, 4]
    }
  ],
  nodeSets: [
    {
      name: "fixedNodes",
      nodes: [0]
    },
    {
      name: "loadNodes",
      nodes: [4]
    },
    {
      name: "supportYNodes",
      nodes: [1]
    },
    {
      name: "supportZNodes",
      nodes: [2]
    }
  ],
  elementSets: [
    {
      name: "allElements",
      elements: [0, 1]
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
      name: "supportY",
      type: "fixed",
      nodeSet: "supportYNodes",
      components: ["y", "z"]
    },
    {
      name: "supportZ",
      type: "fixed",
      nodeSet: "supportZNodes",
      components: ["z"]
    }
  ],
  steps: [
    {
      name: "loadStep",
      type: "staticLinear",
      boundaryConditions: ["fixedSupport", "supportY", "supportZ"],
      loads: ["tipLoad"]
    }
  ]
} satisfies OpenCAEModelJson;

export const invalidConnectivityFixture = {
  ...singleTetStaticFixture,
  elementBlocks: [
    {
      name: "tetrahedra",
      type: "Tet4",
      material: "steel",
      connectivity: [0, 1, 1, 9, 2]
    }
  ],
  elementSets: []
} satisfies OpenCAEModelJson;

const bracketMeshBase = volumeMeshToModelJson({
  nodes: {
    coordinates: [
      0, 0, 0,
      2, 0, 0,
      0, 1, 0,
      0, 0, 0.2,
      2, 1, 0.2,
      0, 0.2, 1.2,
      0, 1, 1.2,
      0.2, 0, 1.2,
      0.2, 1, 1.2,
      1, 0.5, 0.7
    ]
  },
  materials: [
    {
      name: "steel",
      type: "isotropicLinearElastic",
      youngModulus: 210000000000,
      poissonRatio: 0.3,
      yieldStrength: 250000000,
      density: 7850
    }
  ],
  elementBlocks: [
    {
      name: "fused_bracket",
      type: "Tet4",
      material: "steel",
      connectivity: [
        0, 1, 2, 3,
        1, 2, 3, 4,
        0, 2, 3, 7,
        2, 3, 7, 8,
        2, 6, 7, 8,
        1, 4, 3, 9
      ]
    }
  ],
  sourceFaces: [
    { sourceSelectionRef: "base_mount", sourceFaceId: "base_mount", element: 0, elementFace: 3 },
    { sourceSelectionRef: "upright_load", sourceFaceId: "upright_load", element: 4, elementFace: 0 },
    { sourceSelectionRef: "hole_wall", sourceFaceId: "hole_wall", element: 2, elementFace: 2 },
    { sourceSelectionRef: "gusset_skin", sourceFaceId: "gusset_skin", element: 5, elementFace: 0 }
  ],
  surfaceSets: [
    { name: "base_mount", sourceSelectionRef: "base_mount" },
    { name: "upright_load", sourceSelectionRef: "upright_load" },
    { name: "hole_wall", sourceSelectionRef: "hole_wall" },
    { name: "gusset_skin", sourceSelectionRef: "gusset_skin" }
  ]
});

export const bracketActualMeshFixture: OpenCAEModelJson = {
  ...bracketMeshBase,
  nodeSets: [
    deriveFixedSupportNodeSetFromSurface("fixedBaseNodes", "base_mount", bracketMeshBase),
    deriveFixedSupportNodeSetFromSurface("loadFaceNodes", "upright_load", bracketMeshBase)
  ],
  boundaryConditions: [
    {
      name: "fixedBase",
      type: "fixed",
      nodeSet: "fixedBaseNodes",
      components: ["x", "y", "z"]
    }
  ],
  loads: [
    {
      name: "uprightPush",
      type: "surfaceForce",
      surfaceSet: "upright_load",
      totalForce: [0, 0, -250]
    }
  ],
  steps: [
    {
      name: "staticBracket",
      type: "staticLinear",
      boundaryConditions: ["fixedBase"],
      loads: ["uprightPush"]
    },
    {
      name: "dynamicBracket",
      type: "dynamicLinear",
      boundaryConditions: ["fixedBase"],
      loads: ["uprightPush"],
      startTime: 0,
      endTime: 0.05,
      timeStep: 0.005,
      outputInterval: 0.01,
      loadProfile: "ramp",
      dampingRatio: 0.02
    }
  ]
};

export const phase1FixturePaths = {
  singleTetStatic: "fixtures/single-tet-static.json",
  twoTetStatic: "fixtures/two-tet-static.json",
  invalidConnectivity: "fixtures/invalid-connectivity.json"
} as const;
