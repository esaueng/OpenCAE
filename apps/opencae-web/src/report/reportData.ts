import { assessResultFailure, classifyResultProvenance } from "@opencae/schema";
import type { DisplayModel, Project, ResultField, ResultSummary, RunTimingEstimate, Study } from "@opencae/schema";
import { starterMaterials } from "@opencae/materials";
import type { SolverMeshSummary } from "../resultFields";
import { fieldWithOwnValueRange, formatResultValue } from "../resultFields";
import { unitsForLoadType } from "../loadPreview";
import type { CapturedResultView, ResultViewCaptures } from "./captureResultViews";
import {
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
  solverMethodForResult,
  solverRunnerLabelForResult,
  type UnitSystem
} from "../unitDisplay";
import {
  INVALID_REACTION_WARNING,
  PREVIEW_GEOMETRY_WARNING,
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
  units: string;
  caption: string;
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
  keyResults: ReportRow[];
  failureAssessment: NonNullable<ResultSummary["failureAssessment"]>;
  geometry: ReportRow[];
  geometryFiles: ReportTable;
  materials: ReportTable;
  supports: ReportTable;
  loads: ReportTable;
  mesh: ReportRow[];
  solver: ReportRow[];
  figures: {
    stress: ReportFigure;
    displacement: ReportFigure;
  };
  results: ReportRow[];
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
}

const MISSING = "--";
const FOOTER_DISCLAIMER = "Development-grade analysis. Not a substitute for professional engineering review.";

export function buildReportData(input: BuildReportDataInput): ReportData {
  const summary = resultSummaryForUnits(input.resultSummary, input.unitSystem);
  const fields = input.resultFields.map((field) => resultFieldForUnits(field, input.unitSystem));
  const assessment = summary.failureAssessment ?? assessResultFailure(summary);
  const provenance = summary.provenance;
  const provenanceTier = classifyResultProvenance(provenance);
  const stressField = fieldForReport(fields, "stress", input.captures.stress);
  const displacementField = fieldForReport(fields, "displacement", input.captures.displacement);
  const meshSummary = input.solverMeshSummary ?? input.study.meshSettings.summary ?? null;
  const actualMeshCounts = input.solverMeshSummary?.source === "core_solver" || input.study.meshSettings.summary?.source === "core_solver";
  const generatedAtIso = input.generatedAt.toISOString();
  const reportDate = generatedAtIso.slice(0, 10);
  const diagnostics = collectDiagnostics(input, summary, fields);

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
    keyResults: [
      { label: "Max von Mises stress", value: formatResultMetric(summary.maxStress, summary.maxStressUnits) },
      { label: "Max displacement", value: formatResultMetric(summary.maxDisplacement, summary.maxDisplacementUnits) },
      { label: "Safety factor", value: String(summary.safetyFactor) },
      { label: "Reaction force", value: formatResultMetric(summary.reactionForce, summary.reactionForceUnits) },
      { label: "Failure check", value: assessment.title }
    ],
    failureAssessment: assessment,
    geometry: geometryRows(input.project, input.displayModel),
    geometryFiles: {
      headers: ["File", "Format", "Size"],
      rows: input.project.geometryFiles.map((geometry) => [geometry.filename, geometryFormat(geometry.filename), geometryFileSize(geometry.metadata)]),
      emptyMessage: "No geometry file recorded."
    },
    materials: materialTable(input.study, input.unitSystem),
    supports: supportTable(input.study),
    loads: loadTable(input.study, input.unitSystem),
    mesh: [
      { label: "Preset", value: humanize(input.study.meshSettings.preset) },
      { label: "Nodes", value: meshCount(meshSummary?.nodes, actualMeshCounts) },
      { label: "Elements", value: meshCount(meshSummary?.elements, actualMeshCounts) },
      { label: "Element type", value: elementTypeForMesh(provenance?.meshSource) },
      { label: "Source", value: input.solverMeshSummary ? "Core solver" : formatMeshSourceLabel(provenance?.meshSource, input.displayModel ?? undefined) },
      { label: "Warnings", value: input.study.meshSettings.summary?.warnings.length ? input.study.meshSettings.summary.warnings.join("; ") : "None" }
    ],
    solver: solverRows(input, summary),
    figures: {
      stress: figureData("Von Mises stress", stressField, input.captures.stress, fields, input),
      displacement: figureData("Displacement magnitude", displacementField, input.captures.displacement, fields, input)
    },
    results: resultRows(input.project, input.study, summary, input.displayModel),
    transientResults: transientRows(summary),
    diagnostics,
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
  return `OpenCAE-Report_${slug || "opencae-project"}_${generatedAt.toISOString().slice(0, 10)}.pdf`;
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
    source = "Structured block (procedural proxy)";
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

function materialTable(study: Study, unitSystem: UnitSystem): ReportTable {
  return {
    headers: ["Material / target", "Young's modulus", "Poisson ratio", "Density", "Yield strength"],
    rows: study.materialAssignments.map((assignment) => {
      const material = starterMaterials.find((candidate) => candidate.id === assignment.materialId);
      return [
        `${material?.name ?? assignment.materialId} / ${selectionLabel(study, assignment.selectionRef)}`,
        material ? formatMaterialStress(material.youngsModulus, unitSystem) : MISSING,
        material ? String(material.poissonRatio) : MISSING,
        material ? formatDensity(material.density, "kg/m^3", unitSystem) : MISSING,
        material?.yieldStrength ? formatMaterialStress(material.yieldStrength, unitSystem) : MISSING
      ];
    }),
    emptyMessage: "No material assignments recorded."
  };
}

function supportTable(study: Study): ReportTable {
  return {
    headers: ["Support", "Target"],
    rows: study.constraints.map((constraint) => [
      constraint.type === "fixed" ? "Fixed support" : "Prescribed displacement",
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
        load.type === "force" ? "Force" : load.type === "pressure" ? "Pressure" : "Gravity / payload mass",
        converted ? formatResultMetric(converted.value, converted.units) : MISSING,
        formatDirection(load.parameters.direction),
        selectionLabel(study, load.selectionRef)
      ];
    }),
    emptyMessage: "No loads recorded."
  };
}

