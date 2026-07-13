/// <reference types="./worker-configuration" />

// Local-first Cloudflare Worker: serves the built web app from Workers Static
// Assets with security headers and stores only explicitly approved,
// client-encrypted recovery backups. Simulations run entirely in the browser
// with OpenCAE Core (wasm meshing + local solver) — this Worker hosts no solver.
//
// The OpenCAE Core Cloud solve infrastructure (container Durable Object, R2 run
// artifacts, run tokens, /api/cloud-core/* orchestration) was retired in July
// 2026; see docs/cloud-retirement.md. Requests to the retired routes get an
// honest 410 so old clients and monitors fail loudly instead of hanging.

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  ...securityHeaders()
};

const CLOUD_SOLVE_RETIRED_MESSAGE =
  "OpenCAE Core Cloud is retired (July 2026). Simulations run locally in your browser with OpenCAE Core; there is no cloud solve endpoint. See docs/cloud-retirement.md in the OpenCAE repository.";
const PROJECT_BACKUP_PREFIX = "project-backups/";
const PROJECT_BACKUP_MAX_BYTES = 95 * 1024 * 1024;
const PROJECT_BACKUP_RETENTION_DAYS = 30;
const BACKUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BACKUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/u;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    if (isRetiredCloudSolveRoute(url.pathname)) {
      return Response.json(
        {
          error: CLOUD_SOLVE_RETIRED_MESSAGE,
          retired: true,
          solverRuntime: "browser-opencae-core",
          route: url.pathname
        },
        { status: 410, headers: jsonHeaders }
      );
    }

    const backupId = projectBackupId(url.pathname);
    if (backupId) return handleProjectBackup(request, env, backupId);

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: "The Cloudflare Worker serves the local-first web app only. Simulations run in the browser with OpenCAE Core."
        },
        { status: 404, headers: jsonHeaders }
      );
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  // Inert queue handler for stale legacy Workers Builds consumers.
  async queue(): Promise<void> {
    return undefined;
  }
} satisfies ExportedHandler<Env>;

async function handleProjectBackup(request: Request, env: Env, backupId: string): Promise<Response> {
  if (!env.PROJECT_BACKUPS || !env.PROJECT_BACKUP_RATE_LIMITER) {
    return backupJson({ error: "Encrypted cloud recovery is unavailable on this deployment." }, 503);
  }
  if (!BACKUP_ID_PATTERN.test(backupId)) return backupJson({ error: "Invalid cloud backup id." }, 400);
  const token = request.headers.get("x-opencae-backup-token") ?? "";
  if (!BACKUP_TOKEN_PATTERN.test(token)) return backupJson({ error: "Cloud backup authorization is missing or invalid." }, 401);
  const key = `${PROJECT_BACKUP_PREFIX}${backupId}`;

  if (request.method === "PUT") {
    const actor = request.headers.get("cf-connecting-ip") ?? "unknown";
    const rateLimit = await env.PROJECT_BACKUP_RATE_LIMITER.limit({ key: actor });
    if (!rateLimit.success) return backupJson({ error: "Cloud backup rate limit exceeded. Save a local project file and try again later." }, 429);
    const contentLength = Number(request.headers.get("content-length"));
    if (!Number.isFinite(contentLength) || contentLength <= 12 || contentLength > PROJECT_BACKUP_MAX_BYTES) {
      return backupJson({ error: "Encrypted cloud backups must be between 13 bytes and 95 MiB. Save this project to a local file instead." }, 413);
    }
    if (!request.body) return backupJson({ error: "Cloud backup body is missing." }, 400);
    const expiresAt = new Date(Date.now() + PROJECT_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await env.PROJECT_BACKUPS.put(key, request.body, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        tokenHash: await sha256Hex(token),
        expiresAt,
        runId: sanitizeMetadata(request.headers.get("x-opencae-run-id"))
      }
    });
    return backupJson({ backupId, expiresAt }, 201);
  }

  const object = await env.PROJECT_BACKUPS.get(key);
  if (!object) return backupJson({ error: "Cloud backup was not found." }, 404);
  if (!constantTimeEqual(object.customMetadata?.tokenHash ?? "", await sha256Hex(token))) {
    return backupJson({ error: "Cloud backup authorization failed." }, 403);
  }
  const expiresAt = object.customMetadata?.expiresAt ?? "";
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    await env.PROJECT_BACKUPS.delete(key);
    return backupJson({ error: "Cloud backup has expired." }, 410);
  }
  if (request.method === "DELETE") {
    await env.PROJECT_BACKUPS.delete(key);
    return new Response(null, { status: 204, headers: securityHeaders() });
  }
  if (request.method !== "GET") return backupJson({ error: "Method not allowed." }, 405);
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "content-length": String(object.size),
      ...securityHeaders()
    }
  });
}

function projectBackupId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/project-backups\/([^/]+)$/u);
  return match?.[1] ?? null;
}

function backupJson(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: jsonHeaders });
}

function sanitizeMetadata(value: string | null): string {
  return value?.startsWith("run-local-") ? value.slice(0, 128) : "";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

// The retired cloud solve surface: /api/cloud-core/* (run creation, start,
// events, results, cancel, health) and its legacy /api/cloud-fea/* alias.
function isRetiredCloudSolveRoute(pathname: string): boolean {
  return pathname === "/api/cloud-core" ||
    pathname.startsWith("/api/cloud-core/") ||
    pathname === "/api/cloud-fea" ||
    pathname.startsWith("/api/cloud-fea/");
}

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders())) {
    secured.headers.set(key, value);
  }
  return secured;
}

function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'self'",
      // occt-import-js uses Emscripten embind's Function-based method caller
      // generation during STEP import; without unsafe-eval uploaded STEP
      // previews fail under the deployed CSP.
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://plausible.io https://cdn.jsdelivr.net",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()"
  };
}
