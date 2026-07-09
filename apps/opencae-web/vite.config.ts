import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { DONT_CACHE_BUST_URLS, MAX_PRECACHE_FILE_BYTES, PRECACHE_GLOB_IGNORES, PRECACHE_GLOB_PATTERNS, SW_FORCE_REFRESH_SCRIPT } from "./src/lib/offlinePrecache";

// In-browser wasm meshing is the production default (plan A-M4). Builds carry
// gmsh-wasm unless explicitly opted out with VITE_WASM_MESHING=0 — the escape
// hatch for size-constrained deploys stays byte-clean (zero gmsh assets).
const wasmMeshingDisabled = process.env.VITE_WASM_MESHING === "0";

// When VITE_WASM_MESHING=0, swap the mesh worker client for a stub.
// Rollup resolves dynamically imported modules before tree-shaking, so even
// statically dead `import("./meshWorkerClient")` call sites trigger vite's
// worker sub-build, which emits the meshWorker chunk plus the ~44 MB
// gmsh-core.wasm asset into dist.
function stubMeshWorkerClientWhenDisabled(): PluginOption {
  if (!wasmMeshingDisabled) return null;
  const clientStubPath = fileURLToPath(new URL("./src/workers/meshWorkerClient.disabled.ts", import.meta.url));
  const gmshStubPath = fileURLToPath(new URL("./src/workers/gmshWasm.disabled.ts", import.meta.url));
  return {
    name: "opencae:stub-mesh-worker-client-when-flag-off",
    enforce: "pre",
    resolveId(source) {
      if (source.endsWith("/meshWorkerClient") || source.endsWith("/meshWorkerClient.ts")) {
        return clientStubPath;
      }
      // The Emscripten glue emits gmsh-core.wasm on transform, so the package
      // itself must be stubbed too (it is only ever loaded via dynamic import
      // from @opencae/mesh-intake's wasmMesher).
      if (source === "@loumalouomega/gmsh-wasm") {
        return gmshStubPath;
      }
      return null;
    }
  };
}

// Cloudflare Workers static assets cap out at 25 MiB per file, but
// gmsh-core.wasm is ~44 MB. Default builds therefore never ship the raw
// .wasm: this plugin post-processes dist, gzip-compressing the emitted asset
// (~44 MB -> ~11 MB, under the cap), deleting the raw file, and writing a
// tiny stable-named manifest (assets/gmsh-wasm.json) pointing at the hashed
// .wasm.gz. The mesh worker fetches the manifest, streams the .gz through
// DecompressionStream("gzip"), and hands the bytes to the Emscripten factory
// as `wasmBinary` (see src/workers/gmshWasmBinary.ts). In dev the raw .wasm
// is served straight from node_modules — no manifest, no compression.
function compressGmshWasmForDeploy(): PluginOption {
  if (wasmMeshingDisabled) return null;
  return {
    name: "opencae:compress-gmsh-wasm-for-deploy",
    apply: "build",
    closeBundle() {
      const assetsDir = fileURLToPath(new URL("./dist/assets", import.meta.url));
      let entries: string[];
      try {
        entries = readdirSync(assetsDir);
      } catch {
        return; // No assets emitted (e.g. non-app build target).
      }
      const wasmNames = entries.filter((name) => /^gmsh-core.*\.wasm$/.test(name));
      if (!wasmNames.length) {
        // closeBundle can run more than once per build (vite-plugin-pwa's
        // service-worker generation shares the hook); once the raw wasm has
        // been swapped for .wasm.gz + manifest this pass is a no-op.
        const alreadyCompressed = entries.some((name) => /^gmsh-core.*\.wasm\.gz$/.test(name)) && entries.includes("gmsh-wasm.json");
        if (alreadyCompressed) return;
        throw new Error(
          "compressGmshWasmForDeploy: expected a gmsh-core*.wasm asset in dist/assets (wasm meshing is enabled) but found none."
        );
      }
      for (const name of wasmNames) {
        const rawPath = join(assetsDir, name);
        const raw = readFileSync(rawPath);
        const compressed = gzipSync(raw, { level: 9 });
        const gzName = `${name}.gz`;
        writeFileSync(join(assetsDir, gzName), compressed);
        rmSync(rawPath);
        writeFileSync(
          join(assetsDir, "gmsh-wasm.json"),
          JSON.stringify({ wasm: `/assets/${gzName}`, encoding: "gzip", rawBytes: raw.byteLength, gzipBytes: compressed.byteLength })
        );
        const rawMiB = (raw.byteLength / 1024 / 1024).toFixed(1);
        const gzMiB = (compressed.byteLength / 1024 / 1024).toFixed(1);
        console.log(`[opencae] gmsh wasm deploy asset: ${name} ${rawMiB} MiB -> ${gzName} ${gzMiB} MiB (Cloudflare 25 MiB/file cap)`);
        if (compressed.byteLength > 25 * 1024 * 1024) {
          throw new Error(`compressGmshWasmForDeploy: ${gzName} is ${gzMiB} MiB, above the Cloudflare 25 MiB per-asset cap.`);
        }
      }
      // Belt and braces: nothing else in dist may breach the per-asset cap.
      for (const name of readdirSync(assetsDir)) {
        const size = statSync(join(assetsDir, name)).size;
        if (size > 25 * 1024 * 1024) {
          throw new Error(`Deploy asset ${name} is ${(size / 1024 / 1024).toFixed(1)} MiB, above the Cloudflare 25 MiB per-asset cap.`);
        }
      }
    }
  };
}

