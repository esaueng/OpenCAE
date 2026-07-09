import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Cloud retirement guard (B5, 2026-07).
//
// The OpenCAE Core Cloud solve surface was removed in B4b (see
// docs/cloud-retirement.md). This sweep asserts ZERO references to that
// retired surface anywhere in the production tree, outside the explicit
// allowlist below. If this test fails, someone is reintroducing the cloud
// path — that must be a loud, deliberate decision, not a drive-by.
// ---------------------------------------------------------------------------

/** Tokens of the retired cloud solve surface. Case-sensitive on purpose. */
const RETIRED_TOKENS = [
  "/api/cloud-core",
  "runOpenCaeCoreCloudSimulation",
  "startOpenCaeCoreCloudRun",
  "openCaeCoreCloudSolveRequest",
  "CORE_CLOUD_CONTAINER",
  "CORE_CLOUD_ARTIFACTS",
  "EXPECTED_CORE_CLOUD_RUNNER_VERSION",
  "x-opencae-run-token"
];

/** Tokens that indicate the repo still depends on a sibling Core checkout. */
const STANDALONE_FORBIDDEN_TOKENS = ["../opencae-core/", "OPENCAE_CORE_REF"];
const STANDALONE_TOKEN_ALLOWLIST = new Set([
  "scripts/cloud-retirement-guard.test.mjs",
  "scripts/verify-cloudflare-config.test.mjs"
]);

/**
 * ALLOWLIST — every entry needs a justification, and additions require the
 * same scrutiny as reintroducing the cloud path itself. `tokens: "*"` allows
 * all retired tokens in that path; otherwise only the listed tokens are
 * tolerated there. Directory entries end with "/" and cover the subtree.
 *
 * Categories (from the B5 plan):
 *  - frozen-contract keepers: golden fixtures, their README, the recorder
 *    script, and the characterization test;
 *  - the guard itself and negative-assertion tests that name tokens only to
 *    assert their ABSENCE (or the 410 tombstone behavior);
 *  - the historical record in docs/cloud-retirement.md.
 * Historical-labeling code (unitDisplay/RightPanel provenance branches) and
 * the schema alias do not appear here because they never used these exact
 * infrastructure tokens — they label with plain strings like
 * "opencae-core-cloud", which is deliberately NOT a retired token.
 */
const ALLOWLIST = [
  { path: "scripts/cloud-retirement-guard.test.mjs", tokens: "*", reason: "this guard names the tokens it hunts" },
  { path: "scripts/record-core-cloud-golden.mts", tokens: "*", reason: "frozen-contract recorder (permanent keeper)" },
  { path: "apps/opencae-web/src/testdata/core-cloud-golden/", tokens: "*", reason: "golden fixtures + provenance README (permanent keepers)" },
  { path: "apps/opencae-web/src/lib/coreCloudGolden.test.ts", tokens: "*", reason: "characterization test of the frozen contract" },
  { path: "docs/cloud-retirement.md", tokens: "*", reason: "the historical record of what was retired" },
  {
    path: "apps/opencae-web/worker/index.ts",
    tokens: ["/api/cloud-core"],
    reason: "the 410 tombstone must recognize the retired route to answer it honestly"
  },
  {
    path: "apps/opencae-web/worker/index.test.ts",
    tokens: ["/api/cloud-core", "CORE_CLOUD_CONTAINER", "CORE_CLOUD_ARTIFACTS", "EXPECTED_CORE_CLOUD_RUNNER_VERSION", "x-opencae-run-token"],
    reason: "tests the 410 tombstone and asserts the infrastructure tokens are ABSENT from the worker"
  },
  {
    path: "apps/opencae-web/src/lib/api.test.ts",
    tokens: ["/api/cloud-core", "x-opencae-run-token"],
    reason: "negative assertions that the client carries no cloud-solve plumbing (B4a)"
  },
  {
    path: "scripts/verify-cloudflare-config.mjs",
    tokens: ["CORE_CLOUD_CONTAINER", "CORE_CLOUD_ARTIFACTS"],
    reason: "deploy gate asserting the retired bindings stay absent from wrangler configs"
  },
  {
    path: "scripts/verify-cloudflare-config.test.mjs",
    tokens: ["CORE_CLOUD_CONTAINER", "CORE_CLOUD_ARTIFACTS"],
    reason: "exercises the deploy gate by sneaking the retired bindings back in"
  }
];

