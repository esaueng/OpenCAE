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
          if (id.includes("@opencae/solver-service")) return "local-solver";
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
