import { fileURLToPath } from "node:url";

export const PRODUCTION_HEALTH_URL = "https://cae.esau.app/health";

const EXPECTED_HEALTH = {
  ok: true,
  mode: "cloudflare-worker",
  service: "opencae-web",
  solverRuntime: "browser-opencae-core"
};

export function validateProductionHealthResponse(status, health) {
  const failures = [];

  if (status !== 200) failures.push(`HTTP status must be 200, got ${status}`);
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    failures.push("response body must be a JSON object");
  } else {
    for (const [key, expected] of Object.entries(EXPECTED_HEALTH)) {
      if (health[key] !== expected) {
        failures.push(`${key} must be ${JSON.stringify(expected)}, got ${JSON.stringify(health[key])}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Production health check failed: ${failures.join("; ")}`);
  }
}

export async function checkProductionHealth(fetchImpl = fetch) {
  const response = await fetchImpl(PRODUCTION_HEALTH_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  const responseText = await response.text();
  let health;

  try {
    health = JSON.parse(responseText);
  } catch {
    throw new Error(`Production health check failed: response body is not JSON: ${responseText.slice(0, 200)}`);
  }

  validateProductionHealthResponse(response.status, health);
  return health;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const health = await checkProductionHealth();
  console.log(`Production healthy: ${health.service} (${health.solverRuntime})`);
}
