import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  deriveFixedSupportNodeSetFromSurface,
  elevateTet4MeshToTet10,
  volumeMeshToModelJson,
  type OpenCAEModelJson
} from "@opencae/core";
import {
  boundedSolverSettings,
  BROWSER_SOLVE_LIMITS,
  CLOUD_SOLVER_LIMITS,
  DEFAULT_DYNAMIC_MS_PER_STEP,
  dynamicIntegrationSteps,
  estimateDynamicRuntime,
  solveStudyModelWithCorePipeline,
  type SolveProgressEvent
} from "./index";

const FIXTURE_DIR = resolve(__dirname, "../../../apps/opencae-web/src/testdata/core-cloud-golden");

function fixtureModel(name: string): OpenCAEModelJson {
  const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf8")) as {
    response: { artifacts: { generatedCoreModel: OpenCAEModelJson } };
  };
  return structuredClone(fixture.response.artifacts.generatedCoreModel);
}

describe("browser solve limits", () => {
  test("browser limits deviate from cloud limits only where documented", () => {
    // maxDofs matches the retired cloud runner's 100k since 2026-07 (typed-array
    // CSR assembly in the pinned solver + measured Chrome/WebKit runs at ~99.3k
    // DOF via scripts/verify-100k-solve.mjs).
    expect(BROWSER_SOLVE_LIMITS.maxDofs).toBe(100000);
    expect(BROWSER_SOLVE_LIMITS).toEqual({
      ...CLOUD_SOLVER_LIMITS,
      transientFieldBytes: 256e6,
      maxTimeSteps: 20000
    });
  });

  test("running under browser limits surfaces the deviation in diagnostics", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress",
      limits: BROWSER_SOLVE_LIMITS
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const deviation = outcome.result.diagnostics.find(
      (entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === "browser-solve-limits"
    ) as { deviations?: Record<string, { applied: number; cloud: number }> } | undefined;
    expect(deviation).toBeDefined();
    // maxDofs no longer deviates from the cloud limits; claiming it did would
    // be dishonest diagnostics.
    expect(deviation?.deviations).toEqual({
      transientFieldBytes: { applied: 256e6, cloud: 1.5e9 },
      maxTimeSteps: { applied: 20000, cloud: 100000 }
    });
  });

  test("solver settings cannot raise maxDofs above the browser limit", () => {
    const settings = boundedSolverSettings("static_stress", { maxDofs: 250000 }, fixtureModel("beam-static"), BROWSER_SOLVE_LIMITS);
    expect(settings.maxDofs).toBe(100000);
  });

  test("threads the 100k browser limit and bounded mode count into modal solves", () => {
    const dynamic = fixtureModel("beam-dynamic");
    const step = dynamic.steps[0];
    if (!step || step.type !== "dynamicLinear") throw new Error("Expected the dynamic golden fixture.");
    const model: OpenCAEModelJson = {
      ...dynamic,
      schemaVersion: "0.3.0",
      loads: [],
      steps: [{ name: "modes", type: "modal", boundaryConditions: step.boundaryConditions, modeCount: 2 }]
    };
    const settings = boundedSolverSettings("modal_analysis", { maxDofs: 250_000, modeCount: 20 }, model, BROWSER_SOLVE_LIMITS);
    expect(settings).toMatchObject({ maxDofs: 100_000, modeCount: 10 });
    const outcome = solveStudyModelWithCorePipeline({ model, analysisType: "modal_analysis", solverSettings: { modeCount: 2 }, limits: BROWSER_SOLVE_LIMITS });
    expect(outcome.ok, outcome.ok ? undefined : outcome.error.message).toBe(true);
    if (!outcome.ok) return;
    const resource = outcome.result.diagnostics.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === "core-cloud-resource-limits") as { maxDofs?: number; modeCount?: number } | undefined;
    expect(resource).toMatchObject({ maxDofs: 100_000, modeCount: 2 });
  });

  test("a static model above 100k DOFs fails fast with the actionable max-dofs error", { timeout: 120_000 }, () => {
    const model = structuredTet10BlockModel(16); // (2*16+1)^3 = 35,937 nodes = 107,811 DOFs
    expect(Math.floor(model.nodes.coordinates.length / 3) * 3).toBeGreaterThan(BROWSER_SOLVE_LIMITS.maxDofs);
    const outcome = solveStudyModelWithCorePipeline({
      model,
      analysisType: "static_stress",
      limits: BROWSER_SOLVE_LIMITS
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("max-dofs-exceeded");
    expect(outcome.error.message).toContain("107811");
    expect(outcome.error.message).toContain("100000");
  });

  test("running at cloud limits emits no deviation diagnostic (parity mode)", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress",
      limits: CLOUD_SOLVER_LIMITS
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.diagnostics.some(
      (entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === "browser-solve-limits"
    )).toBe(false);
  });
});

