import type { Material } from "@opencae/schema";

export type PayloadMaterialCategory =
  | "metal"
  | "plastic"
  | "composite"
  | "resin"
  | "ceramic-glass"
  | "semiconductor"
  | "rubber"
  | "wood"
  | "concrete-stone"
  | "liquid"
  | "misc";

export interface PayloadMaterial {
  id: string;
  name: string;
  category: PayloadMaterialCategory;
  density: number;
}

export const starterMaterials: Material[] = [
  { id: "mat-aluminum-6061", name: "Aluminum 6061", category: "metal", youngsModulus: 68900000000, poissonRatio: 0.33, density: 2700, yieldStrength: 276000000 },
  { id: "mat-aluminum-7075", name: "Aluminum 7075", category: "metal", youngsModulus: 71700000000, poissonRatio: 0.33, density: 2810, yieldStrength: 503000000 },
  { id: "mat-steel", name: "Steel", category: "metal", youngsModulus: 200000000000, poissonRatio: 0.29, density: 7850, yieldStrength: 250000000 },
  { id: "mat-stainless-304", name: "Stainless Steel 304", category: "metal", youngsModulus: 193000000000, poissonRatio: 0.29, density: 8000, yieldStrength: 215000000 },
  { id: "mat-titanium-grade-5", name: "Titanium Grade 5", category: "metal", youngsModulus: 114000000000, poissonRatio: 0.34, density: 4430, yieldStrength: 880000000 },
  { id: "mat-copper", name: "Copper", category: "metal", youngsModulus: 117000000000, poissonRatio: 0.34, density: 8960, yieldStrength: 70000000 },
  { id: "mat-brass", name: "Brass", category: "metal", youngsModulus: 100000000000, poissonRatio: 0.34, density: 8530, yieldStrength: 200000000 },
  { id: "mat-abs", name: "ABS Plastic", category: "plastic", youngsModulus: 2100000000, poissonRatio: 0.35, density: 1040, yieldStrength: 40000000, printProfile: fdmProfile(35, 3, 0.7) },
  { id: "mat-pla", name: "PLA Plastic", category: "plastic", youngsModulus: 3500000000, poissonRatio: 0.36, density: 1240, yieldStrength: 60000000, printProfile: fdmProfile(35, 3, 0.68) },
  { id: "mat-pla-plus", name: "PLA+ Plastic", category: "plastic", youngsModulus: 3900000000, poissonRatio: 0.36, density: 1240, yieldStrength: 68000000, printProfile: fdmProfile(35, 3, 0.7) },
  { id: "mat-petg", name: "PETG", category: "plastic", youngsModulus: 2100000000, poissonRatio: 0.38, density: 1270, yieldStrength: 50000000, printProfile: fdmProfile(40, 3, 0.72) },
  { id: "mat-asa", name: "ASA", category: "plastic", youngsModulus: 2200000000, poissonRatio: 0.35, density: 1070, yieldStrength: 46000000, printProfile: fdmProfile(35, 3, 0.7) },
  { id: "mat-nylon", name: "Nylon", category: "plastic", youngsModulus: 2800000000, poissonRatio: 0.39, density: 1150, yieldStrength: 70000000, printProfile: fdmProfile(40, 3, 0.74) },
  { id: "mat-nylon-cf", name: "Carbon Fiber Nylon", category: "composite", youngsModulus: 7600000000, poissonRatio: 0.34, density: 1180, yieldStrength: 105000000, printProfile: fdmProfile(40, 4, 0.78) },
  { id: "mat-pa12-sls", name: "PA12 Nylon", category: "plastic", youngsModulus: 1700000000, poissonRatio: 0.39, density: 1010, yieldStrength: 48000000, printProfile: { process: "SLS", defaultInfillDensity: 100, defaultWallCount: 2, defaultLayerOrientation: "z", layerStrengthFactor: 0.9 } },
  { id: "mat-polycarbonate", name: "Polycarbonate", category: "plastic", youngsModulus: 2400000000, poissonRatio: 0.37, density: 1200, yieldStrength: 65000000, printProfile: fdmProfile(40, 3, 0.74) },
  { id: "mat-pc-abs", name: "PC-ABS", category: "plastic", youngsModulus: 2300000000, poissonRatio: 0.36, density: 1150, yieldStrength: 56000000, printProfile: fdmProfile(40, 3, 0.72) },
  { id: "mat-peek", name: "PEEK", category: "plastic", youngsModulus: 3700000000, poissonRatio: 0.4, density: 1300, yieldStrength: 97000000, printProfile: fdmProfile(50, 4, 0.78) },
  { id: "mat-sla-tough-resin", name: "Tough Resin", category: "resin", youngsModulus: 2800000000, poissonRatio: 0.38, density: 1180, yieldStrength: 55000000, printProfile: { process: "SLA", defaultInfillDensity: 100, defaultWallCount: 1, defaultLayerOrientation: "z", layerStrengthFactor: 0.86 } },
  { id: "mat-sla-standard-resin", name: "Standard Resin", category: "resin", youngsModulus: 2200000000, poissonRatio: 0.38, density: 1120, yieldStrength: 42000000, printProfile: { process: "SLA", defaultInfillDensity: 100, defaultWallCount: 1, defaultLayerOrientation: "z", layerStrengthFactor: 0.82 } },
  { id: "mat-316l-am", name: "Stainless Steel 316L", category: "metal", youngsModulus: 180000000000, poissonRatio: 0.3, density: 7900, yieldStrength: 470000000, printProfile: { process: "Metal AM", defaultInfillDensity: 100, defaultWallCount: 1, defaultLayerOrientation: "z", layerStrengthFactor: 0.92 } }
];

