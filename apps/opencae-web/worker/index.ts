/// <reference types="./worker-configuration" />

import { Container } from "@cloudflare/containers";
import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import type { Material, Study } from "@opencae/schema";
import { inferCriticalPrintAxis, type PrintCriticalFace } from "@opencae/study-core";

type ContainerFetchBinding = {
  fetch(request: Request): Promise<Response>;
};

type ContainerBinding = ContainerFetchBinding | {
  idFromName?(name: string): unknown;
  get?(id?: string): ContainerFetchBinding;
  getByName?(name: string): ContainerFetchBinding;
  getRandom?(): ContainerFetchBinding;
};

type RuntimeEnv = Omit<Env, "FEA_ARTIFACTS" | "FEA_RUN_QUEUE" | "FEA_CONTAINER"> & {
  FEA_ARTIFACTS?: R2Bucket;
  FEA_RUN_QUEUE?: Queue;
  FEA_CONTAINER?: ContainerBinding;
};

export class OpenCaeFeaContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "10m";
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const cloudFeaContainersDisabledMessage = "Cloud FEA containers are not enabled for this deployment. Deploy with pnpm deploy:cloudflare:containers using a Cloudflare token with Containers write access, or switch the study backend to Detailed local.";
const cloudFeaQueueContainerMissingMessage = "Cloud FEA queue consumer does not have FEA_CONTAINER. Queue dispatch is disabled for Cloud FEA; rerun the simulation.";
const generatedFallbackResultMessage = "Cloud FEA returned generated fallback data instead of parsed CalculiX results; refusing to publish fake solver results.";
const invalidCloudFeaProvenanceMessage = "Cloud FEA result provenance must identify parsed CalculiX FEA results.";
const missingCloudFeaMaterialMessage = "Cloud FEA requires an assigned material before a CalculiX run can be queued.";
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
export const MAX_CLOUD_FEA_RESULT_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_CLOUD_FEA_FIELD_VALUES = 25_000;
export const MAX_CLOUD_FEA_FIELD_SAMPLES = 25_000;
const MAX_CONTAINER_FAILURE_BODY_PREVIEW = 2_000;
const cloudFeaResultBudgetExceededMessage = "Cloud FEA result payload exceeded the UI result budget. Reduce fidelity or enable result decimation.";

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      logWorkerEvent("health", { method: request.method, pathname: url.pathname });
      return Response.json(
        { ok: true, mode: "cloudflare-worker", service: "opencae-web" },
        { headers: jsonHeaders }
      );
    }

    if (url.pathname === "/api/cloud-fea/health" && request.method === "GET") {
      logWorkerEvent("cloud_fea_health", { method: request.method, pathname: url.pathname });
      return cloudFeaHealth(request, env);
    }

    if (url.pathname === "/api/cloud-fea/runs" && request.method === "POST") {
      logWorkerEvent("cloud_fea_run_create", { method: request.method, pathname: url.pathname });
      return createCloudFeaRun(request, env, ctx);
    }

    const eventsMatch = url.pathname.match(/^\/api\/cloud-fea\/runs\/([^/]+)\/events$/);
    if (eventsMatch && request.method === "GET") {
      logWorkerEvent("cloud_fea_run_events", { method: request.method, pathname: url.pathname, runId: eventsMatch[1] });
      return getCloudFeaRunEvents(eventsMatch[1]!, env);
    }

    const resultsMatch = url.pathname.match(/^\/api\/cloud-fea\/runs\/([^/]+)\/results$/);
    if (resultsMatch && request.method === "GET") {
      logWorkerEvent("cloud_fea_run_results", { method: request.method, pathname: url.pathname, runId: resultsMatch[1] });
      return getCloudFeaRunResults(resultsMatch[1]!, env);
    }

    if (url.pathname.startsWith("/api/")) {
      logWorkerEvent("unsupported_api_route", { method: request.method, pathname: url.pathname });
      return Response.json(
        {
          error: "The Cloudflare Worker deployment serves the local-first web app only. API-backed operations fall back to browser-local behavior."
        },
        { status: 503, headers: jsonHeaders }
      );
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: { messages: Array<{ body: unknown; ack(): void; retry(): void }> }, env: RuntimeEnv): Promise<void> {
    if (!env.FEA_ARTIFACTS) {
      for (const message of batch.messages) message.retry();
      return;
    }
    for (const message of batch.messages) {
      const runId = typeof (message.body as { runId?: unknown }).runId === "string" ? (message.body as { runId: string }).runId : undefined;
      if (!runId) {
        message.ack();
        continue;
      }
      if (!env.FEA_CONTAINER) {
        await markCloudFeaRunFailed(runId, env, cloudFeaQueueContainerMissingMessage);
        message.ack();
        continue;
      }
      logWorkerEvent("cloud_fea_queue_solve", { runId });
      await runCloudFeaSolve(runId, env);
      message.ack();
    }
  }
} satisfies ExportedHandler<Env>;

