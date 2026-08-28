import { init } from "@plausible-analytics/tracker/plausible.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initPlausibleAnalytics, isAnalyticsEnabled, setAnalyticsEnabled } from "./analytics";

vi.mock("@plausible-analytics/tracker/plausible.js", () => ({
  init: vi.fn()
}));

const initMock = vi.mocked(init);

function stubBrowserLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); }
  };
  vi.stubGlobal("window", { localStorage });
  return store;
}

describe("initPlausibleAnalytics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    initMock.mockClear();
  });

  test("initializes Plausible for the production app domain", () => {
    vi.stubGlobal("window", {});

    initPlausibleAnalytics();

    expect(initMock).toHaveBeenCalledWith({
      domain: "cae.esau.app",
      fileDownloads: false,
      outboundLinks: true
    });
  });

  test("allows the Plausible domain to be configured by Vite env", () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("VITE_PLAUSIBLE_DOMAIN", "preview.cae.esau.app");

    initPlausibleAnalytics();

    expect(initMock).toHaveBeenCalledWith({
      domain: "preview.cae.esau.app",
      fileDownloads: false,
      outboundLinks: true
    });
  });

  test("skips initialization outside the browser", () => {
    initPlausibleAnalytics();

    expect(initMock).not.toHaveBeenCalled();
  });

  test("stays off when the user opted out of analytics", () => {
    stubBrowserLocalStorage({ "opencae.analytics.optOut.v1": "1" });

    expect(isAnalyticsEnabled()).toBe(false);
    initPlausibleAnalytics();

    expect(initMock).not.toHaveBeenCalled();
  });

  test("persists the opt-out choice and re-enables cleanly", () => {
    const store = stubBrowserLocalStorage();

    expect(isAnalyticsEnabled()).toBe(true);
    expect(setAnalyticsEnabled(false)).toBe(true);
    expect(store.get("opencae.analytics.optOut.v1")).toBe("1");
    expect(isAnalyticsEnabled()).toBe(false);
    expect(setAnalyticsEnabled(true)).toBe(true);
    expect(store.has("opencae.analytics.optOut.v1")).toBe(false);
    expect(isAnalyticsEnabled()).toBe(true);
  });

  test("reports a storage failure instead of claiming the preference changed", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => { throw new Error("storage unavailable"); },
        removeItem: () => { throw new Error("storage unavailable"); }
      }
    });

    expect(setAnalyticsEnabled(false)).toBe(false);
    expect(setAnalyticsEnabled(true)).toBe(false);
    expect(isAnalyticsEnabled()).toBe(true);
  });
});
