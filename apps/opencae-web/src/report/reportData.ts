import { assessResultFailure, classifyResultProvenance, estimateAllowableLoadForSafetyFactor, isModalResultSummary, isStructuralResultSummary, isThermalResultSummary } from "@opencae/schema";
import type { DisplayModel, FailureAssessment, Material, ModalResultSummary, Project, ResultField, ResultSummary, RunTimingEstimate, StructuralResultSummary, Study, ThermalResultSummary } from "@opencae/schema";
import {
  effectiveMaterialProperties,
  manufacturingProcessForId,
  normalizeManufacturingParameters,
  resolveMaterial,
  type ManufacturingParameters,
  type ManufacturingProcess
} from "@opencae/materials";
import { inferGlobalCriticalPrintAxis } from "@opencae/study-core";
import type { SolverMeshSummary } from "../resultFields";
import { fieldWithOwnValueRange, formatResultValue } from "../resultFields";
import { unitsForLoadType } from "../loadPreview";
import type { CapturedBoundaryView, CapturedResultView, ResultViewCaptures } from "./captureResultViews";
import {
  displayModelForUnits,
  formatDensity,
  formatMaterialStress,
  formatMeshSourceLabel,
  formatResultMetric,
  formatResultProvenanceLabel,
  hasResultUnit,
  legacyResultWarningForProvenance,
  loadValueForUnits,
  resultFieldForUnits,
  resultSummaryForUnits,
  roundDisplayValue,
  solverMethodForResult,
  solverRunnerLabelForResult,
  type UnitSystem
} from "../unitDisplay";
import {
  INVALID_REACTION_WARNING,
  PREVIEW_GEOMETRY_WARNING,
  canShowReverseLoadCapacity,
  hasInvalidReactionForce,
  hasUnavailableReactionDiagnostic,
  shouldBlockPreviewResultsForDisplayModel
} from "../resultProvenance";

export interface ReportRow {
  label: string;
  value: string;
}

export interface ReportTable {
  headers: string[];
  rows: string[][];
  emptyMessage?: string;
}

export interface ReportFigure {
  title: string;
  png?: string;
  unavailableLabel: string;
  legendMin: string;
  legendMax: string;
  caption: string;
}

export interface ReportBoundaryFigure {
  title: string;
  png?: string;
  unavailableLabel: string;
  caption: string;
  /** Marker-key lines explaining the viewer annotations visible in the capture. */
  markerKey: string[];
}

export interface ReportData {
  pageFormat: "a4" | "letter";
  filename: string;
  generatedAtIso: string;
  reportDate: string;
  title: string;
  projectName: string;
  studyName: string;
  unitSystemLabel: string;
  provenanceTier: ReturnType<typeof classifyResultProvenance>;
  provenanceLabel: string;
  coverMeta: ReportRow[];
  keyResults: ReportRow[];
  failureAssessment: FailureAssessment;
  geometry: ReportRow[];
  geometryFiles: ReportTable;
  materials: ReportTable;
  manufacturing: ReportTable;
  supports: ReportTable;
  loads: ReportTable;
  boundaryFigure: ReportBoundaryFigure;
  mesh: ReportRow[];
  solver: ReportRow[];
  figures: {
    stress: ReportFigure;
    displacement: ReportFigure;
  };
  results: ReportRow[];
  loadCapacity: ReportRow[];
  transientResults: ReportRow[];
  diagnostics: string[];
  includeSmoothingDisclaimer: boolean;
  footerDisclaimer: string;
}

export interface BuildReportDataInput {
  project: Project;
  study: Study;
  displayModel: DisplayModel | null;
  resultSummary: ResultSummary;
  resultFields: ResultField[];
  solverMeshSummary: SolverMeshSummary | null;
  runTiming: RunTimingEstimate | null;
  unitSystem: UnitSystem;
  captures: ResultViewCaptures;
  generatedAt: Date;
  exaggeration: number;
  showDeformed?: boolean;
  /** Reverse-check target from the results panel; defaults to 1.5 like the panel. */
  targetSafetyFactor?: number;
}

const MISSING = "--";
const FOOTER_DISCLAIMER = "Development-grade analysis. Not a substitute for professional engineering review.";