async function cloudFeaHealth(request: Request, env: RuntimeEnv): Promise<Response> {
  const origin = new URL(request.url).origin;
  const containerBound = Boolean(env.FEA_CONTAINER);
  const body: Record<string, unknown> = {
    ok: true,
    mode: "cloudflare-worker",
    service: "opencae-web",
    requestOrigin: origin,
    cloudFeaEndpoint: `${origin}/api/cloud-fea/runs`,
    artifactsBound: Boolean(env.FEA_ARTIFACTS),
    queueBound: Boolean(env.FEA_RUN_QUEUE),
    containerBound,
    containersEnabled: containerBound,
    cloudFeaAvailable: containerBound,
    ...(containerBound ? {} : {
      requiredDeployConfig: "wrangler.containers.jsonc",
      deploymentHint: "The current Worker version has no FEA_CONTAINER binding. This usually means a stale or non-container deployment was promoted to Worker opencae. Deploy with wrangler.jsonc or wrangler.containers.jsonc after confirming the config includes FEA_CONTAINER."
    })
  };
  if (containerBound && new URL(request.url).searchParams.get("probeContainer") === "1") {
    try {
      body.containerHealth = await probeFeaContainerHealth(env, "health-check");
    } catch (error) {
      body.containerHealthError = error instanceof Error ? error.message : String(error);
    }
  }
  return Response.json(
    body,
    { headers: jsonHeaders }
  );
}