describe("dynamic runtime guards", () => {
  test("estimateDynamicRuntime multiplies steps by the calibrated pace", () => {
    expect(estimateDynamicRuntime({ steps: 100, calibratedMsPerStep: 12 })).toEqual({
      steps: 100,
      calibratedMsPerStep: 12,
      estimatedMs: 1200
    });
    expect(estimateDynamicRuntime({ steps: 10 }).estimatedMs).toBe(10 * DEFAULT_DYNAMIC_MS_PER_STEP);
    expect(estimateDynamicRuntime({ steps: -5 }).estimatedMs).toBe(0);
  });

  test("dynamicIntegrationSteps derives step counts from bounded settings", () => {
    expect(dynamicIntegrationSteps({ startTime: 0, endTime: 0.05, timeStep: 0.005 })).toBe(10);
    expect(dynamicIntegrationSteps({ startTime: 0, endTime: 0, timeStep: 0.005 })).toBe(0);
  });

  test("rejects dynamic solves above the browser step budget with an honest error", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-dynamic"),
      analysisType: "dynamic_structural",
      // 10 s at the minimum 0.1 ms time step = 100k steps, above the 20k cap.
      solverSettings: { startTime: 0, endTime: 10, timeStep: 0.0001, outputInterval: 0.005 },
      limits: BROWSER_SOLVE_LIMITS
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("dynamic-step-budget-exceeded");
    expect(outcome.error.message).toContain("integration steps");
    expect(outcome.error.message).toContain("Increase the time step");
    // The cloud runner is retired; guard messages must not point users at it.
    expect(outcome.error.message).not.toContain("Cloud");
  });

  test("rejects dynamic solves whose model exceeds the browser DOF budget", () => {
    const model = fixtureModel("beam-dynamic");
    const outcome = solveStudyModelWithCorePipeline({
      model,
      analysisType: "dynamic_structural",
      limits: { ...BROWSER_SOLVE_LIMITS, maxDofs: 10 }
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("max-dofs-exceeded");
  });
});

describe("hooks", () => {
  test("forwards solver progress events and honors cooperative cancel", () => {
    const phases = new Set<string>();
    let cancelAfterAssemble = false;
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress",
      limits: BROWSER_SOLVE_LIMITS,
      hooks: {
        onProgress: (event: SolveProgressEvent) => {
          phases.add(event.phase);
          if (event.phase === "solve") cancelAfterAssemble = true;
        },
        shouldCancel: () => cancelAfterAssemble
      }
    });
    expect(phases.has("assemble")).toBe(true);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("cancelled");
  });

  test("stamps browser runner provenance on successful solves", () => {
    const outcome = solveStudyModelWithCorePipeline({
      model: fixtureModel("beam-static"),
      analysisType: "static_stress"
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.solver).toBe("opencae-core-cloud");
    expect(outcome.result.provenance.runnerVersion).toBe("browser-0.1.0");
    expect(outcome.result.summary.provenance).toEqual(outcome.result.provenance);
  });
});

/**
 * Fully valid (orphan-free, connected, loaded, constrained) structured Tet10
 * block model with (2n+1)^3 nodes — the same 6-tet cube decomposition +
 * quadratic elevation the core adapter uses, so a >100k-DOF model exercises
 * the real fail-fast path instead of tripping validation first.
 */