export function buildReportData(input: BuildReportDataInput): ReportData {
  const summary = resultSummaryForUnits(input.resultSummary, input.unitSystem);
  const fields = input.resultFields.map((field) => resultFieldForUnits(field, input.unitSystem));
  if (isModalResultSummary(summary)) return buildModalReportData(input, summary, fields);
  if (isThermalResultSummary(summary)) return buildThermalReportData(input, summary, fields);
  const assessment = summary.failureAssessment ?? assessResultFailure(summary);
  const provenance = summary.provenance;
  const provenanceTier = classifyResultProvenance(provenance);
  const stressField = fieldForReport(fields, "stress", input.captures.stress);
  const displacementField = fieldForReport(fields, "displacement", input.captures.displacement);
  const meshSummary = input.solverMeshSummary ?? input.study.meshSettings.summary ?? null;
  const actualMeshCounts = input.solverMeshSummary?.source === "core_solver" || input.study.meshSettings.summary?.source === "core_solver";
  const generatedAtIso = input.generatedAt.toISOString();
  const reportDate = localIsoDate(input.generatedAt);
  const diagnostics = collectDiagnostics(input, summary, fields);
  // Same governing-axis inference the solver adapter uses, so the as-analyzed
  // material row reproduces the properties the solve actually ran with.
  const criticalLayerAxis = input.displayModel
    ? inferGlobalCriticalPrintAxis(input.study, input.displayModel.faces.map((face) => ({
        entityId: face.id,
        center: face.center,
        ...(face.area ? { areaM2: face.area * 1e-6 } : {})
      })), input.displayModel)
    : undefined;

  return {
    pageFormat: input.unitSystem === "US" ? "letter" : "a4",
    filename: suggestedReportFilename(input.project.name, input.generatedAt),
    generatedAtIso,
    reportDate,
    title: input.study.type === "dynamic_structural" ? "Dynamic Structural Simulation Report" : "Structural Simulation Report",
    projectName: input.project.name,
    studyName: input.study.name,
    unitSystemLabel: input.unitSystem === "US" ? "US (in, psi)" : "SI (m, Pa)",
    provenanceTier,
    provenanceLabel: formatResultProvenanceLabel(provenance),
    coverMeta: coverMetaRows(input, summary, meshSummary),
    keyResults: [
      { label: "Max von Mises stress", value: formatResultMetric(summary.maxStress, summary.maxStressUnits) },
      { label: "Max displacement", value: formatResultMetric(summary.maxDisplacement, summary.maxDisplacementUnits) },
      { label: "Safety factor", value: String(roundDisplayValue(summary.safetyFactor)) },
      { label: "Reaction force", value: formatResultMetric(summary.reactionForce, summary.reactionForceUnits) }
    ],
    failureAssessment: assessment,
    geometry: geometryRows(input.project, input.displayModel ? displayModelForUnits(input.displayModel, input.unitSystem) : null),
    geometryFiles: {
      headers: ["File", "Format", "Size"],
      rows: input.project.geometryFiles.map((geometry) => [
        geometry.filename,
        isSampleGeometryFile(geometry) ? "Sample placeholder (procedural geometry)" : geometryFormat(geometry.filename),
        geometryFileSize(geometry.metadata)
      ]),
      emptyMessage: "No geometry file recorded."
    },
    materials: materialTable(input.study, input.unitSystem, criticalLayerAxis, input.project.customMaterials),
    manufacturing: manufacturingTable(input.study, input.project.customMaterials),
    supports: supportTable(input.study),
    loads: loadTable(input.study, input.unitSystem),
    boundaryFigure: boundaryFigureData(input.study, input.captures.boundary),
    mesh: [
      { label: "Preset", value: humanize(input.study.meshSettings.preset) },
      { label: "Nodes", value: meshCount(meshSummary?.nodes, actualMeshCounts) },
      { label: "Elements", value: meshCount(meshSummary?.elements, actualMeshCounts) },
      { label: "Element type", value: elementTypeForMesh(provenance?.meshSource) },
      { label: "Source", value: input.solverMeshSummary ? "Core solver" : formatMeshSourceLabel(provenance?.meshSource, input.displayModel ?? undefined) },
      { label: "Warnings", value: input.study.meshSettings.summary?.warnings.length ? input.study.meshSettings.summary.warnings.map(userFacingMeshWarning).join("; ") : "None" }
    ],
    solver: solverRows(input, summary),
    figures: {
      stress: figureData("Von Mises stress", stressField, input.captures.stress, fields, input),
      displacement: figureData("Displacement magnitude", displacementField, input.captures.displacement, fields, input)
    },
    results: resultRows(input.project, input.study, summary, input.displayModel),
    loadCapacity: loadCapacityRows(input, summary, fields),
    transientResults: transientRows(summary),
    diagnostics,
    includeSmoothingDisclaimer: provenance?.kind === "opencae_core_fea",
    footerDisclaimer: FOOTER_DISCLAIMER
  };
}

