import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";

// Coverage for the commit-pin paths of ensure-opencae-core.mjs:
// - a pinned commit already present in the local sibling checkout must be usable
//   without fetching (the pin may be the head of a branch that is not pushed yet), and
// - a pin that is neither local nor fetchable must fail with actionable guidance
//   instead of a bare git fetch error.

const scriptPath = resolve(import.meta.dirname, "ensure-opencae-core.mjs");
const scratch = mkdtempSync(join(tmpdir(), "ensure-core-test-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createCoreCheckout(name) {
  const dir = join(scratch, name);
  git(scratch, "init", "--quiet", dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@opencae/root", private: true }));
  git(dir, "add", "package.json");
  git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "init");
  return dir;
}

function runEnsureCore(coreDir, coreRef) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCAE_CORE_DIR: coreDir,
      OPENCAE_CORE_REF: coreRef,
      // Force the production full-SHA pin rule so the test matches CI/container builds.
      OPENCAE_REQUIRE_PINNED_CORE: "1"
    }
  });
}

describe("ensure-opencae-core commit pins", () => {
  test("uses a pinned commit already present locally without fetching from origin", () => {
    // No origin remote at all: any fetch attempt would fail loudly.
    const coreDir = createCoreCheckout("local-pin");
    const head = git(coreDir, "rev-parse", "HEAD");

    const result = runEnsureCore(coreDir, head);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("skipping remote fetch");
    expect(git(coreDir, "rev-parse", "HEAD")).toBe(head);
  });

  test("fails with push guidance when the pinned commit is neither local nor fetchable", () => {
    const coreDir = createCoreCheckout("unreachable-pin");
    git(coreDir, "remote", "add", "origin", join(scratch, "no-such-remote"));

    const result = runEnsureCore(coreDir, "ffffffffffffffffffffffffffffffffffffffff");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not be fetched from the Core remote");
    expect(result.stderr).toContain("push the OpenCAE Core branch that contains it");
    expect(result.stderr).toContain("services/opencae-core-cloud/OPENCAE_CORE_REF");
  });
});
