# Local Development

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
pnpm deploy:cloudflare:containers:dry-run
pnpm deploy:cloudflare:containers
```

Use the default Cloudflare deploy for the production app domain. It uses `wrangler.jsonc`, targets `opencae-alpha`, and intentionally omits Cloud FEA container bindings because production simulations run in the browser through OpenCAE Core.

Use `pnpm deploy:cloudflare:containers` only for manual Cloud FEA container experiments. That command uses `wrangler.containers.jsonc`, includes `FEA_CONTAINER`, and points `containers[0].image` at the Cloud FEA Dockerfile so Wrangler builds and pushes the current container image.
