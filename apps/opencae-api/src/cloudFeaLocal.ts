import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import {
  ResultFieldSchema,
  ResultSummarySchema,
  type Material,
  type ResultField,
  type ResultSummary,
  type RunEvent,
  type Study,
  type StudyRun
} from "@opencae/schema";
import { inferCriticalPrintAxis, type PrintCriticalFace } from "@opencae/study-core";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface LocalCloudFeaBridgeOptions {
  runnerUrl?: string;
  fetchImpl?: FetchLike;
}

interface LocalCloudFeaRunResponse {
  run: StudyRun;
  streamUrl: string;
  message: string;
}

interface LocalCloudFeaResultBundle {
  summary: ResultSummary;
  fields: ResultField[];
}

interface LocalCloudFeaHealth {
  ok: true;
  mode: "local-cloud-fea-bridge";
  service: "opencae-api";
  runnerUrl: string;
  runnerHealthUrl: string;
  runner: {
    reachable: boolean;
    ok?: unknown;
    solver?: unknown;
    ccx?: unknown;
    gmsh?: unknown;
    error?: string;
  };
}

interface SolverMaterialPayload {
  id: string;
  name: string;
  category?: string;
  youngsModulusMpa: number;
  poissonRatio: number;
  densityTonnePerMm3: number;
  yieldMpa: number;
  original: {
    youngsModulus: number;
    poissonRatio: number;
    densityKgM3: number;
    yieldStrength: number;
    effectiveYoungsModulus: number;
    effectiveDensityKgM3: number;
    effectiveYieldStrength: number;
  };
}

const missingCloudFeaMaterialMessage = "Cloud FEA requires an assigned material before a CalculiX run can be queued.";
const generatedFallbackResultMessage = "Cloud FEA returned generated fallback data instead of parsed CalculiX results; refusing to publish fake solver results.";
const invalidCloudFeaProvenanceMessage = "Cloud FEA result provenance must identify parsed CalculiX FEA results.";
const defaultRunnerUrl = "http://localhost:8080/solve";
const placeholderResultMarkers = [
  "generated-cantilever-fallback",
  "cloud-fea-hard-coded-fallback",
  "cloud-fea-generated-fallback",
  "fallback-for-",
  "cloudflare_fea_placeholder",
  "heuristic",
  "local_detailed",
  "generated_fallback"
];

export class LocalCloudFeaBridgeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "LocalCloudFeaBridgeError";
  }
}

export class LocalCloudFeaBridge {
  private readonly runnerUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly runs = new Map<string, StudyRun>();
  private readonly eventsByRunId = new Map<string, RunEvent[]>();
  private readonly resultsByRunId = new Map<string, LocalCloudFeaResultBundle>();
  private readonly pendingByRunId = new Map<string, Promise<void>>();

