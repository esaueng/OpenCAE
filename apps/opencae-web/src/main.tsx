import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initPlausibleAnalytics } from "./analytics";
import { registerOfflineCaching } from "./lib/registerOfflineCaching";
import "./theme/tokens.css";
import "./styles/app.css";

initPlausibleAnalytics();
registerOfflineCaching();

// Debug/verification harnesses (plan A-M2). The production proof harnesses are
// statically dead-code eliminated in VITE_WASM_MESHING=0 opt-out builds, and
// every harness loads only when its URL flag is present:
// - ?meshProof=1|step|run drives a real end-to-end mesh and exposes
//   window.__opencaeMeshProof (scripts/verify-wasm-mesh-browser.mjs and
//   scripts/verify-offline-pwa.mjs always navigate with this parameter).
// - ?stepSelectionProof=1 is a dev-only regression for real-browser STEP
//   wall/top picking and support/load identity across display LODs.
// - ?solveBench=1 runs the 100k-DOF solve benchmark.
if (import.meta.env.VITE_WASM_MESHING !== "0") {
  const debugParams = new URLSearchParams(window.location.search);
  if (debugParams.has("meshProof")) void import("./workers/meshHarness");
  if (import.meta.env.DEV && debugParams.has("stepSelectionProof")) void import("./workers/stepSelectionHarness");
  if (debugParams.has("solveBench")) void import("./workers/solveBenchHarness");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
