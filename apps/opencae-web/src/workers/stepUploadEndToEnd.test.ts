// A-M3 stage 6: STEP upload end-to-end in Node — registry -> simulated
// face selections by real faceId -> gmsh-wasm mesh -> facet->face
// attribution -> Core model build -> solveCoreStatic via the adapter.
//
// Hard acceptance gate: for STEP models, selection mapping resolves via
// bySelection/byFace and NEVER the geometric fallback (asserted through the
// A-M3 mapping diagnostics). Physics gate: the solved reaction force must
// equal the applied 500 N load (equilibrium), with finite sane stresses.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  attributeFacetsToStepFaces,
  buildCoreModelFromCloudMesh,
  meshStepToMshV2,
  parseGmshMeshToCoreVolumeMesh,
  type CoreVolumeMeshArtifact,
  type SelectionMappingDiagnostic
} from "@opencae/mesh-intake";
import type { OpenCAEModelJson } from "@opencae/core";
import type { DisplayModel, Study } from "@opencae/schema";
import { StudySchema } from "@opencae/schema";
import { hasActualCoreVolumeMesh, openCaeCoreEligibility, trySolveOpenCaeCoreStudy } from "@opencae/core-adapter";
import { studyForCoreCloudGeometryDispatch } from "./opencaeCoreSolve";
import { buildStepFaceRegistry, stepAttributionForRegistry, type StepFaceRegistry } from "../stepFaces";
import {
  STEP_PROOF_LOAD_NEWTONS,
  STEP_PROOF_LOAD_SELECTION,
  STEP_PROOF_SUPPORT_SELECTION,
  stepProofScenario,
  studyWithWasmMeshSummary
} from "./stepProofScenario";

const fixtureUrl = new URL("../../../../libs/opencae-mesh-intake/fixtures/box-with-bore.step", import.meta.url);
const DIMS_MM = { x: 60, y: 40, z: 20 };

