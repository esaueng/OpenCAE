import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent/tooling worktrees under .claude/ carry full repo copies whose suites
    // can't resolve workspace deps from this root — never sweep them into runs.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // CI runners have 4 cores and this suite runs multi-second synchronous
    // wasm stretches (gmsh meshing, occt imports, 100k-DOF solves). At full
    // parallelism those starve the vitest worker RPC heartbeat and the run
    // intermittently dies with an unhandled "[vitest-worker]: Timeout calling
    // onTaskUpdate" even when every test passes. Two workers on CI keep cores
    // free for the pool's RPC; local runs keep full parallelism.
    ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}),
  },
});
