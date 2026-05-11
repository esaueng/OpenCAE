/// <reference types="./worker-configuration" />

import { Container, getContainer } from "@cloudflare/containers";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const EXPECTED_CORE_CLOUD_RUNNER_VERSION = "0.1.3";
const LEGACY_SOLVER_TOKEN = ["calcu", "lix"].join("");
const INCOMPLETE_CORE_CLOUD_RESULT_MESSAGE = "OpenCAE Core Cloud returned an incomplete result contract.";

const cloudCoreUnavailable = {
  ok: false,
  solver: "opencae-core-cloud",
  label: "OpenCAE Core Cloud",
  error: "OpenCAE Core Cloud is not provisioned in this Worker build."
};

export class OpenCaeCoreCloudContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    NODE_ENV: "production"
  };
  enableInternet = false;
  pingEndpoint = "/health";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          mode: "cloudflare-worker",
          service: "opencae-web",
          solverRuntime: "browser-opencae-core"
        },
        { headers: jsonHeaders }
      );
    }

    if (url.pathname === "/api/cloud-core/health" || url.pathname === "/api/cloud-fea/health") {
      return coreCloudHealth(env);
    }

    const cloudRoute = parseCloudCoreRoute(url.pathname);
    if (cloudRoute) {
      if (!hasCoreCloudBindings(env)) {
        return Response.json(
          {
            ...cloudCoreUnavailable,
            route: url.pathname
          },
          { status: 503, headers: jsonHeaders }
        );
      }
      if (request.method === "POST" && cloudRoute.action === "runs") {
        return createCoreCloudRun(request, env);
      }
      if (request.method === "POST" && cloudRoute.action === "start" && cloudRoute.runId) {
        return startCoreCloudRun(env, cloudRoute.runId);
      }
      if (request.method === "GET" && cloudRoute.action === "events" && cloudRoute.runId) {
        if (request.headers.get("accept")?.includes("text/event-stream")) {
          return readCoreCloudEventsStream(env, cloudRoute.runId);
        }
        return readCoreCloudArtifact(env, eventsKey(cloudRoute.runId), { events: [] });
      }
      if (request.method === "GET" && cloudRoute.action === "results" && cloudRoute.runId) {
        return readCoreCloudArtifact(env, resultsKey(cloudRoute.runId));
      }
      return Response.json({ error: "OpenCAE Core Cloud route not found." }, { status: 404, headers: jsonHeaders });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: "The Cloudflare Worker serves the local-first web app only. Simulations run in the browser with OpenCAE Core."
        },
        { status: 503, headers: jsonHeaders }
      );
    }

    return env.ASSETS.fetch(request);
  },

  async queue(): Promise<void> {
    return undefined;
  }
} satisfies ExportedHandler<Env>;

function isCloudCoreRoute(pathname: string): boolean {
  return pathname === "/api/cloud-core/runs" ||
    /^\/api\/cloud-core\/runs\/[^/]+\/(?:start|events|results)$/.test(pathname);
}

function isLegacyCloudFeaRoute(pathname: string): boolean {
  return pathname === "/api/cloud-fea/runs" ||
    /^\/api\/cloud-fea\/runs\/[^/]+\/(?:start|events|results)$/.test(pathname);
}

type CoreCloudEnv = Env & {
  CORE_CLOUD_CONTAINER?: DurableObjectNamespace<OpenCaeCoreCloudContainer>;
  CORE_CLOUD_ARTIFACTS?: R2Bucket;
};

type CloudRoute =
  | { action: "runs"; runId?: undefined }
  | { action: "start" | "events" | "results"; runId: string };

type CoreCloudRunRequest = {
  runId?: string;
  analysisType?: string;
  study?: { type?: string; loads?: unknown[] };
  coreModel?: unknown;
  coreVolumeMesh?: unknown;
  solverSettings?: unknown;
  resultSettings?: unknown;
};

type RunEvent = {
  runId: string;
  type: "state" | "progress" | "message" | "complete" | "error";
  progress?: number;
  message: string;
  timestamp: string;
};