function buildModalReportData(input: BuildReportDataInput, summary: ModalResultSummary, fields: ResultField[]): ReportData {
  const provenance = summary.provenance;
  const meshSummary = input.solverMeshSummary ?? input.study.meshSettings.summary ?? null;
  const actualMeshCounts = input.solverMeshSummary?.source === "core_solver" || input.study.meshSettings.summary?.source === "core_solver";
  const generatedAtIso = input.generatedAt.toISOString();
  const reportDate = localIsoDate(input.generatedAt);
  const firstMode = summary.modes[0];
  const lastMode = summary.modes[summary.modes.length - 1];
  const modeField = fieldForReport(fields, "mode_shape", input.captures.displacement);
  const assessment: FailureAssessment = summary.convergedModeCount === summary.requestedModeCount
    ? { status: "pass", title: "Requested modes converged", message: `All ${summary.requestedModeCount} requested modes met the scaled residual tolerance.` }
    : { status: "warning", title: "Partial modal convergence", message: summary.warning ?? `${summary.convergedModeCount} of ${summary.requestedModeCount} requested modes converged.` };
  const criticalLayerAxis = input.displayModel
    ? inferGlobalCriticalPrintAxis(input.study, input.displayModel.faces.map((face) => ({
        entityId: face.id,
        center: face.center,
        ...(face.area ? { areaM2: face.area * 1e-6 } : {})
      })), input.displayModel)
    : undefined;
  const diagnostics = new Set<string>((summary.diagnostics ?? []).map((diagnostic) => diagnostic.message));
  if (summary.warning) diagnostics.add(summary.warning);
  for (const warning of input.solverMeshSummary?.warnings ?? []) diagnostics.add(warning);
  const modalFigure = figureData("Normalized mode shape", modeField, input.captures.displacement, fields, input);
  return {
    pageFormat: input.unitSystem === "US" ? "letter" : "a4",
    filename: suggestedReportFilename(input.project.name, input.generatedAt),
    generatedAtIso,
    reportDate,
    title: "Modal Analysis Report",
    projectName: input.project.name,
    studyName: input.study.name,
    unitSystemLabel: input.unitSystem === "US" ? "US (in, psi)" : "SI (m, Pa)",
    provenanceTier: classifyResultProvenance(provenance),
    provenanceLabel: formatResultProvenanceLabel(provenance),
    coverMeta: coverMetaRows(input, summary, meshSummary),
    keyResults: [
      { label: "Requested modes", value: String(summary.requestedModeCount) },
      { label: "Converged modes", value: String(summary.convergedModeCount) },
      { label: "First frequency", value: firstMode ? `${Number(firstMode.frequencyHz.toPrecision(6))} Hz` : MISSING },
      { label: "Highest returned frequency", value: lastMode ? `${Number(lastMode.frequencyHz.toPrecision(6))} Hz` : MISSING }
    ],
    failureAssessment: assessment,
    geometry: geometryRows(input.project, input.displayModel ? displayModelForUnits(input.displayModel, input.unitSystem) : null),
    geometryFiles: {
      headers: ["File", "Format", "Size"],
      rows: input.project.geometryFiles.map((geometry) => [geometry.filename, geometryFormat(geometry.filename), geometryFileSize(geometry.metadata)]),
      emptyMessage: "No geometry file recorded."
    },
    materials: materialTable(input.study, input.unitSystem, criticalLayerAxis, input.project.customMaterials),
    manufacturing: manufacturingTable(input.study, input.project.customMaterials),
    supports: supportTable(input.study),
    loads: { headers: ["Load", "Magnitude", "Direction", "Target"], rows: [], emptyMessage: "Applied loads are not used in modal analysis." },
    boundaryFigure: boundaryFigureData(input.study, input.captures.boundary),
    mesh: [
      { label: "Preset", value: humanize(input.study.meshSettings.preset) },
      { label: "Nodes", value: meshCount(meshSummary?.nodes, actualMeshCounts) },
      { label: "Elements", value: meshCount(meshSummary?.elements, actualMeshCounts) },
      { label: "Element type", value: elementTypeForMesh(provenance?.meshSource) },
      { label: "Source", value: input.solverMeshSummary ? "Core solver" : formatMeshSourceLabel(provenance?.meshSource, input.displayModel ?? undefined) }
    ],
    solver: solverRows(input, summary),
    figures: {
      stress: { title: "Natural frequencies", unavailableLabel: "See modal results table", legendMin: MISSING, legendMax: MISSING, caption: "Natural frequencies are listed in the results table." },
      displacement: modalFigure
    },
    results: [
      { label: "Result source", value: formatResultProvenanceLabel(provenance) },
      { label: "Solver method", value: solverMethodForResult(summary, input.study) },
      { label: "Requested modes", value: String(summary.requestedModeCount) },
      { label: "Converged modes", value: String(summary.convergedModeCount) },
      { label: "Normalization", value: "Maximum nodal vector magnitude = 1" },
      { label: "Shape sign", value: "Deterministic but arbitrary" }
    ],
    loadCapacity: [],
    transientResults: summary.modes.map((mode) => ({
      label: `Mode ${mode.modeIndex}`,
      value: `${Number(mode.frequencyHz.toPrecision(6))} Hz · residual ${mode.scaledResidual.toExponential(3)}`
    })),
    diagnostics: [...diagnostics],
    includeSmoothingDisclaimer: false,
    footerDisclaimer: `${FOOTER_DISCLAIMER} Mode-shape amplitude and phase are visualization-only.`
  };
}

