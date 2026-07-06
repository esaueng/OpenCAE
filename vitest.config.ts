import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent/tooling worktrees under .claude/ carry full repo copies whose suites
    // can't resolve workspace deps from this root — never sweep them into runs.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