export type ManufacturingProcessId =
  | "cnc_machining"
  | "injection_molding"
  | "fdm"
  | "sla"
  | "sls"
  | "mjf"
  | "metal_am";

export type ManufacturingSettingsKind = "none" | "fdm" | "build_direction";

export interface ManufacturingProcess {
  id: ManufacturingProcessId;
  label: string;
  shortLabel: string;
  description: string;
  kind: "subtractive" | "molding" | "additive";
  settingsKind: ManufacturingSettingsKind;
}

export interface MaterialManufacturingProfile {
  processId: ManufacturingProcessId;
  defaultInfillDensity?: number;
  defaultWallCount?: number;
  defaultLayerOrientation?: "x" | "y" | "z";
  /** Legacy dense-print strength factor; treated as the in-plane value for FDM. */
  layerStrengthFactor?: number;
  inPlaneModulusFactor?: number;
  interlayerModulusFactor?: number;
  inPlaneStrengthFactor?: number;
  interlayerStrengthFactor?: number;
}

export const manufacturingProcesses: ManufacturingProcess[] = [
  { id: "cnc_machining", label: "CNC machining", shortLabel: "CNC", description: "Solid stock · Isotropic", kind: "subtractive", settingsKind: "none" },
  { id: "injection_molding", label: "Injection molding", shortLabel: "Molded", description: "Solid molded part", kind: "molding", settingsKind: "none" },
  { id: "fdm", label: "FDM printing", shortLabel: "FDM", description: "Layered · Process settings required", kind: "additive", settingsKind: "fdm" },
  { id: "sla", label: "SLA printing", shortLabel: "SLA", description: "Photopolymer resin · Isotropic", kind: "additive", settingsKind: "none" },
  { id: "sls", label: "SLS printing", shortLabel: "SLS", description: "Powder bed · Build direction", kind: "additive", settingsKind: "build_direction" },
  { id: "mjf", label: "MJF printing", shortLabel: "MJF", description: "Powder bed fusion", kind: "additive", settingsKind: "none" },
  { id: "metal_am", label: "Metal additive", shortLabel: "Metal AM", description: "Metal powder bed · Build direction", kind: "additive", settingsKind: "build_direction" }
];