function buildThermalReportData(input: BuildReportDataInput, summary: ThermalResultSummary, fields: ResultField[]): ReportData {
  const provenance = summary.provenance;
  const meshSummary = input.solverMeshSummary ?? input.study.meshSettings.summary ?? null;
  const actualMeshCounts = input.solverMeshSummary?.source === "core_solver" || input.study.meshSettings.summary?.source === "core_solver";
  const temperatureField = fieldForReport(fields, "temperature", input.captures.stress);
  const heatFluxField = fieldForReport(fields, "heat_flux", input.captures.displacement);
  const balancePasses = summary.energyBalanceRelativeError <= 1e-5;
  const assessment: FailureAssessment = balancePasses
    ? { status: "pass", title: "Energy balance converged", message: `The relative steady-state heat balance error is ${formatResultMetric(roundDisplayValue(summary.energyBalanceRelativeError * 100), "%")}.` }
    : { status: "warning", title: "Review energy balance", message: `The relative steady-state heat balance error is ${formatResultMetric(roundDisplayValue(summary.energyBalanceRelativeError * 100), "%")}. Refine the mesh or solver tolerance before design use.` };
  const diagnostics = new Set<string>((summary.diagnostics ?? []).map((diagnostic) => diagnostic.message));
  for (const warning of input.solverMeshSummary?.warnings ?? []) diagnostics.add(warning);
  return {
    pageFormat: input.unitSystem === "US" ? "letter" : "a4",
    filename: suggestedReportFilename(input.project.name, input.generatedAt),
    generatedAtIso: input.generatedAt.toISOString(),
    reportDate: localIsoDate(input.generatedAt),
    title: "Steady-State Thermal Simulation Report",
    projectName: input.project.name,
    studyName: input.study.name,
    unitSystemLabel: input.unitSystem === "US" ? "US display units" : "SI display units",
    provenanceTier: classifyResultProvenance(provenance),
    provenanceLabel: formatResultProvenanceLabel(provenance),
    coverMeta: coverMetaRows(input, summary, meshSummary),
    keyResults: [
      { label: "Minimum temperature", value: formatResultMetric(summary.minTemperature, summary.temperatureUnits) },
      { label: "Maximum temperature", value: formatResultMetric(summary.maxTemperature, summary.temperatureUnits) },
      { label: "Maximum heat flux", value: formatResultMetric(summary.maxHeatFlux, summary.heatFluxUnits) },
      { label: "Energy balance error", value: formatResultMetric(roundDisplayValue(summary.energyBalanceRelativeError * 100), "%") }
    ],
    failureAssessment: assessment,
    geometry: geometryRows(input.project, input.displayModel ? displayModelForUnits(input.displayModel, input.unitSystem) : null),
    geometryFiles: {
      headers: ["File", "Format", "Size"],
      rows: input.project.geometryFiles.map((geometry) => [geometry.filename, geometryFormat(geometry.filename), geometryFileSize(geometry.metadata)]),
      emptyMessage: "No geometry file recorded."
    },
    materials: materialTable(input.study, input.unitSystem, undefined, input.project.customMaterials),
    manufacturing: manufacturingTable(input.study, input.project.customMaterials),
    supports: supportTable(input.study),
    loads: loadTable(input.study, input.unitSystem),
    boundaryFigure: boundaryFigureData(input.study, input.captures.boundary),
    mesh: [
      { label: "Preset", value: humanize(input.study.meshSettings.preset) },
      { label: "Nodes", value: meshCount(meshSummary?.nodes, actualMeshCounts) },
      { label: "Elements", value: meshCount(meshSummary?.elements, actualMeshCounts) },
      { label: "Element type", value: elementTypeForMesh(provenance?.meshSource) },
      { label: "Source", value: input.solverMeshSummary ? "Core solver" : formatMeshSourceLabel(provenance?.meshSource, input.displayModel ?? undefined) }
    ],
    solver: solverRows(input, summary),
    figures: {
      stress: figureData("Temperature", temperatureField, input.captures.stress, fields, input),
      displacement: figureData("Heat flux magnitude", heatFluxField, input.captures.displacement, fields, input)
    },
    results: [
      { label: "Applied surface heat", value: formatResultMetric(summary.appliedHeat, summary.heatRateUnits) },
      { label: "Generated heat", value: formatResultMetric(summary.generatedHeat, summary.heatRateUnits) },
      { label: "Boundary reaction", value: formatResultMetric(summary.reactionHeat, summary.heatRateUnits) },
      { label: "Relative energy balance error", value: formatResultMetric(roundDisplayValue(summary.energyBalanceRelativeError * 100), "%") }
    ],
    loadCapacity: [],
    transientResults: [],
    diagnostics: [...diagnostics],
    includeSmoothingDisclaimer: provenance?.kind === "opencae_core_fea",
    footerDisclaimer: FOOTER_DISCLAIMER
  };
}

export function suggestedReportFilename(projectName: string, generatedAt: Date): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `OpenCAE-Report_${slug || "opencae-project"}_${localIsoDate(generatedAt)}.pdf`;
}

function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function coverMetaRows(input: BuildReportDataInput, summary: ResultSummary, meshSummary: SolverMeshSummary | Study["meshSettings"]["summary"] | null): ReportRow[] {
  const provenance = summary.provenance;
  const version = provenance?.solverVersion ?? provenance?.solverCpuVersion ?? provenance?.coreVersion;
  const elementType = elementTypeForMesh(provenance?.meshSource);
  const elements = Number.isFinite(meshSummary?.elements) ? `${Math.round(meshSummary!.elements).toLocaleString()} elements` : undefined;
  const mesh = [elementType === MISSING ? undefined : elementType, elements].filter(Boolean).join(" · ");
  return [
    { label: "Solver", value: formatResultProvenanceLabel(provenance) },
    { label: "Version", value: version ?? MISSING },
    { label: "Method", value: solverMethodForResult(summary, input.study) },
    { label: "Mesh", value: mesh || MISSING }
  ];
}

