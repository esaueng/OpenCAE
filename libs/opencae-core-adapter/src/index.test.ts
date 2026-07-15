import { describe, expect, test } from "vitest";
import { solverSurfaceMeshFromModel } from "@opencae/core";
import { solveCoreStatic } from "@opencae/solver-cpu";
import type { DisplayModel, Study } from "@opencae/schema";
import {
  autoSolverBackend,
  bracketMeshSizeMmForPreset,
  buildOpenCaeCoreModelForStudy,
  geometrySourceForStudy,
  displayDirectionToSolverFrame,
  explicitSolverBackend,
  openCaeCoreEligibility,
  resolveSolverBackend,
  studyForCoreGeometryDispatch,
  trySolveOpenCaeCoreStudy
} from "./index";

function studyFixture(overrides: Partial<Study> = {}): Study {
  return {
    id: "study-1",
    projectId: "project-1",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Cantilever" }],
    materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", parameters: {}, status: "complete" }],
    namedSelections: [
      {
        id: "selection-fixed-face",
        name: "Fixed end face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-base-left", label: "Fixed end face" }],
        fingerprint: "fixed-face"
      },
      {
        id: "selection-load-face",
        name: "Free end load face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load-top", label: "Free end load face" }],
        fingerprint: "load-face"
      }
    ],
    contacts: [],
    constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
    loads: [{ id: "load-1", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [0, 0, -1] }, status: "complete" }],
    meshSettings: { preset: "medium", status: "complete" },
    solverSettings: { backend: "opencae_core_local" },
    validation: [],
    runs: [],
    ...overrides
  } as Study;
}

function cantileverDisplayModel(): DisplayModel {
  return {
    id: "display-cantilever",
    name: "cantilever demo body",
    bodyCount: 1,
    dimensions: { x: 180, y: 24, z: 24, units: "mm" },
    faces: [
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], stressValue: 132 },
      { id: "face-load-top", label: "Free end load face", color: "#f59e0b", center: [1.9, 0.18, 0], normal: [1, 0, 0], stressValue: 96 },
      { id: "face-beam-top", label: "Top beam face", color: "#22c55e", center: [0, 0.42, 0], normal: [0, 1, 0], stressValue: 74 },
      { id: "face-base-bottom", label: "Beam bottom face", color: "#8b949e", center: [0, -0.08, 0], normal: [0, -1, 0], stressValue: 46 }
    ]
  };
}

function bracketDisplayModelFixture(): DisplayModel {
  return {
    id: "display-bracket",
    name: "bracket demo body",
    bodyCount: 1,
    dimensions: { x: 120, y: 88, z: 34, units: "mm" },
    faces: [
      { id: "face-base-left", label: "Base mounting holes", color: "#4da3ff", center: [0.65, 0.02, 0.58], normal: [0, 0, 1], stressValue: 36 },
      { id: "face-load-top", label: "Top load face", color: "#f59e0b", center: [-1.18, 2.53, 0], normal: [0, 1, 0], stressValue: 142 },
      { id: "face-web-front", label: "Gusset face", color: "#22c55e", center: [-0.38, 0.86, 0.42], normal: [0, 0, 1], stressValue: 96 }
    ]
  };
}

describe("bracket mesh preset sizing", () => {
  test("maps each mesh preset to a distinct gmsh characteristic size", () => {
    expect(bracketMeshSizeMmForPreset("coarse")).toBe(18);
    expect(bracketMeshSizeMmForPreset("medium")).toBe(12);
    expect(bracketMeshSizeMmForPreset("fine")).toBe(9);
    expect(bracketMeshSizeMmForPreset("ultra")).toBe(7);
    expect(new Set([
      bracketMeshSizeMmForPreset("coarse"),
      bracketMeshSizeMmForPreset("medium"),
      bracketMeshSizeMmForPreset("fine"),
      bracketMeshSizeMmForPreset("ultra")
    ]).size).toBe(4);
  });

  test("applies the study mesh preset to the procedural bracket descriptor", () => {
    const study = studyFixture({ meshSettings: { preset: "fine", status: "complete" } });
    const geometry = geometrySourceForStudy(study, bracketDisplayModelFixture());
    expect(geometry?.kind).toBe("sample_procedural");
    expect(geometry?.sampleId).toBe("bracket");
    expect(geometry?.descriptor?.meshSize).toBe(9);
  });

  test("overrides the static meshSize on explicit bracket geometry artifacts", () => {
    const study = studyFixture({ meshSettings: { preset: "ultra", status: "complete" } });
    const displayModel = {
      ...bracketDisplayModelFixture(),
      coreCloudGeometry: {
        kind: "sample_procedural",
        sampleId: "bracket",
        units: "mm",
        descriptor: { base: { length: 120, width: 34, height: 10 }, meshSize: 18 }
      }
    } as DisplayModel;
    const geometry = geometrySourceForStudy(study, displayModel);
    expect(geometry?.descriptor?.meshSize).toBe(7);
    expect(geometry?.descriptor?.base).toEqual({ length: 120, width: 34, height: 10 });
  });

  test("leaves non-bracket geometry descriptors untouched", () => {
    const study = studyFixture({ meshSettings: { preset: "ultra", status: "complete" } });
    const geometry = geometrySourceForStudy(study, cantileverDisplayModel());
    expect(geometry?.kind).toBe("structured_block");
    expect(geometry?.descriptor?.meshSize).toBeUndefined();
  });
});