async function createCloudFeaRun(request: Request, env: RuntimeEnv, ctx?: ExecutionContext): Promise<Response> {
  if (!env.FEA_ARTIFACTS) {
    return Response.json({ error: "Cloud FEA is not configured for this deployment." }, { status: 503, headers: jsonHeaders });
  }
  if (!env.FEA_CONTAINER) {
    return Response.json({ error: cloudFeaContainersDisabledMessage }, { status: 503, headers: jsonHeaders });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const studyArtifact = isRecord(body.study) ? body.study : undefined;
  const displayModelArtifact = isRecord(body.displayModel) ? body.displayModel : undefined;
  let solverMaterial: SolverMaterialPayload;
  try {
    solverMaterial = solverMaterialForCloudFea(studyArtifact, displayModelArtifact);
  } catch (error) {
    const message = error instanceof Error ? error.message : missingCloudFeaMaterialMessage;
    return Response.json({ error: message }, { status: 422, headers: jsonHeaders });
  }
  const runId = `run-cloud-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const run = {
    id: runId,
    studyId: typeof body.studyId === "string" ? body.studyId : "study-cloud",
    status: "queued",
    jobId: `job-${runId}`,
    solverBackend: "cloudflare-fea-calculix",
    solverVersion: "calculix-container-0.1.0",
    startedAt: now,
    diagnostics: []
  };
  const requestArtifact = {
    runId,
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    studyId: run.studyId,
    fidelity: body.fidelity === "ultra" || body.fidelity === "detailed" ? body.fidelity : "standard",
    backend: "cloudflare_fea",
    solver: "calculix",
    analysisType: analysisTypeFromBody(body),
    study: studyArtifact,
    displayModel: displayModelArtifact,
    solverMaterial,
    geometry: isRecord(body.geometry) ? body.geometry : undefined,
    dynamicSettings: isRecord(body.dynamicSettings) ? body.dynamicSettings : undefined,
    createdAt: now
  };
  const dispatchMode = env.FEA_RUN_QUEUE ? "queue" : ctx ? "waitUntil" : "inline";
  const queuedMessage = cloudFeaDispatchMessage(requestArtifact, solverMaterial, {
    dispatchMode,
    containerBound: Boolean(env.FEA_CONTAINER)
  });
  const queuedEvents = [
    { runId, type: "state", progress: 0, message: queuedMessage, timestamp: now },
    { runId, type: "progress", progress: 5, message: "Waiting for CalculiX container worker.", timestamp: now }
  ];
  await env.FEA_ARTIFACTS.put(`runs/${runId}/request.json`, JSON.stringify(requestArtifact, null, 2));
  await env.FEA_ARTIFACTS.put(`runs/${runId}/events.json`, JSON.stringify(queuedEvents, null, 2));
  if (env.FEA_RUN_QUEUE) {
    try {
      await env.FEA_RUN_QUEUE.send({ runId });
    } catch (error) {
      const message = cloudFeaQueueDispatchFailureMessage(error);
      await markCloudFeaRunFailed(runId, env, message);
      return Response.json({ error: message, runId }, { status: 503, headers: jsonHeaders });
    }
  } else if (ctx) {
    ctx.waitUntil(runCloudFeaSolve(runId, env));
  } else {
    await runCloudFeaSolve(runId, env);
  }
  return Response.json({ run, streamUrl: `/api/cloud-fea/runs/${runId}/events`, message: "Cloud FEA simulation queued." }, { status: 202, headers: jsonHeaders });
}

async function getCloudFeaRunEvents(runId: string, env: RuntimeEnv): Promise<Response> {
  if (!env.FEA_ARTIFACTS) {
    return Response.json({ error: "Cloud FEA is not configured for this deployment." }, { status: 503, headers: jsonHeaders });
  }
  const object = await env.FEA_ARTIFACTS.get(`runs/${runId}/events.json`);
  if (!object) {
    return Response.json({ events: [] }, { headers: jsonHeaders });
  }
  const events = JSON.parse(await object.text()) as unknown;
  return Response.json({ events }, { headers: jsonHeaders });
}

async function getCloudFeaRunResults(runId: string, env: RuntimeEnv): Promise<Response> {
  if (!env.FEA_ARTIFACTS) {
    return Response.json({ error: "Cloud FEA is not configured for this deployment." }, { status: 503, headers: jsonHeaders });
  }
  const object = await env.FEA_ARTIFACTS.get(`runs/${runId}/results.json`);
  if (!object) {
    return Response.json({ error: "Cloud FEA results are not ready." }, { status: 404, headers: jsonHeaders });
  }
  return Response.json(JSON.parse(await object.text()), { headers: jsonHeaders });
}

async function runCloudFeaSolve(runId: string, env: RuntimeEnv): Promise<void> {
  const artifacts = env.FEA_ARTIFACTS;
  if (!artifacts) throw new Error("Cloud FEA artifacts bucket is not configured.");
  const now = new Date().toISOString();
  const requestObject = await artifacts.get(`runs/${runId}/request.json`);
  const requestArtifact = requestObject ? JSON.parse(await requestObject.text()) as Record<string, unknown> : { runId };
  const analysisType = analysisTypeFromRequest(requestArtifact);
  const deckMessage = analysisType === "dynamic_structural" ? "Generating CalculiX transient input deck." : "Generating CalculiX static input deck.";
  const events = [
    { runId, type: "state", progress: 0, message: `Cloud FEA worker started: ${requestDiagnosticSummary(requestArtifact)}.`, timestamp: now },
    { runId, type: "progress", progress: 15, message: "Meshing geometry for CalculiX.", timestamp: now },
    { runId, type: "progress", progress: 30, message: deckMessage, timestamp: now }
  ];
  await artifacts.put(`runs/${runId}/events.json`, JSON.stringify(events, null, 2));
  try {
    const containerHealth = await probeFeaContainerHealth(env, runId);
    events.push({
      runId,
      type: "progress",
      progress: 45,
      message: containerHealthMessage(containerHealth),
      timestamp: new Date().toISOString()
    });
    events.push({ runId, type: "progress", progress: 60, message: "Running CalculiX container solve.", timestamp: new Date().toISOString() });
    const solveResponse = await callFeaContainer(env, { ...requestArtifact, runId });
    if (!solveResponse.ok) {
      const failure = await readContainerFailure(solveResponse);
      await putOptionalArtifact(artifacts, `runs/${runId}/input.inp`, failure.artifacts.inputDeck ?? failure.artifacts.inputDeckPreview);
      await putOptionalArtifact(artifacts, `runs/${runId}/solver.log`, failure.artifacts.solverLog ?? failure.artifacts.solverLogPreview);
      await putOptionalArtifact(artifacts, `runs/${runId}/solver-result-parser.txt`, failure.artifacts.solverResultParser);
      await putOptionalArtifact(artifacts, `runs/${runId}/mesh.json`, JSON.stringify(failure.artifacts.meshSummary ?? {}, null, 2));
      await artifacts.put(`runs/${runId}/events.json`, JSON.stringify([
        ...events,
        { runId, type: "error", progress: 100, message: failure.message, timestamp: new Date().toISOString() }
      ], null, 2));
      await artifacts.put(`runs/${runId}/failed.json`, JSON.stringify({ runId, error: failure.message, timestamp: new Date().toISOString() }, null, 2));
      return;
    }
    const containerResult = await solveResponse.json() as Record<string, unknown>;
    events.push({ runId, type: "progress", progress: 90, message: "Post-processing framed nodal and element output.", timestamp: new Date().toISOString() });
    const normalized = normalizeContainerResult(runId, containerResult);
    if (requestRequiresDynamicFrames(requestArtifact)) {
      assertDynamicPlaybackResult(normalized);
    }
    const resultJson = serializeCloudFeaResultForUi(normalized);
    const resultArtifacts = isRecord(containerResult.artifacts) ? containerResult.artifacts : {};
    await putOptionalArtifact(artifacts, `runs/${runId}/input.inp`, resultArtifacts.inputDeck ?? resultArtifacts.inputDeckPreview);
    await putOptionalArtifact(artifacts, `runs/${runId}/solver.log`, resultArtifacts.solverLog ?? resultArtifacts.solverLogPreview);
    await putOptionalArtifact(artifacts, `runs/${runId}/solver-result-parser.txt`, resultArtifacts.solverResultParser);
    await putOptionalArtifact(artifacts, `runs/${runId}/mesh.json`, JSON.stringify(resultArtifacts.meshSummary ?? {}, null, 2));
    await artifacts.put(`runs/${runId}/results.json`, resultJson);
    await artifacts.put(`runs/${runId}/events.json`, JSON.stringify([
      ...events,
      { runId, type: "complete", progress: 100, message: normalized.summary.transient ? "Cloud FEA transient solve complete." : "Cloud FEA static solve complete.", timestamp: new Date().toISOString() }
    ], null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloud FEA container solve failed.";
    await artifacts.put(`runs/${runId}/events.json`, JSON.stringify([
      ...events,
      { runId, type: "error", progress: 100, message, timestamp: new Date().toISOString() }
    ], null, 2));
    await artifacts.put(`runs/${runId}/failed.json`, JSON.stringify({ runId, error: message, timestamp: new Date().toISOString() }, null, 2));
  }
}

async function markCloudFeaRunFailed(runId: string, env: RuntimeEnv, message: string): Promise<void> {
  const artifacts = env.FEA_ARTIFACTS;
  if (!artifacts) return;
  const timestamp = new Date().toISOString();
  const event = {
    runId,
    type: "error",
    progress: 100,
    message,
    timestamp
  };
  const existing = await artifacts.get(`runs/${runId}/events.json`);
  const events = existing ? JSON.parse(await existing.text()) as unknown[] : [];
  await artifacts.put(`runs/${runId}/events.json`, JSON.stringify([...events, event], null, 2));
  await artifacts.put(`runs/${runId}/failed.json`, JSON.stringify({
    runId,
    error: message,
    timestamp
  }, null, 2));
}

function cloudFeaQueueDispatchFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || "unknown error");
  return `Cloud FEA queue dispatch failed: ${detail.replace(/\.+$/, "")}.`;
}

function feaContainerFetcher(env: RuntimeEnv, instanceName: string): ContainerFetchBinding {
  const binding = env.FEA_CONTAINER;
  if (!binding) throw new Error("Cloud FEA container binding is not configured.");
  const fetcher = "fetch" in binding
    ? binding
    : binding.getByName
      ? binding.getByName(instanceName)
      : binding.getRandom
        ? binding.getRandom()
        : binding.get?.(binding.idFromName ? binding.idFromName(instanceName) as string : instanceName);
  if (!fetcher) throw new Error("Cloud FEA container instance could not be resolved.");
  return fetcher;
}

async function fetchFeaContainer(env: RuntimeEnv, instanceName: string, path: "/health" | "/solve", init?: RequestInit): Promise<Response> {
  const fetcher = feaContainerFetcher(env, instanceName);
  try {
    return await fetcher.fetch(new Request(`https://opencae-fea-container${path}`, init));
  } catch (error) {
    throw new Error(normalizeContainerRuntimeError(error));
  }
}

