# Plan 005: Replace Source-Text Guard Tests With Behavioral Contracts

Base commit: `3a67db9`
Status: TODO
Priority: 5
Category: test coverage / DX

## Problem

The suite contains many tests that read source files and assert string fragments. Some are useful quarantine checks, but others encode implementation details such as variable names, import spellings, callback bodies, and CSS class ordering. These tests can fail during safe refactors and still miss the behavior users care about.

The goal is not to delete all source-text guards. The goal is to replace brittle guards with behavior, config, or AST-level contracts where the invariant matters.

## Current Evidence

`apps/opencae-web/src/performanceRewrite.test.ts` reads source files and asserts dozens of implementation strings, including:

```ts
expect(workspaceSource).toContain("lazyCadViewerImport");
expect(viewerSource).toContain("const viewerDpr = props.resultPlaybackPlaying || viewerInteracting ? VIEWER_ACTIVE_DPR_RANGE : VIEWER_IDLE_DPR_RANGE");
expect(playbackLoop).not.toContain("setResultFields");
```

`scripts/core-cloud-validation-docs.test.mjs` checks docs by substring presence instead of rule ids tied to executable tests.

`scripts/calculix-quarantine.test.mjs` is a better use of source scanning because it enforces a production quarantine, but even there the package-script assertions are string includes.

`apps/opencae-web/src/components/BottomPanel.test.tsx` renders markup for most checks, but still asserts handler wiring by source text:

```ts
expect(bottomPanelSource).toContain("function runCoffeeAnimation()");
expect(bottomPanelSource).toContain("onMouseEnter={runCoffeeAnimation}");
```

## Desired Behavior

Important invariants should be covered by one of:

- Behavior tests that render components or call exported helpers.
- Config tests that parse JSON/JSONC/package files and inspect structured fields.
- AST/import graph checks for architectural boundaries.
- Bundle-size/performance commands for actual output budgets.
- Source text scans only for quarantine rules where textual absence is the product requirement.

## Implementation Steps

1. Inventory source-text tests.
   - Search for `readFileSync(` in `*.test.*`.
   - Classify each assertion as:
     - keep as quarantine,
     - convert to structured config test,
     - convert to behavior test,
     - convert to AST/import graph boundary,
     - delete because covered elsewhere.
   - Add the inventory as a short comment block in the first PR or as a temporary checklist in the PR description, not as permanent repo docs unless maintainers want it.

2. Start with `apps/opencae-web/src/performanceRewrite.test.ts`.
   - Keep high-level architecture checks, but move them to helpers that parse imports rather than matching arbitrary strings.
   - Suggested helper: read a TS/TSX file and extract static import sources plus dynamic import string literals. This can be a small parser based on TypeScript if available through devDependencies, or a minimal regex for import declarations only. Prefer TypeScript AST if practical.
   - Replace exact variable/body checks with behavior tests around exported helpers:
     - `resultPlaybackCache` pack/hydrate behavior already has dedicated tests; rely on those.
     - `CadViewer` exported pure helpers such as `shouldShowResultMarkers`, `shouldDisableResultDeformation`, and legend helpers can be directly tested.
     - For lazy loading, assert `App` renders start screen without importing `WorkspaceApp` by mocking dynamic import or by inspecting built chunks in the bundle budget script.

3. Convert BottomPanel handler wiring.
   - Use a DOM-capable testing approach if already available; if not, export a pure helper for animation state transitions and test that helper.
   - If adding React Testing Library or jsdom is too large for this repo, keep the source-text test temporarily and note it as a TODO in the test name.

4. Improve documentation validation.
   - Extend `docs/validation/README.md` hard failure rules with stable ids, for example `HF-001`.
   - Add matching test ids in validation tests or an exported list from test fixtures.
   - Change `scripts/core-cloud-validation-docs.test.mjs` to assert every documented hard failure id appears in an executable test mapping, not just that headings exist.
   - This aligns with the existing quality plan's documentation parity goal.

5. Keep quarantine tests, but make config checks structured.
   - Keep production source scanning for legacy solver tokens in `scripts/calculix-quarantine.test.mjs`.
   - Replace package script `toContain(...)` checks with parsed command assertions where possible. For example, verify script names and arguments through a small command-token parser or exact expected strings for whole scripts.

6. Add a guardrail.
   - Add a lightweight test that fails if new tests under `apps/`, `libs/`, or `services/` call `readFileSync` on source files without a `quarantine` or `architecture-boundary` marker in the test name.
   - This prevents the pattern from growing back accidentally.

## Verification Gates

Run:

```sh
pnpm test apps/opencae-web/src/performanceRewrite.test.ts apps/opencae-web/src/components/BottomPanel.test.tsx scripts/core-cloud-validation-docs.test.mjs scripts/calculix-quarantine.test.mjs
pnpm test
```

Expected:

- Tests pass.
- Remaining source-text reads are explicitly justified as quarantine or architecture-boundary checks.
- Refactoring a variable name without changing behavior should not break performance regression tests.

## Done Criteria

- `performanceRewrite.test.ts` no longer depends on exact function names or callback body substrings for behavior already covered elsewhere.
- Documentation validation uses stable rule ids or an equivalent structured mapping.
- Source scanning remains only for textual quarantine/architecture rules.
- A guard prevents new brittle source-text tests from being added casually.

## Out Of Scope

- Do not introduce a full browser E2E framework in this plan.
- Do not relax legacy solver quarantine coverage.
- Do not delete performance budget scripts.

## Escape Hatches

If a behavior cannot be tested without a large test-environment dependency, keep the existing source-text assertion temporarily but rename the test to include `architecture-boundary` and add a follow-up TODO with the dependency tradeoff.
