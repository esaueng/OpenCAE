/// <reference types="./worker-configuration" />

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const cloudCoreUnavailable = {
  ok: false,
  solver: "opencae-core-cloud",
  label: "OpenCAE Core Cloud",
  error: "OpenCAE Core Cloud is not provisioned in this Worker build."
};

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

    if (url.pathname === "/api/cloud-core/health" || url.pathname === "/api/cloud-fea/health") {
      return Response.json(cloudCoreUnavailable, { status: 503, headers: jsonHeaders });
    }

    if (isCloudCoreRoute(url.pathname) || isLegacyCloudFeaRoute(url.pathname)) {
      return Response.json(
        {
          ...cloudCoreUnavailable,
          route: url.pathname
        },
        { status: 503, headers: jsonHeaders }
      );
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
    /^\/api\/cloud-core\/runs\/[^/]+\/(?:events|results)$/.test(pathname);
}

function isLegacyCloudFeaRoute(pathname: string): boolean {
  return pathname === "/api/cloud-fea/runs" ||
    /^\/api\/cloud-fea\/runs\/[^/]+\/(?:events|results)$/.test(pathname);
}
