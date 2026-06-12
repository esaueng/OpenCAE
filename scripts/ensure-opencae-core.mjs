#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = resolve(process.env.OPENCAE_CORE_DIR ?? resolve(repoRoot, "../opencae-core"));
const coreRepo = process.env.OPENCAE_CORE_REPO ?? "https://github.com/esaueng/OpenCAE-Core.git";
const pinnedCoreRefPath = resolve(repoRoot, "services/opencae-core-cloud/OPENCAE_CORE_REF");
const coreRef = process.env.OPENCAE_CORE_REF ?? readPinnedCoreRef() ?? "main";
if (isProductionBuild() && !isFullGitCommitRef(coreRef)) {
  console.error("Production OpenCAE Core builds must pin OPENCAE_CORE_REF to a full commit SHA.");
  console.error(`Got "${coreRef}". Update services/opencae-core-cloud/OPENCAE_CORE_REF before building production artifacts.`);
  process.exit(1);
}

if (existsSync(resolve(coreDir, "package.json"))) {
  const before = describeHead(coreDir);
  updateExistingCoreWorkspace(coreDir, coreRef);
  const after = describeHead(coreDir);
  if (before !== after) {
    console.log(`OpenCAE Core workspace moved from ${before} to ${after} at ${coreDir} (set OPENCAE_CORE_REF to pin a different ref).`);
  } else {
    console.log(`OpenCAE Core workspace already at ${after} at ${coreDir}`);
  }
  process.exit(0);
}

if (existsSync(coreDir)) {
  console.error(`OpenCAE Core path exists but is not a workspace root: ${coreDir}`);
  process.exit(1);
}

await mkdir(dirname(coreDir), { recursive: true });
if (isGitCommitRef(coreRef)) {
  run("git", ["clone", "--filter=blob:none", "--no-checkout", coreRepo, coreDir]);
  run("git", ["-C", coreDir, "fetch", "--depth", "1", "origin", coreRef]);
  run("git", ["-C", coreDir, "checkout", "--detach", "FETCH_HEAD"]);
} else {
  run("git", ["clone", "--depth", "1", "--branch", coreRef, coreRepo, coreDir]);
}
console.log(`OpenCAE Core workspace cloned to ${coreDir}`);

function updateExistingCoreWorkspace(directory, ref) {
  const insideGitWorkTree = spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (insideGitWorkTree.status !== 0 || insideGitWorkTree.stdout.trim() !== "true") {
    console.error(`OpenCAE Core path exists but is not a git checkout: ${directory}`);
    process.exit(1);
  }

  const status = spawnSync("git", ["-C", directory, "status", "--porcelain"], { encoding: "utf8" });
  if (status.error) throw status.error;
  if (status.status !== 0) process.exit(status.status ?? 1);
  if (status.stdout.trim().length > 0) {
    console.error(`OpenCAE Core checkout has local changes and cannot be updated safely: ${directory}`);
    console.error("Commit, stash, or move those changes before building OpenCAE.");
    process.exit(1);
  }

  run("git", ["-C", directory, "fetch", "--depth", "1", "origin", ref]);
  if (isGitCommitRef(ref)) {
    run("git", ["-C", directory, "checkout", "--detach", "FETCH_HEAD"]);
    return;
  }

  if (localBranchExists(directory, ref)) {
    run("git", ["-C", directory, "checkout", ref]);
    run("git", ["-C", directory, "merge", "--ff-only", "FETCH_HEAD"]);
  } else {
    run("git", ["-C", directory, "checkout", "-B", ref, "FETCH_HEAD"]);
  }

  const head = gitOutput(directory, ["rev-parse", "HEAD"]);
  const fetchedHead = gitOutput(directory, ["rev-parse", "FETCH_HEAD"]);
  if (head !== fetchedHead) {
    console.error(`OpenCAE Core checkout did not update exactly to origin/${ref}.`);
    console.error("Push or remove local ahead commits before building a Cloudflare-matching container.");
    process.exit(1);
  }
}

function readPinnedCoreRef() {
  if (!existsSync(pinnedCoreRefPath)) return undefined;
  const value = readFileSync(pinnedCoreRefPath, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

function isGitCommitRef(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

function isFullGitCommitRef(ref) {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function isProductionBuild() {
  return process.env.CI === "true" || process.env.NODE_ENV === "production" || process.env.OPENCAE_REQUIRE_PINNED_CORE === "1";
}

function localBranchExists(directory, branch) {
  return spawnSync("git", ["-C", directory, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

function describeHead(directory) {
  return gitOutput(directory, ["rev-parse", "--short", "HEAD"]);
}

function gitOutput(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
