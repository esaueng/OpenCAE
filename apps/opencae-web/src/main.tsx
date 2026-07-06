import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initPlausibleAnalytics } from "./analytics";
import "./theme/tokens.css";
import "./styles/app.css";

initPlausibleAnalytics();

// In-browser wasm meshing proof harness (plan A-M2). Statically dead-code
// eliminated unless the build sets VITE_WASM_MESHING=1; even then it loads as
// its own lazy chunk so the initial bundle stays untouched.
if (import.meta.env.VITE_WASM_MESHING === "1") {
  void import("./workers/meshHarness");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
