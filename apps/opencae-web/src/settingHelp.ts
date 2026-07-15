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
  | "targetSafetyFactor";

export interface SettingHelp {
  title: string;
  body: string;
  visual: SettingHelpVisual;
}

export const SETTING_HELP: Record<SettingHelpId, SettingHelp> = {
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
