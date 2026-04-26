export type SettingHelpVisual =
  | "axis"
  | "dimensions"
  | "layers"
  | "load"
  | "mesh"
  | "support"
  | "results"
  | "report";

export type SettingHelpId =
  | "sampleModel"
  | "dimensions"
  | "orientation"
  | "materialLibrary"
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
  | "meshQuality"
  | "runReadiness"
  | "solver"
  | "resultMode"
  | "stressExaggeration"
  | "deformedShape"
  | "targetSafetyFactor"
  | "reportOutput";

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
    title: "Model orientation",
    body: "Rotates the imported model around the global X, Y, or Z axis so the part matches the Z-up coordinate system used for directions, gravity, and dimensions.",
    visual: "axis"
  },
  materialLibrary: {
    title: "Material library",
    body: "Selects the material properties used by the solver, including stiffness, density, Poisson ratio, and yield strength for the break/factor-of-safety checks.",
    visual: "results"
  },
  printSettings: {
    title: "3D print settings",
    body: "Adjusts the effective printed material properties before applying the material. Infill, walls, and layer direction change stiffness and strength estimates.",
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
    body: "Choose which model axis points away from the build plate while printing. 3D printed parts are usually weaker across layer lines, so this changes the effective strength used by the simulation.",
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
    body: "Select the face where the force, pressure, or payload weight acts. The selected face controls both where the load appears and where the solver applies it.",
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
    body: "Chooses the load direction in global axes or along the selected face normal. With Z-up, -Z usually means downward gravity.",
    visual: "axis"
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
    body: "Shows the local solver backend and progress. Results are estimates from the local static solver, not a certified finite-element report.",
    visual: "results"
  },
  resultMode: {
    title: "Result mode",
    body: "Switches the color plot between stress, displacement, and safety factor so you can inspect different failure and deflection views.",
    visual: "results"
  },
  stressExaggeration: {
    title: "Stress exaggeration",
    body: "Scales the displayed stress/deformed visualization to make small changes easier to see. It changes the view only, not the numeric result.",
    visual: "results"
  },
  deformedShape: {
    title: "Deformed shape",
    body: "Overlays the estimated displaced shape on the model so you can see the bending pattern. The visual can be exaggerated for inspection.",
    visual: "results"
  },
  targetSafetyFactor: {
    title: "Target safety factor",
    body: "Reverse-checks the current result to estimate the maximum load for the safety factor you want. Higher targets allow less load.",
    visual: "results"
  },
  reportOutput: {
    title: "Report output",
    body: "Generates a downloadable report with model setup, material data, boundary conditions, result values, and the current simulation summary.",
    visual: "report"
  }
};

export const REQUIRED_SETTING_HELP_IDS: SettingHelpId[] = Object.keys(SETTING_HELP) as SettingHelpId[];

export const LAYER_DIRECTION_HELP_TEXT = SETTING_HELP.layerDirection.body;
