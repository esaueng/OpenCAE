import { starterMaterials } from "@opencae/materials";
import type { Load, Material, Study } from "@opencae/schema";

export const STANDARD_GRAVITY = 9.80665;

export function loadForceNewtons(load: Load, fallbackMassKg = 0): number {
  if (load.type === "gravity") {
    const equivalentForce = Number(load.parameters.equivalentForceN);
    if (Number.isFinite(equivalentForce) && equivalentForce > 0) return equivalentForce;
  }
  const rawValue = Number(load.parameters.value ?? 0);
  const value = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 0;
  if (load.type === "gravity" && load.parameters.units === "kg") {
    return (value || fallbackMassKg) * STANDARD_GRAVITY;
  }
  return value;
}

export function materialForStudy(study: Study): Material {
  const assignment = study.materialAssignments[0];
  if (!assignment) return starterMaterials[0]!;
  const material = starterMaterials.find((candidate) => candidate.id === assignment.materialId);
  if (!material) throw new Error(`Local solver requires an assigned material. Unknown material "${assignment.materialId}".`);
  return material;
}

export function materialParametersForStudy(study: Study): Record<string, unknown> {
  return study.materialAssignments[0]?.parameters ?? {};
}
