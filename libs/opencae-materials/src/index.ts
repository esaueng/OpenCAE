import type { Material } from "@opencae/schema";

export const starterMaterials: Material[] = [
  { id: "mat-aluminum-6061", name: "Aluminum 6061", youngsModulus: 68900000000, poissonRatio: 0.33, density: 2700, yieldStrength: 276000000 },
  { id: "mat-aluminum-7075", name: "Aluminum 7075", youngsModulus: 71700000000, poissonRatio: 0.33, density: 2810, yieldStrength: 503000000 },
  { id: "mat-steel", name: "Steel", youngsModulus: 200000000000, poissonRatio: 0.29, density: 7850, yieldStrength: 250000000 },
  { id: "mat-stainless-304", name: "Stainless Steel 304", youngsModulus: 193000000000, poissonRatio: 0.29, density: 8000, yieldStrength: 215000000 },
  { id: "mat-titanium-grade-5", name: "Titanium Grade 5", youngsModulus: 114000000000, poissonRatio: 0.34, density: 4430, yieldStrength: 880000000 },
  { id: "mat-copper", name: "Copper", youngsModulus: 117000000000, poissonRatio: 0.34, density: 8960, yieldStrength: 70000000 },
  { id: "mat-brass", name: "Brass", youngsModulus: 100000000000, poissonRatio: 0.34, density: 8530, yieldStrength: 200000000 },
  { id: "mat-abs", name: "ABS Plastic", youngsModulus: 2100000000, poissonRatio: 0.35, density: 1040, yieldStrength: 40000000 },
  { id: "mat-pla", name: "PLA Plastic", youngsModulus: 3500000000, poissonRatio: 0.36, density: 1240, yieldStrength: 60000000 },
  { id: "mat-nylon", name: "Nylon", youngsModulus: 2800000000, poissonRatio: 0.39, density: 1150, yieldStrength: 70000000 },
  { id: "mat-polycarbonate", name: "Polycarbonate", youngsModulus: 2400000000, poissonRatio: 0.37, density: 1200, yieldStrength: 65000000 }
];
