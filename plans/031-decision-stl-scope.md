# Decision 3: STL/OBJ — Close the Solve Loop or Declare Preview Scope

Status: PROPOSED — needs product call
Area: import scope / UX honesty
Related: plan 028 D6, `WorkspaceApp.tsx:552` STL/OBJ gate,
`lib/wasmMeshing.ts:24-31`, review feature F4

## User problem

Users can upload STL/OBJ but cannot solve them (preview-only). Import
implies solve; the D6 readiness gate + "preview-only" copy is an interim
honesty patch, not a resolution. The failure mode already burned users
once (placeholder mesh marked complete, run blamed the browser build).

## Options

A. **Close the loop (recommended if STL users matter).** Surface→volume
path in Gmsh WASM (`libs/opencae-mesh-intake`) + quality gate + honest
diagnostics. Effort M–L.
B. **Declare preview scope.** State the limit before Mesh (upload copy +
readiness), never offer Run for STL/OBJ, no placeholder, no dead-end.
Effort S. Honest but permanently cedes STL-solving users.
C. **Keep the interim.** Not recommended: the gate works but every STL
user still hits a dead end mid-workflow.

## Dependencies

Gmsh WASM surface→volume path → quality gate → diagnostics; or copy-only
(UI strings + readiness).

## Effort / acceptance

M–L for A; S for B. Acceptance (A): STL closes to a volume mesh and solves
with `actual_volume_mesh` provenance. Acceptance (B): no STL user reaches
Run with a runnable-looking button.

## Decision needed

Do STL-solving users exist in sufficient numbers to fund A, or is B the
documented scope?
