export type SettingHelpVisual =
  | "axis"
  | "dimensions"
  | "layers"
  | "load"
  | "mesh"
  | "support"
  | "results";

export type SettingHelpId =
  | "sampleModel"
  | "dimensions"
  | "orientation"
  | "materialLibrary"
  | "manufacturingProcess"
  | "printSettings"
  | "printedPart"
  | "infillDensity"
  | "wallCount"
  | "layerDirection"
  | "supportPlacement"
  | "supportType"
  | "loadPlacement"
  | "loadType"
  | "loadMagnitude"
  | "loadDirection"
  | "loadCases"
  | "meshQuality"
  | "runReadiness"
  | "solver"
  | "dynamicStartTime"
  | "dynamicEndTime"
  | "dynamicTimeStep"
  | "dynamicOutputInterval"
  | "dynamicLoadProfile"
  | "dynamicDampingRatio"
  | "resultMode"
  | "stressExaggeration"
  | "deformedShape"
  | "stressMeasure"
  | "colorScale"
  | "modalModes"
  | "modePhase"
  | "pinnedProbes"
  | "sectionPlane"
  | "resultFrame"
  | "loadCombinations"
  | "simulationProperties"
  | "assignedMaterial"
  | "simulationSettings"
  | "preconfigured"
  | "modalSettings"
  | "targetSafetyFactor";

export interface SettingHelp {
  title: string;
  body: string;
  visual: SettingHelpVisual;
}