const manufacturingProcessById = new Map(manufacturingProcesses.map((process) => [process.id, process]));

const manufacturingProfilesByMaterialId: Record<string, MaterialManufacturingProfile[]> = {
  "mat-aluminum-6061": [bulkProfile("cnc_machining")],
  "mat-aluminum-7075": [bulkProfile("cnc_machining")],
  "mat-steel": [bulkProfile("cnc_machining")],
  "mat-stainless-304": [bulkProfile("cnc_machining")],
  "mat-titanium-grade-5": [bulkProfile("cnc_machining")],
  "mat-copper": [bulkProfile("cnc_machining")],
  "mat-brass": [bulkProfile("cnc_machining")],
  "mat-abs": [bulkProfile("cnc_machining"), bulkProfile("injection_molding"), additiveProfile("fdm", 35, 3, 0.7)],
  "mat-pla": [bulkProfile("injection_molding"), additiveProfile("fdm", 35, 3, 0.68)],
  "mat-pla-plus": [additiveProfile("fdm", 35, 3, 0.7)],
  "mat-petg": [bulkProfile("injection_molding"), additiveProfile("fdm", 40, 3, 0.72)],
  "mat-asa": [bulkProfile("injection_molding"), additiveProfile("fdm", 35, 3, 0.7)],
  "mat-nylon": [bulkProfile("cnc_machining"), bulkProfile("injection_molding"), additiveProfile("fdm", 40, 3, 0.74)],
  "mat-nylon-cf": [additiveProfile("fdm", 40, 4, 0.78)],
  "mat-pa12-sls": [additiveProfile("sls", 100, 1, 0.9)],
  "mat-polycarbonate": [bulkProfile("cnc_machining"), bulkProfile("injection_molding"), additiveProfile("fdm", 40, 3, 0.74)],
  "mat-pc-abs": [bulkProfile("injection_molding"), additiveProfile("fdm", 40, 3, 0.72)],
  "mat-peek": [bulkProfile("cnc_machining"), bulkProfile("injection_molding"), additiveProfile("fdm", 50, 4, 0.78)],
  "mat-sla-tough-resin": [additiveProfile("sla", 100, 1)],
  "mat-sla-standard-resin": [additiveProfile("sla", 100, 1)],
  "mat-316l-am": [additiveProfile("metal_am", 100, 1, 0.92)]
};