describe("display to solver frame conversion", () => {
  test("rotates sample display directions into the upright solver frame", () => {
    const displayModel = cantileverDisplayModel();
    // Viewer "-Z" (down) is stored as display -Y and must become solver -Z (down).
    expect(displayDirectionToSolverFrame([0, -1, 0], displayModel)).toEqual([0, 0, -1]);
    // Viewer "+Y" (sideways) is stored as display -Z and must become solver +Y.
    expect(displayDirectionToSolverFrame([0, 0, -1], displayModel)).toEqual([0, 1, 0]);
    expect(displayDirectionToSolverFrame([1, 0, 0], displayModel)).toEqual([1, 0, 0]);
  });

  test("keeps uploaded geometry directions in file coordinates", () => {
    const uploaded: DisplayModel = {
      ...cantileverDisplayModel(),
      id: "display-uploaded",
      visualMesh: { format: "stl", filename: "part.stl", contentBase64: "" }
    };
    expect(displayDirectionToSolverFrame([0, -1, 0], uploaded)).toEqual([0, -1, 0]);
    expect(displayDirectionToSolverFrame([0, -1, 0], undefined)).toEqual([0, -1, 0]);
  });

  test("rewrites study load directions for cloud geometry dispatch", () => {
    const study = studyFixture({
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }]
    });
    const dispatched = studyForCoreGeometryDispatch(study, cantileverDisplayModel());
    expect(dispatched.loads[0]?.parameters.direction).toEqual([0, 0, -1]);
    expect(dispatched.loads[0]?.parameters.value).toBe(500);
    // The original study must stay in display space for the viewer and local solves.
    expect(study.loads[0]?.parameters.direction).toEqual([0, -1, 0]);
  });
});

