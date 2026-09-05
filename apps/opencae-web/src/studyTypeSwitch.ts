import type { Study } from "@opencae/schema";

export const STUDY_TYPE_LABELS: Record<Study["type"], string> = {
  static_stress: "Static",
  dynamic_structural: "Dynamic",
  modal_analysis: "Modal",
  steady_state_thermal: "Thermal"
};

export interface StudyTypeSwitchConsequence {
  supports: number;
  loads: number;
  message: string;
}

/**
 * What handleChangeStudyType (WorkspaceApp) will discard if the study switches
 * to `target`. Structural ↔ thermal clears every support/boundary and load in
 * either direction; switches among the structural types keep them (modal
 * merely ignores loads). Returns null when nothing is lost, so callers can
 * switch without ceremony.
 */
export function studyTypeSwitchConsequence(
  study: Pick<Study, "type" | "constraints" | "loads">,
  target: Study["type"]
): StudyTypeSwitchConsequence | null {
  if (study.type === target) return null;
  const leavingThermal = study.type === "steady_state_thermal";
  if (leavingThermal === (target === "steady_state_thermal")) return null;
  const supports = study.constraints.length;
  const loads = study.loads.length;
  if (supports + loads === 0) return null;
  const parts: string[] = [];
  if (supports) parts.push(`${supports} ${leavingThermal ? (supports === 1 ? "thermal boundary" : "thermal boundaries") : (supports === 1 ? "support" : "supports")}`);
  if (loads) parts.push(`${loads} ${loads === 1 ? "load" : "loads"}`);
  return { supports, loads, message: `Switching to ${STUDY_TYPE_LABELS[target]} clears ${parts.join(" and ")}.` };
}
