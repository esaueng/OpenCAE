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

Use the default Cloudflare deploy for the production app domain and Cloud FEA container binding. It uses `wrangler.containers.jsonc` and requires a token allowed to update Cloudflare Container applications. Use the static or local-first deploy only when Cloud FEA containers are intentionally omitted.