  constructor(options: LocalCloudFeaBridgeOptions = {}) {
    this.runnerUrl = options.runnerUrl ?? process.env.OPCAE_FEA_RUNNER_URL ?? defaultRunnerUrl;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<LocalCloudFeaHealth> {
    const runnerHealthUrl = runnerHealthUrlFor(this.runnerUrl);
    return {
      ok: true,
      mode: "local-cloud-fea-bridge",
      service: "opencae-api",
      runnerUrl: this.runnerUrl,
      runnerHealthUrl,
      runner: await this.probeRunnerHealth(runnerHealthUrl)
    };
  }

  async createRun(body: Record<string, unknown> = {}): Promise<LocalCloudFeaRunResponse> {
    const studyArtifact = isRecord(body.study) ? body.study : undefined;
    const displayModelArtifact = isRecord(body.displayModel) ? body.displayModel : undefined;
    const solverMaterial = solverMaterialForCloudFea(studyArtifact, displayModelArtifact);
    const runId = `run-cloud-local-${crypto.randomUUID()}`;
    const studyId = stringFrom(body.studyId) ?? stringFrom(studyArtifact?.id) ?? "study-local-cloud-fea";
    const fidelity = simulationFidelity(body);
    const analysisType = analysisTypeFromBody(body) ?? "static_stress";
    const now = new Date().toISOString();
    const run: StudyRun = {
      id: runId,
      studyId,
      status: "queued",
      jobId: `job-${runId}`,
      meshRef: isRecord(studyArtifact?.meshSettings) ? stringFrom(studyArtifact.meshSettings.meshRef) : undefined,
      solverBackend: "cloudflare-fea-calculix",
      solverVersion: "local-bridge",
      startedAt: now,
      diagnostics: []
    };
    this.runs.set(runId, run);
    this.eventsByRunId.set(runId, []);

    const requestArtifact = {
      runId,
      projectId: stringFrom(body.projectId) ?? stringFrom(studyArtifact?.projectId),
      studyId,
      fidelity,
      backend: "cloudflare_fea",
      solver: "calculix",
      analysisType,
      study: studyArtifact,
      displayModel: displayModelArtifact,
      solverMaterial,
      geometry: isRecord(body.geometry) ? body.geometry : undefined,
      dynamicSettings: isRecord(body.dynamicSettings) ? body.dynamicSettings : undefined,
      createdAt: now
    };

    this.addEvent(runId, "state", 0, [
      "Cloud FEA local bridge queued",
      `analysis=${analysisType}`,
      `fidelity=${fidelity}`,
      `material=${solverMaterial.name} (${solverMaterial.id})`,
      `geometry=${geometrySourceLabel(requestArtifact)}`,
      `runner=${this.runnerUrl}`
    ].join("; ") + ".");
    this.addEvent(runId, "progress", 5, `Calling local CalculiX runner: POST ${this.runnerUrl}.`);
    const task = this.solveRun(runId, requestArtifact).finally(() => {
      this.pendingByRunId.delete(runId);
    });
    this.pendingByRunId.set(runId, task);

    return {
      run,
      streamUrl: `/api/cloud-fea/runs/${runId}/events`,
      message: "Cloud FEA simulation queued on the local API bridge."
    };
  }

  getEvents(runId: string): RunEvent[] {
    return this.eventsByRunId.get(runId) ?? [];
  }

  getResults(runId: string): LocalCloudFeaResultBundle | undefined {
    return this.resultsByRunId.get(runId);
  }

  async waitForRun(runId: string): Promise<void> {
    await this.pendingByRunId.get(runId);
  }

  private async probeRunnerHealth(runnerHealthUrl: string): Promise<LocalCloudFeaHealth["runner"]> {
    try {
      const response = await this.fetchImpl(runnerHealthUrl, { method: "GET" });
      const payload = await readJsonPayload(response);
      const record = isRecord(payload) ? payload : {};
      return {
        reachable: response.ok,
        ...(record.ok !== undefined ? { ok: record.ok } : {}),
        ...(record.solver !== undefined ? { solver: record.solver } : {}),
        ...(record.ccx !== undefined ? { ccx: record.ccx } : {}),
        ...(record.gmsh !== undefined ? { gmsh: record.gmsh } : {}),
        ...(!response.ok ? { error: runnerPayloadMessage(record) ?? `HTTP ${response.status}` } : {})
      };
    } catch (error) {
      return {
        reachable: false,
        error: error instanceof Error ? compact(error.message) : compact(String(error))
      };
    }
  }

  private async solveRun(runId: string, requestArtifact: Record<string, unknown>): Promise<void> {
    this.markRun(runId, "running");
    let response: Response;
    try {
      response = await this.fetchImpl(this.runnerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestArtifact)
      });
    } catch (error) {
      this.markRun(runId, "failed");
      this.addEvent(runId, "error", 100, runnerUnreachableMessage(this.runnerUrl, error));
      return;
    }

    const payload = await readJsonPayload(response);
    if (!response.ok) {
      this.markRun(runId, "failed");
      this.addEvent(runId, "error", 100, runnerHttpFailureMessage(response.status, payload));
      return;
    }