async function callFeaContainer(env: RuntimeEnv, payload: Record<string, unknown>): Promise<Response> {
  const instanceName = typeof payload.runId === "string" ? payload.runId : crypto.randomUUID();
  return fetchFeaContainer(env, instanceName, "/solve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function probeFeaContainerHealth(env: RuntimeEnv, instanceName: string): Promise<Record<string, unknown>> {
  const response = await fetchFeaContainer(env, instanceName, "/health", { method: "GET" });
  if (!response.ok) {
    const failure = await readContainerFailure(response);
    throw new Error(`Cloud FEA container health check failed before solve: ${failure.message}`);
  }
  const text = await response.text();
  return parseJsonRecord(text) ?? { ok: true };
}

function containerHealthMessage(health: Record<string, unknown>): string {
  const runner = typeof health.runnerVersion === "string" ? health.runnerVersion : "unknown";
  const ccx = typeof health.ccx === "string" ? health.ccx : "unknown";
  const gmsh = typeof health.gmsh === "string" ? health.gmsh : "unknown";
  return `Cloud FEA container health: runner=${runner}; ccx=${ccx}; gmsh=${gmsh}.`;
}

async function readContainerFailure(response: Response): Promise<{ message: string; artifacts: Record<string, unknown> }> {
  const text = await response.text().catch(() => "");
  const payload = parseJsonRecord(text);
  const baseMessage = typeof payload?.error === "string"
    ? payload.error
    : typeof payload?.message === "string"
      ? payload.message
      : `Cloud FEA container failed with HTTP ${response.status}.`;
  const artifacts = isRecord(payload?.artifacts) ? payload.artifacts : {};
  const artifactKeys = Object.keys(artifacts);
  const parserStatus = typeof artifacts.solverResultParser === "string" ? artifacts.solverResultParser : "missing";
  const bodyPreview = payload ? "" : compactBodyPreview(text);
  const details = [
    `container HTTP ${response.status}`,
    `parser=${parserStatus}`,
    `artifacts=${artifactKeys.length ? artifactKeys.join(", ") : "none"}`,
    ...(bodyPreview ? [`bodyPreview=${bodyPreview}`] : [])
  ];
  const message = `${baseMessage} (${details.join("; ")}).`;
  return {
    message,
    artifacts
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compactBodyPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > MAX_CONTAINER_FAILURE_BODY_PREVIEW
    ? `${normalized.slice(0, MAX_CONTAINER_FAILURE_BODY_PREVIEW)}...`
    : normalized;
}

function normalizeContainerResult(runId: string, result: Record<string, unknown>) {
  const summary = isRecord(result.summary) ? result.summary : undefined;
  const rawFields = Array.isArray(result.fields) ? result.fields : undefined;
  const resultArtifacts = isRecord(result.artifacts) ? result.artifacts : {};
  if (!summary) throw new Error("Cloud FEA container returned no result summary.");
  if (!rawFields?.length) throw new Error("Cloud FEA container returned no result fields.");
  assertFiniteSummary(summary);
  if (looksLikePlaceholderResult(summary, rawFields, resultArtifacts)) {
    throw new Error(generatedFallbackResultMessage);
  }
  assertParsedCalculixArtifacts(resultArtifacts);
  const provenance = normalizeCloudFeaProvenance(summary);
  const normalizedSummary = {
    maxStress: numberField(summary, "maxStress"),
    maxStressUnits: stringField(summary, "maxStressUnits"),
    maxDisplacement: numberField(summary, "maxDisplacement"),
    maxDisplacementUnits: stringField(summary, "maxDisplacementUnits"),
    safetyFactor: numberField(summary, "safetyFactor"),
    reactionForce: numberField(summary, "reactionForce"),
    reactionForceUnits: stringField(summary, "reactionForceUnits"),
    failureAssessment: failureAssessmentFor(summary),
    provenance,
    ...(isRecord(summary.transient) ? { transient: normalizeTransient(summary.transient) } : {})
  };
  return {
    summary: normalizedSummary,
    fields: rawFields.map((field, index) => normalizeField(runId, field, index, provenance))
  };
}

function requestRequiresDynamicFrames(request: Record<string, unknown>): boolean {
  if (request.analysisType === "dynamic_structural") return true;
  if (isRecord(request.study) && request.study.type === "dynamic_structural") return true;
  return isRecord(request.dynamicSettings);
}

function assertDynamicPlaybackResult(result: { summary: { transient?: unknown }; fields: Array<Record<string, unknown>> }): void {
  const transient = result.summary.transient;
  if (!isRecord(transient) || numberOr(transient.frameCount, 0) <= 1) {
    throw new Error("Cloud FEA dynamic result did not include animation frames.");
  }
  const frameIndexes = new Set<number>();
  for (const field of result.fields) {
    const frameIndex = field.frameIndex;
    if (typeof frameIndex !== "number") continue;
    if (!Number.isFinite(frameIndex)) {
      throw new Error("Cloud FEA dynamic result did not include animation frames.");
    }
    if (typeof field.timeSeconds !== "number" || !Number.isFinite(field.timeSeconds)) {
      throw new Error("Cloud FEA dynamic result did not include animation frames.");
    }
    frameIndexes.add(frameIndex);
  }
  if (frameIndexes.size <= 1) {
    throw new Error("Cloud FEA dynamic result did not include animation frames.");
  }
}

function assertFiniteSummary(summary: Record<string, unknown>): void {
  for (const key of ["maxStress", "maxDisplacement", "safetyFactor", "reactionForce"]) {
    numberField(summary, key);
  }
  for (const key of ["maxStressUnits", "maxDisplacementUnits", "reactionForceUnits"]) {
    stringField(summary, key);
  }
}

export function looksLikePlaceholderResult(summary: Record<string, unknown>, fields: unknown[], artifacts: Record<string, unknown> = {}): boolean {
  if (numberField(summary, "maxStress") === 1_440_000 && numberField(summary, "safetyFactor") === 172) return true;
  return (
    containsPlaceholderMarker(summary) ||
    containsPlaceholderMarker(fields) ||
    containsPlaceholderMarker({
      solverResultParser: artifacts.solverResultParser,
      meshSummary: artifacts.meshSummary
    })
  );
}

function containsPlaceholderMarker(value: unknown, maxVisited = 50_000): boolean {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length && visited < maxVisited) {
    visited += 1;
    const current = stack.pop();
    if (typeof current === "string") {
      const normalized = current.toLowerCase();
      if (placeholderResultMarkers.some((marker) => normalized.includes(marker))) return true;
      continue;
    }
    if (Array.isArray(current)) {
      if (isNumericArrayLike(current)) continue;
      const maxItems = 200;
      const headCount = Math.min(current.length, maxItems);
      for (let index = 0; index < headCount; index += 1) {
        stack.push(current[index]);
      }
      if (current.length > maxItems) {
        const tailStart = Math.max(maxItems, current.length - 50);
        for (let index = tailStart; index < current.length; index += 1) {
          stack.push(current[index]);
        }
      }
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, item] of Object.entries(current)) {
      if (key === "values" && Array.isArray(item)) continue;
      if (key === "samples" && Array.isArray(item)) {
        for (const sample of item.slice(0, 500)) {
          if (!isRecord(sample)) continue;
          stack.push({
            source: sample.source,
            nodeId: sample.nodeId,
            elementId: sample.elementId
          });
        }
        continue;
      }
      stack.push(item);
    }
  }
  return false;
}

