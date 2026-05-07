import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initPlausibleAnalytics } from "./analytics";
import "./theme/tokens.css";
import "./styles/app.css";

initPlausibleAnalytics();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
