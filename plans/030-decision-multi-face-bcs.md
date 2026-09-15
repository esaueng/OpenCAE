# Decision 2: Multi-Face / Named-Selection BCs + Per-Body Materials

Status: ACCEPTED (option A, first half) — implemented on review/decisions-build; per-body materials remain deferred
Area: modeling expressiveness
Related: plan 028 Stage 3 queue (F4), named selections
(`libs/opencae-samples/src/index.ts:114-150`), review feature F2

## User problem

Every support/load targets one face; multi-body studies share one
material. Users with bolt circles, symmetric faces, or assemblies re-click
each face and cannot assign e.g. steel bracket + rubber bushing.

## Options

A. **Multi-face BCs first, per-body materials second (recommended).**
Multi-face alone is M; the selection model and mesh-intake body mapping
already exist, and volume-force mapping already fails honestly on
ambiguity. Per-body materials build on the same selection plumbing.
B. **Both together.** Larger single increment (L); coherent but slower to
value.
C. **Neither.** Accept single-face/single-material as the preview's scope;
document it as a limit instead of letting users discover it by re-clicking.

## Dependencies

Selection model → viewport pick path → mesh-intake body mapping → adapter →
report tables (per-body rows).

## Effort / acceptance

M for multi-face alone, L with per-body materials. Acceptance: one
support/load references N faces; per-body assignment solves with per-body
report rows; old single-face projects round-trip unchanged.

## Decision needed

Sequence relative to prescribed displacement (Decision 1): which modeling
gap hurts real users more?
