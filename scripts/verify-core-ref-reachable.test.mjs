import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  isFullGitCommitRef,
  probeCoreRefWithGit,
  readPinnedCoreRef,
  verifyCoreRefReachable
} from "./verify-core-ref-reachable.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const fullSha = "0123456789abcdef0123456789abcdef01234567";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("verify-core-ref-reachable gate", () => {
  test("the committed OPENCAE_CORE_REF pin is a full commit SHA", () => {
    const pinned = readPinnedCoreRef(rootDir);
    expect(pinned).toBeDefined();
    expect(isFullGitCommitRef(pinned)).toBe(true);
  });

  test("passes when the probe reports the pin reachable on the remote", () => {
    const result = verifyCoreRefReachable({ repo: "https://example.invalid/core.git", ref: fullSha, probe: () => ({ ok: true }) });
    expect(result.ok).toBe(true);
    expect(result.message).toContain(fullSha);
  });

  test("fails with actionable push guidance when the pin is unreachable on the remote", () => {
    const result = verifyCoreRefReachable({
      repo: "https://example.invalid/core.git",
      ref: fullSha,
      probe: () => ({ ok: false, detail: "fatal: remote error: upload-pack: not our ref" })
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("NOT reachable");
    expect(result.message).toContain("not our ref");
    expect(result.message).toContain("Push the OpenCAE Core branch containing the pinned commit");
    expect(result.message).toContain("OPENCAE_CORE_REF (repo root)");
  });

  test("rejects short or non-SHA refs without probing the network", () => {
    let probed = false;
    const probe = () => {
      probed = true;
      return { ok: true };
    };
    expect(verifyCoreRefReachable({ ref: "6d84498", probe }).ok).toBe(false);
    expect(verifyCoreRefReachable({ ref: "main", probe }).ok).toBe(false);
    expect(probed).toBe(false);
  });

  test("every production deploy script runs the gate", () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    expect(packageJson.scripts["verify:core-ref"]).toContain("scripts/verify-core-ref-reachable.mjs");
    // Container build/deploy scripts were retired with the cloud solver (B4b);
    // the pin still gates the production Worker deploys, which build the
    // browser solver from the pinned sibling Core packages.
    for (const script of ["deploy:cloudflare", "deploy:cloudflare:dry-run"]) {
      expect(packageJson.scripts[script], `${script} must gate on verify:core-ref`).toContain("verify:core-ref");
    }
  });
});

describe("probeCoreRefWithGit integration", () => {
  const scratch = mkdtempSync(join(tmpdir(), "core-ref-probe-int-"));

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("distinguishes reachable and unreachable commits on a real remote", () => {
    const remote = join(scratch, "remote");
    git(scratch, "init", "--quiet", remote);
    writeFileSync(join(remote, "file.txt"), "core\n");
    git(remote, "add", "file.txt");
    git(remote, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "init");
    // GitHub serves arbitrary reachable SHAs; grant the same for the local transport.
    git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    const head = git(remote, "rev-parse", "HEAD");

    expect(probeCoreRefWithGit(remote, head).ok).toBe(true);
    const missing = probeCoreRefWithGit(remote, "ffffffffffffffffffffffffffffffffffffffff");
    expect(missing.ok).toBe(false);
    expect(missing.detail).toBeTruthy();
  });
});
