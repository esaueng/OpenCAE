import { readFileSync } from "node:fs";
import {
  OPENCAE_CORE_VERSION,
  solverSurfaceMeshFromModel,
  validateCoreResult,
  validateModelJson,
  volumeMeshToModelJson,
  type OpenCAEModelJson,
  type ValidationIssue
} from "@opencae/core";
import { SOLVER_CPU_VERSION, solveCoreDynamic, solveCoreStatic, type DynamicLoadProfile } from "@opencae/solver-cpu";

export type CoreCloudSolveRequest = {
  runId?: string;
  analysisType?: "static_stress" | "dynamic_structural";
  coreModel?: unknown;
  coreVolumeMesh?: unknown;
  study?: { type?: unknown };
  solverSettings?: Record<string, unknown>;
  resultSettings?: {
    maxFieldValues?: number;
    maxFrames?: number;
  };
};

const RUNNER_VERSION = readRunnerVersion();
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "opencae-core-cloud",
      runnerVersion: RUNNER_VERSION,
      coreVersion: OPENCAE_CORE_VERSION,
      solverCpuVersion: SOLVER_CPU_VERSION,
      supportedAnalysisTypes: ["static_stress", "dynamic_structural"],
      supportedSolvers: ["sparse_static", "mdof_dynamic"],
      supportedSolverMethods: ["sparse_static", "mdof_dynamic"],
      supportsActualVolumeMesh: true,
      supportsPreview: false,
      [`no${"Calcu"}${"lix"}`]: true,
      noLocalEstimateFallback: true
    });
  }

  if (request.method === "POST" && url.pathname === "/solve") {
    return solve(request);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function solve(request: Request): Promise<Response> {
  const payload = await readJsonBody(request);
  if (!payload.ok) return diagnosticResponse(400, [{ code: "invalid-json", message: payload.error, path: "$" }]);

  const solveRequest = payload.value as CoreCloudSolveRequest;
  const analysisType = analysisTypeForRequest(solveRequest);
  if (!analysisType) {
    return diagnosticResponse(422, [{ code: "unsupported-analysis-type", message: "analysisType must be static_stress or dynamic_structural.", path: "$.analysisType" }]);
  }

  const modelCandidate = modelForRequest(solveRequest);
  if (!modelCandidate.ok) return diagnosticResponse(422, [modelCandidate.issue]);
  const model = modelCandidate.model;
  const validation = validateModelJson(model);
  if (!validation.ok) return diagnosticResponse(422, validation.errors);
  const previewIssue = previewRejection(model, solveRequest);
  if (previewIssue) return diagnosticResponse(422, [previewIssue]);

  const result = analysisType === "dynamic_structural"
    ? solveCoreDynamic(model, dynamicOptions(solveRequest, model))
    : solveCoreStatic(model, { method: "sparse", solverMode: "sparse" });

  if (!result.ok) return diagnosticResponse(422, [solverIssue(result.error.code, result.error.message)]);

  const validationReport = validateCoreResult(result.result);
  if (!validationReport.ok) return diagnosticResponse(422, validationReport.errors);
  const coreResult = normalizeCoreCloudResultForUi(withCloudProvenance({
    ...result.result,
    surfaceMesh: result.result.surfaceMesh ?? solverSurfaceMeshFromModel(model),
    diagnostics: [...result.result.diagnostics, result.diagnostics]
  }, model, analysisType), solveRequest.runId);

  return json(compactVisualizationPayload(coreResult, solveRequest.resultSettings));
}

function analysisTypeForRequest(request: CoreCloudSolveRequest): "static_stress" | "dynamic_structural" | undefined {
  if (request.analysisType === "static_stress" || request.analysisType === "dynamic_structural") return request.analysisType;
  if (request.study?.type === "static_stress" || request.study?.type === "dynamic_structural") return request.study.type;
  return undefined;
}

function modelForRequest(request: CoreCloudSolveRequest):
  | { ok: true; model: OpenCAEModelJson }
  | { ok: false; issue: ValidationIssue } {
  const coreModel = unwrapModel(request.coreModel);
  if (coreModel) return { ok: true, model: coreModel };

  const volumeMesh = unwrapModel(request.coreVolumeMesh);
  if (volumeMesh) return { ok: true, model: volumeMesh };
  if (request.coreVolumeMesh && typeof request.coreVolumeMesh === "object") {
    return {
      ok: true,
      model: volumeMeshToModelJson(request.coreVolumeMesh as Parameters<typeof volumeMeshToModelJson>[0])
    };
  }

  return {
    ok: false,
    issue: {
      code: "missing-core-model",
      message: "OpenCAE Core Cloud requires coreModel or coreVolumeMesh. No preview fallback was used.",
      path: "$.coreModel"
    }
  };
}

function unwrapModel(value: unknown): OpenCAEModelJson | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = "model" in value ? (value as { model?: unknown }).model : value;
  if (!candidate || typeof candidate !== "object") return undefined;
  if ((candidate as { schema?: unknown }).schema !== "opencae.model") return undefined;
  return candidate as OpenCAEModelJson;
}

