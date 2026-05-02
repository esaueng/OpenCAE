# Validation

OpenCAE validates study readiness before a run starts and returns user-facing diagnostics that can be shown in the workflow panels.

Static stress studies require:

- at least one material assignment
- at least one fixed support
- at least one force, pressure, or payload-weight load
- each load to reference a face selection with a positive finite value and a 3D direction vector
- a completed mesh

Dynamic structural studies require the same material, load, load-reference, and mesh checks. They also require at least one support unless `allowFreeMotion` is enabled in dynamic solver settings.

Dynamic solver settings must have an end time greater than start time, a positive time step, an output interval greater than zero and no smaller than the time step, and a non-negative damping ratio.

Validation messages are written for non-expert users first, with advanced details available through diagnostics, run logs, and result artifacts.
