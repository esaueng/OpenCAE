# Decision 6: Full-Transient / Multi-Variant Export Archive

Status: PROPOSED — needs product call
Area: export scope
Related: plan 024 Release 2, `selectedResultExport.ts:66-71,322-325`,
user-guide `:40` (selected-state scope), review feature F8

## User problem

CSV/VTU export is selected-state-only (one static state / one frame / one
mode), honestly labeled with budget/refusal logic. Users comparing frames
or handing off a study must export repeatedly.

## Options

A. **Archive/streaming increment (recommended when handoff demand is
evidenced).** Chunked writer exists; needs streaming/zip + memory profiling
per plan 024 acceptance. Effort M.
B. **Keep selected-state scope.** Document as the limit; revisit on demand.
Zero cost, honest as labeled today.

## Dependencies

Chunked writer (exists) → streaming/zip → memory profiling.

## Effort / acceptance

M. Acceptance: multi-frame/variant archive round-trips through CSV/VTU
re-read fixtures without silent truncation.

## Decision needed

Is repeated-export friction actually reported, or does B hold? Plan 024
already defers this to an increment — confirm that deferral stands.
