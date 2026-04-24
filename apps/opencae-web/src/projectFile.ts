import type { DisplayModel, Project } from "@opencae/schema";

export interface LocalProjectFile {
  format: "opencae-local-project";
  version: 1;
  savedAt: string;
  project: Project;
  displayModel: DisplayModel;
}

export function buildLocalProjectFile(project: Project, displayModel: DisplayModel, savedAt = new Date().toISOString()): LocalProjectFile {
  return {
    format: "opencae-local-project",
    version: 1,
    savedAt,
    project: { ...project, updatedAt: savedAt },
    displayModel
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
