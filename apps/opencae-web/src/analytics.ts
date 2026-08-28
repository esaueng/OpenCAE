import { init } from "@plausible-analytics/tracker/plausible.js";

const DEFAULT_PLAUSIBLE_DOMAIN = "cae.esau.app";
// Persisted opt-out for anonymous usage analytics (Plausible page views and
// outbound-link clicks). The toggle lives in the project storage card;
// project, geometry, and simulation data is never tracked.
const ANALYTICS_OPT_OUT_KEY = "opencae.analytics.optOut.v1";

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY) !== "1";
  } catch {
    // Storage can be unavailable (private browsing); default stays enabled.
    return true;
  }
}

export function setAnalyticsEnabled(enabled: boolean): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (enabled) window.localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
    else window.localStorage.setItem(ANALYTICS_OPT_OUT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function initPlausibleAnalytics() {
  if (typeof window === "undefined") return;
  if (!isAnalyticsEnabled()) return;

  const domain = (import.meta.env.VITE_PLAUSIBLE_DOMAIN ?? DEFAULT_PLAUSIBLE_DOMAIN).trim();
  if (!domain) return;

  init({
    domain,
    fileDownloads: false,
    outboundLinks: true
  });
}
