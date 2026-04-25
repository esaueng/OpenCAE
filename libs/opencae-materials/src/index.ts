import type { Material } from "@opencae/schema";

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
  { id: "mat-tpu-95a", name: "TPU 95A", category: "plastic", youngsModulus: 120000000, poissonRatio: 0.45, density: 1210, yieldStrength: 26000000, printProfile: fdmProfile(35, 3, 0.62) },
  { id: "mat-nylon", name: "Nylon", category: "plastic", youngsModulus: 2800000000, poissonRatio: 0.39, density: 1150, yieldStrength: 70000000, printProfile: fdmProfile(40, 3, 0.74) },
  { id: "mat-nylon-cf", name: "Carbon Fiber Nylon", category: "composite", youngsModulus: 7600000000, poissonRatio: 0.34, density: 1180, yieldStrength: 105000000, printProfile: fdmProfile(40, 4, 0.78) },
  { id: "mat-pa12-sls", name: "PA12 Nylon SLS", category: "plastic", youngsModulus: 1700000000, poissonRatio: 0.39, density: 1010, yieldStrength: 48000000, printProfile: { process: "SLS", defaultInfillDensity: 100, defaultWallCount: 2, defaultLayerOrientation: "z", layerStrengthFactor: 0.9 } },
  { id: "mat-polycarbonate", name: "Polycarbonate", category: "plastic", youngsModulus: 2400000000, poissonRatio: 0.37, density: 1200, yieldStrength: 65000000, printProfile: fdmProfile(40, 3, 0.74) },
  { id: "mat-pc-abs", name: "PC-ABS", category: "plastic", youngsModulus: 2300000000, poissonRatio: 0.36, density: 1150, yieldStrength: 56000000, printProfile: fdmProfile(40, 3, 0.72) },
  { id: "mat-peek", name: "PEEK", category: "plastic", youngsModulus: 3700000000, poissonRatio: 0.4, density: 1300, yieldStrength: 97000000, printProfile: fdmProfile(50, 4, 0.78) },
  { id: "mat-sla-tough-resin", name: "Tough Resin", category: "resin", youngsModulus: 2800000000, poissonRatio: 0.38, density: 1180, yieldStrength: 55000000, printProfile: { process: "SLA", defaultInfillDensity: 100, defaultWallCount: 1, defaultLayerOrientation: "z", layerStrengthFactor: 0.86 } },
  { id: "mat-sla-standard-resin", name: "Standard Resin", category: "resin", youngsModulus: 2200000000, poissonRatio: 0.38, density: 1120, yieldStrength: 42000000, printProfile: { process: "SLA", defaultInfillDensity: 100, defaultWallCount: 1, defaultLayerOrientation: "z", layerStrengthFactor: 0.82 } },
  { id: "mat-316l-am", name: "316L Stainless AM", category: "metal", youngsModulus: 180000000000, poissonRatio: 0.3, density: 7900, yieldStrength: 470000000, printProfile: { process: "Metal AM", defaultInfillDensity: 100, defaultWallCount: 1, defaultLayerOrientation: "z", layerStrengthFactor: 0.92 } }
];

export interface PrintMaterialParameters {
  printed?: boolean;
  infillDensity?: number;
  wallCount?: number;
  layerOrientation?: "x" | "y" | "z";
}

export function defaultPrintParametersFor(material: Material): PrintMaterialParameters {
  return {
    printed: Boolean(material.printProfile),
    infillDensity: material.printProfile?.defaultInfillDensity ?? 100,
    wallCount: material.printProfile?.defaultWallCount ?? 1,
    layerOrientation: material.printProfile?.defaultLayerOrientation ?? "z"
  };
}

export function effectiveMaterialProperties(material: Material, parameters: Record<string, unknown> = {}): Material {
  const printSettings = normalizePrintParameters(material, parameters);
  if (!material.printProfile || !printSettings.printed) return material;

  const infill = clamp((printSettings.infillDensity ?? 100) / 100, 0.05, 1);
  const wallCount = clamp(printSettings.wallCount ?? 3, 1, 12);
  const shellShare = clamp(0.12 + wallCount * 0.045, 0.16, 0.5);
  const sectionFill = clamp(shellShare + (1 - shellShare) * infill, 0.05, 1);
  const layerFactor = printSettings.layerOrientation === "z" ? material.printProfile.layerStrengthFactor ?? 0.72 : 0.9;
  const stiffnessFactor = clamp(0.18 + 0.82 * sectionFill ** 1.35, 0.08, 1);
  const strengthFactor = clamp((0.25 + 0.75 * sectionFill ** 1.15) * layerFactor, 0.08, 1);
  const densityFactor = clamp(0.18 + 0.82 * sectionFill, 0.08, 1);

  return {
    ...material,
    youngsModulus: material.youngsModulus * stiffnessFactor,
    density: material.density * densityFactor,
    yieldStrength: material.yieldStrength * strengthFactor
  };
}

export function normalizePrintParameters(material: Material, parameters: Record<string, unknown> = {}): PrintMaterialParameters {
  const defaults = defaultPrintParametersFor(material);
  return {
    printed: typeof parameters.printed === "boolean" ? parameters.printed : defaults.printed,
    infillDensity: clamp(numberFrom(parameters.infillDensity, defaults.infillDensity ?? 100), 1, 100),
    wallCount: Math.round(clamp(numberFrom(parameters.wallCount, defaults.wallCount ?? 1), 1, 12)),
    layerOrientation: isLayerOrientation(parameters.layerOrientation) ? parameters.layerOrientation : defaults.layerOrientation
  };
}

function fdmProfile(defaultInfillDensity: number, defaultWallCount: number, layerStrengthFactor: number): NonNullable<Material["printProfile"]> {
  return { process: "FDM", defaultInfillDensity, defaultWallCount, defaultLayerOrientation: "z", layerStrengthFactor };
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