function structuredTet10BlockModel(divisions: number): OpenCAEModelJson {
  const [sizeX, sizeY, sizeZ] = [0.1, 0.02, 0.02];
  const coordinates: number[] = [];
  for (let k = 0; k <= divisions; k += 1) {
    for (let j = 0; j <= divisions; j += 1) {
      for (let i = 0; i <= divisions; i += 1) {
        coordinates.push((i / divisions) * sizeX, (j / divisions) * sizeY, (k / divisions) * sizeZ);
      }
    }
  }
  const nodeIndex = (i: number, j: number, k: number) => i + (divisions + 1) * (j + (divisions + 1) * k);
  const tet4Elements: number[][] = [];
  const addTet = (a: number, b: number, c: number, d: number) => {
    tet4Elements.push(signedTetVolume(coordinates, a, b, c, d) > 0 ? [a, b, c, d] : [b, a, c, d]);
  };
  for (let k = 0; k < divisions; k += 1) {
    for (let j = 0; j < divisions; j += 1) {
      for (let i = 0; i < divisions; i += 1) {
        const n000 = nodeIndex(i, j, k);
        const n100 = nodeIndex(i + 1, j, k);
        const n010 = nodeIndex(i, j + 1, k);
        const n110 = nodeIndex(i + 1, j + 1, k);
        const n001 = nodeIndex(i, j, k + 1);
        const n101 = nodeIndex(i + 1, j, k + 1);
        const n011 = nodeIndex(i, j + 1, k + 1);
        const n111 = nodeIndex(i + 1, j + 1, k + 1);
        addTet(n000, n100, n110, n111);
        addTet(n000, n110, n010, n111);
        addTet(n000, n010, n011, n111);
        addTet(n000, n011, n001, n111);
        addTet(n000, n001, n101, n111);
        addTet(n000, n101, n100, n111);
      }
    }
  }
  const elevated = elevateTet4MeshToTet10({ coordinates, elements: tet4Elements });
  const material = {
    name: "mat-test-steel",
    type: "isotropicLinearElastic" as const,
    youngModulus: 200e9,
    poissonRatio: 0.3,
    yieldStrength: 250e6,
    density: 7850
  };
  const base = volumeMeshToModelJson({
    nodes: { coordinates: elevated.coordinates },
    materials: [material],
    elementBlocks: [{
      name: "over-cap-block-tet10",
      type: "Tet10",
      material: material.name,
      connectivity: elevated.elements.flat()
    }],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "structured_block_core"
    }
  });
  const facetOnPlane = (facet: { nodes: number[] }, axisValue: number) =>
    facet.nodes.every((node) => Math.abs((elevated.coordinates[node * 3] ?? 0) - axisValue) < 1e-9);
  const surfaceSets = [
    { name: "FS", facets: (base.surfaceFacets ?? []).filter((facet) => facetOnPlane(facet, 0)).map((facet) => facet.id) },
    { name: "LS", facets: (base.surfaceFacets ?? []).filter((facet) => facetOnPlane(facet, sizeX)).map((facet) => facet.id) }
  ];
  const withSurfaces = { ...base, schemaVersion: "0.2.0", surfaceSets };
  const fixedNodes = deriveFixedSupportNodeSetFromSurface("fixedNodes0", "FS", withSurfaces);
  return {
    ...withSurfaces,
    nodeSets: [...withSurfaces.nodeSets, fixedNodes],
    boundaryConditions: [{ name: "fixedSupport0", type: "fixed", nodeSet: fixedNodes.name, components: ["x", "y", "z"] }],
    loads: [{ name: "appliedForce0", type: "surfaceForce", surfaceSet: "LS", totalForce: [0, 0, -500] }],
    steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: ["fixedSupport0"], loads: ["appliedForce0"] }]
  };
}

function signedTetVolume(coordinates: number[], a: number, b: number, c: number, d: number): number {
  const ax = coordinates[a * 3]!;
  const ay = coordinates[a * 3 + 1]!;
  const az = coordinates[a * 3 + 2]!;
  const bax = coordinates[b * 3]! - ax;
  const bay = coordinates[b * 3 + 1]! - ay;
  const baz = coordinates[b * 3 + 2]! - az;
  const cax = coordinates[c * 3]! - ax;
  const cay = coordinates[c * 3 + 1]! - ay;
  const caz = coordinates[c * 3 + 2]! - az;
  const dax = coordinates[d * 3]! - ax;
  const day = coordinates[d * 3 + 1]! - ay;
  const daz = coordinates[d * 3 + 2]! - az;
  return (
    bax * (cay * daz - caz * day) -
    bay * (cax * daz - caz * dax) +
    baz * (cax * day - cay * dax)
  ) / 6;
}
