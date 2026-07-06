import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";

// When VITE_WASM_MESHING is off, swap the mesh worker client for a stub.
// Rollup resolves dynamically imported modules before tree-shaking, so even
// statically dead `import("./meshWorkerClient")` call sites trigger vite's
// worker sub-build, which emits the meshWorker chunk plus the ~44 MB
// gmsh-core.wasm asset into dist. Flag-off builds must not carry those
// (Cloudflare static assets cap out at 25 MiB per file).
function stubMeshWorkerClientWhenDisabled(): PluginOption {
  if (process.env.VITE_WASM_MESHING === "1") return null;
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

export default defineConfig({
  plugins: [react(), stubMeshWorkerClientWhenDisabled()],
  worker: {
    format: "es"
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
      // The local API has no /api/cloud-core routes; set OPENCAE_CLOUD_PROXY_TARGET
      // (e.g. https://cae.esau.app) to test cloud solves from local dev.
      ...(process.env.OPENCAE_CLOUD_PROXY_TARGET
        ? {
            "/api/cloud-core": {
              target: process.env.OPENCAE_CLOUD_PROXY_TARGET,
              changeOrigin: true
            }
          }
        : {}),
      "/api": "http://localhost:4317",
      "/health": "http://localhost:4317"
    }
  }
});