function isNumericArrayLike(value: unknown[]): boolean {
  if (!value.length) return false;
  const indexes = new Set([0, Math.floor(value.length / 2), value.length - 1]);
  for (const index of indexes) {
    if (typeof value[index] !== "number") return false;
  }
  return true;
}

function assertParsedCalculixArtifacts(artifacts: Record<string, unknown>): void {
  const parserStatus = artifacts.solverResultParser;
  if (typeof parserStatus !== "string") {
    throw new Error("Cloud FEA container did not report parsed CalculiX result parser status.");
  }
  const normalized = parserStatus.toLowerCase();
  if (normalized.startsWith("generated-fallback-") || !normalized.startsWith("parsed-calculix")) {
    throw new Error(generatedFallbackResultMessage);
  }
}

function normalizeCloudFeaProvenance(summary: Record<string, unknown>) {
  const provenance = summary.provenance;
  if (!isRecord(provenance)) throw new Error(invalidCloudFeaProvenanceMessage);
  const kind = provenance.kind;
  const resultSource = provenance.resultSource;
  const solver = typeof provenance.solver === "string" ? provenance.solver : "";
  if (kind !== "calculix_fea") throw new Error(invalidCloudFeaProvenanceMessage);
  if (typeof resultSource !== "string" || !resultSource.startsWith("parsed_")) throw new Error(generatedFallbackResultMessage);
  if (!/(calculix|ccx)/i.test(solver)) throw new Error(invalidCloudFeaProvenanceMessage);
  return {
    kind,
    solver,
    solverVersion: typeof provenance.solverVersion === "string" ? provenance.solverVersion : "unknown",
    meshSource: typeof provenance.meshSource === "string" ? provenance.meshSource : "unknown",
    resultSource,
    units: typeof provenance.units === "string" ? provenance.units : "unknown",
    ...(typeof provenance.renderCoordinateSpace === "string"
      ? { renderCoordinateSpace: provenance.renderCoordinateSpace }
      : {})
  };
}

