import type { OpenCAEModelJson } from "@opencae/core";
import {
  buildCoreModelFromCloudMesh,
  elevateVolumeMeshArtifactToTet10,
  enforceWasmMeshQualityGate,
  meshGeoScriptToMshV2,
  meshStepToMshV2,
  parseGmshMeshToCoreVolumeMesh,
  attributeFacetsToStepFaces,
  type CoreVolumeMeshArtifact,
  type SelectionMappingDiagnostic
} from "@opencae/mesh-intake";
import { BROWSER_SOLVE_LIMITS, solveStudyModelWithCorePipeline } from "@opencae/solve-pipeline";
import { isStructuralResultSummary, StudySchema, type DisplayModel, type StructuralResultSummary } from "@opencae/schema";
import { trySolveOpenCaeCoreStudy } from "../workers/opencaeCoreSolve";
import { buildStepFaceRegistry, stepAttributionForRegistry } from "../stepFaces";
import { STEP_PROOF_LOAD_NEWTONS, stepProofScenario, studyWithWasmMeshSummary } from "../workers/stepProofScenario";
import boxWithBoreStep from "../../../../libs/opencae-mesh-intake/fixtures/box-with-bore.step?raw";
import type { ValidationBenchmarkId, ValidationBenchmarkResult, ValidationMetric } from "./benchmarkRegistry";

const FORCE_N = 500;
const YOUNG_PA = 200e9;
const POISSON = 0.29;
const CANTILEVER_LENGTH_M = 0.18;
const CANTILEVER_SIDE_M = 0.024;
const CANTILEVER_INERTIA_M4 = (CANTILEVER_SIDE_M * CANTILEVER_SIDE_M ** 3) / 12;
const CANTILEVER_AREA_M2 = CANTILEVER_SIDE_M ** 2;
const CANTILEVER_TIP_MM = 1000 * (
  (FORCE_N * CANTILEVER_LENGTH_M ** 3) / (3 * YOUNG_PA * CANTILEVER_INERTIA_M4)
  + (FORCE_N * CANTILEVER_LENGTH_M) / ((5 / 6) * (YOUNG_PA / (2 * (1 + POISSON))) * CANTILEVER_AREA_M2)
);
const CANTILEVER_STRESS_MPA = (FORCE_N * CANTILEVER_LENGTH_M * (CANTILEVER_SIDE_M / 2) / CANTILEVER_INERTIA_M4) / 1e6;

const cantileverDisplayModel: DisplayModel = {
  id: "display-validation-cantilever",
  name: "Validation cantilever",
  bodyCount: 1,
  dimensions: { x: 180, y: 24, z: 24, units: "mm" },
  faces: [
    { id: "face-fixed", label: "Fixed", color: "#94a3b8", center: [0, 12, 12], normal: [-1, 0, 0], stressValue: 0 },
    { id: "face-load", label: "Load", color: "#94a3b8", center: [180, 12, 12], normal: [1, 0, 0], stressValue: 0 }
  ]
};

const WIDTH_MM = 60;
const LENGTH_MM = 120;
const THICKNESS_MM = 6;
const HOLE_DIAMETER_MM = 15;
const PLATE_FORCE_N = 1000;
const HOLE_RADIUS_MM = HOLE_DIAMETER_MM / 2;
const D_OVER_W = HOLE_DIAMETER_MM / WIDTH_MM;
const KT_NET_ORACLE = 2 + (1 - D_OVER_W) ** 3;
const SIGMA_NET_MPA = PLATE_FORCE_N / ((WIDTH_MM - HOLE_DIAMETER_MM) * THICKNESS_MM);
const BENCH_MESH_SIZE_MM = 2.22;

export async function runValidationBenchmark(id: ValidationBenchmarkId): Promise<ValidationBenchmarkResult> {
  const startedAt = performance.now();
  const measuredAt = new Date().toISOString();
  if (id === "cantilever-static") return runCantilever(startedAt, measuredAt);
  if (id === "plate-with-hole") return runPlateWithHole(startedAt, measuredAt);
  return runScale100k(startedAt, measuredAt);
}