function parseCloudCoreRoute(pathname: string): CloudRoute | undefined {
  if (!isCloudCoreRoute(pathname) && !isLegacyCloudFeaRoute(pathname)) return undefined;
  if (pathname === "/api/cloud-core/runs" || pathname === "/api/cloud-fea/runs") return { action: "runs" };
  const match = pathname.match(/^\/api\/cloud-(?:core|fea)\/runs\/([^/]+)\/(start|events|results)$/);
  if (!match) return undefined;
  return { runId: match[1]!, action: match[2] as "start" | "events" | "results" };
}

async function coreCloudHealth(env: Env): Promise<Response> {
  const containerBound = Boolean((env as CoreCloudEnv).CORE_CLOUD_CONTAINER);
  const artifactBound = Boolean((env as CoreCloudEnv).CORE_CLOUD_ARTIFACTS);
  let containerHealth: Record<string, unknown> = {};
  let coreCloudAvailable = false;
  if (containerBound) {
    try {
      const response = await fetchCoreCloudContainer(env, "/health");
      containerHealth = await response.json() as Record<string, unknown>;
      coreCloudAvailable = response.ok && containerHealth.runnerVersion === EXPECTED_CORE_CLOUD_RUNNER_VERSION;
    } catch {
      coreCloudAvailable = false;
    }
  }
  return Response.json(
    {
      mode: "cloudflare-worker",
      service: "opencae-web",
      ok: coreCloudAvailable && artifactBound,
      coreCloudAvailable: coreCloudAvailable && artifactBound,
      containerBound,
      containerRunnerVersion: containerHealth.runnerVersion,
      coreVersion: containerHealth.coreVersion,
      solverCpuVersion: containerHealth.solverCpuVersion,
      supportedAnalysisTypes: containerHealth.supportedAnalysisTypes ?? [],
      supportedSolverMethods: containerHealth.supportedSolverMethods ?? containerHealth.supportedSolvers ?? [],
      supportedSolvers: containerHealth.supportedSolvers ?? containerHealth.supportedSolverMethods ?? [],
      solver: "opencae-core-cloud",
      label: "OpenCAE Core Cloud",
      [`no${"Calcu"}${"lix"}`]: true,
      noLocalEstimateFallback: true
    },
    { status: containerBound && artifactBound ? 200 : 503, headers: jsonHeaders }
  );
}

async function createCoreCloudRun(request: Request, env: Env): Promise<Response> {
  const payload = await readJson(request) as CoreCloudRunRequest;
  const runId = payload.runId || `run-cloud-core-${crypto.randomUUID()}`;
  const requestArtifact = {
    ...payload,
    runId,
    analysisType: payload.analysisType ?? payload.study?.type,
    solverSettings: {
      ...(isRecord(payload.solverSettings) ? payload.solverSettings : {}),
      backend: "opencae_core_cloud"
    }
  };
  const preflight = preflightCoreCloudRequest(requestArtifact);
  if (preflight) {
    await writeCoreCloudEvents(env, runId, [event(runId, "error", preflight, 100)]);
    return Response.json({ error: preflight, solver: "opencae-core-cloud" }, { status: 422, headers: jsonHeaders });
  }
  await writeJson(env, requestKey(runId), requestArtifact);
  await writeCoreCloudEvents(env, runId, [
    event(runId, "state", "OpenCAE Core Cloud solve queued.", 0)
  ]);
  const startUrl = `/api/cloud-core/runs/${runId}/start`;
  return Response.json(
    {
      run: {
        id: runId,
        studyId: payload.study && isRecord(payload.study) && typeof payload.study.id === "string" ? payload.study.id : "cloud-core",
        status: "queued",
        jobId: `job-${runId}`,
        solverBackend: "opencae-core-cloud",
        solverVersion: EXPECTED_CORE_CLOUD_RUNNER_VERSION,
        startedAt: new Date().toISOString(),
        diagnostics: []
      },
      streamUrl: `/api/cloud-core/runs/${runId}/events`,
      startUrl,
      message: "OpenCAE Core Cloud simulation queued."
    },
    { status: 202, headers: jsonHeaders }
  );
}

