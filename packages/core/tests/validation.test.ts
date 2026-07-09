import { describe, expect, test } from "vitest";
import type { BodyGravityLoadJson, DynamicLinearStepJson } from "../src/model-json";
import { preflightCoreModel, validateModelJson } from "../src/validation";
import { createSingleTetModel, createTwoTetModel } from "./fixtures";

describe("validateModelJson", () => {
  test("accepts a valid single-tet model", () => {
    expect(validateModelJson(createSingleTetModel())).toEqual({
      ok: true,
      errors: [],
      warnings: []
    });
  });

  test("accepts a valid two-tet model", () => {
    expect(validateModelJson(createTwoTetModel()).ok).toBe(true);
  });

  test("rejects invalid schema and schemaVersion", () => {
    const model = { ...createSingleTetModel(), schema: "wrong", schemaVersion: "9" };
    const report = validateModelJson(model);

    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toEqual([
      "invalid-schema",
      "invalid-schema-version"
    ]);
  });

  test("rejects invalid node coordinates", () => {
    const model = createSingleTetModel();
    model.nodes.coordinates = [0, 0, 0, Number.NaN];

    const report = validateModelJson(model);

    expect(report.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid-node-coordinate-length", "invalid-node-coordinate"])
    );
  });

  test("rejects invalid materials and duplicate material names", () => {
    const model = createSingleTetModel();
    model.materials = [
      {
        name: "steel",
        type: "isotropicLinearElastic",
        youngModulus: -1,
        poissonRatio: 0.5
      },
      {
        name: "steel",
        type: "isotropicLinearElastic",
        youngModulus: 1,
        poissonRatio: 0.3
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("invalid-young-modulus");
    expect(codes).toContain("invalid-poisson-ratio");
    expect(codes).toContain("duplicate-material-name");
  });

  test("rejects invalid Tet4 connectivity", () => {
    const model = createSingleTetModel();
    model.elementBlocks[0].connectivity = [0, 1, 1, 8, 2];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("invalid-connectivity-length");
    expect(codes).toContain("duplicate-tet-node");
    expect(codes).toContain("node-index-out-of-range");
  });

  test("rejects non-integer Tet4 connectivity and missing materials", () => {
    const model = createSingleTetModel();
    model.elementBlocks[0].material = "missing";
    model.elementBlocks[0].connectivity = [0, 1, 2, 1.5];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-material-reference");
    expect(codes).toContain("node-index-not-integer");
  });

  test("rejects invalid node sets and element sets", () => {
    const model = createSingleTetModel();
    model.nodeSets = [{ name: "badNodes", nodes: [0, 0, 99] }];
    model.elementSets = [{ name: "badElements", elements: [0, 0, 9] }];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("duplicate-node-set-index");
    expect(codes).toContain("node-set-index-out-of-range");
    expect(codes).toContain("duplicate-element-set-index");
    expect(codes).toContain("element-set-index-out-of-range");
  });

  test("rejects invalid boundary conditions", () => {
    const model = createSingleTetModel();
    model.boundaryConditions = [
      {
        name: "badFixed",
        type: "fixed",
        nodeSet: "missingNodes",
        components: ["x", "q"]
      },
      {
        name: "badValue",
        type: "prescribedDisplacement",
        nodeSet: "fixedNodes",
        component: "z",
        value: Number.POSITIVE_INFINITY
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-node-set-reference");
    expect(codes).toContain("invalid-component");
    expect(codes).toContain("invalid-prescribed-displacement-value");
  });

  test("accepts fixed boundary conditions that resolve nodes from a surface set", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 10,
          element: 0,
          elementFace: 3,
          nodes: [0, 2, 1],
          area: 0.5,
          normal: [0, 0, 1],
          center: [1 / 3, 1 / 3, 0]
        }
      ],
      surfaceSets: [{ name: "fixedFace", facets: [10] }],
      boundaryConditions: [
        {
          name: "fixedSupport",
          type: "fixed",
          surfaceSet: "fixedFace",
          components: ["x", "y", "z"]
        }
      ],
      steps: [
        {
          name: "loadStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport"],
          loads: ["tipLoad"]
        }
      ]
    };

    expect(validateModelJson(model).ok).toBe(true);
  });

  test("rejects fixed boundary conditions with both or neither nodeSet and surfaceSet", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 10,
          element: 0,
          elementFace: 3,
          nodes: [0, 2, 1],
          area: 0.5,
          normal: [0, 0, 1],
          center: [1 / 3, 1 / 3, 0]
        }
      ],
      surfaceSets: [{ name: "fixedFace", facets: [10] }],
      boundaryConditions: [
        {
          name: "badBoth",
          type: "fixed",
          nodeSet: "fixedNodes",
          surfaceSet: "fixedFace",
          components: ["x", "y", "z"]
        },
        {
          name: "badNeither",
          type: "fixed",
          components: ["x", "y", "z"]
        },
        {
          name: "badMissingSurface",
          type: "fixed",
          surfaceSet: "missingFace",
          components: ["x", "y", "z"]
        }
      ]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("exclusive-boundary-selection");
    expect(codes).toContain("missing-boundary-selection");
    expect(codes).toContain("missing-surface-set-reference");
  });

  test("rejects invalid loads", () => {
    const model = createSingleTetModel();
    model.loads = [
      {
        name: "badLoad",
        type: "nodalForce",
        nodeSet: "missingNodes",
        vector: [0, Number.NaN, 1]
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-node-set-reference");
    expect(codes).toContain("invalid-load-vector");
  });

  test("rejects invalid static step references", () => {
    const model = createSingleTetModel();
    model.steps = [
      {
        name: "badStep",
        type: "staticLinear",
        boundaryConditions: ["missingBc"],
        loads: ["missingLoad"]
      }
    ];

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("missing-boundary-condition-reference");
    expect(codes).toContain("missing-load-reference");
  });

  test("accepts v0.2.0 models with surface loads and dynamic steps", () => {
    const dynamicStep: DynamicLinearStepJson = {
      name: "transient",
      type: "dynamicLinear",
      boundaryConditions: ["fixedSupport"],
      loads: ["surfacePush", "pressurePush"],
      startTime: 0,
      endTime: 0.1,
      timeStep: 0.01,
      outputInterval: 0.02,
      loadProfile: "quasi_static",
      dampingRatio: 0.02
    };
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      materials: [
        {
          ...createSingleTetModel().materials[0],
          density: 7850
        }
      ],
      surfaceFacets: [
        {
          id: 10,
          element: 0,
          elementFace: 0,
          nodes: [1, 2, 3],
          area: Math.sqrt(3) / 2,
          normal: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
          center: [1 / 3, 1 / 3, 1 / 3],
          sourceFaceId: "base"
        }
      ],
      surfaceSets: [
        {
          name: "baseFace",
          facets: [10]
        }
      ],
      loads: [
        ...createSingleTetModel().loads,
        {
          name: "surfacePush",
          type: "surfaceForce",
          surfaceSet: "baseFace",
          totalForce: [0, 0, -25]
        },
        {
          name: "pressurePush",
          type: "pressure",
          surfaceSet: "baseFace",
          pressure: 100,
          direction: [0, 0, -1]
        }
      ],
      steps: [
        ...createSingleTetModel().steps,
        dynamicStep
      ],
      coordinateSystem: {
        solverUnits: "m-N-s-Pa",
        renderCoordinateSpace: "display_model"
      },
      meshProvenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "actual_volume_mesh"
      }
    };

    expect(validateModelJson(model).ok).toBe(true);
  });

  test("accepts a bodyGravity load referenced by a static step", () => {
    const gravity: BodyGravityLoadJson = {
      name: "gravity",
      type: "bodyGravity",
      acceleration: [0, 0, -9.81]
    };
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      loads: [gravity],
      steps: [
        {
          name: "gravityStep",
          type: "staticLinear",
          boundaryConditions: ["fixedSupport"],
          loads: ["gravity"]
        }
      ]
    };

    expect(validateModelJson(model).ok).toBe(true);
  });

  test("normalizes legacy v0.1.0 models while validation still accepts them", () => {
    const report = validateModelJson(createSingleTetModel());

    expect(report.ok).toBe(true);
  });

  test("accepts canonical half_sine dynamic load profiles", () => {
    const model = createSingleTetModel();
    model.materials = [{ ...model.materials[0], density: 7850 }];
    model.steps = [
      {
        name: "transient",
        type: "dynamicLinear",
        boundaryConditions: ["fixedSupport"],
        loads: ["tipLoad"],
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.01,
        outputInterval: 0.02,
        loadProfile: "half_sine"
      }
    ];

    const report = validateModelJson(model);

    expect(report.ok).toBe(true);
  });

  test("rejects empty node and surface sets", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      nodeSets: [{ name: "emptyNodes", nodes: [] }],
      surfaceFacets: [
        {
          id: 1,
          element: 0,
          elementFace: 0,
          nodes: [0, 1, 2]
        }
      ],
      surfaceSets: [{ name: "emptySurface", facets: [] }]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("empty-node-set");
    expect(codes).toContain("empty-surface-set");
  });

  test("rejects orphan surface facets and missing surface load references", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 1,
          element: 99,
          elementFace: 0,
          nodes: [0, 1, 2]
        }
      ],
      surfaceSets: [{ name: "badSurface", facets: [1, 2] }],
      loads: [
        {
          name: "badSurfaceForce",
          type: "surfaceForce",
          surfaceSet: "missingSurface",
          totalForce: [0, 0, -1]
        }
      ]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("surface-facet-element-out-of-range");
    expect(codes).toContain("surface-set-facet-missing");
    expect(codes).toContain("missing-surface-set-reference");
  });

  test("rejects surface facet node indices outside the mesh node range", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 1,
          element: 0,
          elementFace: 0,
          nodes: [0, 1, 99]
        }
      ]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("surface-facet-node-out-of-range");
  });

  test("rejects invalid dynamic step time ranges and intervals", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      materials: [
        {
          ...createSingleTetModel().materials[0],
          density: 7850
        }
      ],
      steps: [
        {
          name: "badTransient",
          type: "dynamicLinear",
          boundaryConditions: ["fixedSupport"],
          loads: ["tipLoad"],
          startTime: 1,
          endTime: 1,
          timeStep: 0,
          outputInterval: -1,
          loadProfile: "step"
        }
      ]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("invalid-dynamic-time-range");
    expect(codes).toContain("invalid-dynamic-time-step");
    expect(codes).toContain("invalid-dynamic-output-interval");
  });

  test("rejects invalid coordinate render spaces", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      coordinateSystem: {
        solverUnits: "m-N-s-Pa",
        renderCoordinateSpace: "cad"
      }
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("invalid-render-coordinate-space");
  });

  test("rejects disconnected bodies without mesh connection metadata", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      nodes: {
        coordinates: [
          ...createSingleTetModel().nodes.coordinates,
          10, 0, 0,
          11, 0, 0,
          10, 1, 0,
          10, 0, 1
        ]
      },
      elementBlocks: [
        {
          name: "solid",
          type: "Tet4",
          material: "steel",
          connectivity: [0, 1, 2, 3, 4, 5, 6, 7]
        }
      ],
      elementSets: [{ name: "allElements", elements: [0, 1] }]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("disconnected-bodies-without-connections");
  });

  test("accepts valid Tet10 connectivity but rejects invalid Tet10 connectivity length", () => {
    const tet10 = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      nodes: {
        coordinates: [
          ...createSingleTetModel().nodes.coordinates,
          0.5, 0, 0,
          0.5, 0.5, 0,
          0, 0.5, 0,
          0, 0, 0.5,
          0.5, 0, 0.5,
          0, 0.5, 0.5
        ]
      },
      elementBlocks: [
        {
          name: "tet10",
          type: "Tet10",
          material: "steel",
          connectivity: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        }
      ]
    };

    const invalidTet10 = {
      ...tet10,
      elementBlocks: [
        {
          name: "tet10",
          type: "Tet10",
          material: "steel",
          connectivity: [0, 1, 2, 3, 4, 5, 6, 7, 8]
        }
      ]
    };

    const unsupported = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      elementBlocks: [
        {
          name: "hex",
          type: "Hex8",
          material: "steel",
          connectivity: [0, 1, 2, 3, 0, 1, 2, 3]
        }
      ]
    };

    expect(validateModelJson(tet10).ok).toBe(true);
    expect(validateModelJson(invalidTet10).errors.map((issue) => issue.code)).toContain(
      "invalid-connectivity-length"
    );
    expect(validateModelJson(unsupported).errors.map((issue) => issue.code)).toContain(
      "unsupported-element-type"
    );
  });

  test("rejects production display proxy and dynamic models without density", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      meshProvenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-sparse-tet",
        resultSource: "computed",
        meshSource: "display_bounds_proxy"
      },
      steps: [
        {
          name: "transient",
          type: "dynamicLinear",
          boundaryConditions: ["fixedSupport"],
          loads: ["tipLoad"],
          startTime: 0,
          endTime: 0.1,
          timeStep: 0.01,
          outputInterval: 0.01,
          loadProfile: "ramp"
        }
      ]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("display-bounds-proxy-not-production");
    expect(codes).toContain("missing-dynamic-material-density");
  });

  test("rejects surface facets that do not match their referenced element face", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      surfaceFacets: [
        {
          id: 1,
          element: 0,
          elementFace: 0,
          nodes: [0, 1, 2]
        }
      ]
    };

    const codes = validateModelJson(model).errors.map((issue) => issue.code);

    expect(codes).toContain("surface-facet-node-not-on-element-face");
  });

  test("preflight reports topology, surface mapping, and force balance readiness", () => {
    const model = createSingleTetModel();
    const report = preflightCoreModel(model, { stepIndex: 0 });

    expect(report.ok).toBe(true);
    expect(report.diagnostics.connectedComponentCount).toBe(1);
    expect(report.diagnostics.orphanNodeCount).toBe(0);
    expect(report.diagnostics.surfaceFacetCount).toBeGreaterThan(0);
    expect(report.diagnostics.fixedNodeCount).toBeGreaterThan(0);
    expect(report.diagnostics.loadNodeCount).toBeGreaterThan(0);
    expect(report.diagnostics.totalLoadVectorN).toEqual([0, 0, -100]);
  });

  test("preflight rejects orphan nodes and missing production surface selections", () => {
    const model = {
      ...createSingleTetModel(),
      schemaVersion: "0.2.0",
      nodes: {
        coordinates: [...createSingleTetModel().nodes.coordinates, 9, 9, 9]
      },
      surfaceSets: [],
      loads: [
        {
          name: "tipLoad",
          type: "nodalForce",
          nodeSet: "freeNodes",
          vector: [0, 0, -100]
        }
      ]
    };

    const report = preflightCoreModel(model, { requireSurfaceSelections: true });

    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "orphan-nodes",
        "missing-support-surface-set",
        "missing-load-surface-set"
      ])
    );
  });
});
