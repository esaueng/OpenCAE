import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { solverSurfaceMeshFromModel, type OpenCAEModelJson } from "@opencae/core";
import { handleRequest, normalizeCoreCloudResultForUi } from "./index";

describe("OpenCAE Core Cloud service", () => {
  test("defines runner version in the service version file", () => {
    const versionPath = resolve(__dirname, "../RUNNER_VERSION");
    const source = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(existsSync(versionPath)).toBe(true);
    expect(source).toContain("RUNNER_VERSION");
    expect(source).not.toContain('const RUNNER_VERSION = "0.1.0"');
  });

  test("does not import preview or local estimate solvers", () => {
    const source = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(source).not.toContain("solveCorePreviewDynamic");
    expect(source).not.toContain("solvePreviewSdof");
    expect(source).not.toContain("fallbackSolveLocalStudy");
  });

  test("health reports static and dynamic Core support without preview", async () => {
    const response = await handleRequest(new Request("http://core-cloud/health"));
    const runnerVersion = readFileSync(resolve(__dirname, "../RUNNER_VERSION"), "utf8").trim();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "opencae-core-cloud",
      runnerVersion,
      coreVersion: "0.1.2",
      solverCpuVersion: "0.1.2",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportedSolverMethods: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false,
      noCalculix: true,
      noLocalEstimateFallback: true
    });
  });

  test("rejects oversized solve request bodies before parsing", async () => {
    const response = await handleRequest(new Request("http://core-cloud/solve", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5000001" },
      body: "{}"
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ id: "request-too-large" })]
    });
  });

  test("solves a static Core block model", async () => {
    const response = await solve({
      runId: "run-static",
      analysisType: "static_stress",
      coreModel: blockModel("static_stress")
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.maxStress).toBeGreaterThan(0);
    expect(body.summary.maxDisplacement).toBeGreaterThan(0);
    expect(body.summary.reactionForce).toBeGreaterThan(0);
    expect(body.summary).toMatchObject({
      maxStressUnits: "MPa",
      maxDisplacementUnits: "mm",
      reactionForceUnits: "N",
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-cloud",
        resultSource: "computed",
        meshSource: "actual_volume_mesh"
      }
    });
    expect(body.fields.length).toBeGreaterThan(0);
    expect(body.fields.every((field: { units?: string }) => typeof field.units === "string" && field.units.length > 0)).toBe(true);
    expect(body.surfaceMesh.nodes.length).toBeGreaterThan(0);
    expect(body.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "actual_volume_mesh"
    });
    expect(JSON.stringify(body)).not.toContain("undefined");
  });

  test("normalizes app-facing values and does not compact solver surface fields independently", async () => {
    const response = await solve({
      runId: "run-static-compacted",
      analysisType: "static_stress",
      coreModel: blockModel("static_stress"),
      resultSettings: { maxFieldValues: 2 }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const displacement = body.fields.find((field: { type: string }) => field.type === "displacement");
    const stress = body.fields.find((field: { type: string }) => field.type === "stress");

    expect(body.summary.maxStressUnits).toBe("MPa");
    expect(body.summary.maxDisplacementUnits).toBe("mm");
    expect(body.summary.reactionForceUnits).toBe("N");
    expect(displacement.surfaceMeshRef).toBe(body.surfaceMesh.id);
    expect(displacement.values).toHaveLength(body.surfaceMesh.nodes.length);
    expect(displacement.vectors).toHaveLength(body.surfaceMesh.nodes.length);
    expect(displacement.samples).toBeUndefined();
    expect(stress.surfaceMeshRef).toBe(body.surfaceMesh.id);
    expect(stress.values).toHaveLength(body.surfaceMesh.nodes.length);
    expect(stress.samples).toBeUndefined();
    expect(displacement.compaction).toMatchObject({
      originalValueCount: expect.any(Number),
      returnedValueCount: body.surfaceMesh.nodes.length,
      originalSampleCount: expect.any(Number),
      returnedSampleCount: 0
    });
    expect(displacement.vectors.every((vector: number[]) => vector.every(Number.isFinite))).toBe(true);
  });

  test("rejects solver surface fields with mismatched value length and has no modulo node fallback", () => {
    const model = blockModel("static_stress");
    const surfaceMesh = solverSurfaceMeshFromModel(model);
    const source = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(() => normalizeCoreCloudResultForUi({
      summary: { maxStress: 1, maxStressUnits: "MPa", maxDisplacement: 1, maxDisplacementUnits: "mm", safetyFactor: 1, reactionForce: 1, reactionForceUnits: "N" },
      fields: [{
        id: "stress-surface",
        type: "stress",
        location: "node",
        values: [1],
        min: 1,
        max: 1,
        units: "MPa",
        surfaceMeshRef: surfaceMesh.id
      }],
      surfaceMesh,
      provenance: { kind: "opencae_core_fea", solver: "opencae-core-cloud", resultSource: "computed", meshSource: "actual_volume_mesh", units: "mm-N-s-MPa" }
    })).toThrow(/does not match solver surface node count/i);
    expect(source).not.toMatch(/nodes\s*\[\s*index\s*%/);
  });

  test("solves a dynamic Core block model with MDOF fields", async () => {
    const response = await solve({
      runId: "run-dynamic",
      analysisType: "dynamic_structural",
      coreModel: blockModel("dynamic_structural"),
      solverSettings: {
        endTime: 0.02,
        timeStep: 0.005,
        outputInterval: 0.01,
        dampingRatio: 0.02,
        loadProfile: "ramp"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.transient).toMatchObject({
      analysisType: "dynamic_structural",
      frameCount: 3
    });
    expect(body.fields.some((field: { type: string; frameIndex?: number }) => field.type === "velocity" && field.frameIndex === 0)).toBe(true);
    expect(body.fields.some((field: { type: string; frameIndex?: number }) => field.type === "acceleration" && field.frameIndex === 0)).toBe(true);
    expect(body.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed"
    });
  });

  test("builds a Core model from a provided volume mesh", async () => {
    const model = blockModel("static_stress");
    const response = await solve({
      runId: "run-mesh-adapter",
      analysisType: "static_stress",
      coreVolumeMesh: {
        nodes: model.nodes,
        materials: model.materials,
        elementBlocks: model.elementBlocks,
        nodeSets: model.nodeSets,
        elementSets: model.elementSets,
        surfaceSets: model.surfaceSets,
        boundaryConditions: model.boundaryConditions,
        loads: model.loads,
        steps: model.steps,
        coordinateSystem: model.coordinateSystem,
        meshProvenance: model.meshProvenance
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.maxStress).toBeGreaterThan(0);
    expect(body.provenance.meshSource).toBe("actual_volume_mesh");
  });

  test("returns 422 diagnostics for invalid models", async () => {
    const response = await solve({
      runId: "run-invalid",
      analysisType: "static_stress",
      coreModel: {
        ...blockModel("static_stress"),
        elementBlocks: [{ name: "bad", type: "Tet4", material: "steel", connectivity: [0, 1, 1, 9] }]
      }
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ source: "validation" })
      ])
    });
  });

  test("rejects preview requests instead of using SDOF or local estimates", async () => {
    const response = await solve({
      runId: "run-preview",
      analysisType: "dynamic_structural",
      coreModel: {
        ...blockModel("dynamic_structural"),
        meshProvenance: {
          kind: "local_estimate",
          solver: "opencae-core-preview-sdof",
          resultSource: "computed_preview",
          meshSource: "display_bounds_proxy"
        }
      }
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body).toLowerCase()).toContain("preview");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("local estimate fallback");
  });
});