describe("STEP upload end-to-end (registry -> selection -> mesh -> attribution -> solve)", () => {
  let registry: StepFaceRegistry;
  let study: Study;
  let displayModel: DisplayModel;
  let artifact: CoreVolumeMeshArtifact;
  let model: OpenCAEModelJson;
  const mappingDiagnostics: SelectionMappingDiagnostic[] = [];

  beforeAll(async () => {
    const stepText = readFileSync(fixtureUrl, "utf8");
    const contentBase64 = Buffer.from(stepText, "utf8").toString("base64");

    // 1. Face registry from the real occt tessellation.
    const { default: occtimportjs } = await import("occt-import-js");
    const occt = await occtimportjs();
    const imported = occt.ReadStepFile(new TextEncoder().encode(stepText), null);
    expect(imported.success).toBe(true);
    registry = buildStepFaceRegistry(imported.meshes ?? []);

    // 2. Simulated user selections: support + load picked by real faceId.
    const scenario = stepProofScenario(registry, { filename: "box-with-bore.step", contentBase64 });
    study = scenario.study;
    displayModel = scenario.displayModel;

    // 3. wasm mesh + attribution (what meshWorker.ts does per request).
    const meshed = await meshStepToMshV2(stepText, { elementOrder: 2, meshSizeMm: 6 });
    artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm", diagnostics: ["A-M3 E2E"] });
    attributeFacetsToStepFaces(artifact, stepAttributionForRegistry(registry));

    // 4. Core model build from the dispatched study (lib/wasmMeshing.ts contract).
    const dispatchStudy = studyForCoreCloudGeometryDispatch(study, displayModel);
    model = buildCoreModelFromCloudMesh({
      study: {
        id: dispatchStudy.id,
        type: "static_stress",
        materialAssignments: dispatchStudy.materialAssignments,
        namedSelections: dispatchStudy.namedSelections,
        constraints: dispatchStudy.constraints,
        loads: dispatchStudy.loads,
        solverSettings: dispatchStudy.solverSettings as Record<string, unknown>
      },
      displayModel,
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: { elementOrder: 2 },
      mappingDiagnostics
    });
  }, 300_000);

  it("builds a schema-valid study with selections that reference real registry faces", () => {
    expect(StudySchema.safeParse(study).success).toBe(true);
    const support = study.namedSelections.find((selection) => selection.id === STEP_PROOF_SUPPORT_SELECTION)!;
    const load = study.namedSelections.find((selection) => selection.id === STEP_PROOF_LOAD_SELECTION)!;
    expect(support.geometryRefs[0]?.entityId).toMatch(/^step-face-\d+$/);
    expect(load.geometryRefs[0]?.entityId).toMatch(/^step-face-\d+$/);
    expect(support.geometryRefs[0]?.entityId).not.toBe(load.geometryRefs[0]?.entityId);
  });

  it("HARD GATE: selection mapping resolves via byFace, never the geometric fallback", () => {
    expect(mappingDiagnostics).toHaveLength(2);
    for (const diagnostic of mappingDiagnostics) {
      expect(["bySelection", "byFace"]).toContain(diagnostic.mode);
      expect(diagnostic.mode).not.toBe("geometric");
      expect(diagnostic.matchedFacetCount).toBeGreaterThan(0);
    }
    const roles = mappingDiagnostics.map((diagnostic) => diagnostic.role).sort();
    expect(roles).toEqual(["fixed_support", "load_surface"]);
  });

  it("maps the fixed support onto the x=0 face and the load onto the bored top face", () => {
    const supportDiagnostic = mappingDiagnostics.find((diagnostic) => diagnostic.role === "fixed_support")!;
    const loadDiagnostic = mappingDiagnostics.find((diagnostic) => diagnostic.role === "load_surface")!;
    const facetsOf = (setName: string) => {
      const set = artifact.surfaceSets.find((candidate) => candidate.name === setName)!;
      const ids = new Set(set.facets);
      return artifact.surfaceFacets.filter((facet) => ids.has(facet.id));
    };
    for (const facet of facetsOf(supportDiagnostic.surfaceSet)) {
      expect(facet.center?.[0]).toBeCloseTo(0, 5);
    }
    const loadFacets = facetsOf(loadDiagnostic.surfaceSet);
    const loadArea = loadFacets.reduce((total, facet) => total + (facet.area ?? 0), 0);
    for (const facet of loadFacets) {
      expect(facet.center?.[2]).toBeCloseTo(DIMS_MM.z * 1e-3, 5);
    }
    // Bored top face: full rectangle minus the 12 mm bore. The coarse mesh
    // polygonizes the hole inward (hexagon-ish at 6 mm size), so the removed
    // area lands between ~50% and 105% of the exact circle.
    const fullTop = DIMS_MM.x * DIMS_MM.y * 1e-6;
    const bore = Math.PI * 0.006 ** 2;
    expect(loadArea).toBeLessThan(fullTop - bore * 0.5);
    expect(loadArea).toBeGreaterThan(fullTop - bore * 1.05);
  });

  it("solves through the adapter with reaction equal to the applied load", { timeout: 300_000 }, () => {
    const solvableStudy = studyWithWasmMeshSummary({ study, artifact, model, mappingDiagnostics });
    expect(hasActualCoreVolumeMesh(solvableStudy, displayModel)).toBe(true);
    const eligibility = openCaeCoreEligibility(solvableStudy, displayModel);
    expect(eligibility.ok, eligibility.ok ? undefined : eligibility.reason).toBe(true);

    const outcome = trySolveOpenCaeCoreStudy({ study: solvableStudy, runId: "run-a-m3-step-e2e", displayModel });
    expect(outcome.ok, outcome.ok ? undefined : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-sparse-tet");

    const summary = outcome.result.summary;
    expect(Number.isFinite(summary.maxStress)).toBe(true);
    expect(summary.maxStress).toBeGreaterThan(0);
    expect(Number.isFinite(summary.maxDisplacement)).toBe(true);
    expect(summary.maxDisplacement).toBeGreaterThan(0);
    expect(summary.safetyFactor).toBeGreaterThan(0);

    // Equilibrium: reaction magnitude equals the applied 500 N within 2%.
    expect(Math.abs(summary.reactionForce - STEP_PROOF_LOAD_NEWTONS) / STEP_PROOF_LOAD_NEWTONS).toBeLessThan(0.02);

    console.log(
      `[A-M3 E2E] nodes=${artifact.metadata.nodeCount} elements=${artifact.metadata.elementCount} ` +
        `mapping=${mappingDiagnostics.map((diagnostic) => `${diagnostic.role}:${diagnostic.mode}`).join(",")} ` +
        `maxStress=${summary.maxStress.toFixed(3)}${summary.maxStressUnits} ` +
        `maxDisplacement=${summary.maxDisplacement.toExponential(3)}${summary.maxDisplacementUnits} ` +
        `reaction=${summary.reactionForce.toFixed(2)}${summary.reactionForceUnits} applied=${STEP_PROOF_LOAD_NEWTONS}N`
    );
  });
});