export const SETTING_HELP: Record<SettingHelpId, SettingHelp> = {
  stressMeasure: {
    title: "Stress measure",
    body: "Chooses which single number is pulled out of the stress tensor and plotted. Von Mises rolls all six components into one never-negative value and is the standard yield check for ductile metals. σ₁ is the largest (most tensile) principal stress and σ₃ the smallest (most compressive) — reach for these when sign matters, as with brittle materials, bonded joints, or crack-opening checks. Max shear is (σ₁ − σ₃)/2, the Tresca half-range. Only the measures the loaded run can supply are offered: von Mises whenever the run has any stress field, and σ₁, σ₃, and max shear when the run either stored those fields directly or stored full stress tensors they can be worked out from. σ₁ and σ₃ use a diverging ramp — white sits at the zero crossing when the range spans tension and compression, so a range with no compression in it simply runs white to red.",
    visual: "results"
  },
  colorScale: {
    title: "Color scale range",
    body: "Sets the value range that colors map to. Auto spans the smallest and largest value across every frame of the run for the current measure, so colors stay comparable while you scrub playback — that span is the \"Automatic run range\" readout below, which keeps showing even while Manual is active. Manual pins the range to values you type in the units shown; anything outside clamps to the end colors instead of dropping out, which helps when one sharp corner dominates the plot. The setting is kept per run, variant, and measure, so switching von Mises to σ₁ swaps in that measure's own range. Reset returns to Auto and clears the typed values, but leaves the banding choice alone.",
    visual: "results"
  },
  modalModes: {
    title: "Modes",
    body: "Lists the modes that converged, each with its natural frequency in Hz. Selecting one shows that shape in the viewer. Mode shapes are normalized: every shape is scaled so the largest nodal motion is exactly 1, so the amplitudes and colours show relative motion -- where the part moves most versus least -- and are not physical displacements. Only the frequencies are physical quantities. Scaled residual reports how well each mode satisfies the eigenproblem; smaller is better.",
    visual: "results"
  },
  modePhase: {
    title: "Mode phase",
    body: "Sweeps the selected mode shape through one full cycle; the phase readout steps in equal increments from 0 degrees up to just under 360, never reaching it. These frames are generated in the browser by scaling the one solved mode shape by a cosine -- the solver returns a single static shape per mode, not a time history. So playback does not run at the mode's real frequency, and the timeline is not physical time. The part only moves when Animate mode shape is on; with it off, changing phase just rescales the contour magnitudes.",
    visual: "results"
  },
  pinnedProbes: {
    title: "Pinned probes",
    body: "Click the result surface to pin a reading at that spot; up to 20 pins. Each pin re-reads whatever the panel is currently showing, so switching result mode, stress component, or frame updates every pinned number. Readings are interpolated between the nearest solved values rather than copied from a single node. You cannot place a pin while playback is running, and pins are cleared when the run, model, mesh, or variant changes.",
    visual: "results"
  },
  sectionPlane: {
    title: "Open section",
    body: "Clips the rendered view with a flat plane so you can see inside the part. The axis buttons choose which axis the cut plane is perpendicular to, the offset slides it from 0% at the low end of the model's bounding box to 100% at the high end, and Flip cut side keeps the opposite half. This is display-only: it changes nothing about the mesh, the loads, or the solved result. The cut stays applied in the results view, where it clips the stress contours too.",
    visual: "axis"
  },
  resultFrame: {
    title: "Frame",
    body: "Scrubs through the result frames saved by a dynamic run. The readout shows the solved time in seconds alongside the frame number, and the marker on the track is the frame where peak displacement occurs. Frames exist only where the run's output interval saved one, so this steps between stored snapshots rather than continuous time.",
    visual: "results"
  },
  loadCombinations: {
    title: "Load combinations",
    body: "Superposes already-solved load cases with signed factors — for example 1.0 x Down together with -0.5 x Side — and adds each enabled combination as its own result variant. Factors may be negative. A combination re-uses the results already computed for its cases instead of solving again, so it adds little to run time, and von Mises is recomputed from the combined stress tensor rather than scaled from each case. A case referenced by an enabled combination is solved even when that case itself is disabled; it simply does not appear as a result of its own. Static studies only. When a run produces more than one variant, a governing envelope variant is added alongside them.",
    visual: "load"
  },
  simulationProperties: {
    title: "Simulation properties",
    body: "The as-analyzed values the solver will use, after the manufacturing process is applied to the base material. Machined, moulded, SLA and MJF parts pass through unchanged, so those match the base material card exactly. FDM is the only process that lowers stiffness, density and yield together: infill and wall count set the effective density and fill factors, while the build direction relative to the governing load path decides whether layers are loaded across (weakest) or within. SLS and metal additive lower yield strength only. Poisson ratio is taken from the base material and is never modified by the process. These values preview the selection above — press Apply material and process to make them the assigned ones.",
    visual: "results"
  },
  assignedMaterial: {
    title: "Assigned material",
    body: "The material and process actually attached to this study — this, not the selection above, is what the solver reads. It stays empty until you press Apply material and process, and only the first assignment is used. If it points at a material that no longer exists, such as a deleted custom material, it is called out here and the run is blocked until you choose a valid one.",
    visual: "results"
  },
  simulationSettings: {
    title: "Simulation settings",
    body: "Settings that apply to the whole run rather than to any one load or face. The analysis type is locked while a run is in progress. Every run solves locally in your browser, so there is no compute backend to choose. Fidelity is saved with the study and printed on the report, but no solve path reads it today: it does not change mesh density, solver tolerance, or accuracy.",
    visual: "results"
  },
  preconfigured: {
    title: "Preconfigured setup",
    body: "A written description of how the highlighted sample is arranged — where it is held and where it is loaded — so you know what the demo represents before loading it. It follows whichever sample is highlighted in the picker above rather than the study currently open, and it is fixed explanatory text, not a readout of your setup: editing or deleting the supports and loads does not change it. Shown for sample projects only.",
    visual: "support"
  },
  modalSettings: {
    title: "Modal settings",
    body: "Modal analysis finds the part's natural frequencies and mode shapes from its stiffness and mass, so it uses the material, supports, and mesh but ignores every applied load. Request 1 to 10 modes; the solver reports how many actually converged, which can be fewer than the number you asked for.",
    visual: "results"
  },
  sampleModel: {
    title: "Sample model",
    body: "Loads a prepared demo part with example supports, loads, and model data. Use this when you want a known setup instead of starting from an uploaded file.",
    visual: "axis"
  },
  dimensions: {
    title: "Overall dimensions",
    body: "Shows the model bounding size in the 3D viewer and side panel. X is length, Y is depth, and Z is height with Z pointing upward.",
    visual: "dimensions"
  },
  orientation: {
    title: "Orientation",
    body: "Aims the camera straight down the global X, Y, or Z axis, so you can check the part against the Z-up frame that directions, gravity, and dimensions are measured in. These buttons move the camera only: the model is never rotated, which is why the angles below stay at zero and Reset stays greyed out.",
    visual: "axis"
  },
  materialLibrary: {
    title: "Base material",
    body: "Selects the material family and its nominal solid properties. Manufacturing effects are applied separately after you choose a compatible process.",
    visual: "results"
  },
  manufacturingProcess: {
    title: "Manufacturing process",
    body: "Shows only processes with a validated profile for the selected material. The process controls whether solid properties or process-adjusted properties are used.",
    visual: "layers"
  },
  printSettings: {
    title: "Process settings",
    body: "Adjusts only the settings relevant to the selected additive process. FDM uses infill, walls, and build direction to estimate density, stiffness, and load-path strength.",
    visual: "layers"
  },
  printedPart: {
    title: "3D printed part",
    body: "Turns on print-specific material reduction factors. Enable this for FDM printed parts instead of assuming solid molded or machined stock.",
    visual: "layers"
  },
  infillDensity: {
    title: "Infill density",
    body: "Represents how full the interior is. Lower infill reduces effective density, stiffness, and strength, so the part bends more and fails sooner.",
    visual: "layers"
  },
  wallCount: {
    title: "Wall count",
    body: "Represents the number of solid outer perimeters. More walls improve shell stiffness and strength before the sparse infill starts carrying load.",
    visual: "layers"
  },
  layerDirection: {
    title: "Layer direction",
    body: "Choose which model axis points away from the build plate while printing. When the governing load path crosses that build axis, the part is weaker across layer lines, so the simulation reduces interlayer stiffness and strength.",
    visual: "layers"
  },
  supportPlacement: {
    title: "Support placement",
    body: "Select the actual model face that is held fixed. A fixed support removes motion at that face, like a clamp, bolt pattern, or mounted surface.",
    visual: "support"
  },
  supportType: {
    title: "Support type",
    body: "Fixed support locks the selected face. Prescribed displacement is reserved for setups where a face is intentionally moved by a known amount.",
    visual: "support"
  },
  loadPlacement: {
    title: "Load placement",
    body: "Click the exact point for force or pressure loads. For payload mass, click the object carrying the mass so its weight is applied from that object center.",
    visual: "load"
  },
  loadType: {
    title: "Load type",
    body: "Force applies a total load, pressure distributes load over the selected face, and payload mass converts weight to force using gravity.",
    visual: "load"
  },
  loadMagnitude: {
    title: "Magnitude",
    body: "Sets the size of the selected load. Force is in newtons, pressure is distributed over area, and payload mass is converted to equivalent weight.",
    visual: "load"
  },
  loadDirection: {
    title: "Direction",
    body: "Chooses the load direction in global axes, along the selected face normal, or opposite the face normal. With Z-up, -Z usually means downward gravity.",
    visual: "axis"
  },
  loadCases: {
    title: "Load cases",
    body: "Groups loads into named scenarios that share the same geometry, supports, material, and mesh, so only the loads differ between them. Every load belongs to exactly one case: add a second case and each load gains a Case picker to move it. Only enabled cases are solved and returned as results — a disabled case is still solved behind the scenes when an enabled combination needs it, but it never appears as a result of its own. A case cannot be deleted while it still holds loads, or while a combination refers to it.",
    visual: "load"
  },
  meshQuality: {
    title: "Mesh quality",
    body: "Controls how many elements approximate the part. Coarse runs fastest, medium balances speed and detail, and fine gives smoother gradients.",
    visual: "mesh"
  },
  runReadiness: {
    title: "Run readiness",
    body: "The simulation requires a material, at least one support, at least one load, and a generated mesh before the run button is enabled.",
    visual: "results"
  },
  solver: {
    title: "Solver",
    body: "Shows the local solver backend and progress. Results are estimates from the local static solver, not a certified finite-element analysis.",
    visual: "results"
  },
  dynamicStartTime: {
    title: "Start time",
    body: "Sets when the dynamic simulation begins. It is usually zero unless you need the result timeline to start at a later physical time.",
    visual: "results"
  },
  dynamicEndTime: {
    title: "End time",
    body: "Sets how long the dynamic simulation runs. A longer duration captures more of the response but requires more solver steps.",
    visual: "results"
  },
  dynamicTimeStep: {
    title: "Time step",
    body: "Sets the time increment used by the solver. Smaller steps can capture faster motion more accurately, but increase calculation time.",
    visual: "results"
  },
  dynamicOutputInterval: {
    title: "Output interval",
    body: "Sets how often a result frame is saved. Smaller intervals create smoother playback and more frames, which use more memory.",
    visual: "results"
  },
  dynamicLoadProfile: {
    title: "Load profile",
    body: "Controls how the applied load changes over the simulated time, such as arriving gradually, immediately, slowly, or as a repeating sine wave.",
    visual: "load"
  },
  dynamicDampingRatio: {
    title: "Damping ratio",
    body: "Controls how quickly vibration dies out. Zero means no damping; larger values remove oscillation faster and reduce later response peaks.",
    visual: "results"
  },
  resultMode: {
    title: "Result mode",
    body: "Switches the color plot between stress, displacement, and safety factor so you can inspect different failure and deflection views.",
    visual: "results"
  },
  stressExaggeration: {
    title: "Deformation scale",
    body: "Scales the displayed deformed shape to make small displacements easier to see. It changes the view only, not the numeric result.",
    visual: "results"
  },
  deformedShape: {
    title: "Deformed shape",
    body: "Overlays the displaced shape so you can see the bending pattern. The deformation is automatically exaggerated to be visible (the factor is shown in the legend); the white outline is the original undeformed shape. Real displacements are usually far too small to see.",
    visual: "results"
  },
  targetSafetyFactor: {
    title: "Target safety factor",
    body: "Reverse-checks the current result to estimate the maximum load for the safety factor you want. Higher targets allow less load.",
    visual: "results"
  }
};

export const REQUIRED_SETTING_HELP_IDS: SettingHelpId[] = Object.keys(SETTING_HELP) as SettingHelpId[];

export const LAYER_DIRECTION_HELP_TEXT = SETTING_HELP.layerDirection.body;
