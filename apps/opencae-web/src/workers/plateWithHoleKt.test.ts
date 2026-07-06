// Plate-with-central-hole stress concentration benchmark against the WASM
// mesher (plan 013 / A-M4 quality gates). A classical V&V case with a known
// oracle: for a finite-width plate under tension with d/W = 0.25, the
// net-section concentration factor is Kt_net ≈ 2 + (1 − d/W)^3 = 2.422
// (Heywood/Howland fit). The peak von Mises stress from the solved model must
// land within ±15% of Kt_net · σ_net, and the reaction must balance the
// applied load within 1%.
//
// This runs the REAL production pipeline pieces end-to-end in Node: gmsh-wasm
// .geo meshing (with hole-edge refinement via a background size field) ->
// msh parse -> quality gate -> straight-sided Tet10 elevation -> Core model
// build (bySelection mapping) -> sparse static solve.
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCoreModelFromCloudMesh,
  elevateVolumeMeshArtifactToTet10,
  enforceWasmMeshQualityGate,
  meshGeoScriptToMshV2,
  parseGmshMeshToCoreVolumeMesh,
  type CoreVolumeMeshArtifact,
  type SelectionMappingDiagnostic
} from "@opencae/mesh-intake";
import type { OpenCAEModelJson } from "@opencae/core";
import { BROWSER_SOLVE_LIMITS, solveStudyModelWithCorePipeline } from "@opencae/solve-pipeline";

// Geometry (mm) per plans/013: W=60, L=120 (tension along length), t=6,
// central hole d=15 -> d/W = 0.25. Hole at the plate center keeps the
// fully-fixed end far enough for Saint-Venant decay.
const WIDTH_MM = 60;
const LENGTH_MM = 120;
const THICKNESS_MM = 6;
const HOLE_DIAMETER_MM = 15;
const APPLIED_FORCE_N = 1000;

const HOLE_RADIUS_MM = HOLE_DIAMETER_MM / 2;
const D_OVER_W = HOLE_DIAMETER_MM / WIDTH_MM;
/** Heywood/Howland net-section fit: Kt_net ≈ 2 + (1 - d/W)^3. */
const KT_NET_ORACLE = 2 + (1 - D_OVER_W) ** 3;
/** Net-section nominal stress in MPa (N / mm^2). */
const SIGMA_NET_MPA = APPLIED_FORCE_N / ((WIDTH_MM - HOLE_DIAMETER_MM) * THICKNESS_MM);
const KT_TOLERANCE = 0.15;
const REACTION_TOLERANCE = 0.01;

function plateWithHoleGeoScript(): string {
  const cx = LENGTH_MM / 2;
  const cy = WIDTH_MM / 2;
  return [
    'SetFactory("OpenCASCADE");',
    // Let the background size field own the sizing (standard gmsh recipe).
    "Mesh.CharacteristicLengthExtendFromBoundary = 0;",
    "Mesh.CharacteristicLengthFromPoints = 0;",
    "Mesh.CharacteristicLengthFromCurvature = 0;",
    "Mesh.CharacteristicLengthMin = 1.2;",
    "Mesh.CharacteristicLengthMax = 6;",
    `Box(1) = {0, 0, 0, ${LENGTH_MM}, ${WIDTH_MM}, ${THICKNESS_MM}};`,
    // Overshoot the cylinder through both faces so the boolean cut never
    // resolves coincident surfaces at the ends.
    `Cylinder(2) = {${cx}, ${cy}, -1, 0, 0, ${THICKNESS_MM + 2}, ${HOLE_RADIUS_MM}};`,
    "BooleanDifference(3) = { Volume{1}; Delete; }{ Volume{2}; Delete; };",
    // Local refinement at the hole edge: ~1.5 mm at r = 7.5 growing 0.5 mm
    // per mm of radial distance (plan 013: coarse presets miss Kt badly
    // without hole-edge refinement).
    "Field[1] = MathEval;",
    `Field[1].F = "1.5 + 0.5 * (Sqrt((x-${cx})*(x-${cx}) + (y-${cy})*(y-${cy})) - ${HOLE_RADIUS_MM})";`,
    "Background Field = 1;",
    `fixedSurfaces() = Surface In BoundingBox {-0.001, -0.001, -0.001, 0.001, ${WIDTH_MM + 0.001}, ${THICKNESS_MM + 0.001}};`,
    `loadSurfaces() = Surface In BoundingBox {${LENGTH_MM - 0.001}, -0.001, -0.001, ${LENGTH_MM + 0.001}, ${WIDTH_MM + 0.001}, ${THICKNESS_MM + 0.001}};`,
    'Physical Surface("fixed_end") = {fixedSurfaces()};',
    'Physical Surface("load_end") = {loadSurfaces()};',
    'Physical Volume("solid") = {3};'
  ].join("\n");
}

