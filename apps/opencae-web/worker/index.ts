type AssetBinding = {
  fetch(request: Request): Promise<Response>;
};

type R2ObjectBody = {
  text(): Promise<string>;
};

type R2BucketBinding = {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
};

type QueueBinding = {
  send(message: unknown): Promise<void>;
};

type ContainerFetchBinding = {
  startAndWaitForPorts?(): Promise<void>;
  fetch(request: Request): Promise<Response>;
};

type ContainerBinding = ContainerFetchBinding | {
  get?(id?: string): ContainerFetchBinding;
  getByName?(name: string): ContainerFetchBinding;
  getRandom?(): ContainerFetchBinding;
};

type Env = {
  ASSETS: AssetBinding;
  FEA_ARTIFACTS?: R2BucketBinding;
  FEA_RUN_QUEUE?: QueueBinding;
  FEA_CONTAINER?: ContainerBinding;
};

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

export class OpenCaeFeaContainer {
  async fetch(): Promise<Response> {
    return Response.json(
      {
        error: "OpenCAE FEA container binding is configured. The CalculiX adapter endpoint is served by the container image."
      },
      { status: 501, headers: jsonHeaders }
    );
  }
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json(
        { ok: true, mode: "cloudflare-worker", service: "opencae-web" },
        { headers: jsonHeaders }
      );
    }

    if (url.pathname === "/api/cloud-fea/runs" && request.method === "POST") {
      return createCloudFeaRun(request, env, ctx);
    }

    const eventsMatch = url.pathname.match(/^\/api\/cloud-fea\/runs\/([^/]+)\/events$/);
    if (eventsMatch && request.method === "GET") {
      return getCloudFeaRunEvents(eventsMatch[1]!, env);
    }

    const resultsMatch = url.pathname.match(/^\/api\/cloud-fea\/runs\/([^/]+)\/results$/);
    if (resultsMatch && request.method === "GET") {
      return getCloudFeaRunResults(resultsMatch[1]!, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: "The Cloudflare Worker deployment serves the local-first web app only. API-backed operations fall back to browser-local behavior."
        },
        { status: 503, headers: jsonHeaders }
      );
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: { messages: Array<{ body: unknown; ack(): void; retry(): void }> }, env: Env): Promise<void> {
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
      await runCloudFeaSolve(runId, env);
      message.ack();
    }
  }
};

async function createCloudFeaRun(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  if (!env.FEA_ARTIFACTS) {
    return Response.json({ error: "Cloud FEA is not configured for this deployment." }, { status: 503, headers: jsonHeaders });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
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
    study: isRecord(body.study) ? body.study : undefined,
    displayModel: isRecord(body.displayModel) ? body.displayModel : undefined,
    geometry: isRecord(body.geometry) ? body.geometry : undefined,
    dynamicSettings: isRecord(body.dynamicSettings) ? body.dynamicSettings : undefined,
    createdAt: now
  };
  const queuedEvents = [
    { runId, type: "state", progress: 0, message: "Cloud FEA run queued.", timestamp: now },
    { runId, type: "progress", progress: 5, message: "Waiting for CalculiX container worker.", timestamp: now }
  ];
  await env.FEA_ARTIFACTS.put(`runs/${runId}/request.json`, JSON.stringify(requestArtifact, null, 2));
  await env.FEA_ARTIFACTS.put(`runs/${runId}/events.json`, JSON.stringify(queuedEvents, null, 2));
  if (env.FEA_RUN_QUEUE) {
    await env.FEA_RUN_QUEUE.send({ runId });
  } else if (ctx) {
    ctx.waitUntil(runCloudFeaSolve(runId, env));
  } else {
    await runCloudFeaSolve(runId, env);
  }
  return Response.json({ run, streamUrl: `/api/cloud-fea/runs/${runId}/events`, message: "Cloud FEA simulation queued." }, { status: 202, headers: jsonHeaders });
}

