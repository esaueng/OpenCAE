import { describe, expect, test } from "vitest";
import type { DisplayModel, Study } from "@opencae/schema";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/db/sample-data";
import { validateModelJson } from "@opencae/core";
import {
  buildOpenCaeCoreModelForStudy,
  geometrySourceForStudy,
  hasActualCoreVolumeMesh,
  hasMeshableGeometrySource,
  isComplexGeometry,
  isSimpleBlockLikeDisplayModel,
  normalizeSolverBackend,
  OPENCAE_CORE_MESH_REQUIRED_REASON,
  openCaeCoreEligibility,
  studyForCoreGeometryDispatch,
  trySolveOpenCaeCoreStudy
} from "./opencaeCoreSolve";

const displayModel = {
  id: "display-cantilever",
  name: "Cantilever",
  bodyCount: 1,
  dimensions: { x: 100, y: 30, z: 10, units: "mm" },
  faces: [
    { id: "face-fixed", label: "Fixed", color: "#94a3b8", center: [0, 15, 5], normal: [-1, 0, 0], stressValue: 0 },
    { id: "face-load", label: "Load", color: "#94a3b8", center: [100, 15, 5], normal: [1, 0, 0], stressValue: 0 }
  ]
} satisfies DisplayModel;

const staticStudy = {
  id: "study-static",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
  materialAssignments: [{ id: "mat-assignment", materialId: "mat-aluminum-6061", selectionRef: "selection-body", parameters: {}, status: "complete" }],
  namedSelections: [
    {
      id: "selection-body",
      name: "Body",
      entityType: "body",
      geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
      fingerprint: "body"
    },
    {
      id: "selection-fixed",
      name: "Fixed face",
      entityType: "face",
      geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-fixed", label: "Fixed" }],
      fingerprint: "face-fixed"
    },
    {
      id: "selection-load",
      name: "Load face",
      entityType: "face",
      geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load", label: "Load" }],
      fingerprint: "face-load"
    }
  ],
  contacts: [],
  constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
  loads: [{ id: "load-force", type: "force", selectionRef: "selection-load", parameters: { value: 100, units: "N", direction: [0, 0, -1] }, status: "complete" }],
  meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
  solverSettings: { backend: "opencae_core_local", fidelity: "standard" },
  validation: [],
  runs: []
} satisfies Study;