function geometryRows(project: Project, displayModel: DisplayModel | null): ReportRow[] {
  const geometry = displayModel?.coreCloudGeometry;
  let source = "No geometry available";
  if (geometry?.kind === "sample_procedural") {
    source = `Sample model: ${humanize(geometry.sampleId ?? displayModel?.name ?? "procedural")} (procedural)`;
  } else if (geometry?.kind === "uploaded_cad") {
    source = `Uploaded CAD: ${geometry.filename ?? displayModel?.nativeCad?.filename ?? displayModel?.name ?? MISSING}`;
  } else if (geometry?.kind === "uploaded_mesh") {
    source = `Uploaded mesh: ${geometry.filename ?? displayModel?.visualMesh?.filename ?? displayModel?.name ?? MISSING}`;
  } else if (geometry?.kind === "structured_block") {
    source = geometry.sampleId
      ? `Sample model: ${humanize(geometry.sampleId)} (procedural)`
      : "Structured block (procedural proxy)";
  } else if (displayModel?.nativeCad) {
    source = `Uploaded CAD: ${displayModel.nativeCad.filename}`;
  } else if (displayModel?.visualMesh) {
    source = `Uploaded mesh: ${displayModel.visualMesh.filename}`;
  } else if (project.geometryFiles[0]?.metadata.source === "sample") {
    source = `Sample model: ${humanize(String(project.geometryFiles[0].metadata.sampleModel ?? displayModel?.name ?? "procedural"))} (procedural)`;
  }

  return [
    { label: "Source", value: source },
    { label: "Display model", value: displayModel?.name ?? MISSING },
    { label: "Bodies", value: displayModel ? String(displayModel.bodyCount) : MISSING },
    { label: "Dimensions", value: displayModel?.dimensions
      ? `${displayModel.dimensions.x} × ${displayModel.dimensions.y} × ${displayModel.dimensions.z} ${displayModel.dimensions.units}`
      : MISSING }
  ];
}

function materialTable(
  study: Study,
  unitSystem: UnitSystem,
  criticalLayerAxis: "x" | "y" | "z" | undefined,
  customMaterials: Project["customMaterials"]
): ReportTable {
  return {
    headers: ["Material / target", "Young's modulus", "Poisson ratio", "Density", "Yield strength"],
    rows: study.materialAssignments.flatMap((assignment) => {
      const material = tryResolveReportMaterial(assignment.materialId, customMaterials);
      const datasheetRow = [
        `${material ? reportMaterialName(material) : assignment.materialId} / ${selectionLabel(study, assignment.selectionRef)}`,
        material ? formatMaterialStress(material.youngsModulus, unitSystem) : MISSING,
        material ? String(material.poissonRatio) : MISSING,
        material ? formatDensity(material.density, "kg/m^3", unitSystem) : MISSING,
        material?.yieldStrength ? formatMaterialStress(material.yieldStrength, unitSystem) : MISSING
      ];
      if (!material) return [datasheetRow];
      // Additive processes knock properties down before the solve; report the
      // homogenized values alongside the datasheet ones so the numbers the
      // solver used are on the record.
      const process = assignmentProcess(material, assignment.parameters);
      const effective = effectiveMaterialProperties(material, assignment.parameters ?? {}, { criticalLayerAxis });
      if (!process || process.kind !== "additive" || effective === material) return [datasheetRow];
      return [datasheetRow, [
        `As analyzed (${process.shortLabel}, homogenized)`,
        formatMaterialStress(effective.youngsModulus, unitSystem),
        String(effective.poissonRatio),
        formatDensity(effective.density, "kg/m^3", unitSystem),
        Number.isFinite(effective.yieldStrength) ? formatMaterialStress(effective.yieldStrength, unitSystem) : MISSING
      ]];
    }),
    emptyMessage: "No material assignments recorded."
  };
}

function manufacturingTable(study: Study, customMaterials: Project["customMaterials"]): ReportTable {
  return {
    headers: ["Material / target", "Process", "Process settings"],
    rows: study.materialAssignments.map((assignment) => {
      const material = tryResolveReportMaterial(assignment.materialId, customMaterials);
      const target = `${material ? reportMaterialName(material) : assignment.materialId} / ${selectionLabel(study, assignment.selectionRef)}`;
      if (!material) return [target, MISSING, MISSING];
      const process = assignmentProcess(material, assignment.parameters);
      if (!process) return [target, MISSING, MISSING];
      const explicitProcess = typeof assignment.parameters?.manufacturingProcessId === "string";
      const parameters = normalizeManufacturingParameters(material, assignment.parameters ?? {});
      return [
        target,
        explicitProcess ? process.label : `${process.label} (assumed)`,
        manufacturingSettingsLabel(process, parameters)
      ];
    }),
    emptyMessage: "No material assignments recorded."
  };
}

function tryResolveReportMaterial(materialId: string, customMaterials: Project["customMaterials"]): Material | undefined {
  try {
    return resolveMaterial(materialId, customMaterials);
  } catch {
    return undefined;
  }
}

function reportMaterialName(material: Material): string {
  return (material as Material & { verification?: string }).verification === "user_supplied_unverified"
    ? `${material.name} (user-supplied, unverified)`
    : material.name;
}

function assignmentProcess(material: Material, parameters: Record<string, unknown> | undefined): ManufacturingProcess | undefined {
  const processId = normalizeManufacturingParameters(material, parameters ?? {}).manufacturingProcessId;
  return processId ? manufacturingProcessForId(processId) : undefined;
}