export const payloadMaterials: PayloadMaterial[] = [
  { id: "payload-aluminum-6061", name: "Aluminum 6061", category: "metal", density: 2700 },
  { id: "payload-aluminum-7075", name: "Aluminum 7075", category: "metal", density: 2810 },
  { id: "payload-steel", name: "Carbon steel", category: "metal", density: 7850 },
  { id: "payload-stainless-304", name: "Stainless steel 304", category: "metal", density: 8000 },
  { id: "payload-stainless-316", name: "Stainless steel 316", category: "metal", density: 8000 },
  { id: "payload-cast-iron", name: "Cast iron", category: "metal", density: 7200 },
  { id: "payload-titanium-grade-5", name: "Titanium Grade 5", category: "metal", density: 4430 },
  { id: "payload-copper", name: "Copper", category: "metal", density: 8960 },
  { id: "payload-brass", name: "Brass", category: "metal", density: 8530 },
  { id: "payload-bronze", name: "Bronze", category: "metal", density: 8800 },
  { id: "payload-magnesium", name: "Magnesium alloy", category: "metal", density: 1740 },
  { id: "payload-zinc", name: "Zinc", category: "metal", density: 7140 },
  { id: "payload-lead", name: "Lead", category: "metal", density: 11340 },
  { id: "payload-tungsten", name: "Tungsten", category: "metal", density: 19300 },
  { id: "payload-abs", name: "ABS", category: "plastic", density: 1040 },
  { id: "payload-pla", name: "PLA", category: "plastic", density: 1240 },
  { id: "payload-petg", name: "PETG", category: "plastic", density: 1270 },
  { id: "payload-asa", name: "ASA", category: "plastic", density: 1070 },
  { id: "payload-nylon", name: "Nylon", category: "plastic", density: 1150 },
  { id: "payload-polycarbonate", name: "Polycarbonate", category: "plastic", density: 1200 },
  { id: "payload-acrylic", name: "Acrylic PMMA", category: "plastic", density: 1180 },
  { id: "payload-hdpe", name: "HDPE", category: "plastic", density: 950 },
  { id: "payload-ldpe", name: "LDPE", category: "plastic", density: 920 },
  { id: "payload-pp", name: "Polypropylene", category: "plastic", density: 900 },
  { id: "payload-pvc", name: "PVC", category: "plastic", density: 1380 },
  { id: "payload-ptfe", name: "PTFE", category: "plastic", density: 2200 },
  { id: "payload-peek", name: "PEEK", category: "plastic", density: 1300 },
  { id: "payload-carbon-fiber", name: "Carbon fiber composite", category: "composite", density: 1550 },
  { id: "payload-fiberglass", name: "Fiberglass composite", category: "composite", density: 1850 },
  { id: "payload-g10", name: "G10/FR4 fiberglass", category: "composite", density: 1850 },
  { id: "payload-nylon-cf", name: "Carbon fiber nylon", category: "composite", density: 1180 },
  { id: "payload-standard-resin", name: "Standard photopolymer resin", category: "resin", density: 1120 },
  { id: "payload-tough-resin", name: "Tough photopolymer resin", category: "resin", density: 1180 },
  { id: "payload-ceramic-resin", name: "Ceramic-filled resin", category: "resin", density: 1700 },
  { id: "payload-glass", name: "Soda-lime glass", category: "ceramic-glass", density: 2500 },
  { id: "payload-borosilicate", name: "Borosilicate glass", category: "ceramic-glass", density: 2230 },
  { id: "payload-alumina", name: "Alumina ceramic", category: "ceramic-glass", density: 3900 },
  { id: "payload-zirconia", name: "Zirconia ceramic", category: "ceramic-glass", density: 6000 },
  { id: "payload-porcelain", name: "Porcelain", category: "ceramic-glass", density: 2400 },
  { id: "payload-silicon", name: "Silicon", category: "semiconductor", density: 2330 },
  { id: "payload-silicon-carbide", name: "Silicon carbide", category: "semiconductor", density: 3210 },
  { id: "payload-gallium-arsenide", name: "Gallium arsenide", category: "semiconductor", density: 5320 },
  { id: "payload-rubber", name: "Natural rubber", category: "rubber", density: 930 },
  { id: "payload-neoprene", name: "Neoprene", category: "rubber", density: 1230 },
  { id: "payload-silicone-rubber", name: "Silicone rubber", category: "rubber", density: 1130 },
  { id: "payload-tpu", name: "TPU", category: "rubber", density: 1200 },
  { id: "payload-oak", name: "Oak", category: "wood", density: 750 },
  { id: "payload-maple", name: "Maple", category: "wood", density: 700 },
  { id: "payload-pine", name: "Pine", category: "wood", density: 500 },
  { id: "payload-birch-plywood", name: "Birch plywood", category: "wood", density: 680 },
  { id: "payload-mdf", name: "MDF", category: "wood", density: 750 },
  { id: "payload-concrete", name: "Concrete", category: "concrete-stone", density: 2400 },
  { id: "payload-granite", name: "Granite", category: "concrete-stone", density: 2700 },
  { id: "payload-marble", name: "Marble", category: "concrete-stone", density: 2650 },
  { id: "payload-brick", name: "Brick", category: "concrete-stone", density: 1900 },
  { id: "payload-water", name: "Water", category: "liquid", density: 1000 },
  { id: "payload-oil", name: "Mineral oil", category: "liquid", density: 850 },
  { id: "payload-gasoline", name: "Gasoline", category: "liquid", density: 740 },
  { id: "payload-ethanol", name: "Ethanol", category: "liquid", density: 789 },
  { id: "payload-paper", name: "Paper/cardboard", category: "misc", density: 700 },
  { id: "payload-ice", name: "Ice", category: "misc", density: 917 },
  { id: "payload-foam-eps", name: "EPS foam", category: "misc", density: 30 }
];

