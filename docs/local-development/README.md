# Local Development

This repo requires a sibling OpenCAE Core checkout for every install and build (only the relative layout matters):

```text
<workspace>/open-cae
<workspace>/opencae-core
```

Run `pnpm ensure:core` (or clone `https://github.com/esaueng/OpenCAE-Core` into `../opencae-core`) before running `pnpm install` for the first local setup. The pnpm workspace resolves `@opencae/core`, `@opencae/solver-cpu`, and other Core packages from that live checkout, so rebuilding this repo picks up local Core changes. Set `OPENCAE_CORE_DIR` to use a different sibling path.

If `../opencae-core` is missing in a build environment, `pnpm build:core` clones it, reruns `pnpm install --no-frozen-lockfile` (so dependency resolution can pick up sibling workspace changes), and builds the sibling Core packages consumed through this workspace. CI installs with `--frozen-lockfile` against the pinned Core ref.

Install dependencies and run the local API plus web app:

```bash
pnpm install
pnpm dev
```

`pnpm build:core` refreshes the sibling checkout from `https://github.com/esaueng/OpenCAE-Core` before building Core packages. The ref comes from `services/opencae-core-cloud/OPENCAE_CORE_REF` and should be a full commit SHA for production builds so local and Cloudflare container artifacts are reproducible. If the sibling Core checkout has local changes or local-only commits, the refresh fails instead of overwriting work or producing a Cloudflare container that cannot be reproduced from the remote Core repo.

`pnpm dev` starts the Fastify API on `http://localhost:4317` and the Vite web app on `http://localhost:5173`. The API creates and seeds the SQLite database if needed.

## Commands

```bash
pnpm db:migrate
pnpm db:seed
pnpm reset:local
pnpm build
pnpm test
pnpm verify:perf
```

- `pnpm db:migrate` prepares the local SQLite schema.
- `pnpm db:seed` writes the seeded demo project and artifacts.
- `pnpm reset:local` clears and reseeds local database state.
- `pnpm build` builds the API and web app.
- `pnpm test` runs the Vitest suite across the workspace.
- `pnpm verify:perf` builds the web app and runs the web performance verifier.

## Cloudflare Commands

```bash
pnpm deploy:cloudflare:dry-run
pnpm deploy:cloudflare
pnpm deploy:cloudflare:static:dry-run
pnpm deploy:cloudflare:static
pnpm deploy:cloudflare:local-first:dry-run
pnpm deploy:cloudflare:local-first
```

Use the default Cloudflare deploy for the production app domains. It deploys the Core Cloud production Worker with `wrangler.containers.jsonc`, targets `opencae`, and binds `CORE_CLOUD_CONTAINER`, `CORE_CLOUD_ARTIFACTS`, and the versioned OpenCAE Core Cloud container. Use the static and local-first commands only for explicitly non-production Workers.

Deploy and CI runners may start from a standalone checkout of this repo as long as their build command is `pnpm run build` or another script that runs `pnpm build:core`; that script creates `../opencae-core` before compiling.
