import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpenCAEModelJson } from "@opencae/core";
import { handleRequest } from "./index";

describe("OpenCAE Core Cloud service", () => {
  test("does not import preview or local estimate solvers", () => {
    const source = readFileSync(resolve(__dirname, "index.ts"), "utf8");

    expect(source).not.toContain("solveCorePreviewDynamic");
    expect(source).not.toContain("solvePreviewSdof");
    expect(source).not.toContain("fallbackSolveLocalStudy");
  });

  test("health reports static and dynamic Core support without preview", async () => {
    const response = await handleRequest(new Request("http://core-cloud/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "opencae-core-cloud",
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false
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
    expect(body.fields.length).toBeGreaterThan(0);
    expect(body.surfaceMesh.nodes.length).toBeGreaterThan(0);
    expect(body.provenance).toMatchObject({
      kind: "opencae_core_fea",
      solver: "opencae-core-cloud",
      resultSource: "computed",
      meshSource: "actual_volume_mesh"
    });
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