function normalizeField(runId: string, rawField: unknown, index: number, provenance: ReturnType<typeof normalizeCloudFeaProvenance>) {
  if (!isRecord(rawField)) throw new Error(`Cloud FEA container returned invalid field ${index}.`);
  const values = Array.isArray(rawField.values) ? rawField.values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : [];
  if (!values.length) throw new Error(`Cloud FEA container returned field ${index} without numeric values.`);
  const fieldRunId = typeof rawField.runId === "string" ? rawField.runId : runId;
  return {
    ...rawField,
    id: typeof rawField.id === "string" ? rawField.id : `field-${fieldRunId}-${index}`,
    runId: fieldRunId,
    values,
    min: typeof rawField.min === "number" && Number.isFinite(rawField.min) ? rawField.min : Math.min(...values),
    max: typeof rawField.max === "number" && Number.isFinite(rawField.max) ? rawField.max : Math.max(...values),
    units: typeof rawField.units === "string" ? rawField.units : "",
    provenance,
    ...(typeof rawField.timeSeconds === "number" && Number.isFinite(rawField.timeSeconds)
      ? { timeSeconds: rawField.timeSeconds }
      : typeof rawField.time === "number" && Number.isFinite(rawField.time)
        ? { timeSeconds: rawField.time }
      : {})
  };
}