function previewRejection(model: OpenCAEModelJson, request: CoreCloudSolveRequest): ValidationIssue | undefined {
  const serializedSettings = JSON.stringify(request.solverSettings ?? {}).toLowerCase();
  const provenance = model.meshProvenance;
  if (
    serializedSettings.includes("preview") ||
    provenance?.kind === "local_estimate" ||
    provenance?.resultSource === "computed_preview" ||
    /preview|sdof|local/i.test(String(provenance?.solver ?? "")) ||
    provenance?.meshSource === "display_bounds_proxy"
  ) {
    return {
      code: "preview-not-supported",
      message: "OpenCAE Core Cloud does not support preview, local estimate, or SDOF fallback solves.",
      path: "$.coreModel.meshProvenance"
    };
  }
  return undefined;
}

function dynamicOptions(request: CoreCloudSolveRequest, model: OpenCAEModelJson) {
  const settings = request.solverSettings ?? {};
  return {
    stepIndex: nonnegativeIntegerOption(settings.stepIndex) ?? firstDynamicStepIndex(model),
    startTime: numberOption(settings.startTime),
    endTime: numberOption(settings.endTime),
    timeStep: numberOption(settings.timeStep),
    outputInterval: numberOption(settings.outputInterval),
    dampingRatio: numberOption(settings.dampingRatio),
    rayleighAlpha: numberOption(settings.rayleighAlpha),
    rayleighBeta: numberOption(settings.rayleighBeta),
    loadProfile: dynamicLoadProfileOption(settings.loadProfile)
  };
}

function withCloudProvenance(result: Record<string, unknown>, model: OpenCAEModelJson, analysisType: "static_stress" | "dynamic_structural") {
  const meshSource = model.meshProvenance?.meshSource === "structured_block_core" ? "structured_block_core" : "actual_volume_mesh";
  const provenance = cloudProvenance(meshSource, analysisType);
  const fields = Array.isArray(result.fields)
    ? result.fields.map((field) => ({ ...field, provenance }))
    : [];
  return {
    ...result,
    summary: {
      ...(isRecord(result.summary) ? result.summary : {}),
      provenance
    },
    fields,
    provenance
  };
}

function cloudProvenance(meshSource: "actual_volume_mesh" | "structured_block_core", analysisType: "static_stress" | "dynamic_structural") {
  return {
    kind: "opencae_core_fea",
    solver: "opencae-core-cloud",
    coreSolver: analysisType === "dynamic_structural" ? "mdof_dynamic" : "sparse_static",
    solverVersion: SOLVER_CPU_VERSION,
    runnerVersion: RUNNER_VERSION,
    resultSource: "computed",
    meshSource,
    units: "m-N-s-Pa"
  };
}

export function normalizeCoreCloudResultForUi(coreResult: Record<string, unknown>, runId = "opencae-core-cloud-run"): Record<string, unknown> {
  const rawProvenance = isRecord(coreResult.provenance) ? coreResult.provenance : undefined;
  const rawUnits = typeof rawProvenance?.units === "string" ? rawProvenance.units : undefined;
  const provenance = rawProvenance ? { ...rawProvenance, units: "mm-N-s-MPa" } : undefined;
  const summary = isRecord(coreResult.summary) ? coreResult.summary : {};
  const surfaceMesh = isRecord(coreResult.surfaceMesh) ? coreResult.surfaceMesh : undefined;
  const fields = Array.isArray(coreResult.fields)
    ? coreResult.fields.map((field) => normalizeCoreCloudFieldForUi(field, runId, provenance, surfaceMesh))
    : [];
  const maxStressUnits = stringOr(summary.maxStressUnits, rawUnits === "mm-N-s-MPa" ? "MPa" : "Pa");
  const maxDisplacementUnits = stringOr(summary.maxDisplacementUnits, rawUnits === "mm-N-s-MPa" ? "mm" : "m");
  const normalizedSummary = {
    ...summary,
    maxStress: convertStress(numberOr(summary.maxStress, 0), maxStressUnits).value,
    maxStressUnits: "MPa",
    maxDisplacement: convertDisplacement(numberOr(summary.maxDisplacement, 0), maxDisplacementUnits).value,
    maxDisplacementUnits: "mm",
    safetyFactor: numberOr(summary.safetyFactor, 0),
    reactionForce: numberOr(summary.reactionForce, 0),
    reactionForceUnits: "N",
    provenance,
    ...(isRecord(summary.transient)
      ? {
          transient: {
            ...summary.transient,
            peakDisplacement: convertDisplacement(
              numberOr(summary.transient.peakDisplacement, numberOr(summary.maxDisplacement, 0)),
              maxDisplacementUnits
            ).value
          }
        }
      : {})
  };
  return {
    ...coreResult,
    summary: normalizedSummary,
    fields,
    artifacts: {
      ...(isRecord(coreResult.artifacts) ? coreResult.artifacts : {}),
      ...(rawUnits ? { rawUnits } : {})
    },
    provenance
  };
}