    try {
      const results = normalizeRunnerResults(payload);
      this.resultsByRunId.set(runId, results);
      this.markRun(runId, "complete");
      this.addEvent(runId, "complete", 100, "Cloud FEA local CalculiX solve complete with parsed results.");
    } catch (error) {
      this.markRun(runId, "failed");
      this.addEvent(runId, "error", 100, runnerInvalidResultMessage(error));
    }
  }

  private addEvent(runId: string, type: RunEvent["type"], progress: number, message: string): void {
    const events = this.eventsByRunId.get(runId) ?? [];
    events.push({
      runId,
      type,
      progress,
      message,
      timestamp: new Date().toISOString()
    });
    this.eventsByRunId.set(runId, events);
  }

  private markRun(runId: string, status: StudyRun["status"]): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const timestamp = new Date().toISOString();
    this.runs.set(runId, {
      ...run,
      status,
      ...(status === "complete" || status === "failed" || status === "cancelled" ? { finishedAt: timestamp } : {})
    });
  }
}

function normalizeRunnerResults(payload: unknown): LocalCloudFeaResultBundle {
  if (containsPlaceholderMarker(payload)) throw new Error(generatedFallbackResultMessage);
  const record = isRecord(payload) ? payload : {};
  const summary = ResultSummarySchema.parse(record.summary);
  const fields = ResultFieldSchema.array().parse(record.fields);
  validateCloudFeaProvenance(summary);
  validateSolverResultParser(record.artifacts);
  return { summary, fields };
}

function runnerHealthUrlFor(runnerUrl: string): string {
  try {
    const url = new URL(runnerUrl);
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return runnerUrl.replace(/\/solve\/?$/, "/health");
  }
}

function validateCloudFeaProvenance(summary: ResultSummary): void {
  const provenance = summary.provenance;
  if (!provenance || provenance.kind !== "calculix_fea" || !provenance.resultSource.startsWith("parsed_") || !/(calculix|ccx)/i.test(provenance.solver)) {
    throw new Error(invalidCloudFeaProvenanceMessage);
  }
}

function validateSolverResultParser(artifacts: unknown): void {
  const parserStatus = solverResultParserStatus(artifacts);
  if (!parserStatus || parserStatus.startsWith("generated-fallback-") || !parserStatus.startsWith("parsed-calculix")) {
    throw new Error(invalidCloudFeaProvenanceMessage);
  }
}

function containsPlaceholderMarker(value: unknown): boolean {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === "string") {
      const normalized = current.toLowerCase();
      if (placeholderResultMarkers.some((marker) => normalized.includes(marker))) return true;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (isRecord(current)) {
      for (const item of Object.values(current)) stack.push(item);
    }
  }
  return false;
}

async function readJsonPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: compact(text) };
  }
}

function runnerHttpFailureMessage(responseStatus: number, payload: unknown): string {
  const message = runnerPayloadMessage(payload);
  const parserStatus = solverResultParserStatus(isRecord(payload) ? payload.artifacts : undefined);
  const artifactKeys = artifactAvailability(isRecord(payload) ? payload.artifacts : undefined);
  return [
    `Cloud FEA local CalculiX runner failed with HTTP ${responseStatus}`,
    message ? `message=${message}` : undefined,
    parserStatus ? `parser=${parserStatus}` : undefined,
    `artifacts=${artifactKeys.length ? artifactKeys.join(",") : "none"}`
  ].filter(Boolean).join("; ") + ".";
}

function runnerUnreachableMessage(runnerUrl: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Cloud FEA local CalculiX runner is unreachable at ${runnerUrl}. Start the FEA runner/container and set OPCAE_FEA_RUNNER_URL if it is not using the default. ${message}`;
}

function runnerInvalidResultMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Cloud FEA local CalculiX runner returned invalid results: ${compact(message)}`;
}

function runnerPayloadMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const message = stringFrom(payload.error) ?? stringFrom(payload.message) ?? stringFrom(payload.detail);
  return message ? compact(message) : undefined;
}

function solverResultParserStatus(artifacts: unknown): string | undefined {
  if (!isRecord(artifacts)) return undefined;
  return stringFrom(artifacts.solverResultParser);
}