describe("plate-with-hole Kt benchmark (WASM mesher, plan 013)", () => {
  let artifact: CoreVolumeMeshArtifact;
  let model: OpenCAEModelJson;
  const mappingDiagnostics: SelectionMappingDiagnostic[] = [];

  beforeAll(async () => {
    // Linear gmsh elements at the curved hole (mirroring the bracket policy:
    // native curved Tet10 can invert around drilled holes), then straight-
    // sided elevation to Tet10 for stress accuracy.
    const meshed = await meshGeoScriptToMshV2(plateWithHoleGeoScript(), { elementOrder: 1 });
    const tet4Artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, {
      units: "mm",
      sourceSelectionRefs: {
        fixed_end: { sourceSelectionRef: "FS1" },
        load_end: { sourceSelectionRef: "L1" }
      },
      diagnostics: ["plate-with-hole Kt benchmark"]
    });
    // Same first-class quality gate the mesh worker enforces for wasm sessions.
    enforceWasmMeshQualityGate(tet4Artifact, meshed.qualityMinSICN, "Plate-with-hole benchmark meshing");
    artifact = elevateVolumeMeshArtifactToTet10(tet4Artifact);

    model = buildCoreModelFromCloudMesh({
      study: {
        id: "study-plate-with-hole-kt",
        type: "static_stress",
        materialAssignments: [{ materialId: "mat-steel" }],
        constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "FS1" }],
        loads: [{
          id: "load-tension",
          type: "force",
          selectionRef: "L1",
          parameters: { value: APPLIED_FORCE_N, units: "N", direction: [1, 0, 0] }
        }]
      },
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: { elementOrder: 2 },
      mappingDiagnostics
    });
  }, 600_000);

  it("meshes with hole-edge refinement, one component, and clean quality", () => {
    // Element floor guards against silently losing the local refinement
    // (measured 2,909 Tet10 with the hole-edge field; a uniform 6 mm mesh
    // produces far fewer).
    expect(artifact.metadata.elementCount).toBeGreaterThan(2200);
    expect(artifact.metadata.connectedComponentCount).toBe(1);
    expect(artifact.metadata.meshQuality.invertedElementCount).toBe(0);
    expect(artifact.metadata.meshQuality.minSICN).toBeGreaterThanOrEqual(0.05);
    expect(artifact.elements[0]?.type).toBe("Tet10");
  });

  it("maps the fixed and loaded ends via bySelection, never the geometric fallback", () => {
    expect(mappingDiagnostics).toHaveLength(2);
    for (const diagnostic of mappingDiagnostics) {
      expect(["bySelection", "byFace"]).toContain(diagnostic.mode);
      expect(diagnostic.matchedFacetCount).toBeGreaterThan(0);
    }
  });

  it("recovers Kt_net ≈ 2.42 within ±15% with reaction balance ≤ 1%", { timeout: 600_000 }, () => {
    const outcome = solveStudyModelWithCorePipeline({
      model,
      analysisType: "static_stress",
      solverSettings: { elementOrder: 2 },
      limits: { ...BROWSER_SOLVE_LIMITS, maxDofs: 200_000 }
    });
    expect(outcome.ok, outcome.ok ? undefined : JSON.stringify(outcome.error)).toBe(true);
    if (!outcome.ok) return;

    const summary = (outcome.result as { summary: { maxStress: number; reactionForce: number; maxDisplacement: number } }).summary;
    const sigmaPeakOracle = KT_NET_ORACLE * SIGMA_NET_MPA;
    const measuredKt = summary.maxStress / SIGMA_NET_MPA;

    // Reaction balance: |R - P| / P <= 1% (plan 013 gate).
    expect(Math.abs(summary.reactionForce - APPLIED_FORCE_N) / APPLIED_FORCE_N).toBeLessThanOrEqual(REACTION_TOLERANCE);

    // Stress concentration: peak von Mises within ±15% of Kt_net * sigma_net.
    expect(summary.maxStress).toBeGreaterThanOrEqual(sigmaPeakOracle * (1 - KT_TOLERANCE));
    expect(summary.maxStress).toBeLessThanOrEqual(sigmaPeakOracle * (1 + KT_TOLERANCE));

    console.log(
      `[plate-with-hole Kt] nodes=${artifact.metadata.nodeCount} elements=${artifact.metadata.elementCount} ` +
        `minSICN=${artifact.metadata.meshQuality.minSICN?.toFixed(3)} ` +
        `sigma_net=${SIGMA_NET_MPA.toFixed(3)}MPa Kt_oracle=${KT_NET_ORACLE.toFixed(3)} ` +
        `peakVM=${summary.maxStress.toFixed(3)}MPa Kt_measured=${measuredKt.toFixed(3)} ` +
        `(ratio ${(measuredKt / KT_NET_ORACLE).toFixed(3)}) reaction=${summary.reactionForce.toFixed(2)}N applied=${APPLIED_FORCE_N}N`
    );
  });
});
