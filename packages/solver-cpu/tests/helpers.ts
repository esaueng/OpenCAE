import {
  extractBoundarySurfaceFacets,
  nodeSetFromSurfaceSet,
  type OpenCAEModelJson,
  type SurfaceFacetJson,
  type SurfaceSetJson
} from "@opencae/core";

export const HEX_TETS = [
  0, 1, 3, 4,
  1, 2, 3, 6,
  1, 3, 4, 6,
  1, 4, 5, 6,
  3, 4, 6, 7
];

export function createHexBarModel(options: {
  length: number;
  youngModulus: number;
  density?: number;
  fixedLeftFace?: boolean;
  loads: OpenCAEModelJson["loads"];
  stepType: "staticLinear" | "dynamicLinear";
}): OpenCAEModelJson {
  const coordinates = [
    0, 0, 0,
    options.length, 0, 0,
    options.length, 1, 0,
    0, 1, 0,
    0, 0, 1,
    options.length, 0, 1,
    options.length, 1, 1,
    0, 1, 1
  ];
  const base: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [
      {
        name: "benchmark",
        type: "isotropicLinearElastic",
        youngModulus: options.youngModulus,
        poissonRatio: 0,
        density: options.density ?? 1,
        yieldStrength: 1e9
      }
    ],
    elementBlocks: [{ name: "hex-tet", type: "Tet4", material: "benchmark", connectivity: HEX_TETS }],
    nodeSets: [],
    elementSets: [{ name: "all", elements: [0, 1, 2, 3, 4] }],
    boundaryConditions: [],
    loads: options.loads,
    steps: []
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base);
  const leftFace = surfaceSetByX("leftFace", surfaceFacets, coordinates, 0);
  const rightFace = surfaceSetByX("rightFace", surfaceFacets, coordinates, options.length);
  const leftNodes = nodeSetFromSurfaceSet(leftFace, surfaceFacets);
  const rightNodes = nodeSetFromSurfaceSet(rightFace, surfaceFacets);
  const supportConditions: OpenCAEModelJson["boundaryConditions"] = options.fixedLeftFace
    ? [{ name: "fixedLeft", type: "fixed", nodeSet: "leftNodes", components: ["x", "y", "z"] }]
    : [
        { name: "leftX", type: "fixed", nodeSet: "leftNodes", components: ["x"] },
        { name: "pinYZ", type: "fixed", nodeSet: "pinNode", components: ["y", "z"] },
        { name: "rollerZ", type: "fixed", nodeSet: "rollerNode", components: ["z"] }
      ];

  return {
    ...base,
    surfaceFacets,
    surfaceSets: [leftFace, rightFace],
    nodeSets: [
      { name: "leftNodes", nodes: leftNodes },
      { name: "rightNodes", nodes: rightNodes },
      { name: "pinNode", nodes: [0] },
      { name: "rollerNode", nodes: [3] }
    ],
    boundaryConditions: supportConditions,
    steps: [
      options.stepType === "staticLinear"
        ? { name: "loadStep", type: "staticLinear", boundaryConditions: supportConditions.map((bc) => bc.name), loads: options.loads.map((load) => load.name) }
        : {
            name: "loadStep",
            type: "dynamicLinear",
            boundaryConditions: supportConditions.map((bc) => bc.name),
            loads: options.loads.map((load) => load.name),
            startTime: 0,
            endTime: 0.04,
            timeStep: 0.005,
            outputInterval: 0.01,
            loadProfile: "ramp",
            dampingRatio: 0.02
          }
    ]
  };
}

export function dynamicLoadedModel(loadProfile: "ramp" | "step" | "half_sine"): OpenCAEModelJson {
  const model = createHexBarModel({
    length: 1,
    youngModulus: 1000,
    loads: [{ name: "axialLoad", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [100, 0, 0] }],
    stepType: "dynamicLinear"
  });
  return {
    ...model,
    steps: model.steps.map((step) => (step.type === "dynamicLinear" ? { ...step, loadProfile } : step))
  };
}