describe("core cloud structured block model frame", () => {
  function downLoadedStudy(): Study {
    return studyFixture({
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }]
    });
  }

  test("builds the structured block mesh upright with solver-frame load vectors", () => {
    // Non-square section so a height/width axis swap cannot hide: display y (height)
    // is 24 mm and display z (width) is 36 mm.
    const displayModel: DisplayModel = {
      ...cantileverDisplayModel(),
      dimensions: { x: 180, y: 24, z: 36, units: "mm" }
    };
    const coreBuild = buildOpenCaeCoreModelForStudy(downLoadedStudy(), displayModel);
    const spans = coordinateSpans(coreBuild.model.nodes.coordinates);
    expect(spans.x).toBeCloseTo(0.18, 9);
    expect(spans.y).toBeCloseTo(0.036, 9);
    expect(spans.z).toBeCloseTo(0.024, 9);
    expect(coreBuild.model.coordinateSystem?.renderCoordinateSpace).toBe("solver");
    expect(coreBuild.meshSource).toBe("structured_block_core");

    const force = coreBuild.model.loads.find((load) => load.type === "surfaceForce");
    expect(force?.type === "surfaceForce" ? force.totalForce : undefined).toEqual([0, 0, -500]);
  });

  test("solves the cantilever with the tip deflecting along the applied -Z load", () => {
    const coreBuild = buildOpenCaeCoreModelForStudy(downLoadedStudy(), cantileverDisplayModel());
    const solved = solveCoreStatic(coreBuild.model, { method: "sparse", solverMode: "sparse" });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;

    const surfaceMesh = solved.result.surfaceMesh ?? solverSurfaceMeshFromModel(coreBuild.model);
    const displacement = solved.result.fields.find((field) => field.type === "displacement" && field.surfaceMeshRef === surfaceMesh.id);
    expect(displacement?.vectors?.length).toBe(surfaceMesh.nodes.length);

    const tipX = Math.max(...surfaceMesh.nodes.map((node) => node[0]));
    let tipY = 0;
    let tipZ = 0;
    let tipCount = 0;
    surfaceMesh.nodes.forEach((node, index) => {
      if (Math.abs(node[0] - tipX) > 1e-9) return;
      const vector = displacement?.vectors?.[index] ?? [0, 0, 0];
      tipY += vector[1];
      tipZ += vector[2];
      tipCount += 1;
    });
    expect(tipCount).toBeGreaterThan(0);
    const meanTipZ = tipZ / tipCount;
    const meanTipY = tipY / tipCount;
    // The free end must deflect downward (solver -Z), matching the viewer load arrow,
    // and must not bend sideways across the beam width.
    expect(meanTipZ).toBeLessThan(0);
    expect(Math.abs(meanTipZ)).toBeGreaterThan(Math.abs(meanTipY) * 10);
  });

  test("compares FDM build direction in the same global frame used by sample loads", () => {
    const displayModel: DisplayModel = {
      ...cantileverDisplayModel(),
      faces: [
        { id: "face-base-left", label: "Fixed face", color: "#4da3ff", center: [0, -1.9, 0], normal: [0, -1, 0], stressValue: 0 },
        { id: "face-load-top", label: "Load face", color: "#f59e0b", center: [0, 1.9, 0], normal: [0, 1, 0], stressValue: 0 }
      ]
    };
    const printedStudy = (layerOrientation: "y" | "z"): Study => studyFixture({
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [1, 0, 0] }, status: "complete" }],
      materialAssignments: [{
        id: "assign-1",
        materialId: "mat-pla",
        selectionRef: "selection-body-1",
        parameters: { manufacturingProcessId: "fdm", infillDensity: 100, wallCount: 3, layerOrientation },
        status: "complete"
      }]
    });

    const globalYBuild = buildOpenCaeCoreModelForStudy(printedStudy("y"), displayModel);
    const globalZBuild = buildOpenCaeCoreModelForStudy(printedStudy("z"), displayModel);

    // Raw sample-model Y becomes global Z after the legacy base rotation, so Z
    // must receive the interlayer penalty and Y remains an in-layer direction.
    expect(globalZBuild.model.materials[0]!.yieldStrength).toBeLessThan(globalYBuild.model.materials[0]!.yieldStrength!);
    expect(globalZBuild.model.materials[0]!.youngModulus).toBeLessThan(globalYBuild.model.materials[0]!.youngModulus);

    const rotatedDisplayModel = { ...displayModel, orientation: { x: 90, y: 0, z: 0 } };
    const rotatedGlobalYBuild = buildOpenCaeCoreModelForStudy(printedStudy("y"), rotatedDisplayModel);
    const rotatedGlobalZBuild = buildOpenCaeCoreModelForStudy(printedStudy("z"), rotatedDisplayModel);
    expect(rotatedGlobalYBuild.model.materials[0]!.yieldStrength).toBeLessThan(rotatedGlobalZBuild.model.materials[0]!.yieldStrength!);
    expect(rotatedGlobalYBuild.model.materials[0]!.youngModulus).toBeLessThan(rotatedGlobalZBuild.model.materials[0]!.youngModulus);
  });

  test("local solver-cpu builders emit render-ready surface node fields including safety factor", () => {
    // Parity with the cloud container: the same @opencae/solver-cpu builders back both, so a
    // local solveCoreStatic result must carry the surface mesh plus node-located
    // stress/displacement/safety-factor fields aligned 1:1 with surfaceMesh.nodes — the exact
    // contract the web surface render path (solverSurfaceResultFields) consumes.
    const coreBuild = buildOpenCaeCoreModelForStudy(downLoadedStudy(), cantileverDisplayModel());
    const solved = solveCoreStatic(coreBuild.model, { method: "sparse", solverMode: "sparse" });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;

    const surfaceMesh = solved.result.surfaceMesh ?? solverSurfaceMeshFromModel(coreBuild.model);
    for (const type of ["stress", "displacement", "safety_factor"] as const) {
      const field = solved.result.fields.find((candidate) => candidate.type === type && candidate.surfaceMeshRef === surfaceMesh.id);
      expect(field, `missing surface node field for ${type}`).toBeDefined();
      expect(field?.location).toBe("node");
      expect(field?.values.length).toBe(surfaceMesh.nodes.length);
    }
    const safetyField = solved.result.fields.find((candidate) => candidate.type === "safety_factor" && candidate.surfaceMeshRef === surfaceMesh.id);
    expect(safetyField?.id).toBe("safety-factor-surface");
    expect(safetyField?.units).toBe("ratio");
  });
});

