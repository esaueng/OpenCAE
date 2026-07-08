// Offline asset caching (plan Workstream C): everything the app needs runs
// in-browser already, so offline support is purely an ASSET problem — the
// service worker must precache the app shell, every JS/CSS chunk (lazy
// worker chunks included: a user who goes offline before their first mesh
// still needs meshWorker + gmsh), and the wasm payloads:
//
// - gmsh: shipped gzip-precompressed as assets/gmsh-core-<hash>.wasm.gz plus
//   the stable-named manifest assets/gmsh-wasm.json (written by the
//   compressGmshWasmForDeploy plugin in vite.config.ts, which DELETES the raw
//   gmsh-core-<hash>.wasm).
// - occt-import-js: shipped raw (assets/occt-import-js-<hash>.wasm, ~7.4 MiB).
//
// This module is pure and shared between vite.config.ts (Workbox glob
// options) and unit tests (precache-entry derivation), so the "what must be
// cached for the app to honestly claim offline readiness" policy lives in
// exactly one place. scripts/verify-offline-pwa.mjs re-asserts the same
// policy against the real dist/sw.js and then proves it in a headless
// browser with the network gone.

/**
 * Dist files the service worker precaches (relative to dist/). `_headers` is
 * intentionally included even though it is not an offline runtime asset: its
 * revision forces installed service workers to update after CSP/header-only
 * deploys, so they do not keep serving a cached app shell with stale headers.
 * No "webmanifest": vite-plugin-pwa injects manifest.webmanifest itself, so
 * globbing it too would duplicate the entry.
 */
export const PRECACHE_GLOB_PATTERNS = ["**/*.{js,css,html,png,wasm,gz,json}", "_headers"];

/**
 * Extra script imported by the generated Workbox service worker. It reloads
 * already-open clients once a new SW activates, which moves stale tabs off an
 * old cached app-shell response and onto the current CSP/header set.
 */
export const SW_FORCE_REFRESH_SCRIPT = "sw-force-refresh.js";

/**
 * Hash-named assets are versioned by URL (revision:null is correct and avoids
 * pointless cache-bust query params) — EXCEPT assets/gmsh-wasm.json, whose URL
 * is stable while its content changes with every gmsh wasm hash. It must keep
 * a content revision or updated deploys would serve a stale manifest pointing
 * at a deleted .wasm.gz.
 */
export const DONT_CACHE_BUST_URLS = /^assets\/(?!gmsh-wasm\.json)/;

/**
 * Raw gmsh-core-<hash>.wasm must NEVER be precached: compressGmshWasmForDeploy
 * deletes it in closeBundle, so a precache entry for it would 404 during SW
 * install (and closeBundle ordering bugs would otherwise surface as a broken
 * deploy instead of a build-time diff). The .wasm.gz replacement is matched by
 * the "gz" glob above.
 */
export const PRECACHE_GLOB_IGNORES = ["**/gmsh-core-*.wasm"];

/**
 * Workbox refuses to precache files above 2 MiB by default; the gmsh .wasm.gz
 * is ~10.7 MiB and occt ~7.4 MiB. Anything deployable at all must fit the
 * Cloudflare static-asset cap (25 MiB/file, enforced at build time by
 * compressGmshWasmForDeploy), so align the precache limit with it.
 */
export const MAX_PRECACHE_FILE_BYTES = 25 * 1024 * 1024;

const RAW_GMSH_WASM_PATTERN = /(^|\/)gmsh-core-[^/]*\.wasm$/;
const GMSH_WASM_GZ_PATTERN = /(^|\/)gmsh-core-[^/]*\.wasm\.gz$/;
export const GMSH_WASM_MANIFEST_URL = "assets/gmsh-wasm.json";

/** Generated service-worker machinery is never part of its own precache. */
const SERVICE_WORKER_FILE_PATTERN = /(^|\/)(sw\.js|workbox-[^/]*\.js|registerSW\.js)$/;

function normalizeUrl(url: string): string {
  const withoutLeadingSlash = url.replace(/^\.?\//, "");
  const queryIndex = withoutLeadingSlash.indexOf("?");
  return queryIndex === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, queryIndex);
}

/**
 * Given a dist file listing (paths relative to dist/), derive every URL that
 * MUST be in the service-worker precache manifest for the app to genuinely
 * work with no network. In VITE_WASM_MESHING=0 builds the gmsh assets simply
 * do not exist, so nothing gmsh-related is required.
 */
export function requiredOfflineUrls(distFiles: string[]): string[] {
  return distFiles
    .map(normalizeUrl)
    .filter((file) => {
      if (SERVICE_WORKER_FILE_PATTERN.test(file)) return false;
      if (RAW_GMSH_WASM_PATTERN.test(file)) return false; // deleted post-compress; must not be required OR present
      return /\.(js|css|html|png|wasm|webmanifest)$/.test(file) || GMSH_WASM_GZ_PATTERN.test(file) || file === GMSH_WASM_MANIFEST_URL;
    })
    .sort();
}

export interface PrecacheAudit {
  ok: boolean;
  /** Required for offline use but absent from the precache manifest. */
  missing: string[];
  /** Precached URLs that must not be there (raw gmsh wasm that closeBundle deletes). */
  forbidden: string[];
}

/**
 * Audit a service-worker precache manifest (URLs from dist/sw.js) against the
 * actual dist listing. This is the build-time honesty gate: "Offline-ready"
 * in the UI is keyed off SW activation, which Workbox only reaches after
 * fetching every manifest entry — so the manifest itself must cover
 * everything the app can lazily load.
 */
export function auditPrecacheManifest(precachedUrls: string[], distFiles: string[]): PrecacheAudit {
  const precached = new Set(precachedUrls.map(normalizeUrl));
  const missing = requiredOfflineUrls(distFiles).filter((url) => !precached.has(url));
  const forbidden = [...precached].filter((url) => RAW_GMSH_WASM_PATTERN.test(url)).sort();
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}
