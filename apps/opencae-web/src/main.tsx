import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initPlausibleAnalytics } from "./analytics";
import { registerOfflineCaching } from "./lib/registerOfflineCaching";
import "./theme/tokens.css";
import "./styles/app.css";

initPlausibleAnalytics();
registerOfflineCaching();

// In-browser wasm meshing proof harness (plan A-M2). On by default (A-M4);
// statically dead-code eliminated in VITE_WASM_MESHING=0 opt-out builds. It
// loads as its own lazy chunk so the initial bundle stays untouched.
if (import.meta.env.VITE_WASM_MESHING !== "0") {
  void import("./workers/meshHarness");
  // 100k-DOF solve benchmark harness (?solveBench=1): only loaded when the
  // URL asks for it, so normal sessions never fetch the chunk.
  if (new URLSearchParams(window.location.search).has("solveBench")) {
    void import("./workers/solveBenchHarness");
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
