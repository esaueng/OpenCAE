# User Guide

OpenCAE starts on a local workspace screen with three paths:

- **Create new project** opens the simulation type picker for static stress, dynamic structural, modal, or steady-state thermal studies.
- **Open local project** loads a saved `.opencae.json` file, including embedded uploaded geometry and saved results when present.
- **Load sample project** opens the bracket, beam, or cantilever sample. Samples can be loaded as static or dynamic studies from the Model panel.

## Study Setup

Static, dynamic, and thermal studies work through Model, Material, Supports, Loads, Mesh, Run, and Results. Modal studies skip Loads because natural frequencies do not use applied loads.

- Model: inspect the part, upload STEP, STP, STL, or OBJ files, show dimensions, rotate the model, switch between model and mesh views, or enable one axis-aligned open section. Choose X/Y/Z, move its normalized offset, and flip the visible side. The cut is uncapped; loads, supports, probes, and labels remain visible.
- Material: assign starter materials and configure print parameters for 3D-printing materials. Print layer orientation changes the effective material properties used by OpenCAE Core. **Duplicate & edit** creates a project-only custom material, including optional conductivity in `W/(m·K)`. Editor stress/density units follow the project, while saved values remain Pa and kg/m³. Custom definitions are always labeled user-supplied and unverified.
- Supports: select model faces and add fixed supports.
- Loads: choose **Face force (total)**, pressure, surface traction, volume force, remote force, equivalent bolt preload, or payload mass. Face force is distributed over the selected face; moving its visual arrow point does not change the solve. Surface traction is force per area, while volume force is force per volume over a selected body. A remote force applies an equivalent distributed force and moment from its explicit remote point; it is not a rigid MPC coupling. Equivalent bolt preload is static-only and requires two opposing faces; it is a bonded-linear equal/opposite load pair without contact, slip, or fastener stiffness. Payload loads can use selected payload objects and material density to calculate mass. Every structural study starts with an enabled **Default** load case. Add cases, rename or disable them, and assign each load to exactly one case. Static studies can also add signed combinations; dynamic combinations are intentionally unavailable.
- Mesh: choose coarse, medium, fine, or ultra sampling. The generated mesh summary is stored as a study artifact. Multi-body models may add fuse, tie, or contact connections between named face selections; tie/contact preserve part identity during meshing. For a static study, select an enabled load case and set a displacement-probe point to run the automatic coarse-to-medium-to-fine convergence ladder. The point defaults to the primary load application point.
- Run: review readiness messages, start an OpenCAE Core run, watch progress/log events, or cancel an active local run.

For modal analysis, choose 1–10 requested modes in Run (default 6). Every assigned material must have density, and the model must be constrained against rigid-body motion. If supports are insufficient, OpenCAE stops with a Supports-step error instead of showing a numerical solver failure.

For steady thermal analysis, assign a material with conductivity, add at least one prescribed temperature, and add surface heat flux and/or volumetric heat generation as needed. Temperatures are entered in the visible project units and converted explicitly; heat flux and heat generation use `W/m²` and `W/m³`. Results include temperature, heat-flux magnitude/vector, and energy-balance error.

Tie connections constrain all three displacement components. Frictionless contact constrains only the initial interface normal and leaves tangential motion free. The beta contact route is an initially closed linear penalty, so it must not be used to infer gap opening, lift-off, impact, friction, or large sliding.

Editing a custom material that is assigned to a study clears that study's stale displayed results. An assigned custom material cannot be deleted; assign a different material first. Unknown material IDs in older or hand-edited files are reported explicitly instead of being replaced by Aluminum 6061.

Surface traction, volume force, and remote force work in static and dynamic cases. Equivalent bolt preload is intentionally unavailable in dynamic studies. A volume force on imported multi-body geometry requires an unambiguous body-to-element mapping; OpenCAE reports a mapping error rather than applying it to a guessed body. Remote and preload selections are also checked for enough area and geometric rank to preserve their requested force and moment.

The convergence panel plots probe displacement and raw element peak von Mises stress against actual DOF. A red capped/skipped marker means that rung was not solved. The automatic CPU route is guarded at 150,000 DOF; eligible connection-free static Tet4 models route to matrix-free WebGPU from 150,001 through 500,000 DOF when WebGPU is available. These are routing guards, not memory/performance guarantees for every device. OpenCAE reports **apparent convergence** only when all three successful rungs have strictly increasing DOF and the medium-to-fine changes are at most 5% displacement and 10% stress. Failed or non-increasing ladders are inconclusive. Running the ladder does not change the working mesh selection or replace the active results.

## Results And Reports

Static runs show stress, displacement, safety factor, and tensor-derived principal stress fields. When multiple static cases or combinations are enabled, Results adds a run-variant selector and an Envelope. Envelope stress is the maximum recovered von Mises at each node; envelope displacement keeps the complete vector from the variant with the largest magnitude. Pinned envelope probes identify the governing case or combination near the probe.

Dynamic runs add timed frames and may include velocity and acceleration fields. Dynamic cases share the assembled system but are independent transients; each completed case is saved separately as it finishes, so switching cases loads only the selected transient payload. Modal runs show a frequency table and normalized vector mode shapes. Selecting a mode creates 24 sinusoidal phase frames in the browser; the Phase control and visualization amplitude do not represent physical displacement.

Thermal runs show nodal temperature, heat-flux magnitude/vectors, and energy balance. Each completed run writes result artifacts plus an HTML report and PDF report. **Export result viewer** creates one self-contained offline HTML file with the solved surface mesh, fields, summary, and provenance embedded; it can be sent to a colleague and opened without OpenCAE or a server. Saved local project files include completed result bundles so a project can be reopened without rerunning the study.

Open **Validation** from the workspace activity action to compare the cantilever, plate-with-hole stress-concentration, and 100k-class scale cases against checked-in release baselines. **Run live** executes the selected benchmark in a worker and reports theory/reference values, tolerance, measured error, residual, iterations, and elapsed time.

## Local Storage And Overflow Recovery

OpenCAE keeps simulation work local by default. Small workspace state uses
`localStorage`; large completed result bundles use IndexedDB. When the browser
reports that its autosave quota is exceeded, OpenCAE first requests persistent
site storage to reduce eviction and then asks before any network upload.

- **Cancel** keeps the project local. Use **Save project** to write a complete
  `.opencae.json` file. Chromium browsers can write to a user-selected file;
  browsers without the File System Access picker download the file instead.
- **Allow** encrypts the recovery snapshot in the browser and uploads only the
  ciphertext to the private `opencae-project-backups` R2 bucket. The
  decryption key stays in the browser. Backups expire automatically after 30
  days and are used only if the normal IndexedDB reload restore is unavailable.

Browser code cannot silently expand its own quota or write to arbitrary system
directories. A user-selected file is the only standards-based route outside
browser-managed storage, and persistent write permission varies by browser.
