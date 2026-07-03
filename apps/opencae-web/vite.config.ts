import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