export function payloadMaterialForId(materialId: string): PayloadMaterial {
  return payloadMaterials.find((material) => material.id === materialId) ?? payloadMaterials[0]!;
}

export function massKgForPayloadMaterial(materialId: string, volumeM3: number): number {
  const volume = Number(volumeM3);
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  return payloadMaterialForId(materialId).density * volume;
}

export interface ManufacturingParameters extends Record<string, unknown> {
  manufacturingProcessId?: ManufacturingProcessId;
  printed?: boolean;
  infillDensity?: number;
  wallCount?: number;
  layerOrientation?: "x" | "y" | "z";
}

export type PrintMaterialParameters = ManufacturingParameters;

export interface PrintStrengthContext {
  criticalLayerAxis?: "x" | "y" | "z";
  /** Legacy/testing override for the interlayer strength factor. */
  criticalLayerFactor?: number;
}

export type FdmLoadPathRelation = "within_layers" | "across_layers" | "conservative";

export interface FdmPropertyFactors {
  buildAxis: "x" | "y" | "z";
  criticalAxis?: "x" | "y" | "z";
  loadPathRelation: FdmLoadPathRelation;
  shellShare: number;
  relativeDensity: number;
  stiffnessFillFactor: number;
  strengthFillFactor: number;
  modulusDirectionFactor: number;
  strengthDirectionFactor: number;
}

export function manufacturingProcessForId(processId: ManufacturingProcessId): ManufacturingProcess | undefined {
  return manufacturingProcessById.get(processId);
}

export function materialManufacturingProfilesFor(material: Material | string): MaterialManufacturingProfile[] {
  const materialId = typeof material === "string" ? material : material.id;
  const configured = manufacturingProfilesByMaterialId[materialId];
  if (configured) return configured.map((profile) => ({ ...profile }));
  if (typeof material === "string" || !material.printProfile) return [];
  const processId = legacyManufacturingProcessId(material.printProfile.process);
  if (!processId) return [];
  const profile = material.printProfile;
  const additive = {
    processId,
    defaultInfillDensity: profile.defaultInfillDensity,
    defaultWallCount: profile.defaultWallCount,
    defaultLayerOrientation: profile.defaultLayerOrientation,
    layerStrengthFactor: profile.layerStrengthFactor,
    inPlaneModulusFactor: profile.inPlaneModulusFactor,
    interlayerModulusFactor: profile.interlayerModulusFactor,
    inPlaneStrengthFactor: profile.inPlaneStrengthFactor,
    interlayerStrengthFactor: profile.interlayerStrengthFactor
  } satisfies MaterialManufacturingProfile;
  // A caller-provided material definition can still describe solid stock; its
  // printProfile adds an additive option rather than making printing mandatory.
  return [bulkProfile("cnc_machining"), additive];
}

export function compatibleManufacturingProcessesFor(material: Material | string): ManufacturingProcess[] {
  return materialManufacturingProfilesFor(material).flatMap((profile) => {
    const process = manufacturingProcessForId(profile.processId);
    return process ? [process] : [];
  });
}

export function isManufacturingProcessCompatible(material: Material | string, processId: ManufacturingProcessId): boolean {
  return materialManufacturingProfilesFor(material).some((profile) => profile.processId === processId);
}