describe("advanced load adapter contracts", () => {
  function withBodySelection(study: Study): Study {
    return {
      ...study,
      namedSelections: [{
        id: "selection-body-1",
        name: "Cantilever body",
        entityType: "body",
        geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Cantilever body" }],
        fingerprint: "body-1"
      }, ...study.namedSelections]
    };
  }

  test("maps traction and volume-force density into canonical solver units", () => {
    const study = withBodySelection(studyFixture({
      loads: [
        { id: "traction", type: "surface_traction", selectionRef: "selection-load-face", parameters: { value: 125, units: "kPa", direction: [0, -1, 0] }, status: "complete" },
        { id: "volume", type: "volume_force", selectionRef: "selection-body-1", parameters: { value: 2.5, units: "kN/m^3", direction: [0, -1, 0] }, status: "complete" }
      ]
    }));

    const model = buildOpenCaeCoreModelForStudy(study, cantileverDisplayModel()).model;
    const traction = model.loads.find((load) => load.type === "surfaceTraction");
    const volume = model.loads.find((load) => load.type === "bodyForceDensity");

    expect(traction).toMatchObject({ type: "surfaceTraction", traction: [0, 0, -125_000] });
    expect(volume).toMatchObject({ type: "bodyForceDensity", elementSet: "allElements", forceDensity: [0, 0, -2_500] });
  });

  test("maps remote force point and records distributed-wrench diagnostics", () => {
    const study = studyFixture({
      loads: [{
        id: "remote",
        type: "remote_force",
        selectionRef: "selection-load-face",
        parameters: { value: 200, units: "N", direction: [0, -1, 0], remotePoint: [2.4, 0.8, 0] },
        status: "complete"
      }]
    });

    const coreBuild = buildOpenCaeCoreModelForStudy(study, cantileverDisplayModel());
    const remote = coreBuild.model.loads.find((load) => load.type === "remoteForce");
    expect(remote).toMatchObject({ type: "remoteForce", totalForce: [0, 0, -200] });
    expect(remote?.type === "remoteForce" ? remote.remotePoint.every(Number.isFinite) : false).toBe(true);
    const solved = solveCoreStatic(coreBuild.model, { method: "sparse", solverMode: "sparse" });
    expect(solved.ok, solved.ok ? undefined : solved.error.message).toBe(true);
    if (!solved.ok) return;
    const loadAssembly = solved.diagnostics.loadAssembly;
    expect(loadAssembly?.perLoad[0]).toMatchObject({
      distribution: "area_weighted_minimum_norm",
      approximation: expect.stringMatching(/no rigid MPC coupling/i)
    });
    expect(loadAssembly?.perLoad[0]?.forceBalanceError).toBeLessThan(1e-9);
    expect(loadAssembly?.perLoad[0]?.momentBalanceError).toBeLessThan(1e-9);
  });

  test("maps a static equivalent preload and rejects it for dynamic studies", () => {
    const preload = {
      id: "preload",
      type: "bolt_preload" as const,
      selectionRef: "selection-fixed-face",
      parameters: { value: 1_200, units: "N", direction: [1, 0, 0], secondarySelectionRef: "selection-load-face" },
      status: "complete" as const
    };
    const staticStudy = studyFixture({ loads: [preload] });
    const model = buildOpenCaeCoreModelForStudy(staticStudy, cantileverDisplayModel()).model;
    expect(model.loads[0]).toMatchObject({
      type: "equivalentBoltPreload",
      axis: [1, 0, 0],
      preloadForce: 1_200
    });
    const dynamicStudy = studyFixture({
      name: "Dynamic",
      type: "dynamic_structural",
      loads: [preload],
      solverSettings: {
        backend: "opencae_core_local",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.01,
        outputInterval: 0.01,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    });
    expect(openCaeCoreEligibility(dynamicStudy, cantileverDisplayModel())).toEqual({
      ok: false,
      reason: "Equivalent bolt preload is supported for static studies only."
    });
  });
});

function coordinateSpans(coordinates: number[]): { x: number; y: number; z: number } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < coordinates.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, coordinates[index + axis] ?? 0);
      max[axis] = Math.max(max[axis]!, coordinates[index + axis] ?? 0);
    }
  }
  return { x: max[0]! - min[0]!, y: max[1]! - min[1]!, z: max[2]! - min[2]! };
}