async function solve(body: unknown): Promise<Response> {
  return handleRequest(new Request("http://core-cloud/solve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
}

function blockModel(analysisType: "static_stress" | "dynamic_structural"): OpenCAEModelJson {
  const step = analysisType === "dynamic_structural"
    ? {
        name: "dynamicStep",
        type: "dynamicLinear" as const,
        boundaryConditions: ["fixedLeft"],
        loads: ["tipLoad"],
        startTime: 0,
        endTime: 0.02,
        timeStep: 0.005,
        outputInterval: 0.01,
        loadProfile: "ramp" as const,
        dampingRatio: 0.02
      }
    : {
        name: "staticStep",
        type: "staticLinear" as const,
        boundaryConditions: ["fixedLeft"],
        loads: ["tipLoad"]
      };

  return {
    schema: "opencae.model",
    schemaVersion: "0.2.0",
    nodes: {
      coordinates: [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1
      ]
    },
    materials: [{
      name: "steel",
      type: "isotropicLinearElastic",
      youngModulus: 210_000_000_000,
      poissonRatio: 0.3,
      yieldStrength: 250_000_000,
      density: 7850
    }],
    elementBlocks: [{
      name: "blockTet",
      type: "Tet4",
      material: "steel",
      connectivity: [0, 1, 2, 3]
    }],
    nodeSets: [
      { name: "fixedNodes", nodes: [0, 1, 2] },
      { name: "loadNodes", nodes: [3] }
    ],
    elementSets: [{ name: "allElements", elements: [0] }],
    boundaryConditions: [{ name: "fixedLeft", type: "fixed", nodeSet: "fixedNodes", components: ["x", "y", "z"] }],
    loads: [{ name: "tipLoad", type: "nodalForce", nodeSet: "loadNodes", vector: [0, 0, -100] }],
    steps: [step],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: {
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "actual_volume_mesh"
    }
  };
}
