import { init } from "@plausible-analytics/tracker/plausible.js";

const DEFAULT_PLAUSIBLE_DOMAIN = "cae.esau.app";

export function initPlausibleAnalytics() {
  if (typeof window === "undefined") return;

  const domain = (import.meta.env.VITE_PLAUSIBLE_DOMAIN ?? DEFAULT_PLAUSIBLE_DOMAIN).trim();
  if (!domain) return;

  init({
    domain,
    fileDownloads: true,
    outboundLinks: true
  });
}