function manufacturingSettingsLabel(process: ManufacturingProcess, parameters: ManufacturingParameters): string {
  const buildDirection = `${(parameters.layerOrientation ?? "z").toUpperCase()} build direction`;
  if (process.settingsKind === "fdm") {
    const wallCount = parameters.wallCount ?? 1;
    return `${wallCount} ${wallCount === 1 ? "wall" : "walls"} · ${parameters.infillDensity ?? 100}% infill · ${buildDirection}`;
  }
  if (process.settingsKind === "build_direction") return buildDirection;
  return process.description;
}

function supportTable(study: Study): ReportTable {
  return {
    headers: ["Support", "Target"],
    rows: study.constraints.map((constraint) => [
      constraint.type === "fixed" ? "Fixed support" : constraint.type === "prescribed_temperature" ? `Prescribed temperature (${Number(constraint.parameters.value ?? 0)} ${String(constraint.parameters.units ?? "°C")})` : "Prescribed displacement",
      selectionLabel(study, constraint.selectionRef)
    ]),
    emptyMessage: "No supports recorded."
  };
}

function loadTable(study: Study, unitSystem: UnitSystem): ReportTable {
  return {
    headers: ["Load", "Magnitude", "Direction", "Target"],
    rows: study.loads.map((load) => {
      const rawValue = Number(load.parameters.value);
      const rawUnits = typeof load.parameters.units === "string" ? load.parameters.units : unitsForLoadType(load.type);
      const converted = Number.isFinite(rawValue) ? loadValueForUnits(rawValue, rawUnits, unitSystem) : null;
      return [
        reportLoadTypeLabel(load.type),
        converted ? formatResultMetric(roundDisplayValue(converted.value), converted.units) : MISSING,
        formatDirection(load.parameters.direction),
        load.type === "bolt_preload" && typeof load.parameters.secondarySelectionRef === "string"
          ? `${selectionLabel(study, load.selectionRef)} ↔ ${selectionLabel(study, load.parameters.secondarySelectionRef)}`
          : selectionLabel(study, load.selectionRef)
      ];
    }),
    emptyMessage: "No loads recorded."
  };
}

function boundaryFigureData(study: Study, capture: CapturedBoundaryView | undefined): ReportBoundaryFigure {
  const supportCount = study.constraints.length;
  const loadCount = study.loads.length;
  const hasPayloadMass = study.loads.some((load) => load.type === "gravity");
  return {
    title: "Boundary conditions on model",
    ...(capture ? { png: capture.png } : {}),
    unavailableLabel: "Not captured for this run — open the Results view once, then regenerate the report.",
    caption: "Support and load markers as placed in the study, shown on the undeformed model.",
    markerKey: [
      ...(supportCount ? [`FS n — fixed support on the constrained face (${supportCount} in this study)`] : []),
      ...(loadCount ? [`L n — applied load at its application point; the arrow shows the load direction (${loadCount} in this study)`] : []),
      ...(hasPayloadMass ? ["Payload-mass loads are marked at the payload body with a leader instead of an arrow."] : [])
    ]
  };
}

function reportLoadTypeLabel(type: Study["loads"][number]["type"]): string {
  if (type === "heat_flux") return "Surface heat flux";
  if (type === "heat_generation") return "Volumetric heat generation";
  if (type === "force") return "Face force (total)";
  if (type === "pressure") return "Pressure";
  if (type === "surface_traction") return "Surface traction";
  if (type === "volume_force") return "Volume force";
  if (type === "remote_force") return "Remote force (distributed wrench)";
  if (type === "bolt_preload") return "Equivalent bolt preload (bonded-linear)";
  return "Gravity / payload mass";
}

function solverRows(input: BuildReportDataInput, summary: ResultSummary): ReportRow[] {
  const provenance = summary.provenance;
  const settings = input.study.solverSettings;
  const rows: ReportRow[] = [
    { label: "Analysis type", value: input.study.type === "dynamic_structural" ? "Dynamic structural" : input.study.type === "modal_analysis" ? "Modal analysis" : input.study.type === "steady_state_thermal" ? "Steady-state thermal" : "Static stress" },
    { label: "Backend", value: settings.backend === "opencae_core_local" ? "OpenCAE Core local" : "Automatic (local-first)" },
    { label: "Fidelity", value: humanize(settings.fidelity ?? "standard") },
    { label: "Solver method", value: solverMethodForResult(summary, input.study) },
    { label: "Core version", value: provenance?.coreVersion ?? MISSING },
    { label: "Solver version", value: provenance?.solverCpuVersion ?? provenance?.solverVersion ?? MISSING },
    { label: "Runner version", value: provenance?.runnerVersion ?? MISSING },
    { label: "Solve wall time", value: Number.isFinite(input.runTiming?.elapsedMs) ? formatDuration(input.runTiming!.elapsedMs!) : MISSING }
  ];
  if (input.study.type === "dynamic_structural") {
    rows.push(
      { label: "Integration method", value: humanize(input.study.solverSettings.integrationMethod) },
      { label: "Time step", value: `${input.study.solverSettings.timeStep} s` },
      { label: "End time", value: `${input.study.solverSettings.endTime} s` },
      { label: "Output interval", value: `${input.study.solverSettings.outputInterval} s` },
      { label: "Damping ratio", value: String(input.study.solverSettings.dampingRatio) },
      { label: "Load profile", value: humanize(provenance?.loadProfile ?? input.study.solverSettings.loadProfile) }
    );
  }
  if (input.study.type === "modal_analysis") rows.push({ label: "Requested modes", value: String(input.study.solverSettings.modeCount) });
  return rows;
}

