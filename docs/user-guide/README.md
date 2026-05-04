# User Guide

OpenCAE starts on a local workspace screen with three paths:

- **Create new project** opens the simulation type picker for static stress or dynamic structural studies.
- **Open local project** loads a saved `.opencae.json` file, including embedded uploaded geometry and saved results when present.
- **Load sample project** opens the bracket, beam, or cantilever sample. Samples can be loaded as static or dynamic studies from the Model panel.

## Study Setup

Work through the Model, Material, Supports, Loads, Mesh, Run, Results, and Report steps.

- Model: inspect the part, upload STEP, STP, STL, or OBJ files, show dimensions, rotate the model, and switch between model and mesh views.
- Material: assign starter materials and configure print parameters for 3D-printing materials. Print layer orientation changes the effective material properties used by local solves.
- Supports: select model faces and add fixed supports.
- Loads: add force, pressure, or payload-weight loads. Payload loads can use selected payload objects and material density to calculate mass.
- Mesh: choose coarse, medium, fine, or ultra sampling. The generated mesh summary is stored as a study artifact.
- Run: pick Detailed local or OpenCAE Core, review readiness messages, start a run, watch progress/log events, or cancel an active local run. Unsupported OpenCAE Core cases fall back to Detailed local automatically.

## Results And Reports

Static runs show stress, displacement, and safety-factor result fields. Dynamic runs add timed frames and may include velocity and acceleration fields. Use the Results step to switch fields, toggle deformed shape, adjust stress exaggeration, and play cached dynamic frames.

Each completed run writes result artifacts plus an HTML report and PDF report. Saved local project files include completed result bundles so a project can be reopened without rerunning the study.
