#!/usr/bin/env node

// Deploy/build gate: CI and deploy environments clone OpenCAE Core from its
// GitHub remote at the commit pinned in OPENCAE_CORE_REF (repo root) — the pin
// for the sibling SOLVER packages the browser build consumes. A pin that only
// exists in the local sibling checkout (e.g. the head of a not-yet-pushed
// branch) makes every fresh build fail with a cryptic "not our ref" fetch
// error. This script probes the remote the same way pnpm ensure:core does and
// fails FAST with an actionable message instead.
// (The Core Cloud container this gate originally protected was retired in
// 2026-07; the pin and this reachability check outlived it. See
// docs/cloud-retirement.md.)

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultCoreRepo = "https://github.com/esaueng/OpenCAE-Core.git";

export function readPinnedCoreRef(baseDir = rootDir) {
  const pinPath = resolve(baseDir, "OPENCAE_CORE_REF");
  if (!existsSync(pinPath)) return undefined;
  const value = readFileSync(pinPath, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

export function isFullGitCommitRef(ref) {
  return /^[0-9a-f]{40}$/i.test(String(ref ?? ""));
}

export function verifyCoreRefReachable({ repo, ref, probe = probeCoreRefWithGit } = {}) {
  const coreRepo = repo ?? process.env.OPENCAE_CORE_REPO ?? defaultCoreRepo;
  const coreRef = ref ?? process.env.OPENCAE_CORE_REF ?? readPinnedCoreRef();
  if (!coreRef) {
    return {
      ok: false,
      ref: coreRef,
      message:
        "OPENCAE_CORE_REF (repo root) is missing or empty. Pin a full OpenCAE Core commit SHA before building or deploying."
    };
  }
  if (!isFullGitCommitRef(coreRef)) {
    return {
      ok: false,
      ref: coreRef,
      message: `OPENCAE_CORE_REF must pin a full 40-character commit SHA for reproducible builds; got "${coreRef}".`
    };
  }
  const result = probe(coreRepo, coreRef);
  if (result.ok) {
    return { ok: true, ref: coreRef, message: `Pinned OpenCAE Core commit ${coreRef} is reachable on ${coreRepo}.` };
  }
  return {
    ok: false,
    ref: coreRef,
    message: [
      `Pinned OpenCAE Core commit ${coreRef} is NOT reachable on ${coreRepo}.`,
      result.detail ? `git: ${result.detail}` : undefined,
      "CI and deploy builds (pnpm ensure:core) clone from that remote, so an unpushed pin can never build or deploy.",
      "Push the OpenCAE Core branch containing the pinned commit first; after a squash/rebase merge, update OPENCAE_CORE_REF (repo root) to the merged SHA."
    ]
      .filter(Boolean)
      .join("\n")
  };
}

// Mirrors ensure-opencae-core's clone path: fetch the bare commit from the remote
// into a throwaway repository. Exported for the integration test.
export function probeCoreRefWithGit(repo, ref) {
  const probeDir = mkdtempSync(join(tmpdir(), "opencae-core-ref-probe-"));
  try {
    const init = spawnSync("git", ["init", "--quiet", probeDir], { encoding: "utf8" });
    if (init.error) return { ok: false, detail: String(init.error.message ?? init.error) };
    if (init.status !== 0) return { ok: false, detail: (init.stderr ?? "").trim() };
    const fetch = spawnSync("git", ["-C", probeDir, "fetch", "--quiet", "--depth", "1", repo, ref], {
      encoding: "utf8"
    });
    if (fetch.error) return { ok: false, detail: String(fetch.error.message ?? fetch.error) };
    if (fetch.status !== 0) return { ok: false, detail: (fetch.stderr ?? "").trim() };
    return { ok: true };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyCoreRefReachable();
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exitCode = 1;
  }
}
