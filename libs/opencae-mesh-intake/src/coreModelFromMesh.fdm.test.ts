import { describe, expect, test } from "vitest";
import { buildCoreModelFromCloudMesh } from "./coreModelFromMesh";
import type { CloudStudyLike, CoreVolumeMeshArtifact } from "./types";

const PRINT_PARAMETERS = {
  manufacturingProcessId: "fdm",
  infillDensity: 35,
  wallCount: 3,
  layerOrientation: "x"
};

describe("cloud-mesh FDM material resolution", () => {
  test("threads the governing axis through built-in material resolution", () => {
    const across = buildModel("mat-abs", "x");
    const within = buildModel("mat-abs", "y");

    expect(across.youngModulus).toBeLessThan(within.youngModulus);
    expect(across.yieldStrength).toBeLessThan(within.yieldStrength!);
    expect(across.density).toBe(within.density);
  });

  test("retains a partial custom FDM profile and honors its calibration", () => {
    const customMaterial = {
      id: "custom-fdm",
      name: "Custom FDM",
      type: "isotropicLinearElastic",
      youngModulus: 2_000_000_000,
      poissonRatio: 0.35,
      density: 1000,
      yieldStrength: 40_000_000,
      printProfile: {
        process: "FDM",
        inPlaneModulusFactor: 0.8,
        interlayerModulusFactor: 0.4,
        inPlaneStrengthFactor: 0.7,
        interlayerStrengthFactor: 0.3
      }
    };
    const across = buildModel("custom-fdm", "x", [customMaterial]);
    const within = buildModel("custom-fdm", "y", [customMaterial]);

    expect(across.youngModulus / within.youngModulus).toBeCloseTo(0.5);
    expect(across.yieldStrength! / within.yieldStrength!).toBeCloseTo(0.3 / 0.7);
    expect(across.density).toBe(within.density);
  });

  test("keeps a process-only custom profile instead of silently treating it as solid stock", () => {
    const processOnlyMaterial = {
      id: "process-only-fdm",
      name: "Process-only FDM",
      type: "isotropicLinearElastic",
      youngModulus: 2_000_000_000,
      poissonRatio: 0.35,
      density: 1000,
      yieldStrength: 40_000_000,
      printProfile: { process: "FDM" }
    };
    const printed = buildModel("process-only-fdm", "x", [processOnlyMaterial]);

    expect(printed.youngModulus).toBeLessThan(processOnlyMaterial.youngModulus);
    expect(printed.yieldStrength).toBeLessThan(processOnlyMaterial.yieldStrength);
    expect(printed.density).toBeLessThan(processOnlyMaterial.density);
  });
});

function buildModel(
  materialId: string,
  criticalLayerAxis: "x" | "y" | "z",
  materials?: Array<Record<string, unknown>>
) {
  const model = buildCoreModelFromCloudMesh({
    study: studyFixture(materialId),
    volumeMesh: volumeMeshFixture(),
    materials,
    analysisType: "static_stress",
    criticalLayerAxis
  });
  return model.materials[0]!;
}

function studyFixture(materialId: string): CloudStudyLike {
  return {
    id: "fdm-study",
    type: "static_stress",
    materialAssignments: [{ materialId, parameters: PRINT_PARAMETERS }],
    namedSelections: [
      { id: "FS1", name: "Fixed", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "fixed-face" }] },
      { id: "L1", name: "Load", entityType: "face", geometryRefs: [{ entityType: "face", entityId: "load-face" }] }
    ],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "FS1", parameters: {} }],
    loads: [{ id: "load", type: "force", selectionRef: "L1", parameters: { value: 100, units: "N", direction: [0, 0, -1] } }]
  };
}

function volumeMeshFixture(): CoreVolumeMeshArtifact {
  return {
    nodes: { coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    elements: [{ type: "Tet4", connectivity: [0, 1, 2, 3] }],
    surfaceFacets: [
      { id: 0, element: 0, elementFace: 3, nodes: [0, 2, 1], area: 0.5, normal: [0, 0, -1], center: [1 / 3, 1 / 3, 0], sourceSelectionRef: "FS1", sourceFaceId: "fixed-face" },
      { id: 1, element: 0, elementFace: 2, nodes: [0, 1, 3], area: 0.5, normal: [0, -1, 0], center: [1 / 3, 0, 1 / 3], sourceSelectionRef: "L1", sourceFaceId: "load-face" },
      { id: 2, element: 0, elementFace: 0, nodes: [1, 2, 3], area: 0.866, normal: [0.577, 0.577, 0.577], center: [1 / 3, 1 / 3, 1 / 3] },
      { id: 3, element: 0, elementFace: 1, nodes: [2, 0, 3], area: 0.5, normal: [-1, 0, 0], center: [0, 1 / 3, 1 / 3] }
    ],
    surfaceSets: [
      { name: "fixed", facets: [0] },
      { name: "load", facets: [1] },
      { name: "other", facets: [2, 3] }
    ],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    metadata: {
      source: "gmsh",
      nodeCount: 4,
      elementCount: 1,
      surfaceFacetCount: 4,
      physicalGroups: [],
      connectedComponentCount: 1,
      meshQuality: { minTetVolume: 1 / 6, maxTetVolume: 1 / 6, invertedElementCount: 0 },
      diagnostics: [],
      units: "m"
    }
  };
}