function artifactAvailability(artifacts: unknown): string[] {
  if (!isRecord(artifacts)) return [];
  return Object.keys(artifacts).filter((key) => artifacts[key] !== undefined && artifacts[key] !== null);
}

function solverMaterialForCloudFea(study: Record<string, unknown> | undefined, displayModel: Record<string, unknown> | undefined): SolverMaterialPayload {
  const assignment = firstMaterialAssignment(study);
  const materialId = typeof assignment?.materialId === "string" ? assignment.materialId : "";
  const material = starterMaterials.find((candidate) => candidate.id === materialId);
  if (!material) throw new LocalCloudFeaBridgeError(422, missingCloudFeaMaterialMessage);
  const parameters = isRecord(assignment?.parameters) ? assignment.parameters : {};
  const criticalLayerAxis = inferCriticalPrintAxis(study as Study, printCriticalFaces(displayModel));
  const effective = effectiveMaterialProperties(material, parameters, { criticalLayerAxis });
  return solverMaterialPayload(material, effective);
}

function solverMaterialPayload(material: Material, effective: Material): SolverMaterialPayload {
  return {
    id: material.id,
    name: material.name,
    ...(typeof material.category === "string" ? { category: material.category } : {}),
    youngsModulusMpa: effective.youngsModulus / 1_000_000,
    poissonRatio: effective.poissonRatio,
    densityTonnePerMm3: finitePrecision(effective.density * 1e-12),
    yieldMpa: effective.yieldStrength / 1_000_000,
    original: {
      youngsModulus: material.youngsModulus,
      poissonRatio: material.poissonRatio,
      densityKgM3: material.density,
      yieldStrength: material.yieldStrength,
      effectiveYoungsModulus: effective.youngsModulus,
      effectiveDensityKgM3: effective.density,
      effectiveYieldStrength: effective.yieldStrength
    }
  };
}

function firstMaterialAssignment(study: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const assignments = Array.isArray(study?.materialAssignments) ? study.materialAssignments : [];
  return assignments.find(isRecord);
}

function printCriticalFaces(displayModel: Record<string, unknown> | undefined): PrintCriticalFace[] {
  const faces = Array.isArray(displayModel?.faces) ? displayModel.faces : [];
  return faces.flatMap((face): PrintCriticalFace[] => {
    if (!isRecord(face)) return [];
    const center = vector3(face.center);
    if (!center) return [];
    return [{
      entityId: typeof face.id === "string" ? face.id : undefined,
      selectionId: typeof face.selectionId === "string" ? face.selectionId : undefined,
      center
    }];
  });
}

function geometrySourceLabel(requestArtifact: Record<string, unknown>): string {
  const geometry = isRecord(requestArtifact.geometry) ? requestArtifact.geometry : undefined;
  if (geometry) {
    const format = typeof geometry.format === "string" ? geometry.format : "unknown";
    const filename = typeof geometry.filename === "string" ? geometry.filename : "unnamed";
    return `uploaded:${format}:${filename}`;
  }
  const displayModel = isRecord(requestArtifact.displayModel) ? requestArtifact.displayModel : undefined;
  if (isRecord(displayModel?.dimensions)) return "display-model-dimensions";
  if (Array.isArray(displayModel?.faces) && displayModel.faces.length > 0) return "display-model-faces";
  return "unknown";
}

function analysisTypeFromBody(body: Record<string, unknown>): string | undefined {
  if (isRecord(body.study) && typeof body.study.type === "string") return body.study.type;
  return undefined;
}

function simulationFidelity(body: Record<string, unknown>): "standard" | "detailed" | "ultra" {
  if (body.fidelity === "detailed" || body.fidelity === "ultra") return body.fidelity;
  return "standard";
}

function vector3(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0]!, value[1]!, value[2]!]
    : undefined;
}

function finitePrecision(value: number): number {
  return Number(value.toPrecision(12));
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact(message: string): string {
  const compactMessage = message.replace(/\s+/g, " ").trim();
  return compactMessage.length > 500 ? `${compactMessage.slice(0, 497)}...` : compactMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
