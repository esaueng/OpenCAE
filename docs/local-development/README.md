# Local Development

This repo requires a sibling OpenCAE Core checkout for every install and build:

```text
/Users/userzero/codex/opencae-alpha
/Users/userzero/codex/opencae-core
```

Clone `https://github.com/esaueng/OpenCAE-Core` into `../opencae-core` before running `pnpm install`. The pnpm workspace resolves `@opencae/core`, `@opencae/solver-cpu`, and other Core packages from that live checkout, so rebuilding this repo picks up local Core changes.

Install dependencies and run the local API plus web app:

```bash
pnpm install
pnpm dev
```

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

Use the default Cloudflare deploy for the production app domains. It uses `wrangler.jsonc`, targets `opencae`, and intentionally omits container solver bindings because production simulations run in the browser through OpenCAE Core.

Deploy and CI runners must also check out `OpenCAE-Core` as `../opencae-core` before `pnpm install`; a standalone `opencae-alpha` checkout is no longer sufficient.
