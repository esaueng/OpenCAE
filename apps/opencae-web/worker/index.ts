/// <reference types="./worker-configuration" />

// Local-first Cloudflare Worker: serves the built web app from Workers Static
// Assets with security headers. Simulations run entirely in the browser with
// OpenCAE Core (wasm meshing + local solver) — this Worker hosts no solver.
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