function resultRows(project: Project, study: Study, summary: StructuralResultSummary, displayModel: DisplayModel | null): ReportRow[] {
  const provenance = summary.provenance;
  const assessment = summary.failureAssessment ?? assessResultFailure(summary);
  return [
    { label: "Result source", value: formatResultProvenanceLabel(provenance) },
    { label: "Core solver version", value: provenance?.solverVersion ?? provenance?.solverCpuVersion ?? provenance?.coreVersion ?? MISSING },
    { label: "Core model schema version", value: project.schemaVersion },
    { label: "Mesh source", value: formatMeshSourceLabel(provenance?.meshSource, displayModel ?? undefined) },
    { label: "Solver method", value: solverMethodForResult(summary, study) },
    { label: "Runner", value: solverRunnerLabelForResult(provenance) },
    { label: "Local fallback", value: "none" },
    { label: "Max stress", value: formatResultMetric(summary.maxStress, summary.maxStressUnits) },
    { label: "Max displacement", value: formatResultMetric(summary.maxDisplacement, summary.maxDisplacementUnits) },
    { label: "Safety factor", value: String(roundDisplayValue(summary.safetyFactor)) },
    { label: "Failure check", value: assessment.title },
    { label: "Reaction force", value: formatResultMetric(summary.reactionForce, summary.reactionForceUnits) }
  ];
}

const DEFAULT_TARGET_SAFETY_FACTOR = 1.5;

// Mirrors the results panel's Reverse Check gating: only report a load
// capacity when the reaction force is trustworthy and units are intact.
function loadCapacityRows(input: BuildReportDataInput, summary: StructuralResultSummary, fields: ResultField[]): ReportRow[] {
  const target = Number.isFinite(input.targetSafetyFactor) && input.targetSafetyFactor! > 0
    ? input.targetSafetyFactor!
    : DEFAULT_TARGET_SAFETY_FACTOR;
  const atTarget = estimateAllowableLoadForSafetyFactor(summary, target);
  const atYield = estimateAllowableLoadForSafetyFactor(summary, 1);
  const unitsIntact = hasResultUnit(summary.maxStressUnits) && hasResultUnit(summary.maxDisplacementUnits) && hasResultUnit(summary.reactionForceUnits) && fields.every((field) => hasResultUnit(field.units));
  if (!unitsIntact || atTarget.status !== "available" || !input.displayModel || !canShowReverseLoadCapacity(summary, input.displayModel, fields, input.study)) {
    return [];
  }
  return [
    { label: "Current applied load", value: formatResultMetric(roundDisplayValue(atTarget.currentLoad), atTarget.loadUnits) },
    { label: "Max theoretical load (at FoS 1.0)", value: formatResultMetric(roundDisplayValue(atYield.allowableLoad), atYield.loadUnits) },
    { label: "Target factor of safety", value: String(roundDisplayValue(target)) },
    { label: "Max load at target FoS", value: `${formatResultMetric(roundDisplayValue(atTarget.allowableLoad), atTarget.loadUnits)} (${roundDisplayValue(atTarget.loadScale)}x current)` }
  ];
}

function transientRows(summary: StructuralResultSummary): ReportRow[] {
  const transient = summary.transient;
  if (!transient) return [];
  return [
    { label: "Transient analysis", value: "Dynamic structural" },
    { label: "Integration method", value: humanize(transient.integrationMethod ?? "newmark_average_acceleration") },
    { label: "Start time", value: `${transient.startTime} s` },
    { label: "End time", value: `${transient.endTime} s` },
    { label: "Time step", value: `${transient.timeStep} s` },
    { label: "Output interval", value: `${transient.outputInterval} s` },
    { label: "Damping ratio", value: transient.dampingRatio === undefined ? MISSING : String(transient.dampingRatio) },
    { label: "Frames", value: String(transient.frameCount) },
    { label: "Peak displacement", value: `${transient.peakDisplacement} ${summary.maxDisplacementUnits} at ${transient.peakDisplacementTimeSeconds} s` }
  ];
}

function figureData(
  title: string,
  field: ResultField | undefined,
  capture: CapturedResultView | undefined,
  fields: ResultField[],
  input: BuildReportDataInput
): ReportFigure {
  const frameCaption = capture?.selection === "peak" && capture.frameIndex !== undefined
    ? ` Automatically selected peak ${lowercaseFirst(title)} frame (${framePositionLabel(fields, capture.frameIndex)}${capture.timeSeconds === undefined ? "" : `, ${capture.timeSeconds.toFixed(4)} s`}).`
    : "";
  const deformationCaption = input.showDeformed
    ? `Deformed shape, ×${formatResultValue(input.exaggeration)} exaggeration (display only)`
    : "Undeformed shape";
  return {
    title,
    ...(capture?.png ? { png: capture.png } : {}),
    unavailableLabel: "Not available (--)",
    legendMin: field ? legendValueWithUnits(field.min, field.units) : MISSING,
    legendMax: field ? legendValueWithUnits(field.max, field.units) : MISSING,
    caption: `${title}${field?.units ? ` (${field.units})` : ""}.${frameCaption} ${deformationCaption}.`
  };
}