// Swept roots. plans/ is intentionally NOT swept: it is an append-mostly log
// of historical planning documents whose quoted code predates the retirement.
const SWEPT_ROOTS = ["apps", "libs", "scripts", "services", "runners", "examples", "infra", "docs", "data", ".github"];
const SWEPT_ROOT_FILES = [
  "package.json",
  "README.md",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "tsconfig.base.json",
  ...readdirSync(rootDir).filter((name) => /^wrangler.*\.jsonc$/.test(name))
];
const SWEPT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".jsonc", ".md", ".yml", ".yaml", ".html", ".css", ".txt", ".toml", ".sh"
]);
const SWEPT_EXTENSIONLESS = new Set(["Dockerfile", "_headers", "OPENCAE_CORE_REF"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git", ".claude", "coverage"]);
const SKIPPED_RELATIVE_DIRECTORIES = new Set(["data/artifacts", "data/logs", "data/reports", "data/sqlite"]);

function sweptFiles() {
  const files = [];
  for (const root of SWEPT_ROOTS) {
    const absolute = resolve(rootDir, root);
    if (existsSync(absolute)) collect(root, files);
  }
  for (const file of SWEPT_ROOT_FILES) {
    if (existsSync(resolve(rootDir, file))) files.push(file);
  }
  return files.sort();
}

function collect(relativeDir, files) {
  for (const entry of readdirSync(resolve(rootDir, relativeDir), { withFileTypes: true })) {
    const child = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !SKIPPED_RELATIVE_DIRECTORIES.has(child)) collect(child, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const dotIndex = entry.name.lastIndexOf(".");
    const extension = dotIndex >= 0 ? entry.name.slice(dotIndex) : "";
    if (SWEPT_EXTENSIONS.has(extension) || SWEPT_EXTENSIONLESS.has(entry.name)) files.push(child);
  }
}

function allowedTokensFor(path) {
  for (const entry of ALLOWLIST) {
    const matches = entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path;
    if (matches) return entry.tokens;
  }
  return [];
}

describe("cloud retirement guard", () => {
  test("no retired cloud-solve token appears outside the explicit allowlist", () => {
    const offenders = [];
    for (const path of sweptFiles()) {
      const source = readFileSync(resolve(rootDir, path), "utf8");
      const allowed = allowedTokensFor(path);
      if (allowed === "*") continue;
      for (const token of RETIRED_TOKENS) {
        if (source.includes(token) && !allowed.includes(token)) {
          offenders.push(`${path}: ${token}`);
        }
      }
    }
    expect(offenders, "Retired cloud-solve surface reintroduced (or an allowlist update is needed — justify it):\n").toEqual([]);
  });

  test("allowlisted files still exist (stale entries must be pruned)", () => {
    for (const entry of ALLOWLIST) {
      const target = resolve(rootDir, entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path);
      expect(existsSync(target), `${entry.path} (${entry.reason})`).toBe(true);
    }
  });

  test("the retired infrastructure files stay deleted", () => {
    for (const retiredPath of [
      "services/opencae-core-cloud",
      "wrangler.containers.jsonc",
      "wrangler.local-first.jsonc",
      "scripts/verify-runner-version.mjs"
    ]) {
      expect(existsSync(resolve(rootDir, retiredPath)), `${retiredPath} must stay deleted`).toBe(false);
    }
  });

  test("production files do not depend on a sibling OpenCAE Core checkout", () => {
    const offenders = [];
    for (const path of sweptFiles()) {
      if (path.startsWith("docs/") || path.startsWith("plans/") || STANDALONE_TOKEN_ALLOWLIST.has(path)) continue;
      const source = readFileSync(resolve(rootDir, path), "utf8");
      for (const token of STANDALONE_FORBIDDEN_TOKENS) {
        if (source.includes(token)) offenders.push(`${path}: ${token}`);
      }
    }
    expect(offenders, "Standalone repo guard found sibling Core coupling outside docs/plans:\n").toEqual([]);
  });

  // Bundle proof: when a production build exists, the emitted chunks must be
  // free of ALL retired tokens — no allowlist applies to shipped bytes.
  // (CI runs tests without a dist; run `pnpm --filter @opencae/web build`
  // first to exercise this locally or in a build-then-test pipeline.)
  const distDir = resolve(rootDir, "apps/opencae-web/dist");
  test.skipIf(!existsSync(distDir))("emitted web bundle contains no retired cloud symbols", () => {
    const offenders = [];
    scanDist(distDir, offenders);
    expect(offenders).toEqual([]);
  });

  function scanDist(directory, offenders) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        scanDist(absolute, offenders);
        continue;
      }
      if (!/\.(?:js|mjs|css|html|json|txt|map)$/.test(entry.name)) continue;
      if (statSync(absolute).size > 200_000_000) continue;
      const source = readFileSync(absolute, "utf8");
      for (const token of RETIRED_TOKENS) {
        if (source.includes(token)) offenders.push(`${absolute}: ${token}`);
      }
    }
  }
});