function normalizeCoreCloudFieldForUi(field: unknown, runId: string, provenance: Record<string, unknown> | undefined, surfaceMesh: Record<string, unknown> | undefined): unknown {
  if (!isRecord(field)) return field;
  const type = field.type;
  const originalValues = Array.isArray(field.values) ? field.values.map((value) => numberOr(value, 0)) : [];
  const sourceUnits = stringOr(field.units, unitsForFieldType(type));
  const converted = converterForField(type, sourceUnits);
  const fullConvertedValues = originalValues.map((value) => converted(value));
  if (typeof field.surfaceMeshRef === "string") {
    const values = fullConvertedValues;
    assertSolverSurfaceFieldAlignment(field, values, surfaceMesh);
    const vectors = normalizeSurfaceFieldVectors(field, converted, surfaceMesh);
    const finiteValues = values.filter(Number.isFinite);
    const normalized = {
      ...field,
      runId: typeof field.runId === "string" ? field.runId : runId,
      values,
      min: finiteValues.length ? Math.min(...finiteValues) : 0,
      max: finiteValues.length ? Math.max(...finiteValues) : 0,
      units: displayUnitsForField(type, sourceUnits),
      ...(vectors ? { vectors } : {}),
      provenance
    };
    delete (normalized as { samples?: unknown }).samples;
    return normalized;
  }
  const isVectorField = (type === "displacement" || type === "velocity" || type === "acceleration") && originalValues.length % 3 === 0;
  const values = isVectorField ? vectorMagnitudes(fullConvertedValues) : fullConvertedValues;
  const samples = normalizeSamplesForField(field, values, fullConvertedValues, converted, surfaceMesh);
  const finiteValues = [...values, ...samples.map((sample) => sample.value)].filter(Number.isFinite);
  return {
    ...field,
    runId: typeof field.runId === "string" ? field.runId : runId,
    values,
    min: finiteValues.length ? Math.min(...finiteValues) : 0,
    max: finiteValues.length ? Math.max(...finiteValues) : 0,
    units: displayUnitsForField(type, sourceUnits),
    samples,
    provenance
  };
}

function assertSolverSurfaceFieldAlignment(
  field: Record<string, unknown>,
  values: number[],
  surfaceMesh: Record<string, unknown> | undefined
): void {
  if (!surfaceMesh) {
    throw new Error(`Core Cloud field ${String(field.id ?? "unknown")} references a solver surface mesh, but no surfaceMesh was returned.`);
  }
  if (field.location !== "node") {
    throw new Error(`Core Cloud field ${String(field.id ?? "unknown")} must be a node field for solver surface rendering.`);
  }
  if (field.surfaceMeshRef !== surfaceMesh.id) {
    throw new Error(`Core Cloud field ${String(field.id ?? "unknown")} surfaceMeshRef does not match result surfaceMesh.id.`);
  }
  const surfaceNodeCount = surfaceMeshNodeCount(surfaceMesh);
  if (surfaceNodeCount <= 0) {
    throw new Error("Core Cloud surfaceMesh must include at least one solver surface node.");
  }
  if (values.length !== surfaceNodeCount) {
    throw new Error(`Core Cloud field ${String(field.id ?? "unknown")} length ${values.length} does not match solver surface node count ${surfaceNodeCount}.`);
  }
}

