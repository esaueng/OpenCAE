import type { Study } from "@opencae/schema";

/**
 * What replacing the geometry throws away (2026-09 review D5).
 *
 * `attachUploadedModelToProject` resets material assignments, supports, loads,
 * the mesh and the run history, and `openProjectResponse` clears undo. Before
 * this list existed a click on "Add to project" or "Replace model" discarded
 * all of it with no confirmation.
 */
export function geometryReplacementLosses(study: Study | null | undefined, hasResults: boolean): string[] {
  if (!study) return [];
  const losses: string[] = [];
  const count = (n: number, singular: string, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
  if (study.materialAssignments.length) losses.push(count(study.materialAssignments.length, "material assignment"));
  if (study.constraints.length) losses.push(count(study.constraints.length, study.type === "steady_state_thermal" ? "temperature boundary" : "support", study.type === "steady_state_thermal" ? "temperature boundaries" : "supports"));
  if (study.loads.length) losses.push(count(study.loads.length, "load"));
  if (study.meshSettings.status === "complete") losses.push("the generated mesh");
  if (hasResults) losses.push("the current results");
  return losses;
}

export function formatGeometryReplacementLosses(losses: readonly string[]): string {
  if (losses.length === 0) return "";
  if (losses.length === 1) return losses[0]!;
  return `${losses.slice(0, -1).join(", ")} and ${losses[losses.length - 1]}`;
}
