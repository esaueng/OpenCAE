import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent/tooling worktrees under .claude/ carry full repo copies whose suites
    // can't resolve workspace deps from this root — never sweep them into runs.
    // packages/*/tests/** already run in the earlier "Test OpenCAE Core
    // packages" CI step; excluding them here keeps the root `pnpm test` from
    // executing the heaviest suites (golden parity, 100k-DOF) twice.
    exclude: [...configDefaults.exclude, "**/.claude/**", "packages/*/tests/**"],
    // CI runners have 4 cores and this suite runs multi-second synchronous
    // wasm stretches (gmsh meshing, occt imports, 100k-DOF solves). At full
    // parallelism those starve the vitest worker RPC heartbeat and the run
    // intermittently dies with an unhandled "[vitest-worker]: Timeout calling
    // onTaskUpdate" even when every test passes. Two workers on CI keep cores
    // free for the pool's RPC; local runs keep full parallelism.
    ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}),
  },
});