describe("local core solve mesh statistics", () => {
  test("reports the actual solver mesh node and element counts as artifacts", () => {
    const solved = trySolveOpenCaeCoreStudy({
      study: studyFixture(),
      runId: "run-test",
      displayModel: cantileverDisplayModel()
    });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const stats = solved.result.artifacts?.meshStatistics;
    expect(stats).toBeDefined();
    expect(stats!.nodes).toBeGreaterThan(0);
    expect(stats!.elements).toBeGreaterThan(0);
    // Medium preset structured block proxy for this 180x24x24 mm cantilever:
    // 3 cells across the 24 mm minimum dimension (distinct coarse/medium/fine/ultra
    // densities {2,3,4,5}) gives a 23x3x3 grid elevated from Tet4 to Tet10 with
    // shared midside nodes: (2*23+1)*(2*3+1)*(2*3+1) = 2303 nodes.
    expect(stats!.nodes).toBe(2303);
    expect(stats!.elements).toBe(23 * 3 * 3 * 6);
    expect(stats!.totalDofs).toBe(stats!.nodes * 3);
    expect(stats!.freeDofs).toBeLessThan(stats!.totalDofs);
    expect(stats!.constrainedDofs).toBe(stats!.totalDofs - stats!.freeDofs);
    expect(stats!.representativeElementSizeMm).toBeGreaterThan(0);
  });
});

describe("load-case run variants", () => {
  test("ignores disabled empty cases without invalidating the enabled solve", () => {
    const study = studyFixture({
      loadCases: [
        { id: "service", name: "Service", enabled: true, loadIds: ["load-1"] },
        { id: "draft", name: "Draft", enabled: false, loadIds: [] }
      ],
      loadCombinations: []
    });

    const solved = trySolveOpenCaeCoreStudy({ study, runId: "run-disabled-case", displayModel: cantileverDisplayModel() });

    expect(solved.ok, solved.ok ? undefined : solved.reason).toBe(true);
    if (!solved.ok) return;
    expect(solved.result.variants?.map((variant) => variant.id)).toEqual(["case:service"]);
  });

  test("solves enabled cases and signed combinations, then creates a governing envelope", () => {
    const study = studyFixture({
      loads: [
        { id: "load-down", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" },
        { id: "load-side", type: "force", selectionRef: "selection-load-face", parameters: { value: 250, units: "N", direction: [0, 0, -1] }, status: "complete" }
      ],
      loadCases: [
        { id: "down", name: "Down", enabled: true, loadIds: ["load-down"] },
        { id: "side", name: "Side", enabled: true, loadIds: ["load-side"] }
      ],
      loadCombinations: [{
        id: "down-minus-side",
        name: "Down - 0.5 Side",
        enabled: true,
        factors: [{ caseId: "down", factor: 1 }, { caseId: "side", factor: -0.5 }]
      }]
    });
    const solved = trySolveOpenCaeCoreStudy({ study, runId: "run-cases", displayModel: cantileverDisplayModel() });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.result.variants?.map((variant) => [variant.id, variant.kind])).toEqual([
      ["case:down", "case"],
      ["case:side", "case"],
      ["combination:down-minus-side", "combination"],
      ["envelope", "envelope"]
    ]);
    expect(solved.result.activeVariantId).toBe("case:down");
    expect(solved.result.fields.every((field) => field.runId === "run-cases" && field.variantId === "case:down")).toBe(true);
    const envelope = solved.result.variants?.at(-1);
    expect(envelope?.governingVariantIndices?.variantIds).toEqual([
      "case:down",
      "case:side",
      "combination:down-minus-side"
    ]);
    expect(envelope?.governingVariantIndices?.stress.length).toBe(solved.result.surfaceMesh?.nodes.length);
    expect(envelope?.governingVariantIndices?.displacement.length).toBe(solved.result.surfaceMesh?.nodes.length);
  });

  test("streams dynamic cases separately and retains only the active transient payload", () => {
    const loads = [
      { id: "load-down", type: "force" as const, selectionRef: "selection-load-face", parameters: { value: 40, units: "N", direction: [0, -1, 0] }, status: "complete" as const },
      { id: "load-side", type: "force" as const, selectionRef: "selection-load-face", parameters: { value: 20, units: "N", direction: [0, 0, -1] }, status: "complete" as const }
    ];
    const study = studyFixture({
      name: "Dynamic cases",
      type: "dynamic_structural",
      loads,
      loadCases: [
        { id: "down", name: "Down", enabled: true, loadIds: ["load-down"] },
        { id: "side", name: "Side", enabled: true, loadIds: ["load-side"] }
      ],
      loadCombinations: [],
      meshSettings: {
        preset: "coarse",
        status: "complete",
        meshRef: "actual-core-model",
        summary: {
          nodes: 4,
          elements: 1,
          warnings: [],
          artifacts: { actualCoreModel: { model: actualCoreModelFixture() } }
        }
      },
      solverSettings: {
        backend: "opencae_core_local",
        startTime: 0,
        endTime: 0.01,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      }
    });
    const streamed: Array<{ id: string; frameCount: number }> = [];

    const solved = trySolveOpenCaeCoreStudy({
      study,
      runId: "run-dynamic-cases",
      displayModel: cantileverDisplayModel(),
      onVariantComplete: (variant) => streamed.push({
        id: variant.id,
        frameCount: variant.fields.filter((field) => field.type === "displacement").length
      })
    });

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(streamed.map((variant) => variant.id)).toEqual(["case:down", "case:side"]);
    expect(streamed.every((variant) => variant.frameCount === 3)).toBe(true);
    expect(solved.result.variants?.map((variant) => variant.id)).toEqual(["case:down"]);
    expect(solved.result.variantRefs).toEqual([
      { id: "case:down", name: "Down", kind: "case", caseId: "down", persistedSeparately: true },
      { id: "case:side", name: "Side", kind: "case", caseId: "side", persistedSeparately: true }
    ]);
    expect(solved.result.activeVariantId).toBe("case:down");
  });
});

