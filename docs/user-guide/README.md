# User Guide

OpenCAE starts on a local workspace screen with three paths:

- **Create new project** opens the simulation type picker for static stress, dynamic structural, or modal studies.
- **Open local project** loads a saved `.opencae.json` file, including embedded uploaded geometry and saved results when present.
- **Load sample project** opens the bracket, beam, or cantilever sample. Samples can be loaded as static or dynamic studies from the Model panel.

## Study Setup

Static and dynamic studies work through Model, Material, Supports, Loads, Mesh, Run, and Results. Modal studies skip Loads because natural frequencies do not use applied loads.

- Model: inspect the part, upload STEP, STP, STL, or OBJ files, show dimensions, rotate the model, switch between model and mesh views, or enable one axis-aligned open section. Choose X/Y/Z, move its normalized offset, and flip the visible side. The cut is uncapped; loads, supports, probes, and labels remain visible.
- Material: assign starter materials and configure print parameters for 3D-printing materials. Print layer orientation changes the effective material properties used by OpenCAE Core. **Duplicate & edit** creates a project-only custom material. Editor stress/density units follow the project, while saved values remain Pa and kg/m³. Custom definitions are always labeled user-supplied and unverified.
- Supports: select model faces and add fixed supports.
- Loads: add force, pressure, or payload-weight loads. Payload loads can use selected payload objects and material density to calculate mass.
- Mesh: choose coarse, medium, fine, or ultra sampling. The generated mesh summary is stored as a study artifact.
- Run: review readiness messages, start an OpenCAE Core run, watch progress/log events, or cancel an active local run.

For modal analysis, choose 1–10 requested modes in Run (default 6). Every assigned material must have density, and the model must be constrained against rigid-body motion. If supports are insufficient, OpenCAE stops with a Supports-step error instead of showing a numerical solver failure.

Editing a custom material that is assigned to a study clears that study's stale displayed results. An assigned custom material cannot be deleted; assign a different material first. Unknown material IDs in older or hand-edited files are reported explicitly instead of being replaced by Aluminum 6061.

## Results And Reports

Static runs show stress, displacement, and safety-factor result fields. Dynamic runs add timed frames and may include velocity and acceleration fields. Modal runs show a frequency table and normalized vector mode shapes. Selecting a mode creates 24 sinusoidal phase frames in the browser; the Phase control and visualization amplitude do not represent physical displacement.

Each completed run writes result artifacts plus an HTML report and PDF report. Saved local project files include completed result bundles so a project can be reopened without rerunning the study.

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
