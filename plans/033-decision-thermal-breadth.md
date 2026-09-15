# Decision 5: Thermal Breadth — Transient Conduction, Convection BCs

Status: PROPOSED — needs product call (lowest priority of the six)
Area: physics scope
Related: `study-core:104-132`, solver `thermal.ts:50-127`, review feature F10

## User problem

Thermal is steady-state only, with prescribed-temperature +
heat-flux/generation loads. No transient, no Robin (convection) BC, no
coupled thermo-mechanical strain (isothermal linear-elastic; no CTE
anywhere surveyed).

## Options

A. **Convection BC only (recommended if any thermal breadth is funded).**
Small matrix/vector extension; effort M. Analytic slab agreement +
energy-balance error as today.
B. **A + transient thermal.** Reuses thermal assembly + dynamic time
machinery; effort L on top. Lumped-capacitance agreement.
C. **No thermal breadth.** Keep steady-state conduction as the documented
scope. Thermo-mechanical coupling is explicitly NOT recommended under any
option — it contradicts the uncoupled architecture.

## Dependencies

Thermal assembly → (transient) dynamic time machinery → report.

## Effort / acceptance

M (convection) / L (transient). Acceptance: analytic agreement;
energy-balance error reported as today.

## Decision needed

Is there user evidence for thermal breadth, or does C hold until demand
appears? Keep behind Decisions 1–4 regardless.
