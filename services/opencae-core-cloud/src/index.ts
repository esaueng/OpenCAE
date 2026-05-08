import {
  OPENCAE_CORE_VERSION,
  solverSurfaceMeshFromModel,
  validateCoreResult,
  validateModelJson,
  volumeMeshToModelJson,
  type OpenCAEModelJson,
  type ValidationIssue
} from "@opencae/core";
import { solveCoreDynamic, solveCoreStatic, type DynamicLoadProfile } from "@opencae/solver-cpu";

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

const RUNNER_VERSION = "0.1.0";
const SOLVER_CPU_VERSION = "0.1.0";
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
      supportsActualVolumeMesh: true,
      supportsPreview: false
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
    ? solveCoreDynamic(model, dynamicOptions(solveRequest))
    : solveCoreStatic(model, { method: "sparse", solverMode: "sparse" });

  if (!result.ok) return diagnosticResponse(422, [solverIssue(result.error.code, result.error.message)]);

  const validationReport = validateCoreResult(result.result);
  if (!validationReport.ok) return diagnosticResponse(422, validationReport.errors);
  const coreResult = withCloudProvenance({
    ...result.result,
    surfaceMesh: result.result.surfaceMesh ?? solverSurfaceMeshFromModel(model),
    diagnostics: [...result.result.diagnostics, result.diagnostics]
  }, model, analysisType);

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

function dynamicOptions(request: CoreCloudSolveRequest) {
  const settings = request.solverSettings ?? {};
  const resultSettings = request.resultSettings ?? {};
  return {
    startTime: numberOption(settings.startTime),
    endTime: numberOption(settings.endTime),
    timeStep: numberOption(settings.timeStep),
    outputInterval: numberOption(settings.outputInterval),
    dampingRatio: numberOption(settings.dampingRatio),
    rayleighAlpha: numberOption(settings.rayleighAlpha),
    rayleighBeta: numberOption(settings.rayleighBeta),
    loadProfile: dynamicLoadProfileOption(settings.loadProfile),
    maxFrames: numberOption(resultSettings.maxFrames)
  };
}

function withCloudProvenance(result: Record<string, unknown>, model: OpenCAEModelJson, analysisType: "static_stress" | "dynamic_structural") {
  const meshSource = model.meshProvenance?.meshSource === "structured_block_core" ? "structured_block_core" : "actual_volume_mesh";
  const fields = Array.isArray(result.fields)
    ? result.fields.map((field) => ({ ...field, provenance: cloudProvenance(meshSource, analysisType) }))
    : [];
  return {
    ...result,
    fields,
    provenance: cloudProvenance(meshSource, analysisType)
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

function compactVisualizationPayload(result: Record<string, unknown>, settings: CoreCloudSolveRequest["resultSettings"]): Record<string, unknown> {
  const maxFieldValues = integerOption(settings?.maxFieldValues);
  const maxFrames = integerOption(settings?.maxFrames);
  let fields = Array.isArray(result.fields) ? result.fields : [];
  if (maxFrames && maxFrames > 1) fields = compactFrames(fields, maxFrames);
  if (maxFieldValues && maxFieldValues > 1) {
    fields = fields.map((field) => {
      if (!field || typeof field !== "object" || !Array.isArray((field as { values?: unknown }).values)) return field;
      return {
        ...field,
        values: downsample((field as { values: number[] }).values, maxFieldValues)
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
  if (values.length <= maxValues) return values;
  const output: T[] = [];
  const last = values.length - 1;
  for (let index = 0; index < maxValues; index += 1) {
    output.push(values[Math.round((index / (maxValues - 1)) * last)]!);
  }
  return output;
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

function dynamicLoadProfileOption(value: unknown): DynamicLoadProfile | undefined {
  return value === "step" || value === "ramp" || value === "quasiStatic" || value === "quasi_static" || value === "sinusoidal"
    ? value
    : undefined;
}