export function manufacturingProcessCompatibilityError(materialId: string, processId: unknown): string | null {
  const material = starterMaterials.find((candidate) => candidate.id === materialId);
  if (!material) return `Unknown material ${materialId}.`;
  if (!isManufacturingProcessId(processId)) return "Choose a recognized manufacturing process.";
  if (isManufacturingProcessCompatible(material, processId)) return null;
  const process = manufacturingProcessForId(processId)!;
  if (processId === "sla" && material.category !== "resin") {
    return `SLA printing uses photopolymer resin, so it is not compatible with ${material.name}.`;
  }
  return `${process.label} does not have a validated material profile for ${material.name}.`;
}

export function assertCompatibleManufacturingProcess(materialId: string, processId: unknown): asserts processId is ManufacturingProcessId {
  const error = manufacturingProcessCompatibilityError(materialId, processId);
  if (error) throw new Error(error);
}

export function materialCategoryLabel(material: Material): string {
  if (material.category === "metal") return "Engineering metal";
  if (material.category === "plastic") return "Thermoplastic";
  if (material.category === "composite") return "Composite";
  if (material.category === "resin") return "Photopolymer resin";
  return "Engineering material";
}

export function defaultManufacturingProcessIdFor(material: Material, parameters: Record<string, unknown> = {}): ManufacturingProcessId {
  const profiles = materialManufacturingProfilesFor(material);
  if (profiles.length === 0) return "cnc_machining";
  const explicit = parameters.manufacturingProcessId;
  if (isManufacturingProcessId(explicit) && isManufacturingProcessCompatible(material, explicit)) return explicit;

  if (parameters.printed === false) {
    const nonAdditive = profiles.find((profile) => manufacturingProcessForId(profile.processId)?.kind !== "additive");
    if (nonAdditive) return nonAdditive.processId;
  }

  const legacyProcessId = legacyManufacturingProcessId(material.printProfile?.process);
  if (legacyProcessId && isManufacturingProcessCompatible(material, legacyProcessId)) return legacyProcessId;
  return profiles[0]!.processId;
}

export function defaultManufacturingParametersFor(material: Material, processId?: ManufacturingProcessId): ManufacturingParameters {
  const selectedProcessId = processId && isManufacturingProcessCompatible(material, processId)
    ? processId
    : defaultManufacturingProcessIdFor(material);
  const profile = materialManufacturingProfileFor(material, selectedProcessId);
  const process = manufacturingProcessForId(selectedProcessId);
  return {
    manufacturingProcessId: selectedProcessId,
    printed: process?.kind === "additive",
    infillDensity: profile?.defaultInfillDensity ?? 100,
    wallCount: profile?.defaultWallCount ?? 1,
    layerOrientation: profile?.defaultLayerOrientation ?? "z"
  };
}

export function defaultPrintParametersFor(material: Material): PrintMaterialParameters {
  return defaultManufacturingParametersFor(material);
}

export function effectiveMaterialProperties(material: Material, parameters: Record<string, unknown> = {}, context: PrintStrengthContext = {}): Material {
  const settings = normalizeManufacturingParameters(material, parameters);
  const processId = settings.manufacturingProcessId ?? defaultManufacturingProcessIdFor(material, parameters);
  const process = manufacturingProcessForId(processId);
  const profile = materialManufacturingProfileFor(material, processId);
  if (!process || !profile || process.kind !== "additive") return material;

  const fdm = fdmPropertyFactorsFor(material, settings, context);
  const directionSensitive = profile.layerStrengthFactor !== undefined && process.settingsKind !== "none";
  const unknownOrCriticalDirection = !context.criticalLayerAxis || context.criticalLayerAxis === settings.layerOrientation;
  const nonFdmLayerFactor = directionSensitive && unknownOrCriticalDirection
    ? context.criticalLayerFactor ?? profile.layerStrengthFactor ?? 1
    : 1;
  const stiffnessFactor = fdm
    ? clamp(fdm.stiffnessFillFactor * fdm.modulusDirectionFactor, 0.05, 1)
    : 1;
  const strengthFactor = fdm
    ? clamp(fdm.strengthFillFactor * fdm.strengthDirectionFactor, 0.05, 1)
    : clamp(nonFdmLayerFactor, 0.1, 1);
  const densityFactor = fdm ? fdm.relativeDensity : 1;

  return {
    ...material,
    youngsModulus: material.youngsModulus * stiffnessFactor,
    density: material.density * densityFactor,
    yieldStrength: material.yieldStrength * strengthFactor
  };
}

