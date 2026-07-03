# Plan 014: Unit Round-Trip Gate And Strict Unit Rejection

Base commit: open-cae `d1556f2` (origin/main). Execute AFTER plan 006. All changes in open-cae.
Status: TODO
Priority: 4 of the engineering-validity plans
Category: correctness / unit integrity

## Problem

This implements the two smallest-but-sharpest items of the maintainer's own accuracy roadmap (`docs/validation/quality-accuracy-plan.md`, Phase 2.3 and 2.4), which remain open:

1. **Silent unit defaulting.** `normalizeCoreCloudResultForUi` (open-cae `services/opencae-core-cloud/src/index.ts`, ~lines 241–284 in the June review; re-locate by function name) recognizes only known solver unit strings and silently defaults anything else to Pa/m before rewriting provenance to `mm-N-s-MPa`. A typo'd or future-variant units string from the container would silently mis-scale every displayed number by 10³/10⁶ instead of failing the request.
2. **No unit round-trip test.** Nothing in either repo pushes a known analytical case through solver → normalization → UI formatting and asserts the DISPLAYED magnitude. Every ×1000 (m→mm) and ×10⁻⁶ (Pa→MPa) hop is individually reasonable and collectively untested; a double-apply or dropped factor in a refactor would ship as a plausible-looking wrong number. The units chain today: solver-cpu emits mm/MPa-normalized fields (`lengthToMmScale`/stress scaling in the sibling's `packages/solver-cpu/src/results.ts`) with provenance units `m-N-s-Pa`; the mirror service normalizes provenance; the web formats via `apps/opencae-web/src/unitDisplay.ts` with `unitFactor` handling in the viewer legend.

## Desired Behavior

- Unknown/unsupported solver-units strings are rejected with a 422-style validation error carrying the offending string — never defaulted.
- The applied raw→display conversion is recorded on the normalized result (e.g. a `unitNormalization: { from, to, displacementScale, stressScale }` note in the artifact/diagnostics) so a report reader can audit it.
- A CI-run round-trip test locks the end-to-end magnitude: cantilever tip deflection formats as `0.178 mm`-class output (value within tolerance in mm) and root stress as ~`39`–`47 MPa`-class, from a REAL solve result fixture, through the same code path the app uses.

## Implementation Steps

1. Locate current behavior (function names, since lines have drifted since June): in open-cae `services/opencae-core-cloud/src/index.ts` find `normalizeCoreCloudResultForUi` and the unit-string recognition (the June review noted exactly two recognized strings with silent Pa/m default). Read its existing tests in `services/opencae-core-cloud/src/index.test.ts` for harness conventions.
2. Make unit recognition strict:
   - Introduce an explicit allowlist (the two real strings the container emits — verify against the sibling's emission in `packages/solver-cpu/src/results.ts` / `packages/core/src/results.ts`).
   - Unknown string → return the service's standard validation-error shape (match how other 4xx validation failures in that file are constructed) including the raw units string.
   - Thread the error through the Worker proxy path if it surfaces there (check `apps/opencae-web/worker/index.ts` result handling only for pass-through — do not redesign it).
3. Record the conversion: attach the from/to units and numeric scales applied onto the normalized result object where provenance already lives, so it lands in stored artifacts.
4. Round-trip test (open-cae, colocated with existing tests):
   - Fixture: capture a small REAL result (the localCantileverAccuracy harness already produces solved results in-browser-path form; alternatively build a minimal `ResultsResponse` from a solved fixture emitted by the adapter tests). The fixture must include provenance units and field values in the solver's raw convention.
   - Test A (`services/opencae-core-cloud/src/index.test.ts`): known-units fixture → normalized values match hand-computed mm/MPa numbers; unknown-units fixture (`"mm-N-s-kPa"`) → rejected with the string in the error.
   - Test B (web): feed the normalized result through the same formatting used by the results panel (`unitDisplay.ts` formatters) and assert the final display strings for tip deflection and max stress equal the analytical values within tolerance (reuse the Timoshenko constants from `apps/opencae-web/src/workers/localCantileverAccuracy.test.ts` — 0.1782 mm, 39.06 MPa references).
5. Sweep for other silent unit defaults in the same file while there (the June review's H3 also flagged `libs/opencae-units/src/index.ts:30` STL mm-hardcoding and `loadForceNewtons` raw reads — do NOT fix those here; they are UX/schema features. Note them in the PR body as remaining H3 items.)

## Verification Gates

```sh
pnpm typecheck
pnpm test
```

Expected: exit 0; new tests visible; a deliberately-unknown units string test proves rejection (red-before/green-after: write the rejection test first and watch it fail against the silent-default behavior).

## Done Criteria

- No code path defaults an unrecognized solver-units string; rejection carries the raw string.
- Conversion record present on normalized results.
- Round-trip display-magnitude test green in `pnpm test` (so it rides open-cae CI already).

## Out Of Scope

- STL upload unit detection/confirmation UX (accuracy-plan Phase 2.2), schema-wide typed units (Phase 2.1), the sibling repo, report templates.

## Maintenance Note

When the container starts emitting a new units string (e.g. a future unit-system change), the allowlist forces a deliberate, tested addition instead of a silent scale guess — that is the point. Keep the allowlist next to the normalization function with a comment pointing at the sibling emission site.

## Escape Hatches

- If `normalizeCoreCloudResultForUi` no longer exists or normalization moved into the Worker/sibling since `d1556f2`, STOP and report where the units boundary now lives; do not chase it across layers in this plan.
- If strict rejection breaks the live bracket/cantilever flows in tests (i.e., production containers emit a THIRD string the June review missed), add it to the allowlist with evidence from the sibling source — that discovery goes in the PR body.
