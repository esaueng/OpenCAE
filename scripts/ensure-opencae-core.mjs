#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = resolve(process.env.OPENCAE_CORE_DIR ?? resolve(repoRoot, "../opencae-core"));
const coreRepo = process.env.OPENCAE_CORE_REPO ?? "https://github.com/esaueng/OpenCAE-Core.git";
const coreRef = process.env.OPENCAE_CORE_REF ?? "main";

if (existsSync(resolve(coreDir, "package.json"))) {
  console.log(`OpenCAE Core workspace found at ${coreDir}`);
  process.exit(0);
}

if (existsSync(coreDir)) {
  console.error(`OpenCAE Core path exists but is not a workspace root: ${coreDir}`);
  process.exit(1);
}

await mkdir(dirname(coreDir), { recursive: true });
run("git", ["clone", "--depth", "1", "--branch", coreRef, coreRepo, coreDir]);
console.log(`OpenCAE Core workspace cloned to ${coreDir}`);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