describe("per-model solver backend resolution", () => {
  function autoStudy(overrides: Partial<Study> = {}): Study {
    return studyFixture({ solverSettings: {}, ...overrides });
  }

  function actualMeshSettings(): Study["meshSettings"] {
    return {
      preset: "medium",
      status: "complete",
      meshRef: "project-1/mesh/core-volume-model.json",
      summary: {
        nodes: 4,
        elements: 1,
        warnings: [],
        source: "actual_volume_mesh",
        artifacts: {
          meshConnectivity: { connectedComponents: 1 },
          actualCoreModel: { model: actualCoreModelFixture() }
        }
      }
    } as Study["meshSettings"];
  }

  test("treats unset, auto, legacy, retired-cloud, and unknown backend values as no explicit choice", () => {
    for (const backend of [undefined, "auto", "cloudflare_fea", "opencae_core", "local_detailed", "opencae_core_cloud", "mystery_backend"]) {
      const study = studyFixture({ solverSettings: { backend } as unknown as Study["solverSettings"] });
      expect(explicitSolverBackend(study), `backend=${String(backend)}`).toBeNull();
      expect(resolveSolverBackend(study, cantileverDisplayModel()).source, `backend=${String(backend)}`).toBe("auto");
    }
    expect(explicitSolverBackend({ solverSettings: { backend: "opencae_core_local" } })).toBe("opencae_core_local");
  });

  test("auto routes eligible simple block studies to the local browser backend", () => {
    const study = autoStudy();
    expect(openCaeCoreEligibility(study, cantileverDisplayModel()).ok).toBe(true);
    expect(resolveSolverBackend(study, cantileverDisplayModel())).toEqual({
      backend: "opencae_core_local",
      source: "auto"
    });
  });

  test("gates complex geometry without a mesh artifact on mesh-on-demand capability (A-M4/B4a)", () => {
    const study = autoStudy();
    // Routing is always local since B4a; honesty lives in eligibility. With
    // no mesh-on-demand capability (opt-out build / no Worker) the run must
    // fail with the actionable mesh-required reason, never estimate.
    const withoutCapability = openCaeCoreEligibility(study, bracketDisplayModelFixture());
    expect(withoutCapability.ok).toBe(false);
    if (!withoutCapability.ok) expect(withoutCapability.reason).toMatch(/needs a volume mesh/i);
    expect(resolveSolverBackend(study, bracketDisplayModelFixture())).toEqual({
      backend: "opencae_core_local",
      source: "auto"
    });
    // With in-browser wasm meshing available, the run meshes first and solves
    // locally — complex geometry without an artifact is fully runnable.
    expect(openCaeCoreEligibility(study, bracketDisplayModelFixture(), { canMeshOnDemand: true }).ok).toBe(true);
    expect(resolveSolverBackend(study, bracketDisplayModelFixture(), { canMeshOnDemand: true })).toEqual({
      backend: "opencae_core_local",
      source: "auto"
    });
  });

  test("auto routes complex geometry with an actual Core volume mesh artifact locally", () => {
    const study = autoStudy({ meshSettings: actualMeshSettings() });
    expect(openCaeCoreEligibility(study, bracketDisplayModelFixture()).ok).toBe(true);
    expect(resolveSolverBackend(study, bracketDisplayModelFixture())).toEqual({
      backend: "opencae_core_local",
      source: "auto"
    });
  });

  test("a material assigned after meshing rebinds the stored artifact's element blocks", () => {
    // The stored artifact was meshed while aluminum was assigned; the user then
    // assigns PETG with print settings. The run-time model must follow the
    // study's current material — a dangling mesh-time reference fails model
    // validation with "Element block material must reference an existing material."
    const study = autoStudy({
      meshSettings: actualMeshSettings(),
      materialAssignments: [{
        id: "assign-petg",
        materialId: "mat-petg",
        selectionRef: "selection-body-1",
        parameters: { printed: true, infillDensity: 40, wallCount: 3, layerOrientation: "z" },
        status: "complete"
      }]
    });
    const coreBuild = buildOpenCaeCoreModelForStudy(study, bracketDisplayModelFixture());
    expect(coreBuild.model.materials).toHaveLength(1);
    expect(coreBuild.model.materials[0]!.name).toBe("mat-petg");
    for (const block of coreBuild.model.elementBlocks) {
      expect(block.material).toBe("mat-petg");
    }
  });

  test("reuses stored physical surface mappings from pre-alias mesh artifacts", () => {
    const storedModel = actualCoreModelFixture();
    storedModel.surfaceFacets = storedModel.surfaceFacets.map(({ sourceSelectionRef: _selection, sourceFaceId: _face, ...facet }) => facet);
    storedModel.surfaceSets = [
      { name: "physical_support", facets: [0] },
      { name: "physical_load", facets: [1] }
    ];
    storedModel.nodeSets = [{ name: "physical_support_nodes", nodes: [0, 2, 3] }];
    storedModel.boundaryConditions = [{ name: "fixedSupport0", type: "fixed", nodeSet: "physical_support_nodes", components: ["x", "y", "z"] }];
    storedModel.loads = [{ name: "appliedForce0", type: "surfaceForce", surfaceSet: "physical_load", totalForce: [0, -500, 0] }];

    const study = studyFixture({
      namedSelections: [
        {
          id: "selection-step-face-3",
          name: "FS 1",
          entityType: "face",
          geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: "step-face-3", label: "STEP face 3" }],
          fingerprint: "step-face-3"
        },
        {
          id: "selection-step-face-7",
          name: "L 1",
          entityType: "face",
          geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: "step-face-7", label: "STEP face 7" }],
          fingerprint: "step-face-7"
        }
      ],
      constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-step-face-3", parameters: {}, status: "complete" }],
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-step-face-7", parameters: { value: 500, units: "N", direction: [0, 0, -1] }, status: "complete" }],
      meshSettings: {
        preset: "medium",
        status: "complete",
        meshRef: "actual-core-model",
        summary: {
          nodes: 4,
          elements: 1,
          warnings: [],
          source: "actual_volume_mesh",
          artifacts: {
            meshConnectivity: { connectedComponents: 1 },
            actualCoreModel: { model: storedModel }
          }
        }
      }
    });

    const rebuilt = buildOpenCaeCoreModelForStudy(study, cantileverDisplayModel());

    expect(rebuilt.model.boundaryConditions[0]).toMatchObject({ nodeSet: "fixedNodes0" });
    expect(rebuilt.model.loads[0]).toMatchObject({ type: "surfaceForce", surfaceSet: "physical_load" });
    expect(rebuilt.model.nodeSets.find((set) => set.name === "fixedNodes0")?.nodes).toEqual([0, 2, 3]);
  });

  test("builds and validates with a project custom material while rejecting unknown IDs", () => {
    const custom = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6,
      verification: "user_supplied_unverified" as const
    };
    const customStudy = studyFixture({
      materialAssignments: [{ ...studyFixture().materialAssignments[0]!, materialId: custom.id }]
    });
    const unknownStudy = studyFixture({
      materialAssignments: [{ ...studyFixture().materialAssignments[0]!, materialId: "deleted-custom-material" }]
    });

    expect(openCaeCoreEligibility(customStudy, cantileverDisplayModel(), undefined, [custom])).toEqual({ ok: true });
    const coreBuild = buildOpenCaeCoreModelForStudy(customStudy, cantileverDisplayModel(), [custom]);
    expect(coreBuild.model.materials[0]).toMatchObject({
      name: custom.id,
      youngModulus: custom.youngsModulus,
      density: custom.density
    });
    expect(openCaeCoreEligibility(unknownStudy, cantileverDisplayModel())).toEqual({ ok: false, reason: 'Unknown material "deleted-custom-material".' });
  });

  test("a retired explicit cloud choice resolves as auto local (old saves keep working)", () => {
    const study = studyFixture({ solverSettings: { backend: "opencae_core_cloud" } as unknown as Study["solverSettings"] });
    expect(openCaeCoreEligibility(study, cantileverDisplayModel()).ok).toBe(true);
    expect(resolveSolverBackend(study, cantileverDisplayModel())).toEqual({
      backend: "opencae_core_local",
      source: "auto"
    });
  });

  test("an explicit local choice keeps its honest hard error for ineligible models", () => {
    const study = studyFixture({ solverSettings: { backend: "opencae_core_local" } });
    expect(resolveSolverBackend(study, bracketDisplayModelFixture())).toEqual({
      backend: "opencae_core_local",
      source: "explicit"
    });
    const outcome = trySolveOpenCaeCoreStudy({ study, runId: "run-explicit-local", displayModel: bracketDisplayModelFixture() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Explicit local + ineligible must keep failing hard.");
    expect(outcome.reason).toMatch(/needs a volume mesh|in-browser meshing is unavailable/i);
  });

  test("autoSolverBackend is local for every study (single execution path since B4a)", () => {
    expect(autoSolverBackend(autoStudy(), cantileverDisplayModel())).toBe("opencae_core_local");
    expect(autoSolverBackend(autoStudy(), bracketDisplayModelFixture())).toBe("opencae_core_local");
  });
});

