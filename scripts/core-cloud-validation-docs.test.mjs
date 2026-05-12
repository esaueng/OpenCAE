import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = resolve(import.meta.dirname, "..");

describe("Core Cloud validation documentation", () => {
  test("documents local, deployed, beam theory, and limitation validation flows", () => {
    const readme = readFileSync(resolve(rootDir, "docs/validation/README.md"), "utf8");

    expect(readme).toContain("## Validate Locally");
    expect(readme).toContain("## Validate Deployed Cloud");
    expect(readme).toContain("## Beam Theory Comparison");
    expect(readme).toContain("## Known Limitations");
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
    expect(readme).toContain("OpenCAE Core Cloud");
    expect(readme).toContain("opencae-core-cloud");
    expect(readme).toContain("No local estimate fallback");
  });

  test("documents production uptime checks in the root README", () => {
    const readme = readFileSync(resolve(rootDir, "README.md"), "utf8");

    expect(readme).toContain("## Production Uptime");
    expect(readme).toContain("https://cae.esau.app/health");
    expect(readme).toContain("https://cae.esau.app/api/cloud-core/health");
  });
});