export function createStructuredCantileverModel(options: {
  length: number;
  width: number;
  height: number;
  force: number;
  xDivisions: number;
  yDivisions: number;
  zDivisions: number;
}): OpenCAEModelJson {
  const coordinates: number[] = [];
  const nodeIndex = (i: number, j: number, k: number) =>
    i * (options.yDivisions + 1) * (options.zDivisions + 1) + j * (options.zDivisions + 1) + k;
  for (let i = 0; i <= options.xDivisions; i += 1) {
    const x = (options.length * i) / options.xDivisions;
    for (let j = 0; j <= options.yDivisions; j += 1) {
      const y = -options.width / 2 + (options.width * j) / options.yDivisions;
      for (let k = 0; k <= options.zDivisions; k += 1) {
        const z = -options.height / 2 + (options.height * k) / options.zDivisions;
        coordinates.push(x, y, z);
      }
    }
  }

  const connectivity: number[] = [];
  for (let i = 0; i < options.xDivisions; i += 1) {
    for (let j = 0; j < options.yDivisions; j += 1) {
      for (let k = 0; k < options.zDivisions; k += 1) {
        const cube = [
          nodeIndex(i, j, k),
          nodeIndex(i + 1, j, k),
          nodeIndex(i + 1, j + 1, k),
          nodeIndex(i, j + 1, k),
          nodeIndex(i, j, k + 1),
          nodeIndex(i + 1, j, k + 1),
          nodeIndex(i + 1, j + 1, k + 1),
          nodeIndex(i, j + 1, k + 1)
        ];
        for (let offset = 0; offset < HEX_TETS.length; offset += 4) {
          connectivity.push(
            cube[HEX_TETS[offset]!]!,
            cube[HEX_TETS[offset + 1]!]!,
            cube[HEX_TETS[offset + 2]!]!,
            cube[HEX_TETS[offset + 3]!]!
          );
        }
      }
    }
  }

  const base: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: { coordinates },
    materials: [
      {
        name: "Aluminum 6061",
        type: "isotropicLinearElastic",
        youngModulus: 68_900_000_000,
        poissonRatio: 0.33,
        density: 2700,
        yieldStrength: 276_000_000
      }
    ],
    elementBlocks: [{ name: "cantilever", type: "Tet4", material: "Aluminum 6061", connectivity }],
    nodeSets: [],
    elementSets: [{ name: "all", elements: Array.from({ length: connectivity.length / 4 }, (_value, index) => index) }],
    boundaryConditions: [],
    loads: [],
    steps: [],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "actual_volume_mesh"
    }
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base);
  const fixedFace = surfaceSetByX("fixedFace", surfaceFacets, coordinates, 0);
  const tipFace = surfaceSetByX("tipFace", surfaceFacets, coordinates, options.length);
  return {
    ...base,
    surfaceFacets,
    surfaceSets: [fixedFace, tipFace],
    nodeSets: [
      { name: "fixedNodes", nodes: nodeSetFromSurfaceSet(fixedFace, surfaceFacets) },
      { name: "tipNodes", nodes: nodeSetFromSurfaceSet(tipFace, surfaceFacets) }
    ],
    boundaryConditions: [{ name: "fixedSupport", type: "fixed", nodeSet: "fixedNodes", components: ["x", "y", "z"] }],
    loads: [{ name: "tipLoad", type: "surfaceForce", surfaceSet: "tipFace", totalForce: [0, 0, -options.force] }],
    steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: ["fixedSupport"], loads: ["tipLoad"] }]
  };
}

export function surfaceSetByX(name: string, facets: SurfaceFacetJson[], coordinates: number[], x: number): SurfaceSetJson {
  return {
    name,
    facets: facets
      .filter((facet) => facet.nodes.every((node) => Math.abs(coordinates[node * 3] - x) < 1e-12))
      .map((facet) => facet.id)
  };
}
