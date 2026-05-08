/// <reference types="./worker-configuration" />

import { Container, getContainer } from "@cloudflare/containers";

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
      const proxied = proxyCoreCloudRequest(request, env, "/health");
      if (proxied) return proxied;
      return Response.json(cloudCoreUnavailable, { status: 503, headers: jsonHeaders });
    }

    if (isCloudCoreRoute(url.pathname) || isLegacyCloudFeaRoute(url.pathname)) {
      const proxied = proxyCoreCloudRequest(request, env, containerPathForCloudRoute(url.pathname));
      if (proxied) return proxied;
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

function proxyCoreCloudRequest(request: Request, env: Env, pathname: string): Promise<Response> | undefined {
  const binding = (env as Env & { CORE_CLOUD_CONTAINER?: DurableObjectNamespace<OpenCaeCoreCloudContainer> }).CORE_CLOUD_CONTAINER;
  if (!binding) return undefined;
  const target = new URL(request.url);
  target.pathname = pathname;
  target.search = "";
  return getContainer(binding, "opencae-core-cloud").fetch(new Request(target, request));
}

function containerPathForCloudRoute(pathname: string): string {
  if (pathname === "/api/cloud-core/runs" || pathname === "/api/cloud-fea/runs") return "/solve";
  return pathname.replace(/^\/api\/cloud-(?:core|fea)/, "");
}