async function getCloudFeaRunEvents(runId: string, env: Env): Promise<Response> {
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

async function getCloudFeaRunResults(runId: string, env: Env): Promise<Response> {
  if (!env.FEA_ARTIFACTS) {
    return Response.json({ error: "Cloud FEA is not configured for this deployment." }, { status: 503, headers: jsonHeaders });
  }
  const object = await env.FEA_ARTIFACTS.get(`runs/${runId}/results.json`);
  if (!object) {
    return Response.json({ error: "Cloud FEA results are not ready." }, { status: 404, headers: jsonHeaders });
  }
  return Response.json(JSON.parse(await object.text()), { headers: jsonHeaders });
}

async function runCloudFeaSolve(runId: string, env: Env): Promise<void> {
  const artifacts = env.FEA_ARTIFACTS;
  if (!artifacts) throw new Error("Cloud FEA artifacts bucket is not configured.");
  const now = new Date().toISOString();
  const requestObject = await artifacts.get(`runs/${runId}/request.json`);
  const requestArtifact = requestObject ? JSON.parse(await requestObject.text()) as Record<string, unknown> : { runId };
  const events = [
    { runId, type: "state", progress: 0, message: "Cloud FEA run queued.", timestamp: now },
    { runId, type: "progress", progress: 15, message: "Meshing geometry for CalculiX.", timestamp: now },
    { runId, type: "progress", progress: 30, message: "Generating CalculiX transient input deck.", timestamp: now },
    { runId, type: "progress", progress: 60, message: "Running CalculiX container solve.", timestamp: now },
    { runId, type: "progress", progress: 90, message: "Post-processing framed nodal and element output.", timestamp: now }
  ];
  await artifacts.put(`runs/${runId}/events.json`, JSON.stringify(events, null, 2));
  try {
    const solveResponse = await callFeaContainer(env, { ...requestArtifact, runId });
    if (!solveResponse.ok) {
      const failure = await readContainerFailure(solveResponse);
      await artifacts.put(`runs/${runId}/events.json`, JSON.stringify([
        ...events,
        { runId, type: "error", progress: 100, message: failure, timestamp: new Date().toISOString() }
      ], null, 2));
      await artifacts.put(`runs/${runId}/failed.json`, JSON.stringify({ runId, error: failure, timestamp: new Date().toISOString() }, null, 2));
      return;
    }
    const containerResult = await solveResponse.json() as Record<string, unknown>;
    const normalized = normalizeContainerResult(runId, containerResult);
    const resultArtifacts = isRecord(containerResult.artifacts) ? containerResult.artifacts : {};
    await putOptionalArtifact(artifacts, `runs/${runId}/input.inp`, resultArtifacts.inputDeck);
    await putOptionalArtifact(artifacts, `runs/${runId}/solver.log`, resultArtifacts.solverLog);
    await putOptionalArtifact(artifacts, `runs/${runId}/mesh.json`, JSON.stringify(resultArtifacts.meshSummary ?? {}, null, 2));
    await artifacts.put(`runs/${runId}/results.json`, JSON.stringify(normalized, null, 2));
    await artifacts.put(`runs/${runId}/events.json`, JSON.stringify([
      ...events,
      { runId, type: "complete", progress: 100, message: "Cloud FEA transient solve complete.", timestamp: new Date().toISOString() }
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

async function callFeaContainer(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const binding = env.FEA_CONTAINER;
  if (!binding) throw new Error("Cloud FEA container binding is not configured.");
  const fetcher = "fetch" in binding
    ? binding
    : binding.getByName
      ? binding.getByName(typeof payload.runId === "string" ? payload.runId : crypto.randomUUID())
      : binding.getRandom
        ? binding.getRandom()
        : binding.get?.(typeof payload.runId === "string" ? payload.runId : undefined);
  if (!fetcher) throw new Error("Cloud FEA container instance could not be resolved.");
  await fetcher.startAndWaitForPorts?.();
  return fetcher.fetch(new Request("https://opencae-fea-container/solve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

async function readContainerFailure(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.message === "string") return payload.message;
  return `Cloud FEA container failed with HTTP ${response.status}.`;
}

function normalizeContainerResult(runId: string, result: Record<string, unknown>) {
  const summary = isRecord(result.summary) ? result.summary : {};
  const fields = Array.isArray(result.fields) ? result.fields : [];
  return {
    summary,
    fields: fields.map((field) => isRecord(field) ? { ...field, runId: typeof field.runId === "string" ? field.runId : runId } : field)
  };
}

async function putOptionalArtifact(artifacts: R2BucketBinding, key: string, value: unknown): Promise<void> {
  if (typeof value !== "string") return;
  await artifacts.put(key, value);
}

function analysisTypeFromBody(body: Record<string, unknown>): string | undefined {
  if (isRecord(body.study) && typeof body.study.type === "string") return body.study.type;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
