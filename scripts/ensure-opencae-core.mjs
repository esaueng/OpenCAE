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

if (existsSync(resolve(coreDir, "package.json"))) {
  console.log(`OpenCAE Core workspace found at ${coreDir}`);
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

function readPinnedCoreRef() {
  if (!existsSync(pinnedCoreRefPath)) return undefined;
  const value = readFileSync(pinnedCoreRefPath, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

function isGitCommitRef(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