function legendValueWithUnits(value: number, units: string): string {
  const formatted = formatResultValue(value);
  return hasResultUnit(units) ? `${formatted} ${units}` : formatted;
}

function collectDiagnostics(input: BuildReportDataInput, summary: ResultSummary, fields: ResultField[]): string[] {
  const entries = new Set<string>();
  for (const diagnostic of summary.diagnostics ?? []) entries.add(diagnostic.message);
  if (input.displayModel && shouldBlockPreviewResultsForDisplayModel(input.displayModel, summary, fields, input.study)) entries.add(PREVIEW_GEOMETRY_WARNING);
  const legacyWarning = legacyResultWarningForProvenance(summary.provenance);
  if (legacyWarning) entries.add(legacyWarning);
  if (hasInvalidReactionForce(summary, input.study) || hasUnavailableReactionDiagnostic(summary)) entries.add(INVALID_REACTION_WARNING);
  if (isStructuralResultSummary(summary) && (!hasResultUnit(summary.maxStressUnits) || !hasResultUnit(summary.maxDisplacementUnits) || !hasResultUnit(summary.reactionForceUnits) || fields.some((field) => !hasResultUnit(field.units)))) {
    entries.add("Unit missing");
  }
  for (const warning of input.solverMeshSummary?.warnings ?? []) entries.add(warning);
  return [...entries];
}

function fieldForReport(fields: ResultField[], type: ResultField["type"], capture?: CapturedResultView): ResultField | undefined {
  const candidates = fields.filter((field) => field.type === type);
  if (capture) {
    const capturedField = candidates.find((field) => field.id === capture.fieldId);
    if (capturedField) return fieldWithOwnValueRange(capturedField);
    if (capture.frameIndex !== undefined) {
      const active = candidates.find((field) => field.frameIndex === capture.frameIndex && field.location === "node")
        ?? candidates.find((field) => field.frameIndex === capture.frameIndex);
      if (active) return fieldWithOwnValueRange(active);
    }
  }
  const fallback = candidates.find((field) => field.location === "node")
    ?? candidates.find((field) => field.location === "face")
    ?? candidates[0];
  return fallback ? fieldWithOwnValueRange(fallback) : undefined;
}

function framePositionLabel(fields: ResultField[], frameIndex: number): string {
  const frameIndexes = [...new Set(fields
    .map((field) => field.frameIndex)
    .filter((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate)))]
    .sort((left, right) => left - right);
  const ordinal = frameIndexes.indexOf(frameIndex);
  return ordinal >= 0 ? `frame ${ordinal + 1} of ${frameIndexes.length}` : `solver frame ${frameIndex}`;
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value;
}

function meshCount(value: number | undefined, actual: boolean): string {
  if (!Number.isFinite(value)) return MISSING;
  return `${Math.round(value!).toLocaleString()}${actual ? "" : " (est.)"}`;
}

function elementTypeForMesh(meshSource: ResultSummary["provenance"] extends infer _P ? NonNullable<ResultSummary["provenance"]>["meshSource"] | undefined : never): string {
  if (meshSource === "actual_volume_mesh" || meshSource === "structured_block_core") return "Tet10";
  if (meshSource === "opencae_core_tet4") return "Tet4";
  return MISSING;
}

function selectionLabel(study: Study, selectionRef: string): string {
  return study.namedSelections.find((selection) => selection.id === selectionRef)?.name ?? selectionRef ?? MISSING;
}

// Saved demo projects persist the internal seed-data phrasing; translate it at
// the report boundary so customer PDFs never show mock-mesh jargon.
const USER_FACING_MESH_WARNINGS: Record<string, string> = {
  "Small feature simplified for the mock mesh.": "Small features simplified in the demo mesh preview."
};

function userFacingMeshWarning(warning: string): string {
  return USER_FACING_MESH_WARNINGS[warning] ?? warning;
}

// Sample geometry "files" are display names only — no CAD data exists, so the
// report must not present them as customer CAD that was meshed.
function isSampleGeometryFile(geometry: Project["geometryFiles"][number]): boolean {
  return geometry.metadata.source === "sample" || typeof geometry.metadata.sampleModel === "string";
}

function geometryFormat(filename: string): string {
  const extension = filename.split(".").pop()?.toUpperCase();
  if (extension === "STP") return "STEP";
  return extension || MISSING;
}

function geometryFileSize(metadata: Record<string, unknown>): string {
  const embedded = metadata.embeddedModel;
  const embeddedSize = embedded && typeof embedded === "object" ? Number((embedded as { size?: unknown }).size) : Number.NaN;
  const bytes = [embeddedSize, Number(metadata.originalSize), Number(metadata.size)].find((candidate) => Number.isFinite(candidate) && candidate >= 0);
  if (bytes === undefined) return MISSING;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDirection(value: unknown): string {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return `[${value.join(", ")}]`;
  }
  return typeof value === "string" && value ? value : MISSING;
}

function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)} ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1000).toFixed(1)} s`;
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.round((elapsedMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