/**
 * Homogenized FDM response for the study's governing load path.
 *
 * The Core solver currently accepts one isotropic material per body, so the weak
 * interlayer axis is projected onto that governing path. The factors are deliberately
 * conservative engineering defaults and can be overridden by calibrated material
 * profiles; production allowables still require coupons made with the real printer,
 * filament, raster, layer height, and temperature.
 */
export function fdmPropertyFactorsFor(
  material: Material,
  parameters: Record<string, unknown> = {},
  context: PrintStrengthContext = {}
): FdmPropertyFactors | undefined {
  const settings = normalizeManufacturingParameters(material, parameters);
  if (settings.manufacturingProcessId !== "fdm") return undefined;
  const profile = materialManufacturingProfileFor(material, "fdm");
  if (!profile) return undefined;

  const infill = clamp((settings.infillDensity ?? 100) / 100, 0.01, 1);
  const wallCount = clamp(settings.wallCount ?? 3, 1, 12);
  const shellShare = clamp(0.12 + wallCount * 0.045, 0.16, 0.5);
  const relativeDensity = clamp(shellShare + (1 - shellShare) * infill, 0.01, 1);
  // Modulus is close to linear with infill; strength shows stronger diminishing
  // returns because solid perimeters keep carrying load at sparse infill.
  const stiffnessFillFactor = clamp(shellShare + (1 - shellShare) * infill ** 0.9, 0.01, 1);
  const strengthFillFactor = clamp(shellShare + (1 - shellShare) * infill ** 0.75, 0.01, 1);
  const buildAxis = settings.layerOrientation ?? "z";
  const loadPathRelation: FdmLoadPathRelation = !context.criticalLayerAxis
    ? "conservative"
    : context.criticalLayerAxis === buildAxis
      ? "across_layers"
      : "within_layers";
  const acrossLayers = loadPathRelation !== "within_layers";
  const inPlaneModulusFactor = profile.inPlaneModulusFactor ?? 0.9;
  const interlayerModulusFactor = Math.min(
    profile.interlayerModulusFactor ?? Math.min(0.65, inPlaneModulusFactor),
    inPlaneModulusFactor
  );
  const inPlaneStrengthFactor = profile.inPlaneStrengthFactor ?? profile.layerStrengthFactor ?? 0.72;
  const interlayerStrengthFactor = Math.min(
    profile.interlayerStrengthFactor ?? Math.min(clamp(inPlaneStrengthFactor * 0.5, 0.35, 0.4), inPlaneStrengthFactor),
    inPlaneStrengthFactor
  );
  const modulusDirectionFactor = acrossLayers
    ? interlayerModulusFactor
    : inPlaneModulusFactor;
  const strengthDirectionFactor = acrossLayers
    ? Math.min(context.criticalLayerFactor ?? interlayerStrengthFactor, inPlaneStrengthFactor)
    : inPlaneStrengthFactor;

  return {
    buildAxis,
    criticalAxis: context.criticalLayerAxis,
    loadPathRelation,
    shellShare,
    relativeDensity,
    stiffnessFillFactor,
    strengthFillFactor,
    modulusDirectionFactor,
    strengthDirectionFactor
  };
}

export function normalizeManufacturingParameters(material: Material, parameters: Record<string, unknown> = {}): ManufacturingParameters {
  const processId = defaultManufacturingProcessIdFor(material, parameters);
  const defaults = defaultManufacturingParametersFor(material, processId);
  const process = manufacturingProcessForId(processId);
  return {
    manufacturingProcessId: processId,
    printed: process?.kind === "additive",
    infillDensity: clamp(numberFrom(parameters.infillDensity, defaults.infillDensity ?? 100), 1, 100),
    wallCount: Math.round(clamp(numberFrom(parameters.wallCount, defaults.wallCount ?? 1), 1, 12)),
    layerOrientation: isLayerOrientation(parameters.layerOrientation) ? parameters.layerOrientation : defaults.layerOrientation
  };
}