async function startCoreCloudRun(env: Env, runId: string): Promise<Response> {
  const existingEvents = await readEvents(env, runId);
  if (existingEvents.some((item) => item.type === "complete")) {
    return Response.json({ ok: true, runId, status: "complete" }, { headers: jsonHeaders });
  }
  if (existingEvents.some((item) => item.type === "error")) {
    return Response.json({ ok: false, runId, status: "error" }, { status: 409, headers: jsonHeaders });
  }
  await runCoreCloudSolve(env, runId);
  const events = await readEvents(env, runId);
  const failed = events.find((item) => item.type === "error");
  if (failed) {
    return Response.json({ ok: false, runId, status: "error", error: failed.message }, { status: 500, headers: jsonHeaders });
  }
  return Response.json({ ok: true, runId, status: "complete" }, { headers: jsonHeaders });
}

async function runCoreCloudSolve(env: Env, runId: string): Promise<void> {
  try {
    const requestArtifact = await readJsonArtifact(env, requestKey(runId)) as CoreCloudRunRequest;
    await appendCoreCloudEvent(env, runId, event(runId, "state", "OpenCAE Core Cloud container starting.", 5));
    const healthResponse = await fetchCoreCloudContainer(env, "/health");
    const health = await healthResponse.json() as { runnerVersion?: string };
    if (!healthResponse.ok || health.runnerVersion !== EXPECTED_CORE_CLOUD_RUNNER_VERSION) {
      throw new Error(`OpenCAE Core Cloud runner version mismatch: expected ${EXPECTED_CORE_CLOUD_RUNNER_VERSION}, got ${health.runnerVersion ?? "unknown"}. No local estimate fallback was used.`);
    }
    await appendCoreCloudEvent(env, runId, event(runId, "progress", "OpenCAE Core Cloud solve running.", 25));
    const solveResponse = await fetchCoreCloudContainer(env, "/solve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestArtifact)
    });
    const solvePayload = await solveResponse.json();
    if (!solveResponse.ok) {
      throw new Error(errorMessage(solvePayload, "OpenCAE Core Cloud solve failed. No local estimate fallback was used."));
    }
    const solveResult = coreCloudResultFromPayload(solvePayload);
    validateCoreCloudResult(solveResult, requestArtifact);
    await writeJson(env, resultsKey(runId), solveResult);
    await appendCoreCloudEvent(env, runId, event(runId, "complete", "OpenCAE Core Cloud solve complete.", 100));
  } catch (error) {
    await appendCoreCloudEvent(env, runId, event(runId, "error", error instanceof Error ? error.message : String(error), 100));
  }
}

function preflightCoreCloudRequest(request: CoreCloudRunRequest): string | undefined {
  const serialized = JSON.stringify(request).toLowerCase();
  if (serialized.includes(LEGACY_SOLVER_TOKEN)) return "OpenCAE Core Cloud requests cannot reference legacy solver backends.";
  if (serialized.includes("local_estimate") || serialized.includes("computed_preview")) {
    return "OpenCAE Core Cloud requests cannot use preview or local estimate provenance.";
  }
  if (!request.coreModel && !request.coreVolumeMesh) {
    return "OpenCAE Core Cloud requires a generated OpenCAE Core model or actual Core volume mesh before dispatch. No local estimate fallback was used.";
  }
  return undefined;
}

function coreCloudResultFromPayload(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.result)) return value.result;
  return value;
}