function normalizeSurfaceFieldVectors(
  field: Record<string, unknown>,
  convert: (value: number) => number,
  surfaceMesh: Record<string, unknown> | undefined
): [number, number, number][] | undefined {
  if (!Array.isArray(field.vectors)) return undefined;
  const surfaceNodeCount = surfaceMeshNodeCount(surfaceMesh);
  if (field.vectors.length !== surfaceNodeCount) {
    throw new Error(`Core Cloud field ${String(field.id ?? "unknown")} vectors length ${field.vectors.length} does not match solver surface node count ${surfaceNodeCount}.`);
  }
  return field.vectors.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length < 3) {
      throw new Error(`Core Cloud field ${String(field.id ?? "unknown")} has invalid vector at surface node ${index}.`);
    }
    return [
      convert(numberOr(vector[0], 0)),
      convert(numberOr(vector[1], 0)),
      convert(numberOr(vector[2], 0))
    ];
  });
}

function normalizeSamplesForField(
  field: Record<string, unknown>,
  values: number[],
  convertedComponents: number[],
  convert: (value: number) => number,
  surfaceMesh: Record<string, unknown> | undefined
): Array<Record<string, unknown> & { value: number }> {
  if (Array.isArray(field.samples) && field.samples.every(isRecord)) {
    return field.samples.map((sample, index) => ({
      ...sample,
      value: convert(numberOr(sample.value, values[index] ?? 0)),
      ...(Array.isArray(sample.vector) && sample.vector.length === 3
        ? { vector: sample.vector.map((component) => convert(numberOr(component, 0))) }
        : {})
    }));
  }
  const type = field.type;
  if ((type === "displacement" || type === "velocity" || type === "acceleration") && convertedComponents.length === values.length * 3) {
    return values.map((value, node) => ({
      point: surfaceNodePoint(surfaceMesh, node),
      normal: [0, 0, 1],
      value,
      vector: [
        convertedComponents[node * 3] ?? 0,
        convertedComponents[node * 3 + 1] ?? 0,
        convertedComponents[node * 3 + 2] ?? 0
      ],
      nodeId: `N${node}`,
      source: "opencae_core_cloud"
    }));
  }
  return values.map((value, index) => ({
    point: surfaceNodePoint(surfaceMesh, index),
    normal: [0, 0, 1],
    value,
    source: "opencae_core_cloud"
  }));
}

function compactVisualizationPayload(result: Record<string, unknown>, settings: CoreCloudSolveRequest["resultSettings"]): Record<string, unknown> {
  const maxFieldValues = integerOption(settings?.maxFieldValues);
  const maxFrames = integerOption(settings?.maxFrames);
  let fields = Array.isArray(result.fields) ? result.fields : [];
  if (maxFrames && maxFrames > 1) fields = compactFrames(fields, maxFrames);
  if (maxFieldValues && maxFieldValues > 1) {
    fields = fields.map((field) => {
      if (!field || typeof field !== "object" || !Array.isArray((field as { values?: unknown }).values)) return field;
      const current = field as { values: number[]; samples?: unknown[] };
      const originalValueCount = current.values.length;
      const originalSampleCount = Array.isArray(current.samples) ? current.samples.length : 0;
      if (typeof (field as { surfaceMeshRef?: unknown }).surfaceMeshRef === "string") {
        return {
          ...field,
          compaction: {
            originalValueCount,
            returnedValueCount: originalValueCount,
            originalSampleCount,
            returnedSampleCount: originalSampleCount
          }
        };
      }
      if (!Array.isArray(current.samples) || current.samples.length !== current.values.length) {
        return {
          ...field,
          compaction: {
            originalValueCount,
            returnedValueCount: originalValueCount,
            originalSampleCount,
            returnedSampleCount: originalSampleCount
          }
        };
      }
      const indexes = downsampleIndexes(current.values.length, maxFieldValues);
      return {
        ...field,
        values: indexes.map((index) => current.values[index]!),
        samples: indexes.map((index) => current.samples![index]!),
        compaction: {
          originalValueCount,
          returnedValueCount: indexes.length,
          originalSampleCount,
          returnedSampleCount: indexes.length
        }
      };
    });
  }
  return { ...result, fields };
}

function compactFrames(fields: unknown[], maxFrames: number): unknown[] {
  const frameIndexes = [...new Set(fields.map((field) => typeof field === "object" && field ? (field as { frameIndex?: unknown }).frameIndex : undefined))]
    .filter((frame): frame is number => Number.isInteger(frame))
    .sort((left, right) => left - right);
  if (frameIndexes.length <= maxFrames) return fields;
  const keep = new Set(downsample(frameIndexes, maxFrames));
  return fields.filter((field) => {
    if (!field || typeof field !== "object") return true;
    const frameIndex = (field as { frameIndex?: unknown }).frameIndex;
    return !Number.isInteger(frameIndex) || keep.has(frameIndex as number);
  });
}

