import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = resolve(import.meta.dirname, "..");

// The Core Cloud backend was retired in July 2026 (B4b). This suite keeps the
// documentation honest about that: the validation story is local-first, the
// retirement is recorded with its open items, and stale cloud instructions
// cannot quietly return to the top-level docs.

describe("validation and retirement documentation", () => {
  test("documents local validation, beam theory, and limitation flows", () => {
    const readme = readFileSync(resolve(rootDir, "docs/validation/README.md"), "utf8");

    expect(readme).toContain("## Validate Locally");
    expect(readme).toContain("## Beam Theory Comparison");
    expect(readme).toContain("## Known Limitations");
    expect(readme).toContain("## Hard Failure Rules");
    for (const validationCase of [
      "simple cantilever static",
      "simple cantilever dynamic",
      "pressure patch",
      "payload mass",
      "bracket actual mesh static",
      "bracket actual mesh dynamic",
      "disconnected mesh rejection"
    ]) {
      expect(readme.toLowerCase()).toContain(validationCase);
    }
    // Local-first is the production story; the cloud flow is explicit history.
    expect(readme).toContain("locally in the browser");
    expect(readme).toContain("retired in July 2026");
    expect(readme).toContain("## Historical: Validate Deployed Cloud (retired 2026-07)");
    expect(readme).toContain("cloud-retirement.md");
    expect(readme).toContain("goldenParity.test.ts");
    // No instructions may point at the removed cloud endpoints or gates.
    expect(readme).not.toContain("verify:runner-version");
    expect(readme).not.toContain("deploy:core-cloud");
  });

  test("records the cloud retirement with rollback and open owner decisions", () => {
    const retirement = readFileSync(resolve(rootDir, "docs/cloud-retirement.md"), "utf8");

    expect(retirement).toContain("# OpenCAE Core Cloud retirement (July 2026)");
    expect(retirement).toContain("HTTP 410");
    expect(retirement).toContain("opencae/opencae-core-cloud:0.1.6");
    expect(retirement).toContain("cloud-core/runs/*");
    expect(retirement).toContain("open owner decision");
    expect(retirement).toContain("Repo consolidation coda");
    expect(retirement).toContain("bc6c305272bd2789634f5e4c9006e0eae21e116b");
    expect(retirement).toContain("cloud-retirement-guard.test.mjs");
  });

  test("documents production uptime checks in the root README without cloud endpoints", () => {
    const readme = readFileSync(resolve(rootDir, "README.md"), "utf8");

    expect(readme).toContain("## Production Uptime");
    expect(readme).toContain("https://cae.esau.app/health");
    expect(readme).toContain("browser-opencae-core");
    expect(readme).toContain("docs/cloud-retirement.md");
    expect(readme).not.toContain("api/cloud-core/health");
    expect(readme).not.toContain("wrangler.containers.jsonc");
  });
});