describe("OpenCAE Core browser solver adapter", () => {
  test("normalizes every backend selection to the local browser solver (cloud retired)", () => {
    expect(normalizeSolverBackend({ solverSettings: { backend: "cloudflare_fea" } })).toBe("opencae_core_local");
    expect(normalizeSolverBackend({ solverSettings: { backend: "opencae_core" } })).toBe("opencae_core_local");
    expect(normalizeSolverBackend({ solverSettings: { backend: "opencae_core_cloud" } })).toBe("opencae_core_local");
    expect(normalizeSolverBackend({ solverSettings: { backend: "opencae_core_local" } })).toBe("opencae_core_local");
    expect(normalizeSolverBackend({ solverSettings: {} })).toBe("opencae_core_local");
    expect(normalizeSolverBackend(undefined)).toBe("opencae_core_local");
  });

  test("accepts static force studies with usable block dimensions", () => {
    const eligibility = openCaeCoreEligibility(staticStudy, displayModel);

    expect(eligibility).toEqual({ ok: true });
  });

  test("rejects the Bracket Demo without an actual Core volume mesh", () => {
    const bracketStudy = bracketDemoProject.studies[0]!;
    const eligibility = openCaeCoreEligibility(bracketStudy, bracketDisplayModel);

    expect(isSimpleBlockLikeDisplayModel(bracketDisplayModel)).toBe(false);
    expect(isComplexGeometry(bracketDisplayModel, bracketStudy)).toBe(true);
    expect(hasActualCoreVolumeMesh(bracketStudy, bracketDisplayModel)).toBe(false);
    expect(eligibility.ok).toBe(false);
    if (eligibility.ok) throw new Error("Bracket should not be Core-preview eligible.");
    expect(eligibility.reason).toMatch(/needs a volume mesh|in-browser meshing is unavailable/i);
  });

  test("treats the Bracket Demo as cloud-meshable without an actual Core volume mesh", () => {
    const bracketStudy = bracketDemoProject.studies[0]!;
    const geometry = geometrySourceForStudy(bracketStudy, bracketDisplayModel);

    expect(hasActualCoreVolumeMesh(bracketStudy, bracketDisplayModel)).toBe(false);
    expect(hasMeshableGeometrySource(bracketStudy, bracketDisplayModel)).toBe(true);
    expect(geometry).toMatchObject({
      kind: "sample_procedural",
      sampleId: "bracket",
      units: "mm",
      descriptor: expect.objectContaining({
        base: expect.any(Object),
        upright: expect.any(Object),
        gusset: expect.any(Object),
        holes: expect.any(Array),
        surfaces: expect.any(Object)
      })
    });
  });

  test("solves eligible static studies through the production Core pipeline", { timeout: 60000 }, () => {
    const outcome = trySolveOpenCaeCoreStudy({ study: staticStudy, runId: "run-core-1", displayModel });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");
    // Cloud-parity contract: same provenance stamp as the deployed runner,
    // with a browser runnerVersion (honest about where it was computed).
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      meshSource: "structured_block_core",
      resultSource: "computed",
      units: "mm-N-s-MPa",
      runnerVersion: "browser-0.1.0"
    });
    expect(outcome.result.summary.maxStress).toBeGreaterThan(0);
    expect(outcome.result.summary.maxDisplacement).toBeGreaterThan(0);
    expect(outcome.result.fields.map((field) => field.id).sort()).toEqual([
      "displacement-surface",
      "safety-factor",
      "safety-factor-surface",
      "stress-surface",
      "stress-von-mises-element"
    ]);
    const surfaceMesh = outcome.result.surfaceMesh as { id: string; nodes: unknown[] };
    expect(surfaceMesh.id).toBe("solver-surface");
    const displacement = outcome.result.fields.find((field) => field.id === "displacement-surface");
    expect(displacement?.location).toBe("node");
    expect(displacement?.values.length).toBe(surfaceMesh.nodes.length);
    expect(displacement?.vectors?.length).toBe(surfaceMesh.nodes.length);
    expect(outcome.result.diagnostics?.some((entry) => (entry as { id?: unknown })?.id === "browser-solve-limits")).toBe(true);
  });

  test("solves dynamic studies with OpenCAE Core transient fields", { timeout: 120000 }, () => {
    const dynamicStudy = {
      ...staticStudy,
      // Coarse preset: the medium-density transient ran ~97 s on CI runners
      // (~26 s locally) and tripped the 60 s timeout; the assertions below
      // check contract/provenance, not mesh density.
      meshSettings: { preset: "coarse", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core_local",
        fidelity: "standard",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "ramp"
      },
      loads: [{ id: "load-force", type: "force", selectionRef: "selection-load", parameters: { value: 500, units: "N", direction: [0, 0, -1] }, status: "complete" }]
    } satisfies Study;

    const eligibility = openCaeCoreEligibility(dynamicStudy, displayModel);
    const outcome = trySolveOpenCaeCoreStudy({ study: dynamicStudy, runId: "run-core-dynamic-1", displayModel });

    expect(eligibility).toEqual({ ok: true });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.ok).toBe(true);
    expect(outcome.solverBackend).toBe("opencae-core-mdof-tet");
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      meshSource: "structured_block_core",
      resultSource: "computed",
      runnerVersion: "browser-0.1.0"
    });
    expect(outcome.result.summary.transient?.frameCount).toBeGreaterThan(1);
    expect(outcome.result.summary.transient?.integrationMethod).toBe("newmark_average_acceleration");
    expect(Number.isFinite(outcome.result.summary.maxDisplacement)).toBe(true);
    expect(outcome.result.fields.some((field) => field.type === "displacement" && field.frameIndex === 1)).toBe(true);
    expect(outcome.result.fields.some((field) => field.type === "velocity")).toBe(true);
    expect(outcome.result.fields.some((field) => field.type === "acceleration")).toBe(true);
  });

  test("allows complex geometry only when an actual connected Core volume mesh artifact is present", () => {
    const actualMeshStudy = {
      ...bracketDemoProject.studies[0]!,
      meshSettings: {
        preset: "medium",
        status: "complete",
        meshRef: "project-bracket-demo/mesh/core-volume-model.json",
        summary: {
          nodes: 4,
          elements: 1,
          warnings: [],
          source: "actual_volume_mesh",
          artifacts: {
            meshConnectivity: { connectedComponents: 1 },
            actualCoreModel: {
              model: actualCoreModelFixture()
            }
          }
        }
      }
    } satisfies Study;

    expect(hasActualCoreVolumeMesh(actualMeshStudy, bracketDisplayModel)).toBe(true);
    expect(openCaeCoreEligibility(actualMeshStudy, bracketDisplayModel)).toEqual({ ok: true });

    const outcome = trySolveOpenCaeCoreStudy({ study: actualMeshStudy, runId: "run-actual-core", displayModel: bracketDisplayModel });

    expect(outcome.ok, outcome.ok ? undefined : outcome.reason).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");
    expect(outcome.result.summary.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      meshSource: "actual_volume_mesh",
      resultSource: "computed",
      runnerVersion: "browser-0.1.0"
    });
    expect(outcome.result.artifacts?.meshConnectivity?.connectedComponents).toBe(1);
  });

  test("builds a valid v0.2 Core Cloud model for a simple block study", () => {
    const result = buildOpenCaeCoreModelForStudy(staticStudy, displayModel);

    expect(result.model.schemaVersion).toBe("0.2.0");
    expect(validateModelJson(result.model).ok).toBe(true);
    expect(result.model.meshProvenance?.meshSource).toBe("structured_block_core");
    expect(result.model.surfaceFacets?.length).toBeGreaterThan(0);
    expect(result.model.surfaceSets?.map((set) => set.name)).toEqual(expect.arrayContaining(["selection-fixed", "selection-load"]));
    expect(result.model.boundaryConditions[0]).toMatchObject({ type: "fixed", nodeSet: "fixedNodes0" });
    // Display-space -Z (front) rotates into the upright solver frame as +Y.
    expect(result.model.loads[0]).toMatchObject({ type: "surfaceForce", surfaceSet: "selection-load", totalForce: [0, 100, 0] });
    expect(result.model.coordinateSystem?.renderCoordinateSpace).toBe("solver");
    expect(result.model.materials[0]).toMatchObject({ density: 2700, yieldStrength: 276000000 });
  });

  test("builds a valid dynamic Core Cloud model with dynamic solver settings", () => {
    const dynamicStudy = {
      ...staticStudy,
      type: "dynamic_structural",
      solverSettings: {
        backend: "opencae_core_local",
        fidelity: "standard",
        startTime: 0,
        endTime: 0.25,
        timeStep: 0.002,
        outputInterval: 0.01,
        dampingRatio: 0.04,
        integrationMethod: "newmark_average_acceleration",
        loadProfile: "sinusoidal"
      }
    } satisfies Study;

    const result = buildOpenCaeCoreModelForStudy(dynamicStudy, displayModel);

    expect(validateModelJson(result.model).ok).toBe(true);
    expect(result.model.steps[0]).toMatchObject({
      type: "dynamicLinear",
      startTime: 0,
      endTime: 0.25,
      timeStep: 0.002,
      outputInterval: 0.01,
      dampingRatio: 0.04,
      loadProfile: "sinusoidal"
    });
  });

  test("converts pressure loads to Core pressure loads", () => {
    const pressureStudy = {
      ...staticStudy,
      loads: [{ id: "load-pressure", type: "pressure", selectionRef: "selection-load", parameters: { value: 12, units: "kPa", direction: [0, 0, -1] }, status: "complete" }]
    } satisfies Study;

    const result = buildOpenCaeCoreModelForStudy(pressureStudy, displayModel);

    expect(validateModelJson(result.model).ok).toBe(true);
    expect(result.model.loads[0]).toMatchObject({ type: "pressure", surfaceSet: "selection-load", pressure: 12000, direction: [0, 1, 0] });
  });

  test("converts payload gravity loads to equivalent Core surface force loads", () => {
    const payloadStudy = {
      ...staticStudy,
      loads: [{
        id: "load-payload",
        type: "gravity",
        selectionRef: "selection-load",
        parameters: { value: 2.5, units: "kg", direction: [0, -1, 0], payloadMassMode: "manual" },
        status: "complete"
      }]
    } satisfies Study;

    const result = buildOpenCaeCoreModelForStudy(payloadStudy, displayModel);

    expect(validateModelJson(result.model).ok).toBe(true);
    // Display-space -Y (down) gravity rotates into the upright solver frame as -Z.
    expect(result.model.loads[0]).toMatchObject({ type: "surfaceForce", surfaceSet: "selection-load", totalForce: [0, 0, -24.516625] });
  });

  test("applies effective printed material properties to the Core material", () => {
    const printedStudy = {
      ...staticStudy,
      materialAssignments: [{ id: "mat-assignment", materialId: "mat-pla", selectionRef: "selection-body", parameters: { printed: true, infillDensity: 50, wallCount: 2, layerOrientation: "z" }, status: "complete" }]
    } satisfies Study;

    const result = buildOpenCaeCoreModelForStudy(printedStudy, displayModel);

    expect(validateModelJson(result.model).ok).toBe(true);
    expect(result.model.materials[0]?.density).toBeGreaterThan(0);
    expect(result.model.materials[0]?.density).toBeLessThan(1240);
    expect(result.model.materials[0]?.yieldStrength).toBeLessThan(60000000);
  });

  test("uses display-face identifiers when applying the critical FDM layer penalty", () => {
    const printedStudy = {
      ...staticStudy,
      materialAssignments: [{
        id: "mat-assignment",
        materialId: "mat-pla",
        selectionRef: "selection-body",
        parameters: { manufacturingProcessId: "fdm", infillDensity: 100, wallCount: 3, layerOrientation: "x" },
        status: "complete"
      }]
    } satisfies Study;

    const result = buildOpenCaeCoreModelForStudy(printedStudy, displayModel);

    expect(result.model.materials[0]?.yieldStrength).toBeCloseTo(60_000_000 * 0.35);
  });

  test("does not build a local Core Cloud model for bracket geometry that should be meshed in the container", () => {
    expect(() => buildOpenCaeCoreModelForStudy(bracketDemoProject.studies[0]!, bracketDisplayModel)).toThrow(/must be meshed into a Core volume mesh before solving/i);
  });

  test("fails complex Core Cloud model building when no geometry source exists", () => {
    const complexDisplayModel = {
      ...displayModel,
      id: "display-complex-casting",
      name: "complex casting",
      faces: Array.from({ length: 8 }, (_value, index) => ({
        id: `face-complex-${index}`,
        label: `Casting face ${index}`,
        color: "#94a3b8",
        center: [index, 0, 0] as [number, number, number],
        normal: [1, 0, 0] as [number, number, number],
        stressValue: 0
      }))
    } satisfies DisplayModel;

    expect(isComplexGeometry(complexDisplayModel, staticStudy)).toBe(true);
    expect(hasMeshableGeometrySource(staticStudy, complexDisplayModel)).toBe(false);
    expect(() => buildOpenCaeCoreModelForStudy(staticStudy, complexDisplayModel)).toThrow(OPENCAE_CORE_MESH_REQUIRED_REASON);
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
    // Real actual-mesh artifacts carry the boundary facets tagged with the
    // selections that produced them; the cloud model builder maps study
    // constraints/loads onto these surface sets.
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

// Ported from the retired api.cloudSolveRequest.test.ts (B4a): the solver-frame
// dispatch physics guard. The wasm meshing path hands the mirrored Core model
// builder a solver-frame study (studyForCoreGeometryDispatch), so the seeded
// display-frame load direction must remap and the source study must not mutate.
describe("solver-frame geometry dispatch (ported cloud-solve request physics)", () => {
  const seededBracketStudy = bracketDemoProject.studies[0]! as Study;

  test("remaps stored sample load directions into the solver global frame", () => {
    const prepared = studyForCoreGeometryDispatch(seededBracketStudy, bracketDisplayModel);

    // Seeded "Global -Z" load is stored viewer-down [0, -1, 0]; the mesher
    // builds the bracket Z-up, so the solver-frame study must carry [0, 0, -1].
    expect(seededBracketStudy.loads[0]!.parameters.direction).toEqual([0, -1, 0]);
    expect(prepared.loads[0]!.parameters.direction).toEqual([0, 0, -1]);
  });

  test("does not mutate the source study", () => {
    const direction = seededBracketStudy.loads[0]!.parameters.direction;
    studyForCoreGeometryDispatch(seededBracketStudy, bracketDisplayModel);
    expect(seededBracketStudy.loads[0]!.parameters.direction).toBe(direction);
  });
});
