import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = resolve(import.meta.dirname, "..");
const WEB_SRC = resolve(rootDir, "apps/opencae-web/src");

// ---------------------------------------------------------------------------
// Local-first architecture guard.
//
// The production web app solves in the browser: it must not call the
// reference-backend HTTP surface, and it must not import the reference
// heuristic engines (they exist for the loopback dev API only). The deploy
// verifier covers wrangler config; this covers source imports and fetch
// calls, in the same allowlist style as cloud-retirement-guard.
// ---------------------------------------------------------------------------

/** Relative paths (from apps/opencae-web/src) allowed to touch fetch("/api/..."). */
const FETCH_API_ALLOWLIST = new Set([
  "cloudBackup.ts", // the only production server flow: consent-gated encrypted recovery backup
]);

/** Module specifiers the web source must never import (reference engines). */
const FORBIDDEN_IMPORTS = [
  "@opencae/solver-service",
  "@opencae/mesh-service",
  "@opencae/post-service",
  "@opencae/cad-service"
];

function webSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const absolute = resolve(dir, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "testdata") continue;
        walk(absolute);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
      files.push(absolute);
    }
  };
  walk(WEB_SRC);
  return files;
}

describe("local-first architecture guard", () => {
  test("only the encrypted-backup module calls the Worker API surface", () => {
    const offenders = [];
    for (const absolute of webSourceFiles()) {
      const relative = absolute.slice(WEB_SRC.length + 1);
      if (FETCH_API_ALLOWLIST.has(relative)) continue;
      const source = readFileSync(absolute, "utf8");
      for (const match of source.matchAll(/fetch\(\s*["'`](\/api\/[^"'`]*)/g)) {
        offenders.push(`${relative}: fetch("${match[1]}")`);
      }
      // CLOUD_BACKUP_PATH-style indirection: a non-allowlisted file
      // referencing the backup path constant is the same violation.
      if (/["'`]\/api\/project-backups["'`]/.test(source)) {
        offenders.push(`${relative}: references /api/project-backups outside cloudBackup.ts`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("web source never imports the reference heuristic engines", () => {
    const offenders = [];
    for (const absolute of webSourceFiles()) {
      const relative = absolute.slice(WEB_SRC.length + 1);
      const source = readFileSync(absolute, "utf8");
      for (const specifier of FORBIDDEN_IMPORTS) {
        if (source.includes(`from "${specifier}"`) || source.includes(`from '${specifier}'`)) {
          offenders.push(`${relative}: imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("web source imports the adapter through one style (no relative deep-link mix)", () => {
    // workers/opencaeCoreSolve.ts is the declared re-export shim; web modules
    // must not also reach into the adapter package through other spellings.
    const offenders = [];
    for (const absolute of webSourceFiles()) {
      const relative = absolute.slice(WEB_SRC.length + 1);
      if (relative === "workers/opencaeCoreSolve.ts") continue;
      const source = readFileSync(absolute, "utf8");
      if (/(["'])@opencae\/core-adapter\/dist\//.test(source)) {
        offenders.push(`${relative}: deep-links @opencae/core-adapter/dist`);
      }
      if (/from ["']\.\.?\/.*core-adapter\/src\//.test(source)) {
        offenders.push(`${relative}: deep-links core-adapter/src`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
