// Target-scale smoke for the 100k-DOF browser solve cap (Node/V8 leg; the
// cross-engine browser evidence lives in scripts/verify-100k-solve.mjs +
// ?solveBench=1). Same pipeline as stepUploadEndToEnd.test.ts — registry ->
// selections -> gmsh-wasm mesh -> attribution -> Core model -> adapter solve —
// but at the bench density (2.22 mm -> 33,115 Tet10 nodes = 99,345 DOFs),
// under the PRODUCTION BROWSER_SOLVE_LIMITS. Guards two regressions:
//   - the cap silently dropping back below target scale, and
//   - target-scale models failing (memory/convergence) under default limits.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isStructuralResultSummary } from "@opencae/schema";
import {
  attributeFacetsToStepFaces,
  meshStepToMshV2,
  parseGmshMeshToCoreVolumeMesh,
  type SelectionMappingDiagnostic
} from "@opencae/mesh-intake";
import { buildCoreModelFromCloudMesh } from "@opencae/mesh-intake";
import { BROWSER_SOLVE_LIMITS } from "@opencae/solve-pipeline";
import { trySolveOpenCaeCoreStudy } from "@opencae/core-adapter";
import { buildStepFaceRegistry, stepAttributionForRegistry } from "../stepFaces";
import { STEP_PROOF_LOAD_NEWTONS, stepProofScenario, studyWithWasmMeshSummary } from "./stepProofScenario";

const fixtureUrl = new URL("../../../../libs/opencae-mesh-intake/fixtures/box-with-bore.step", import.meta.url);
/** Keep in sync with DEFAULT_BENCH_MESH_SIZE_MM in solveBenchHarness.ts. */
const BENCH_MESH_SIZE_MM = 2.22;

describe("100k-DOF target-scale solve smoke (production browser limits)", () => {
  it("solves a ~99.3k-DOF Tet10 STEP mesh under BROWSER_SOLVE_LIMITS with balanced reactions", { timeout: 600_000 }, async () => {
    const stepText = readFileSync(fixtureUrl, "utf8");
    const contentBase64 = Buffer.from(stepText, "utf8").toString("base64");

    const { default: occtimportjs } = await import("occt-import-js");
    const occt = await occtimportjs();
    const imported = occt.ReadStepFile(new TextEncoder().encode(stepText), null);
    expect(imported.success).toBe(true);
    const registry = buildStepFaceRegistry(imported.meshes ?? []);
    const scenario = stepProofScenario(registry, { filename: "box-with-bore.step", contentBase64 });

    const meshed = await meshStepToMshV2(stepText, { elementOrder: 2, meshSizeMm: BENCH_MESH_SIZE_MM });
    const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm", diagnostics: ["100k scale smoke"] });
    attributeFacetsToStepFaces(artifact, stepAttributionForRegistry(registry));

    const mappingDiagnostics: SelectionMappingDiagnostic[] = [];
    const model = buildCoreModelFromCloudMesh({
      study: {
        id: scenario.study.id,
        type: "static_stress",
        materialAssignments: scenario.study.materialAssignments,
        namedSelections: scenario.study.namedSelections,
        constraints: scenario.study.constraints,
        loads: scenario.study.loads,
        solverSettings: scenario.study.solverSettings as Record<string, unknown>
      },
      displayModel: scenario.displayModel,
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: { elementOrder: 2 },
      mappingDiagnostics
    });

    // Target scale: inside the 90k..100k band the browser bench certifies.
    const dofs = model.nodes.coordinates.length;
    expect(dofs).toBeGreaterThan(90000);
    expect(dofs).toBeLessThanOrEqual(BROWSER_SOLVE_LIMITS.maxDofs);

    const solvableStudy = studyWithWasmMeshSummary({ study: scenario.study, artifact, model, mappingDiagnostics });
    const startedAt = performance.now();
    const outcome = trySolveOpenCaeCoreStudy({
      study: solvableStudy,
      runId: "run-scale-smoke-100k",
      displayModel: scenario.displayModel
    });
    const elapsedMs = Math.round(performance.now() - startedAt);

    expect(outcome.ok, outcome.ok ? undefined : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");

    const summary = outcome.result.summary;
    if (!isStructuralResultSummary(summary)) throw new Error("Expected structural scale-smoke results.");
    expect(Number.isFinite(summary.maxStress)).toBe(true);
    expect(summary.maxStress).toBeGreaterThan(0);
    expect(Number.isFinite(summary.maxDisplacement)).toBe(true);
    expect(summary.maxDisplacement).toBeGreaterThan(0);
    expect(Math.abs(summary.reactionForce - STEP_PROOF_LOAD_NEWTONS) / STEP_PROOF_LOAD_NEWTONS).toBeLessThan(0.01);

    console.log(
      `[100k scale smoke] dofs=${dofs} nodes=${artifact.metadata.nodeCount} elements=${artifact.metadata.elementCount} ` +
        `solveMs=${elapsedMs} maxStress=${summary.maxStress.toFixed(3)}${summary.maxStressUnits} ` +
        `maxDisplacement=${summary.maxDisplacement.toExponential(3)}${summary.maxDisplacementUnits} ` +
        `reaction=${summary.reactionForce.toFixed(2)}N applied=${STEP_PROOF_LOAD_NEWTONS}N`
    );
  });
});