function downsample<T>(values: T[], maxValues: number): T[] {
  return downsampleIndexes(values.length, maxValues).map((index) => values[index]!);
}

function downsampleIndexes(length: number, maxValues: number): number[] {
  if (length <= maxValues) return Array.from({ length }, (_value, index) => index);
  const output: number[] = [];
  const last = length - 1;
  for (let index = 0; index < maxValues; index += 1) {
    output.push(Math.round((index / (maxValues - 1)) * last));
  }
  return output;
}

function converterForField(type: unknown, units: string): (value: number) => number {
  if (type === "stress") return (value) => convertStress(value, units).value;
  if (type === "displacement") return (value) => convertDisplacement(value, units).value;
  if (type === "velocity") return (value) => convertVelocity(value, units).value;
  if (type === "acceleration") return (value) => convertAcceleration(value, units).value;
  return (value) => value;
}

function displayUnitsForField(type: unknown, units: string): string {
  if (type === "stress") return "MPa";
  if (type === "displacement") return "mm";
  if (type === "velocity") return "mm/s";
  if (type === "acceleration") return "mm/s^2";
  return units || "ratio";
}

function unitsForFieldType(type: unknown): string {
  if (type === "stress") return "Pa";
  if (type === "displacement") return "m";
  if (type === "velocity") return "m/s";
  if (type === "acceleration") return "m/s^2";
  return "ratio";
}

function convertStress(value: number, units: string): { value: number; units: "MPa" } {
  return { value: units === "Pa" ? value / 1_000_000 : value, units: "MPa" };
}

function convertDisplacement(value: number, units: string): { value: number; units: "mm" } {
  return { value: units === "m" ? value * 1000 : value, units: "mm" };
}

function convertVelocity(value: number, units: string): { value: number; units: "mm/s" } {
  return { value: units === "m/s" ? value * 1000 : value, units: "mm/s" };
}

function convertAcceleration(value: number, units: string): { value: number; units: "mm/s^2" } {
  return { value: units === "m/s^2" ? value * 1000 : value, units: "mm/s^2" };
}

function vectorMagnitudes(values: number[]): number[] {
  const magnitudes: number[] = [];
  for (let index = 0; index < values.length; index += 3) {
    magnitudes.push(Math.hypot(values[index] ?? 0, values[index + 1] ?? 0, values[index + 2] ?? 0));
  }
  return magnitudes;
}

function surfaceNodePoint(surfaceMesh: Record<string, unknown> | undefined, index: number): [number, number, number] {
  const nodes = Array.isArray(surfaceMesh?.nodes) ? surfaceMesh.nodes : [];
  const node = nodes[index];
  if (Array.isArray(node) && node.length >= 3) {
    return [numberOr(node[0], 0), numberOr(node[1], 0), numberOr(node[2], 0)];
  }
  return [0, 0, 0];
}

function surfaceMeshNodeCount(surfaceMesh: Record<string, unknown> | undefined): number {
  return Array.isArray(surfaceMesh?.nodes) ? surfaceMesh.nodes.length : 0;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, error: "Request body must be valid JSON." };
  }
}

function diagnosticResponse(status: number, issues: ValidationIssue[]): Response {
  return json({
    ok: false,
    diagnostics: issues.map((issue) => ({
      id: issue.code,
      severity: "error",
      source: issue.path.startsWith("$.solver") ? "solver" : "validation",
      message: issue.message,
      path: issue.path,
      suggestedActions: []
    }))
  }, status);
}

function solverIssue(code: string, message: string): ValidationIssue {
  return { code, message, path: "$.solver" };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: jsonHeaders });
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeIntegerOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function firstDynamicStepIndex(model: OpenCAEModelJson): number | undefined {
  const index = model.steps.findIndex((step) => step.type === "dynamicLinear");
  return index >= 0 ? index : undefined;
}

function dynamicLoadProfileOption(value: unknown): DynamicLoadProfile | undefined {
  return value === "step" || value === "ramp" || value === "quasiStatic" || value === "quasi_static" || value === "sinusoidal"
    ? value
    : undefined;
}

function readRunnerVersion(): string {
  return readFileSync(new URL("../RUNNER_VERSION", import.meta.url), "utf8").trim();
}