// Offline asset caching (plan Workstream C): precache EVERYTHING — app
// shell, every JS/CSS chunk (lazy meshWorker/solveWorker chunks included,
// so offline-first-use works), the gmsh .wasm.gz + its stable manifest, and
// the occt wasm. The big downloads happen in the service worker's install
// step, in the background, without blocking the app; the UI only claims
// "Offline-ready" once that install completed (see lib/offlineStatus.ts).
//
// Ordering trap, solved explicitly: compressGmshWasmForDeploy rewrites
// dist/assets in closeBundle (raw gmsh-core-<hash>.wasm -> .wasm.gz +
// gmsh-wasm.json). vite-plugin-pwa also globs dist in ITS closeBundle, so
// the SW generation must run after the compression:
// - vite-plugin-pwa's build plugin is enforce:"post" while the compress
//   plugin is unenforced, which already orders the sequential closeBundle
//   hooks compress-first;
// - integration.closeBundleOrder:"post" pins that even if plugin ordering
//   ever changes;
// - PRECACHE_GLOB_IGNORES excludes the raw wasm so a regression would show
//   up as a missing .gz entry in scripts/verify-offline-pwa.mjs's manifest
//   audit rather than as a silently broken deploy.
function offlineAssetCaching(): PluginOption {
  return VitePWA({
    registerType: "autoUpdate",
    // Registration lives in src/lib/registerOfflineCaching.ts (prod only,
    // via virtual:pwa-register) so the indicator can track install state.
    injectRegister: null,
    integration: { closeBundleOrder: "post" },
    // The icon is already precached via the png glob; injecting it again
    // from the manifest would duplicate the entry.
    includeManifestIcons: false,
    manifest: {
      name: "OpenCAE",
      short_name: "OpenCAE",
      description: "Open structural simulation that runs locally in your browser.",
      start_url: "/",
      display: "standalone",
      background_color: "#0b0f14",
      theme_color: "#0b0f14",
      icons: [{ src: "/opencae-logo.png", sizes: "512x512", type: "image/png" }]
    },
    workbox: {
      importScripts: [SW_FORCE_REFRESH_SCRIPT],
      globPatterns: PRECACHE_GLOB_PATTERNS,
      globIgnores: PRECACHE_GLOB_IGNORES,
      dontCacheBustURLsMatching: DONT_CACHE_BUST_URLS,
      maximumFileSizeToCacheInBytes: MAX_PRECACHE_FILE_BYTES,
      navigateFallback: "index.html",
      cleanupOutdatedCaches: true,
      // The 3D viewer's text labels (troika-three-text) resolve fonts from
      // cdn.jsdelivr.net at runtime; cache them opportunistically so label
      // rendering keeps working offline after the viewer has been used once
      // online. (Precache can't cover this — the font set is codepoint
      // dependent. The core offline flows do not depend on it.)
      runtimeCaching: [
        {
          urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
          handler: "CacheFirst",
          options: {
            cacheName: "jsdelivr-fonts",
            expiration: { maxEntries: 64, maxAgeSeconds: 365 * 24 * 60 * 60 },
            cacheableResponse: { statuses: [0, 200] }
          }
        }
      ]
    }
  });
}

export default defineConfig({
  plugins: [react(), stubMeshWorkerClientWhenDisabled(), compressGmshWasmForDeploy(), offlineAssetCaching()],
  worker: {
    format: "es"
  },
  optimizeDeps: {
    // Keep the Emscripten glue out of dev pre-bundling: esbuild would inline
    // it under /node_modules/.vite/deps, where its import.meta.url-relative
    // gmsh-core.wasm fetch resolves to a URL the dev server answers with the
    // SPA fallback (index.html), aborting every dev mesh with a wasm
    // CompileError. Served un-bundled, the relative .wasm resolves to the
    // real file in node_modules.
    exclude: ["@loumalouomega/gmsh-wasm"]
  },
  build: {
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("vite/preload-helper")) return "react-vendor";
          if (id.includes("/node_modules/.pnpm/react@") || id.includes("/node_modules/.pnpm/react-dom@") || id.includes("/node_modules/.pnpm/scheduler@")) {
            return "react-vendor";
          }
          if (id.includes("occt-import-js")) return "cad-import";
          if (id.includes("@react-three") || id.includes("/node_modules/.pnpm/three@") || id.includes("three/examples")) return "viewer-three";
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4317",
      "/health": "http://localhost:4317"
    }
  }
});