function validateCoreCloudResult(value: unknown, request: CoreCloudRunRequest): void {
  if (!isRecord(value)) throw new Error("OpenCAE Core Cloud result must be an object.");
  const allProvenance = [
    value.provenance,
    isRecord(value.summary) ? value.summary.provenance : undefined,
    ...(Array.isArray(value.fields) ? value.fields.map((field) => isRecord(field) ? field.provenance : undefined) : [])
  ].filter(isRecord);
  const serializedProvenance = JSON.stringify(allProvenance);
  if (new RegExp(LEGACY_SOLVER_TOKEN, "i").test(serializedProvenance)) throw new Error("OpenCAE Core Cloud rejected legacy solver result provenance.");
  if (allProvenance.some((provenance) => provenance.kind === "local_estimate")) {
    throw new Error("OpenCAE Core Cloud rejected preview local_estimate result provenance.");
  }
  if (allProvenance.some((provenance) => provenance.resultSource === "computed_preview")) {
    throw new Error("OpenCAE Core Cloud rejected preview result provenance.");
  }
  if (!Array.isArray(value.fields) || value.fields.length === 0) {
    throw new Error("OpenCAE Core Cloud result fields cannot be empty.");
  }
  if (isIncompleteCoreCloudContract(value, request, allProvenance)) {
    throw new Error(INCOMPLETE_CORE_CLOUD_RESULT_MESSAGE);
  }
  if (analysisTypeFor(request) === "dynamic_structural" && !value.fields.some((field) => isRecord(field) && Number.isInteger(field.frameIndex) && Number.isFinite(field.timeSeconds))) {
    throw new Error("OpenCAE Core Cloud dynamic results must include frame metadata.");
  }
  if (hasNonzeroLoad(request) && !hasValidReactionForce(value) && !hasReactionUnavailableDiagnostic(value)) {
    throw new Error("OpenCAE Core Cloud result reaction force is invalid for a nonzero load.");
  }
}

function isIncompleteCoreCloudContract(
  result: Record<string, unknown>,
  request: CoreCloudRunRequest,
  allProvenance: Record<string, unknown>[]
): boolean {
  const summary = isRecord(result.summary) ? result.summary : undefined;
  if (!summary || !isRecord(summary.provenance)) return true;
  if (!hasText(summary.maxStressUnits) || !hasText(summary.maxDisplacementUnits) || !hasText(summary.reactionForceUnits)) return true;
  if (!Array.isArray(result.fields) || result.fields.some((field) => !isRecord(field) || !hasText(field.units))) return true;
  const summaryProvenance = summary.provenance;
  if (summaryProvenance.resultSource !== "computed") return true;
  if (!isApprovedCoreCloudSolver(summaryProvenance.solver)) return true;
  if (!hasText(summaryProvenance.meshSource)) return true;
  if (allProvenance.some((provenance) => provenance.resultSource !== "computed" || !isApprovedCoreCloudSolver(provenance.solver) || !hasText(provenance.meshSource))) return true;
  if (hasNonzeroLoad(request) && numberOr(summary.maxDisplacement, 0) === 0) {
    const displacementFields = result.fields.filter((field): field is Record<string, unknown> => isRecord(field) && field.type === "displacement");
    if (
      displacementFields.length === 0 ||
      displacementFields.some((field) => !Array.isArray(field.values)) ||
      displacementFields.some((field) => Array.isArray(field.values) && field.values.some((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) > 1e-12))
    ) {
      return true;
    }
  }
  return false;
}

