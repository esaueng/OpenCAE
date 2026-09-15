# Decision 1: Prescribed-Displacement Supports

Status: PROPOSED — needs product call
Area: solver capability / UX honesty
Related: `UNSUPPORTED_STRUCTURAL_SUPPORT_TYPES` (`libs/opencae-study-core/src/index.ts:202`),
`settingHelp.ts:184`, plan 028 D1 deferral, review findings D4/H3

## User problem

Users modeling a known imposed motion — press fit, test-rig displacement,
foundation settlement — can select a `prescribed_displacement` constraint
type that exists in schema and Core, but the product refuses it at the run
gate ("not supported yet") after letting them build setup around it. The
type's presence implies more than the solver delivers.

## Options

A. **Implement end to end (recommended if demand exists).** Core already
models/validates `prescribedDisplacement`; work is adapter mapping
(`buildOpenCaeCoreModelForStudy:843` fail-closed throw added this branch),
study-core validator, constraint application, UI value fields, and report
rows (`reportData.ts:516-525` already renders the label).
B. **Remove the type from the product surface.** Delete the schema option
(or hide it everywhere including legacy display) and migrate legacy
studies carrying it to `fixed` with a notice. Cheaper, but destroys the
migration path if demand appears later.
C. **Keep the status quo.** Not recommended: the fail-closed throw added
this branch makes refusal loud, but the deferred type still invites
setup work that cannot run.

## Dependencies

Core BC primitive (exists) → adapter mapping → study-core validator →
solver constraint application → UI value fields → report rows.

## Effort / acceptance

Effort M. Acceptance: nonzero prescribed value solves; zero-value equals
`fixed` within tolerance; reactions reflect the imposed motion; mm/MPa and
m/Pa agree (regression: extend the mm parity suite added this branch).

## Decision needed

Is imposed-motion modeling in scope for the preview, and if so, at what
priority relative to multi-face BCs (Decision 2)?