function serializeCloudFeaResultForUi(result: { fields: Array<Record<string, unknown>> }): string {
  assertCloudFeaResultWithinUiFieldBudget(result);
  let resultJson: string;
  try {
    resultJson = JSON.stringify(result);
  } catch (error) {
    if (error instanceof RangeError || (error instanceof Error && /invalid string length/i.test(error.message))) {
      throw new Error(cloudFeaResultBudgetExceededMessage);
    }
    throw error;
  }
  if (new TextEncoder().encode(resultJson).byteLength > MAX_CLOUD_FEA_RESULT_JSON_BYTES) {
    throw new Error(cloudFeaResultBudgetExceededMessage);
  }
  return resultJson;
}

function assertCloudFeaResultWithinUiFieldBudget(result: { fields: Array<Record<string, unknown>> }): void {
  for (const field of result.fields) {
    if (Array.isArray(field.values) && field.values.length > MAX_CLOUD_FEA_FIELD_VALUES) {
      throw new Error(cloudFeaResultBudgetExceededMessage);
    }
    if (Array.isArray(field.samples) && field.samples.length > MAX_CLOUD_FEA_FIELD_SAMPLES) {
      throw new Error(cloudFeaResultBudgetExceededMessage);
    }
  }
}

function normalizeTransient(transient: Record<string, unknown>) {
  const startTime = numberOr(transient.startTime, 0);
  const endTime = numberOr(transient.endTime, startTime);
  const timeStep = numberOr(transient.timeStep, 0);
  const outputInterval = numberOr(transient.outputInterval, timeStep);
  const frameCount = Math.max(1, Math.round(numberOr(transient.frameCount, 1)));
  return {
    analysisType: "dynamic_structural" as const,
    integrationMethod: "newmark_average_acceleration" as const,
    startTime,
    endTime,
    timeStep,
    outputInterval,
    dampingRatio: numberOr(transient.dampingRatio, 0),
    frameCount,
    peakDisplacementTimeSeconds: numberOr(transient.peakDisplacementTimeSeconds, endTime),
    peakDisplacement: numberOr(transient.peakDisplacement, 0)
  };
}