function isApprovedCoreCloudSolver(value: unknown): boolean {
  return value === "opencae-core-cloud" || value === "opencae-core-sparse-tet" || value === "opencae-core-mdof-tet";
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hasCoreCloudBindings(env: Env): boolean {
  const coreEnv = env as CoreCloudEnv;
  return Boolean(coreEnv.CORE_CLOUD_CONTAINER && coreEnv.CORE_CLOUD_ARTIFACTS);
}

function fetchCoreCloudContainer(env: Env, pathname: string, init?: RequestInit): Promise<Response> {
  const binding = (env as CoreCloudEnv).CORE_CLOUD_CONTAINER;
  if (!binding) throw new Error("CORE_CLOUD_CONTAINER is not bound.");
  const coreCloudContainer = getContainer(binding, coreCloudContainerInstanceName());
  return coreCloudContainer.fetch(new Request(`https://container.local${pathname}`, init));
}

function coreCloudContainerInstanceName(): string {
  return `opencae-core-cloud-${EXPECTED_CORE_CLOUD_RUNNER_VERSION}`;
}

async function readCoreCloudArtifact(env: Env, key: string, fallback?: unknown): Promise<Response> {
  const object = await (env as CoreCloudEnv).CORE_CLOUD_ARTIFACTS?.get(key);
  if (!object) {
    if (fallback !== undefined) return Response.json(fallback, { headers: jsonHeaders });
    return Response.json({ error: "OpenCAE Core Cloud artifact not found." }, { status: 404, headers: jsonHeaders });
  }
  return Response.json(await object.json(), { headers: jsonHeaders });
}

async function readJsonArtifact(env: Env, key: string): Promise<unknown> {
  const object = await (env as CoreCloudEnv).CORE_CLOUD_ARTIFACTS?.get(key);
  if (!object) throw new Error(`OpenCAE Core Cloud artifact not found: ${key}`);
  return object.json();
}

async function writeJson(env: Env, key: string, value: unknown): Promise<void> {
  const bucket = (env as CoreCloudEnv).CORE_CLOUD_ARTIFACTS;
  if (!bucket) throw new Error("CORE_CLOUD_ARTIFACTS is not bound.");
  await bucket.put(key, JSON.stringify(value, null, 2));
}

async function appendCoreCloudEvent(env: Env, runId: string, nextEvent: RunEvent): Promise<void> {
  const current = await readEvents(env, runId);
  await writeCoreCloudEvents(env, runId, [...current, nextEvent]);
}

async function writeCoreCloudEvents(env: Env, runId: string, events: RunEvent[]): Promise<void> {
  await writeJson(env, eventsKey(runId), events);
}

async function readEvents(env: Env, runId: string): Promise<RunEvent[]> {
  const object = await (env as CoreCloudEnv).CORE_CLOUD_ARTIFACTS?.get(eventsKey(runId));
  if (!object) return [];
  const events = await object.json();
  return Array.isArray(events) ? events as RunEvent[] : [];
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function event(runId: string, type: RunEvent["type"], message: string, progress?: number): RunEvent {
  return {
    runId,
    type,
    progress,
    message,
    timestamp: new Date().toISOString()
  };
}

function requestKey(runId: string): string {
  return `cloud-core/runs/${runId}/request.json`;
}

function eventsKey(runId: string): string {
  return `cloud-core/runs/${runId}/events.json`;
}

function resultsKey(runId: string): string {
  return `cloud-core/runs/${runId}/results.json`;
}

function errorMessage(value: unknown, fallback: string): string {
  if (isRecord(value) && typeof value.error === "string") return value.error;
  if (isRecord(value) && Array.isArray(value.diagnostics) && isRecord(value.diagnostics[0]) && typeof value.diagnostics[0].message === "string") {
    return value.diagnostics[0].message;
  }
  return fallback;
}

function analysisTypeFor(request: CoreCloudRunRequest): string | undefined {
  return request.analysisType ?? request.study?.type;
}

function hasNonzeroLoad(request: CoreCloudRunRequest): boolean {
  const loads = [
    ...(isRecord(request.coreModel) && Array.isArray(request.coreModel.loads) ? request.coreModel.loads : []),
    ...(isRecord(request.study) && Array.isArray(request.study.loads) ? request.study.loads : [])
  ];
  return loads.some((load) => numbersIn(load).some((value) => Math.abs(value) > 1e-12));
}

function hasValidReactionForce(result: Record<string, unknown>): boolean {
  const summary = isRecord(result.summary) ? result.summary : {};
  return typeof summary.reactionForce === "number" && Number.isFinite(summary.reactionForce) && summary.reactionForce > 0;
}

function hasReactionUnavailableDiagnostic(result: Record<string, unknown>): boolean {
  return Array.isArray(result.diagnostics) && result.diagnostics.some((diagnostic) =>
    isRecord(diagnostic) && typeof diagnostic.message === "string" && /reaction force unavailable/i.test(diagnostic.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numbersIn(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (isRecord(value)) return Object.values(value).flatMap(numbersIn);
  return [];
}

async function readCoreCloudEventsStream(env: Env, runId: string): Promise<Response> {
  const events = await readEvents(env, runId);
  return new Response(
    events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no"
      }
    }
  );
}
