// A-M2 adapter contract, corrected for the coordinate-frame boundary (plan 016):
// the adapter's trySolveOpenCaeCoreStudy expects the app's DISPLAY-FRAME study and
// applies displayDirectionToSolverFrame itself, while the stored actualCoreModel
// artifact is built from the DISPATCHED (solver-frame) study — exactly what
// lib/wasmMeshing.ts does. Feeding the adapter a golden request study (already
// dispatched) double-remaps the load and skews results ~2.8x, which is what the
// earlier version of this test did from libs/opencae-mesh-intake.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isModalResultSummary } from "@opencae/schema";
import type { DisplayModel, Study } from "@opencae/schema";
import { hasActualCoreVolumeMesh, openCaeCoreEligibility, trySolveOpenCaeCoreStudy } from "@opencae/core-adapter";
import {
  bracketGeoScript,
  bracketGeometrySourceMetadata,
  buildCoreModelFromCloudMesh,
  meshGeoScriptToMshV2,
  parseGmshMeshToCoreVolumeMesh,
  type CoreVolumeMeshArtifact
} from "@opencae/mesh-intake";
import { beforeAll, describe, expect, it } from "vitest";
import { createLocalSampleProject } from "../localProjectFactory";
import { studyForCoreGeometryDispatch } from "./opencaeCoreSolve";

type GoldenFixture = {
  request: {
    geometry: { descriptor: Record<string, unknown>; units?: "mm" | "m" };
    solverSettings: Record<string, unknown> & { elementOrder?: number };
  };
  response: {
    summary: { maxStress: number; maxDisplacement: number };
  };
};

const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../testdata/core-cloud-golden/bracket-static.json"
);

const FIXED_NOW = "2026-07-06T00:00:00.000Z";

describe("wasm-meshed bracket through the adapter (display-frame contract)", () => {
  let golden: GoldenFixture;
  let displayStudy: Study;
  let displayModel: DisplayModel;
  let artifact: CoreVolumeMeshArtifact;
  let model: ReturnType<typeof buildCoreModelFromCloudMesh>;

  beforeAll(async () => {
    golden = JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenFixture;
    expect(golden.request.solverSettings.elementOrder).toBe(1);

    // Display-frame inputs exactly as the app holds them.
    const sample = await createLocalSampleProject("bracket", "static_stress", FIXED_NOW);
    const baseStudy = sample.project.studies[0];
    if (!baseStudy) throw new Error("bracket sample produced no study");
    displayStudy = baseStudy;
    displayModel = sample.displayModel;

    // Artifact + model exactly as lib/wasmMeshing.ts stores them: mesh with the
    // golden's recorded settings, build the model from the DISPATCHED study.
    const meshed = await meshGeoScriptToMshV2(bracketGeoScript(golden.request.geometry.descriptor), {
      elementOrder: golden.request.solverSettings.elementOrder as 1
    });
    artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, {
      units: golden.request.geometry.units ?? "mm",
      sourceSelectionRefs: bracketGeometrySourceMetadata(),
      diagnostics: ["A-M2 adapter contract test"]
    });
    const dispatchStudy = studyForCoreGeometryDispatch(displayStudy, displayModel);
    model = buildCoreModelFromCloudMesh({
      study: dispatchStudy as unknown as Record<string, unknown>,
      displayModel: displayModel as unknown as Record<string, unknown>,
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: golden.request.solverSettings
    });
  }, 180_000);

  it("solves the stored artifact within 2 percent of the golden summary", { timeout: 120_000 }, () => {
    const study: Study = {
      ...displayStudy,
      meshSettings: {
        preset: "medium",
        status: "complete",
        meshRef: `${displayStudy.projectId}/mesh/wasm-gmsh-mesh.json`,
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

    const outcome = trySolveOpenCaeCoreStudy({ study, runId: "run-a-m2-adapter-contract", displayModel });
    expect(outcome.ok, outcome.ok ? undefined : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");
    if (isModalResultSummary(outcome.result.summary)) throw new Error("Expected structural adapter results.");
    const goldenSummary = golden.response.summary;
    expect(Math.abs(outcome.result.summary.maxStress - goldenSummary.maxStress) / goldenSummary.maxStress).toBeLessThan(0.02);
    expect(Math.abs(outcome.result.summary.maxDisplacement - goldenSummary.maxDisplacement) / goldenSummary.maxDisplacement).toBeLessThan(0.02);
  });
});
