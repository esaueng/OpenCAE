# Plan 003: Make Core Builds Reproducible

Base commit: `3a67db9`
Status: TODO
Priority: 3
Category: DX / release integrity

## Problem

The local `pnpm build` path can mutate dependency state because `build:core` runs `pnpm install --no-frozen-lockfile`. CI, however, installs with `pnpm install --frozen-lockfile` before building Core packages and does not run the root `build:core` script. This split makes local release verification weaker than CI and can hide lockfile/workspace drift.

## Current Evidence

`package.json`:

```json
"build": "pnpm build:core && pnpm --filter @opencae/api build && pnpm --filter @opencae/web build",
"build:core": "pnpm ensure:core && pnpm install --no-frozen-lockfile && pnpm --filter @opencae/core build && ..."
```

`.github/workflows/ci.yml`:

```yaml
- name: Install dependencies
  run: pnpm install --frozen-lockfile

- name: Build OpenCAE Core packages
  run: |
    pnpm --filter @opencae/core build
    ...
```

`scripts/ensure-opencae-core.mjs` clones or updates the sibling Core workspace, then exits. The install mutation comes from the package script, not the helper.

## Desired Behavior

Build scripts should verify dependency state rather than change it. The command developers run locally should match CI as closely as possible.

Recommended command structure:

- `pnpm ensure:core`: clone/update the sibling checkout only.
- `pnpm install:core-workspace` or similar: explicit dependency install command, documented as mutating.
- `pnpm build:core`: build Core packages without running install.
- `pnpm build`: ensure Core exists, then build, but do not modify the lockfile.
- CI and local verification both fail if workspace dependencies are missing or lockfile is stale.

## Implementation Steps

1. Split package scripts in `package.json`.
   - Remove `pnpm install --no-frozen-lockfile` from `build:core`.
   - Add an explicit mutating setup script, for example:

```json
"setup:core": "pnpm ensure:core && pnpm install --frozen-lockfile"
```

   - If the sibling workspace packages require lockfile refresh during development, add a clearly named opt-in script:

```json
"install:core-workspace": "pnpm ensure:core && pnpm install --no-frozen-lockfile"
```

2. Align CI with scripts.
   - Keep the frozen install step.
   - Replace the manual Core package build block with `pnpm build:core` once `build:core` is non-mutating.
   - Keep `pnpm verify:cloudflare-config`, `pnpm verify:runner-version`, `pnpm typecheck`, and `pnpm test`.

3. Add a regression test for script contracts.
   - Extend `scripts/verify-cloudflare-config.test.mjs` or add `scripts/package-scripts.test.mjs`.
   - Assert `packageJson.scripts["build:core"]` does not contain `install --no-frozen-lockfile`.
   - Assert any `--no-frozen-lockfile` command is in an explicitly named setup/install script, not `build`, `build:core`, `build:cloudflare`, or deploy scripts.
   - Assert CI invokes either `pnpm build:core` or a command sequence matching the same non-mutating Core build steps.

4. Update docs.
   - `README.md` Local Development should tell first-time contributors to run `pnpm install` after `pnpm ensure:core` if needed.
   - Make it explicit that `pnpm build` is a verification/build command, not an install command.

5. Validate lockfile behavior.
   - From a clean tree, run the build/typecheck/test gates below.
   - Confirm `git status --short` is empty afterward except for intentional source changes.

## Verification Gates

Run:

```sh
pnpm ensure:core
pnpm install --frozen-lockfile
pnpm build:core
pnpm typecheck
pnpm test
git status --short
```

Expected:

- Commands exit 0.
- `git status --short` does not show changes to `pnpm-lock.yaml`, package manifests, generated dist files, or source files.

If production deploy scripts are in scope, also run:

```sh
pnpm verify:cloudflare-config
pnpm verify:runner-version
pnpm deploy:cloudflare:dry-run
```

## Done Criteria

- `pnpm build`, `pnpm build:core`, `pnpm build:cloudflare`, and deploy scripts no longer run unfrozen installs.
- CI and local Core build paths share the same script or the same non-mutating command sequence.
- Docs tell developers which setup commands may mutate dependency state.
- A test fails if an unfrozen install is reintroduced into a build/deploy script.

## Out Of Scope

- Do not change the pinned OpenCAE Core ref.
- Do not vendor OpenCAE Core into this repo.
- Do not remove support for `OPENCAE_CORE_DIR`.

## Escape Hatches

If `pnpm build:core` cannot work without refreshing the workspace lockfile, stop and document the exact pnpm workspace limitation. Then create a separate checked-in lockfile refresh procedure rather than hiding mutation inside build.
