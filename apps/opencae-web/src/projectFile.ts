import type { DisplayModel, Project, ResultField, ResultSummary } from "@opencae/schema";

export interface LocalResultBundle {
  activeRunId?: string;
  completedRunId?: string;
  summary: ResultSummary;
  fields: ResultField[];
}

export interface LocalProjectFile {
  format: "opencae-local-project";
  version: 2;
  savedAt: string;
  project: Project;
  displayModel: DisplayModel;
  results?: LocalResultBundle;
}

export function buildLocalProjectFile(
  project: Project,
  displayModel: DisplayModel,
  savedAt = new Date().toISOString(),
  results?: LocalResultBundle
): LocalProjectFile {
  return {
    format: "opencae-local-project",
    version: 2,
    savedAt,
    project: { ...project, updatedAt: savedAt },
    displayModel,
    ...(results ? { results } : {})
  };
}

export function suggestedProjectFilename(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "opencae-project"}.opencae.json`;
}