function solverRows(input: BuildReportDataInput, summary: ResultSummary): ReportRow[] {
  const provenance = summary.provenance;
  const settings = input.study.solverSettings;
  const rows: ReportRow[] = [
    { label: "Analysis type", value: input.study.type === "dynamic_structural" ? "Dynamic structural" : "Static stress" },
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
  return rows;
}

function resultRows(project: Project, study: Study, summary: ResultSummary, displayModel: DisplayModel | null): ReportRow[] {
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
    { label: "Safety factor", value: String(summary.safetyFactor) },
    { label: "Failure check", value: assessment.title },
    { label: "Reaction force", value: formatResultMetric(summary.reactionForce, summary.reactionForceUnits) }
  ];
}

function transientRows(summary: ResultSummary): ReportRow[] {
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
    legendMin: field ? formatResultValue(field.min) : MISSING,
    legendMax: field ? formatResultValue(field.max) : MISSING,
    units: field?.units || MISSING,
    caption: `${title}${field?.units ? ` (${field.units})` : ""}.${frameCaption} ${deformationCaption}.`
  };
}

function collectDiagnostics(input: BuildReportDataInput, summary: ResultSummary, fields: ResultField[]): string[] {
  const entries = new Set<string>();
  for (const diagnostic of summary.diagnostics ?? []) entries.add(diagnostic.message);
  if (input.displayModel && shouldBlockPreviewResultsForDisplayModel(input.displayModel, summary, fields, input.study)) entries.add(PREVIEW_GEOMETRY_WARNING);
  const legacyWarning = legacyResultWarningForProvenance(summary.provenance);
  if (legacyWarning) entries.add(legacyWarning);
  if (hasInvalidReactionForce(summary, input.study) || hasUnavailableReactionDiagnostic(summary)) entries.add(INVALID_REACTION_WARNING);
  if (!hasResultUnit(summary.maxStressUnits) || !hasResultUnit(summary.maxDisplacementUnits) || !hasResultUnit(summary.reactionForceUnits) || fields.some((field) => !hasResultUnit(field.units))) {
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
