# Decision 4: Harmonic Response + Linear Buckling Sequencing

Status: PROPOSED — needs product call
Area: solver roadmap
Related: plan 024 Releases 6–7, `selectedResultExport.ts:13,446`
(`harmonic_frequency` state with no producing study), review feature F3

## User problem

Modal gives natural frequencies but no forced-response-vs-frequency;
there is no buckling load-factor check. Both reuse the existing
eigen/sparse infrastructure without a new solver paradigm.

## Options

A. **Sequence after Releases 1–5 per plan 024 (recommended).** Harmonic
(modal superposition, truncation warnings, amplitude/phase views) then
linear buckling (geometric stiffness, ascending load factors). L each.
B. **Harmonic only.** Forced response answers the more common "will it
resonate?" question; defer buckling until demand is evidenced.
C. **Neither in preview.** Document modal + transient as the dynamics
scope; revisit on user evidence.

## Dependencies

Modal subspace iteration (`packages/solver-cpu/src/modal.ts:54-122`) →
result fields/viewer → report. Export code already anticipates a
`harmonic_frequency` state.

## Effort / acceptance

L each. Acceptance (per plan 024): SDOF/2-DOF analytic agreement,
static-limit recovery, Euler-column orientation/scale invariance.

## Decision needed

Fund A/B now, or confirm C and close the roadmap items as out-of-scope?