function failureAssessmentFor(summary: Record<string, unknown>) {
  const safetyFactor = numberField(summary, "safetyFactor");
  if (safetyFactor < 1) {
    return {
      status: "fail",
      title: "Likely to fail",
      message: `Peak stress is ${formatNumber(numberField(summary, "maxStress"))} ${stringField(summary, "maxStressUnits")}, which exceeds the assigned material yield limit.`
    };
  }
  if (safetyFactor < 1.5) {
    return {
      status: "warning",
      title: "Low safety margin",
      message: `Safety factor is ${formatNumber(safetyFactor)}. Increase material strength, section size, or reduce load.`
    };
  }
  return {
    status: "pass",
    title: "Unlikely to yield",
    message: `Safety factor is ${formatNumber(safetyFactor)}. Peak stress is below the assigned material yield limit.`
  };
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Cloud FEA container returned invalid numeric summary field: ${key}.`);
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Cloud FEA container returned invalid text summary field: ${key}.`);
  return value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function normalizeContainerRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Cloud FEA container solve failed.";
  if (message.includes("Containers have not been enabled")) return cloudFeaContainersDisabledMessage;
  return message;
}

async function putOptionalArtifact(artifacts: R2Bucket, key: string, value: unknown): Promise<void> {
  if (typeof value !== "string") return;
  await artifacts.put(key, value);
}

function logWorkerEvent(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, service: "opencae-web-worker", ...details }));
}

type CloudFeaDispatchMode = "waitUntil" | "inline" | "queue";

function cloudFeaDispatchMessage(
  requestArtifact: Record<string, unknown>,
  solverMaterial: SolverMaterialPayload,
  bindings: { dispatchMode: CloudFeaDispatchMode; containerBound: boolean }
): string {
  return `Cloud FEA run queued: ${[
    `analysis=${analysisTypeFromRequest(requestArtifact)}`,
    `fidelity=${typeof requestArtifact.fidelity === "string" ? requestArtifact.fidelity : "standard"}`,
    `material=${solverMaterial.name} (${solverMaterial.id})`,
    `geometry=${geometrySourceLabel(requestArtifact)}`,
    `dispatch=${bindings.dispatchMode}`,
    `container=${bindings.containerBound ? "bound" : "missing"}`
  ].join("; ")}.`;
}

function requestDiagnosticSummary(requestArtifact: Record<string, unknown>): string {
  const material = isRecord(requestArtifact.solverMaterial)
    ? `${typeof requestArtifact.solverMaterial.name === "string" ? requestArtifact.solverMaterial.name : "unknown"} (${typeof requestArtifact.solverMaterial.id === "string" ? requestArtifact.solverMaterial.id : "unknown"})`
    : "unknown";
  return [
    `analysis=${analysisTypeFromRequest(requestArtifact)}`,
    `fidelity=${typeof requestArtifact.fidelity === "string" ? requestArtifact.fidelity : "standard"}`,
    `material=${material}`,
    `geometry=${geometrySourceLabel(requestArtifact)}`
  ].join("; ");
}

function analysisTypeFromRequest(requestArtifact: Record<string, unknown>): string {
  if (typeof requestArtifact.analysisType === "string") return requestArtifact.analysisType;
  if (isRecord(requestArtifact.study) && typeof requestArtifact.study.type === "string") return requestArtifact.study.type;
  return "static_stress";
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

function solverMaterialForCloudFea(study: Record<string, unknown> | undefined, displayModel: Record<string, unknown> | undefined): SolverMaterialPayload {
  const assignment = firstMaterialAssignment(study);
  const materialId = typeof assignment?.materialId === "string" ? assignment.materialId : "";
  const material = starterMaterials.find((candidate) => candidate.id === materialId);
  if (!material) throw new Error(missingCloudFeaMaterialMessage);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
