import { describe, expect, test } from "vitest";
import { checkProductionHealth, PRODUCTION_HEALTH_URL, validateProductionHealthResponse } from "./check-production-health.mjs";

const healthyResponse = {
  ok: true,
  mode: "cloudflare-worker",
  service: "opencae-web",
  solverRuntime: "browser-opencae-core"
};

describe("production health check", () => {
  test("accepts the deployed browser-solver Worker contract", () => {
    expect(() => validateProductionHealthResponse(200, healthyResponse)).not.toThrow();
  });

  test.each([
    [503, healthyResponse, "HTTP status must be 200"],
    [200, { ...healthyResponse, ok: false }, "ok must be true"],
    [200, { ...healthyResponse, solverRuntime: "cloud" }, "solverRuntime must be \"browser-opencae-core\""],
    [200, null, "response body must be a JSON object"]
  ])("rejects an unhealthy production response", (status, body, message) => {
    expect(() => validateProductionHealthResponse(status, body)).toThrow(message);
  });

  test("checks the production URL and parses its JSON response", async () => {
    const fetchMock = async (url) => {
      expect(url).toBe(PRODUCTION_HEALTH_URL);
      return new Response(JSON.stringify(healthyResponse), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    await expect(checkProductionHealth(fetchMock)).resolves.toEqual(healthyResponse);
  });

  test("fails clearly when production returns a non-JSON page", async () => {
    const fetchMock = async () => new Response("upstream error", { status: 502 });

    await expect(checkProductionHealth(fetchMock)).rejects.toThrow("response body is not JSON");
  });
});
