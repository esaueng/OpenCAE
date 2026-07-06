// End-to-end A-M2 parity test: wasm-mesh the bracket with the EXACT meshing
// settings recorded in the B0 golden fixture (medium preset -> meshSize 12 mm,
// elementOrder 1 per the production api.ts bracket override), build the Core
// model with the mirrored cloud builder, solve with @opencae/solver-cpu's
// solveCoreStatic (the same entry point the deployed runner calls), and
// compare against the frozen production response.
//
// Measured on record (2026-07-06, gmsh-wasm 0.1.2 vs native gmsh 4.15.2-git):
// nodes 611 vs 611 (exact), elements 1947 vs 1955 (-0.41%), maxStress -1.45%,
// maxDisplacement +0.90% — the different gmsh build places interior nodes
// slightly differently, so bit-identical results are not expected, but both
// engineering quantities sit comfortably inside the +/-2% gate.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DisplayModel, Study } from "@opencae/schema";
import { hasActualCoreVolumeMesh, openCaeCoreEligibility, trySolveOpenCaeCoreStudy } from "@opencae/core-adapter";
import { solveCoreStatic } from "@opencae/solver-cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { bracketGeoScript, bracketGeometrySourceMetadata } from "./bracketGeo";
import { buildCoreModelFromCloudMesh } from "./coreModelFromMesh";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import type { CoreVolumeMeshArtifact } from "./types";
import { meshGeoScriptToMshV2 } from "./wasmMesher";

type GoldenFixture = {
  request: {
    study: Record<string, unknown>;
    displayModel: Record<string, unknown>;
    geometry: { descriptor: Record<string, unknown>; units?: "mm" | "m" };
    solverSettings: Record<string, unknown> & { elementOrder?: number };
  };
  response: {
    summary: { maxStress: number; maxDisplacement: number; reactionForce: number };
    artifacts: { meshSummary: { nodeCount: number; elementCount: number } };
  };
};

const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/opencae-web/src/testdata/core-cloud-golden/bracket-static.json"
);

describe("wasm-meshed bracket vs Core Cloud golden (plan A-M2)", () => {
  let golden: GoldenFixture;
  let artifact: CoreVolumeMeshArtifact;
  let model: ReturnType<typeof buildCoreModelFromCloudMesh>;

  beforeAll(async () => {
    golden = JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenFixture;
    // The golden bracket was meshed with elementOrder 1 (production api.ts
    // override: curved native Tet10 can invert around the drilled holes).
    expect(golden.request.solverSettings.elementOrder).toBe(1);
    const meshed = await meshGeoScriptToMshV2(bracketGeoScript(golden.request.geometry.descriptor), {
      elementOrder: golden.request.solverSettings.elementOrder as 1
    });
    artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, {
      units: golden.request.geometry.units ?? "mm",
      sourceSelectionRefs: bracketGeometrySourceMetadata(),
      diagnostics: ["A-M2 golden parity test"]
    });
    model = buildCoreModelFromCloudMesh({
      study: golden.request.study,
      displayModel: golden.request.displayModel,
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: golden.request.solverSettings
    });
  }, 180_000);

  it("reproduces the golden mesh within 10 percent (same .geo, same settings, wasm gmsh build)", () => {
    const goldenMesh = golden.response.artifacts.meshSummary;
    expect(artifact.metadata.connectedComponentCount).toBe(1);
    expect(artifact.metadata.meshQuality.invertedElementCount).toBe(0);
    expect(artifact.elements.every((element) => element.type === "Tet4")).toBe(true);
    expect(artifact.metadata.nodeCount).toBeGreaterThan(goldenMesh.nodeCount * 0.9);
    expect(artifact.metadata.nodeCount).toBeLessThan(goldenMesh.nodeCount * 1.1);
    expect(artifact.metadata.elementCount).toBeGreaterThan(goldenMesh.elementCount * 0.9);
    expect(artifact.metadata.elementCount).toBeLessThan(goldenMesh.elementCount * 1.1);
  });

  it("solves with solveCoreStatic to within 2 percent of the golden summary", { timeout: 120_000 }, () => {
    const solved = solveCoreStatic(model, {
      ...golden.request.solverSettings,
      method: "sparse",
      solverMode: "sparse"
    });
    expect(solved.ok, solved.ok ? undefined : JSON.stringify(solved.error)).toBe(true);
    if (!solved.ok) return;
    const summary = solved.result.summary;
    const goldenSummary = golden.response.summary;
    console.log(
      `[A-M2 parity] maxStress=${summary.maxStress} MPa (golden ${goldenSummary.maxStress}, ` +
        `${deltaPct(summary.maxStress, goldenSummary.maxStress)}) ` +
        `maxDisplacement=${summary.maxDisplacement} mm (golden ${goldenSummary.maxDisplacement}, ` +
        `${deltaPct(summary.maxDisplacement, goldenSummary.maxDisplacement)}) ` +
        `nodes=${artifact.metadata.nodeCount}/${golden.response.artifacts.meshSummary.nodeCount} ` +
        `elements=${artifact.metadata.elementCount}/${golden.response.artifacts.meshSummary.elementCount}`
    );
    expect(Math.abs(summary.maxStress - goldenSummary.maxStress) / goldenSummary.maxStress).toBeLessThan(0.02);
    expect(Math.abs(summary.maxDisplacement - goldenSummary.maxDisplacement) / goldenSummary.maxDisplacement).toBeLessThan(0.02);
    expect(Math.abs(summary.reactionForce - goldenSummary.reactionForce) / goldenSummary.reactionForce).toBeLessThan(0.001);
  });

  it("makes the complex bracket eligible for local solve once the artifact is stored (adapter contract)", { timeout: 120_000 }, () => {
    // Store the artifact exactly the way apps/opencae-web/src/lib/wasmMeshing.ts
    // does, then run the untouched adapter pipeline end to end.
    const baseStudy = golden.request.study as unknown as Study;
    const displayModel = golden.request.displayModel as unknown as DisplayModel;
    const study: Study = {
      ...baseStudy,
      meshSettings: {
        preset: "medium",
        status: "complete",
        meshRef: `${baseStudy.projectId}/mesh/wasm-gmsh-mesh.json`,
        summary: {
          nodes: artifact.metadata.nodeCount,
          elements: artifact.metadata.elementCount,
          warnings: [],
          quality: "medium",
          source: "wasm_gmsh",
          units: "m",
          solverCoordinateSpace: "solver",
          artifacts: {
            actualCoreModel: { model },
            meshConnectivity: { connectedComponents: artifact.metadata.connectedComponentCount }
          }
        }
      }
    };

    expect(hasActualCoreVolumeMesh(study, displayModel)).toBe(true);
    const eligibility = openCaeCoreEligibility(study, displayModel);
    expect(eligibility.ok, eligibility.ok ? undefined : eligibility.reason).toBe(true);

    const outcome = trySolveOpenCaeCoreStudy({ study, runId: "run-a-m2-parity", displayModel });
    expect(outcome.ok, outcome.ok ? undefined : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");
    const goldenSummary = golden.response.summary;
    expect(Math.abs(outcome.result.summary.maxStress - goldenSummary.maxStress) / goldenSummary.maxStress).toBeLessThan(0.02);
    expect(Math.abs(outcome.result.summary.maxDisplacement - goldenSummary.maxDisplacement) / goldenSummary.maxDisplacement).toBeLessThan(0.02);
  });
});

function deltaPct(actual: number, golden: number): string {
  return `${((100 * (actual - golden)) / golden).toFixed(2)}%`;
}