function actualCoreModelFixture() {
  return {
    schema: "opencae.model" as const,
    schemaVersion: "0.2.0" as const,
    nodes: { coordinates: [0, 0, 0, 0.04, 0, 0, 0, 0.04, 0, 0, 0, 0.04] },
    materials: [{
      name: "mat-aluminum-6061",
      type: "isotropicLinearElastic" as const,
      youngModulus: 68_900_000_000,
      poissonRatio: 0.33,
      yieldStrength: 276_000_000,
      density: 2700
    }],
    elementBlocks: [{ name: "actual-volume", type: "Tet4" as const, material: "mat-aluminum-6061", connectivity: [0, 1, 2, 3] }],
    surfaceFacets: [
      {
        id: 0,
        element: 0,
        elementFace: 1,
        nodes: [0, 3, 2],
        area: 0.0008,
        normal: [-1, 0, 0] as [number, number, number],
        center: [0, 0.04 / 3, 0.04 / 3] as [number, number, number],
        sourceSelectionRef: "selection-fixed-face",
        sourceFaceId: "face-base-left"
      },
      {
        id: 1,
        element: 0,
        elementFace: 0,
        nodes: [1, 2, 3],
        area: 0.0008 * Math.sqrt(3),
        normal: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)] as [number, number, number],
        center: [0.04 / 3, 0.04 / 3, 0.04 / 3] as [number, number, number],
        sourceSelectionRef: "selection-load-face",
        sourceFaceId: "face-load-top"
      }
    ],
    surfaceSets: [],
    nodeSets: [
      { name: "fixedNodes", nodes: [0, 1, 2] },
      { name: "loadNodes", nodes: [3] }
    ],
    elementSets: [{ name: "allElements", elements: [0] }],
    boundaryConditions: [{ name: "fixedSupport", type: "fixed" as const, nodeSet: "fixedNodes", components: ["x" as const, "y" as const, "z" as const] }],
    loads: [{ name: "appliedForce", type: "nodalForce" as const, nodeSet: "loadNodes", vector: [0, -500, 0] as [number, number, number] }],
    steps: [{ name: "loadStep", type: "staticLinear" as const, boundaryConditions: ["fixedSupport"], loads: ["appliedForce"] }],
    coordinateSystem: { solverUnits: "m-N-s-Pa" as const, renderCoordinateSpace: "solver" },
    meshProvenance: {
      kind: "opencae_core_fea" as const,
      solver: "opencae-core-sparse-tet",
      resultSource: "computed" as const,
      meshSource: "actual_volume_mesh"
    }
  };
}
