import type { Diagnostic, Study } from "@opencae/schema";

export function validateStaticStressStudy(study: Study): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (study.materialAssignments.length === 0) diagnostics.push(issue("validation-material", "Choose what the part is made of."));
  if (study.constraints.length === 0) diagnostics.push(issue("validation-support", "Choose where the part is held fixed."));
  if (study.loads.length === 0) diagnostics.push(issue("validation-load", "Choose where force, pressure, or payload weight is applied."));
  for (const load of study.loads) {
    const selection = study.namedSelections.find((item) => item.id === load.selectionRef);
    if (!selection || selection.entityType !== "face") {
      diagnostics.push(issue(`validation-load-selection-${load.id}`, `Load ${load.id} must reference a face selection.`));
    }
    if (!isPositiveFinite(load.parameters.value)) {
      diagnostics.push(issue(`validation-load-value-${load.id}`, `Load ${load.id} needs a positive finite magnitude.`));
    }
    if (!isDirection(load.parameters.direction)) {
      diagnostics.push(issue(`validation-load-direction-${load.id}`, `Load ${load.id} needs a 3D direction vector.`));
    }
  }
  if (study.meshSettings.status !== "complete") diagnostics.push(issue("validation-mesh", "Generate the mesh before running."));
  return diagnostics;
}

function issue(id: string, message: string): Diagnostic {
  return { id, severity: "warning", source: "validation", message, suggestedActions: [] };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isDirection(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}
