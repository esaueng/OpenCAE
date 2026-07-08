// Precache-entry derivation for the offline service worker (Workstream C).
// The dist listings mirror real builds: default (gmsh .wasm.gz + stable
// manifest json, raw wasm deleted by compressGmshWasmForDeploy) and
// VITE_WASM_MESHING=0 (no gmsh assets at all).
import { describe, expect, test } from "vitest";
import {
  DONT_CACHE_BUST_URLS,
  GMSH_WASM_MANIFEST_URL,
  MAX_PRECACHE_FILE_BYTES,
  PRECACHE_GLOB_IGNORES,
  PRECACHE_GLOB_PATTERNS,
  auditPrecacheManifest,
  requiredOfflineUrls
} from "./offlinePrecache";

const DEFAULT_DIST = [
  "index.html",
  "opencae-logo.png",
  "_headers",
  "manifest.webmanifest",
  "sw.js",
  "workbox-835c8c05.js",
  "assets/index-BE098Mki.js",
  "assets/index-DPJAkoKU.css",
  "assets/meshWorker-CFH3q_LL.js",
  "assets/solveWorker-CYDTlGYD.js",
  "assets/occt-import-js-BhHfLpto.wasm",
  "assets/gmsh-core-HGUso1mk.wasm.gz",
  "assets/gmsh-wasm.json",
  "assets/static-analysis-CM2D4-im.png"
];

describe("requiredOfflineUrls", () => {
  test("requires app shell, every JS/CSS chunk, and both wasm payloads", () => {
    const required = requiredOfflineUrls(DEFAULT_DIST);
    expect(required).toContain("index.html");
    expect(required).toContain("assets/index-BE098Mki.js");
    expect(required).toContain("assets/index-DPJAkoKU.css");
    // Lazy worker chunks: offline-first-use must work.
    expect(required).toContain("assets/meshWorker-CFH3q_LL.js");
    expect(required).toContain("assets/solveWorker-CYDTlGYD.js");
    // Wasm assets: the honesty requirement — no "offline ready" without them.
    expect(required).toContain("assets/occt-import-js-BhHfLpto.wasm");
    expect(required).toContain("assets/gmsh-core-HGUso1mk.wasm.gz");
    expect(required).toContain(GMSH_WASM_MANIFEST_URL);
    // Start-screen imagery renders offline too.
    expect(required).toContain("opencae-logo.png");
    expect(required).toContain("assets/static-analysis-CM2D4-im.png");
  });

  test("never requires the service worker machinery, _headers, or the deleted raw gmsh wasm", () => {
    const required = requiredOfflineUrls([...DEFAULT_DIST, "assets/gmsh-core-HGUso1mk.wasm", "registerSW.js"]);
    expect(required).not.toContain("sw.js");
    expect(required).not.toContain("workbox-835c8c05.js");
    expect(required).not.toContain("registerSW.js");
    expect(required).not.toContain("_headers");
    expect(required).not.toContain("assets/gmsh-core-HGUso1mk.wasm");
  });

  test("VITE_WASM_MESHING=0 dist simply has no gmsh requirements", () => {
    const flagOff = DEFAULT_DIST.filter((file) => !file.includes("gmsh"));
    const required = requiredOfflineUrls(flagOff);
    expect(required.some((url) => url.includes("gmsh"))).toBe(false);
    expect(required).toContain("assets/occt-import-js-BhHfLpto.wasm");
  });
});

describe("auditPrecacheManifest", () => {
  const fullManifest = requiredOfflineUrls(DEFAULT_DIST);

  test("passes when the manifest covers everything required", () => {
    const audit = auditPrecacheManifest(fullManifest, DEFAULT_DIST);
    expect(audit).toEqual({ ok: true, missing: [], forbidden: [] });
  });

  test("normalizes leading slashes and cache-bust query params", () => {
    const audit = auditPrecacheManifest(
      fullManifest.map((url) => `/${url}?__WB_REVISION__=abc123`),
      DEFAULT_DIST
    );
    expect(audit.ok).toBe(true);
  });

  test("fails when the gmsh wasm.gz or its manifest are missing (the closeBundle ordering trap)", () => {
    const withoutGmsh = fullManifest.filter((url) => !url.includes("gmsh"));
    const audit = auditPrecacheManifest(withoutGmsh, DEFAULT_DIST);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(["assets/gmsh-core-HGUso1mk.wasm.gz", GMSH_WASM_MANIFEST_URL]);
  });

  test("fails when a lazy worker chunk is missing from the manifest", () => {
    const withoutWorker = fullManifest.filter((url) => !url.includes("meshWorker"));
    const audit = auditPrecacheManifest(withoutWorker, DEFAULT_DIST);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(["assets/meshWorker-CFH3q_LL.js"]);
  });

  test("flags a precached raw gmsh wasm as forbidden (it is deleted after compression)", () => {
    const audit = auditPrecacheManifest([...fullManifest, "assets/gmsh-core-HGUso1mk.wasm"], DEFAULT_DIST);
    expect(audit.ok).toBe(false);
    expect(audit.forbidden).toEqual(["assets/gmsh-core-HGUso1mk.wasm"]);
  });
});

describe("workbox settings", () => {
  test("header changes force a service-worker update", () => {
    expect(PRECACHE_GLOB_PATTERNS).toContain("_headers");
  });

  test("glob ignores keep the raw gmsh wasm out of the precache", () => {
    expect(PRECACHE_GLOB_IGNORES).toContain("**/gmsh-core-*.wasm");
  });

  test("size cap admits the gzip-precompressed gmsh module (Cloudflare per-asset cap)", () => {
    expect(MAX_PRECACHE_FILE_BYTES).toBe(25 * 1024 * 1024);
  });

  test("gmsh-wasm.json keeps a content revision; hash-named assets are URL-versioned", () => {
    expect(DONT_CACHE_BUST_URLS.test("assets/gmsh-wasm.json")).toBe(false);
    expect(DONT_CACHE_BUST_URLS.test("assets/gmsh-core-HGUso1mk.wasm.gz")).toBe(true);
    expect(DONT_CACHE_BUST_URLS.test("assets/index-BE098Mki.js")).toBe(true);
    expect(DONT_CACHE_BUST_URLS.test("index.html")).toBe(false);
  });
});
