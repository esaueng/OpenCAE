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
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
