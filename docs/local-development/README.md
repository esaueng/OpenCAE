# Local Development

Install dependencies and run the local API plus web app:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

OpenCAE Core packages are part of this monorepo under `packages/*`. `pnpm build:core` only builds those local packages; it does not install dependencies, clone another repository, or mutate the lockfile. CI and local verification should use `pnpm install --frozen-lockfile`.

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
pnpm deploy:cloudflare:retired-do-cleanup
pnpm deploy:cloudflare:static:dry-run
pnpm deploy:cloudflare:static
```

Use the default Cloudflare deploy for the production app domain. It deploys the local-first Worker with the default `wrangler.jsonc` (static assets + security headers, no solver bindings) and targets `opencae`. Use the static commands only for the explicitly non-production `opencae-static` Worker. (The cloud container deploy commands were retired in July 2026; see [docs/cloud-retirement.md](../cloud-retirement.md).)

Use `pnpm deploy:cloudflare:retired-do-cleanup` only once if Cloudflare still has the retired `OpenCaeCoreCloudContainer` Durable Object class recorded and rejects the normal deploy with code `10064`.

Deploy and CI runners may start from a standalone checkout of this repo. Use `pnpm install --frozen-lockfile` followed by `pnpm run build` or another script that runs `pnpm build:core`.