function runCantilever(startedAt: number, measuredAt: string): ValidationBenchmarkResult {
  const study = StudySchema.parse({
    id: "study-validation-cantilever",
    projectId: "project-validation",
    name: "Cantilever validation",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }],
    materialAssignments: [{ id: "mat-assignment", materialId: "mat-steel", selectionRef: "selection-body", parameters: {}, status: "complete" }],
    namedSelections: [
      { id: "selection-body", name: "Body", entityType: "body", geometryRefs: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Body" }], fingerprint: "body" },
      { id: "selection-fixed", name: "Fixed", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-fixed", label: "Fixed" }], fingerprint: "fixed" },
      { id: "selection-load", name: "Load", entityType: "face", geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load", label: "Load" }], fingerprint: "load" }
    ],
    contacts: [],
    constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
    loads: [{ id: "load-force", type: "force", selectionRef: "selection-load", parameters: { value: FORCE_N, units: "N", direction: [0, 0, -1] }, status: "complete" }],
    meshSettings: { preset: "medium", status: "complete", meshRef: "validation/mesh.json" },
    solverSettings: { backend: "opencae_core_local", fidelity: "standard" },
    validation: [],
    runs: []
  });
  const outcome = trySolveOpenCaeCoreStudy({ study, runId: "run-validation-cantilever", displayModel: cantileverDisplayModel });
  if (!outcome.ok) throw new Error(outcome.reason);
  if (!isStructuralResultSummary(outcome.result.summary)) throw new Error("Cantilever validation returned non-structural results.");
  const summary = outcome.result.summary;
  const metrics: ValidationMetric[] = [
    { id: "tip-displacement", label: "Tip displacement", value: summary.maxDisplacement, units: summary.maxDisplacementUnits, reference: CANTILEVER_TIP_MM, tolerancePercent: 3 },
    { id: "root-stress", label: "Peak von Mises", value: summary.maxStress, units: summary.maxStressUnits, reference: CANTILEVER_STRESS_MPA, tolerancePercent: 35 },
    { id: "reaction", label: "Reaction", value: summary.reactionForce, units: summary.reactionForceUnits, reference: FORCE_N, tolerancePercent: 0.2 }
  ];
  return result("cantilever-static", measuredAt, startedAt, metrics, [
    `${outcome.solverBackend}`,
    `Displacement ratio ${(summary.maxDisplacement / CANTILEVER_TIP_MM).toFixed(4)}`,
    `Stress ratio ${(summary.maxStress / CANTILEVER_STRESS_MPA).toFixed(4)}`
  ]);
}

async function runPlateWithHole(startedAt: number, measuredAt: string): Promise<ValidationBenchmarkResult> {
  const meshed = await meshGeoScriptToMshV2(plateWithHoleGeoScript(), { elementOrder: 1 });
  const tet4 = parseGmshMeshToCoreVolumeMesh(meshed.msh, {
    units: "mm",
    sourceSelectionRefs: {
      fixed_end: { sourceSelectionRef: "FS1" },
      load_end: { sourceSelectionRef: "L1" }
    },
    diagnostics: ["in-app plate-with-hole validation"]
  });
  enforceWasmMeshQualityGate(tet4, meshed.qualityMinSICN, "Plate-with-hole validation");
  const artifact = elevateVolumeMeshArtifactToTet10(tet4);
  const model = plateModel(artifact);
  const outcome = solveStudyModelWithCorePipeline({
    model,
    analysisType: "static_stress",
    solverSettings: { elementOrder: 2 },
    limits: { ...BROWSER_SOLVE_LIMITS, maxDofs: 200_000 }
  });
  if (!outcome.ok) throw new Error(outcome.error.message);
  const summary = structuralSummary(outcome.result.summary);
  const measuredKt = summary.maxStress / SIGMA_NET_MPA;
  const metrics: ValidationMetric[] = [
    { id: "kt", label: "Net-section Kt", value: measuredKt, units: "", reference: KT_NET_ORACLE, tolerancePercent: 15 },
    { id: "reaction", label: "Reaction", value: summary.reactionForce, units: summary.reactionForceUnits, reference: PLATE_FORCE_N, tolerancePercent: 1 },
    { id: "quality", label: "Minimum SICN", value: artifact.metadata.meshQuality.minSICN ?? 0, units: "" }
  ];
  return result("plate-with-hole", measuredAt, startedAt, metrics, [
    `${artifact.metadata.nodeCount.toLocaleString()} nodes`,
    `${artifact.metadata.elementCount.toLocaleString()} Tet10 elements`,
    `Peak ${summary.maxStress.toFixed(3)} MPa`
  ]);
}

async function runScale100k(startedAt: number, measuredAt: string): Promise<ValidationBenchmarkResult> {
  const { default: occtimportjs } = await import("occt-import-js");
  const occt = await occtimportjs();
  const imported = occt.ReadStepFile(new TextEncoder().encode(boxWithBoreStep), null);
  if (!imported.success) throw new Error("The 100k validation STEP fixture could not be inspected.");
  const registry = buildStepFaceRegistry(imported.meshes ?? []);
  const contentBase64 = bytesToBase64(new TextEncoder().encode(boxWithBoreStep));
  const scenario = stepProofScenario(registry, { filename: "box-with-bore.step", contentBase64 });
  const meshed = await meshStepToMshV2(boxWithBoreStep, { elementOrder: 2, meshSizeMm: BENCH_MESH_SIZE_MM });
  const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm", diagnostics: ["in-app 100k validation"] });
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
  const dofs = model.nodes.coordinates.length;
  if (dofs < 90_000 || dofs > BROWSER_SOLVE_LIMITS.maxDofs) throw new Error(`Scale validation generated ${dofs} DOF outside the production band.`);
  const study = studyWithWasmMeshSummary({ study: scenario.study, artifact, model, mappingDiagnostics });
  const solveStartedAt = performance.now();
  const outcome = trySolveOpenCaeCoreStudy({ study, runId: "run-validation-100k", displayModel: scenario.displayModel });
  const solveMs = performance.now() - solveStartedAt;
  if (!outcome.ok) throw new Error(outcome.reason);
  const summary = structuralSummary(outcome.result.summary);
  const metrics: ValidationMetric[] = [
    { id: "dofs", label: "Degrees of freedom", value: dofs, units: "DOF" },
    { id: "reaction", label: "Reaction", value: summary.reactionForce, units: summary.reactionForceUnits, reference: STEP_PROOF_LOAD_NEWTONS, tolerancePercent: 1 },
    { id: "solve-time", label: "Solve time", value: solveMs / 1000, units: "s" }
  ];
  return result("scale-100k", measuredAt, startedAt, metrics, [
    `${artifact.metadata.nodeCount.toLocaleString()} Tet10 nodes`,
    `${artifact.metadata.elementCount.toLocaleString()} elements`,
    `${outcome.solverBackend}`
  ]);
}

function plateModel(artifact: CoreVolumeMeshArtifact): OpenCAEModelJson {
  const mappingDiagnostics: SelectionMappingDiagnostic[] = [];
  return buildCoreModelFromCloudMesh({
    study: {
      id: "study-validation-plate",
      type: "static_stress",
      materialAssignments: [{ materialId: "mat-steel" }],
      constraints: [{ id: "constraint-fixed", type: "fixed", selectionRef: "FS1" }],
      loads: [{ id: "load-tension", type: "force", selectionRef: "L1", parameters: { value: PLATE_FORCE_N, units: "N", direction: [1, 0, 0] } }]
    },
    volumeMesh: artifact,
    analysisType: "static_stress",
    solverSettings: { elementOrder: 2 },
    mappingDiagnostics
  });
}

function plateWithHoleGeoScript(): string {
  const cx = LENGTH_MM / 2;
  const cy = WIDTH_MM / 2;
  return [
    'SetFactory("OpenCASCADE");',
    "Mesh.CharacteristicLengthExtendFromBoundary = 0;",
    "Mesh.CharacteristicLengthFromPoints = 0;",
    "Mesh.CharacteristicLengthFromCurvature = 0;",
    "Mesh.CharacteristicLengthMin = 1.2;",
    "Mesh.CharacteristicLengthMax = 6;",
    `Box(1) = {0, 0, 0, ${LENGTH_MM}, ${WIDTH_MM}, ${THICKNESS_MM}};`,
    `Cylinder(2) = {${cx}, ${cy}, -1, 0, 0, ${THICKNESS_MM + 2}, ${HOLE_RADIUS_MM}};`,
    "BooleanDifference(3) = { Volume{1}; Delete; }{ Volume{2}; Delete; };",
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

function result(
  benchmarkId: ValidationBenchmarkId,
  measuredAt: string,
  startedAt: number,
  metrics: ValidationMetric[],
  details: string[]
): ValidationBenchmarkResult {
  const passed = metrics.every((metric) => {
    if (metric.reference === undefined || metric.tolerancePercent === undefined) return Number.isFinite(metric.value);
    if (Math.abs(metric.reference) <= Number.EPSILON) return Math.abs(metric.value) <= Number.EPSILON;
    return (Math.abs(metric.value - metric.reference) / Math.abs(metric.reference)) * 100 <= metric.tolerancePercent;
  });
  return { benchmarkId, passed, measuredAt, durationMs: Math.round(performance.now() - startedAt), metrics, details };
}

function structuralSummary(summary: unknown): StructuralResultSummary {
  if (!summary || typeof summary !== "object" || typeof (summary as { maxStress?: unknown }).maxStress !== "number") {
    throw new Error("Expected structural validation results.");
  }
  return summary as StructuralResultSummary;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