export function manufacturingParametersForAssignment(material: Material, parameters: Record<string, unknown> = {}): ManufacturingParameters {
  const normalized = normalizeManufacturingParameters(material, parameters);
  const process = normalized.manufacturingProcessId ? manufacturingProcessForId(normalized.manufacturingProcessId) : undefined;
  const common: ManufacturingParameters = {
    manufacturingProcessId: normalized.manufacturingProcessId,
    printed: normalized.printed
  };
  if (process?.settingsKind === "fdm") return { ...common, infillDensity: normalized.infillDensity, wallCount: normalized.wallCount, layerOrientation: normalized.layerOrientation };
  if (process?.settingsKind === "build_direction") return { ...common, layerOrientation: normalized.layerOrientation };
  return common;
}

export function normalizePrintParameters(material: Material, parameters: Record<string, unknown> = {}): PrintMaterialParameters {
  return normalizeManufacturingParameters(material, parameters);
}

function materialManufacturingProfileFor(material: Material, processId: ManufacturingProcessId): MaterialManufacturingProfile | undefined {
  return materialManufacturingProfilesFor(material).find((profile) => profile.processId === processId);
}

function legacyManufacturingProcessId(process: "FDM" | "SLA" | "SLS" | "MJF" | "Metal AM" | undefined): ManufacturingProcessId | undefined {
  if (process === "FDM") return "fdm";
  if (process === "SLA") return "sla";
  if (process === "SLS") return "sls";
  if (process === "MJF") return "mjf";
  if (process === "Metal AM") return "metal_am";
  return undefined;
}

function isManufacturingProcessId(value: unknown): value is ManufacturingProcessId {
  return typeof value === "string" && manufacturingProcessById.has(value as ManufacturingProcessId);
}

function bulkProfile(processId: "cnc_machining" | "injection_molding"): MaterialManufacturingProfile {
  return { processId };
}

function additiveProfile(
  processId: Extract<ManufacturingProcessId, "fdm" | "sla" | "sls" | "mjf" | "metal_am">,
  defaultInfillDensity: number,
  defaultWallCount: number,
  layerStrengthFactor?: number
): MaterialManufacturingProfile {
  const profile: MaterialManufacturingProfile = {
    processId,
    defaultInfillDensity,
    defaultWallCount,
    defaultLayerOrientation: "z",
    ...(layerStrengthFactor === undefined ? {} : { layerStrengthFactor })
  };
  if (processId !== "fdm" || layerStrengthFactor === undefined) return profile;
  return {
    ...profile,
    inPlaneModulusFactor: 0.9,
    interlayerModulusFactor: 0.65,
    inPlaneStrengthFactor: layerStrengthFactor,
    interlayerStrengthFactor: clamp(layerStrengthFactor * 0.5, 0.35, 0.4)
  };
}

function fdmProfile(defaultInfillDensity: number, defaultWallCount: number, layerStrengthFactor: number): NonNullable<Material["printProfile"]> {
  return {
    process: "FDM",
    defaultInfillDensity,
    defaultWallCount,
    defaultLayerOrientation: "z",
    layerStrengthFactor,
    inPlaneModulusFactor: 0.9,
    interlayerModulusFactor: 0.65,
    inPlaneStrengthFactor: layerStrengthFactor,
    interlayerStrengthFactor: clamp(layerStrengthFactor * 0.5, 0.35, 0.4)
  };
}

function isLayerOrientation(value: unknown): value is "x" | "y" | "z" {
  return value === "x" || value === "y" || value === "z";
}

function numberFrom(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
