import type { Project } from "@opencae/schema";
import type { StepGeometryMetadata } from "./lib/api";

const STEP_GEOMETRY_STATUSES = new Set<StepGeometryMetadata["status"]>([
  "solid",
  "repairable",
  "unrepairable",
  "invalid",
  "unchecked",
  "repaired"
]);

export function stepGeometryMetadataForProject(project: Pick<Project, "geometryFiles"> | null | undefined): StepGeometryMetadata | null {
  const value = project?.geometryFiles.find((geometry) => geometry.metadata.source === "local-upload")?.metadata.stepGeometry;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StepGeometryMetadata>;
  if (typeof candidate.status !== "string" || !STEP_GEOMETRY_STATUSES.has(candidate.status as StepGeometryMetadata["status"])) return null;
  return {
    ...candidate,
    status: candidate.status as StepGeometryMetadata["status"],
    ...(typeof candidate.message === "string" ? { message: candidate.message } : { message: undefined })
  } as StepGeometryMetadata;
}

export function stepGeometryNeedsRepair(project: Pick<Project, "geometryFiles"> | null | undefined): boolean {
  const status = stepGeometryMetadataForProject(project)?.status;
  return status === "repairable" || status === "unrepairable" || status === "invalid";
}
