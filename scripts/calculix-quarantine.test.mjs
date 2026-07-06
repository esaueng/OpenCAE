import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = resolve(import.meta.dirname, "..");

const productionRoots = [
  "apps",
  "libs",
  "services",
  "scripts",
  "package.json",
  "wrangler*.jsonc"
];
const productionExtensions = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".jsx", ".json", ".jsonc", ".Dockerfile"]);

const allowedPatterns = [
  /(^|\/)legacy-calculix-container\//,
  /(^|\/)docs\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /\.test\./,
  /worker-configuration\.d\.ts$/
];

function productionFiles() {
  return [...new Set(productionRoots.flatMap((entry) => collectFiles(entry)))]
    .filter((path) => !allowedPatterns.some((allowed) => allowed.test(path)))
    .sort();
}

function collectFiles(entry) {
  if (entry === "wrangler*.jsonc") {
    return readdirSync(rootDir).filter((name) => /^wrangler.*\.jsonc$/.test(name));
  }
  const absolute = resolve(rootDir, entry);
  const stat = statSync(absolute);
  if (stat.isFile()) return [entry];
  return collectDirectory(entry);
}

function collectDirectory(relativeDir) {
  return readdirSync(resolve(rootDir, relativeDir), { withFileTypes: true }).flatMap((entry) => {
    const child = `${relativeDir}/${entry.name}`;
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    if (entry.isDirectory()) return collectDirectory(child);
    if (!entry.isFile()) return [];
    if (entry.name === "Dockerfile") return [child];
    const dotIndex = entry.name.lastIndexOf(".");
    if (dotIndex < 0) return [];
    const extension = entry.name.slice(dotIndex);
    return productionExtensions.has(extension) ? [child] : [];
  });
}

describe("CalculiX production quarantine", () => {
  test("old FEA container service is absent or quarantined under legacy-calculix-container", () => {
    const oldPath = resolve(rootDir, "services/opencae-fea-container");
    const legacyPath = resolve(rootDir, "services/legacy-calculix-container");

    expect(() => statSync(oldPath)).toThrow();
    expect(() => statSync(legacyPath)).not.toThrow();
  });

  test("package scripts expose no container commands (cloud solver retired 2026-07)", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    const scripts = packageJson.scripts;

    expect(scripts["test:fea-container"]).toBeUndefined();
    expect(scripts["containers:build"]).toBeUndefined();
    // B4b removed the OpenCAE Core Cloud container commands with the rest of
    // the cloud solve infrastructure; none of them may return.
    expect(scripts["test:core-cloud-container"]).toBeUndefined();
    expect(scripts["deploy:core-cloud"]).toBeUndefined();
    expect(scripts["containers:build:core-cloud"]).toBeUndefined();
    expect(scripts["containers:push:core-cloud"]).toBeUndefined();
    expect(JSON.stringify(scripts)).not.toContain("wrangler containers");
    expect(JSON.stringify(scripts).toLowerCase()).not.toContain("cloudflare-fea-calculix");
  });

  test("production source has no CalculiX, ccx, or legacy solver artifact references", () => {
    const blocked = [
      /calculix/i,
      /\bccx\b/i,
      /cloudflare-fea-calculix/i,
      /\.(?:inp|frd|dat)\b/i
    ];
    const offenders = productionFiles().flatMap((path) => {
      const source = readFileSync(resolve(rootDir, path), "utf8");
      return blocked
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relative(rootDir, resolve(rootDir, path))}: ${pattern}`);
    });

    expect(offenders).toEqual([]);
  });
});
