import { init } from "@plausible-analytics/tracker/plausible.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initPlausibleAnalytics } from "./analytics";

vi.mock("@plausible-analytics/tracker/plausible.js", () => ({
  init: vi.fn()
}));

const initMock = vi.mocked(init);

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
      domain: "alpha-cae.esau.app",
      fileDownloads: true,
      outboundLinks: true
    });
  });

  test("allows the Plausible domain to be configured by Vite env", () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("VITE_PLAUSIBLE_DOMAIN", "preview.alpha-cae.esau.app");

    initPlausibleAnalytics();

    expect(initMock).toHaveBeenCalledWith({
      domain: "preview.alpha-cae.esau.app",
      fileDownloads: true,
      outboundLinks: true
    });
  });

  test("skips initialization outside the browser", () => {
    initPlausibleAnalytics();

    expect(initMock).not.toHaveBeenCalled();
  });
});
