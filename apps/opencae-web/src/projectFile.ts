import type { DisplayModel, Project, ResultField, ResultSummary } from "@opencae/schema";

export interface EmbeddedModelFile {
  filename: string;
  contentType: string;
  size: number;
  contentBase64: string;
}

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
  const projectWithEmbeddedModel = embedDisplayModelFileIfNeeded(project, displayModel);
  return {
    format: "opencae-local-project",
    version: 2,
    savedAt,
    project: { ...projectWithEmbeddedModel, updatedAt: savedAt },
    displayModel,
    ...(results ? { results } : {})
  };
}

export function embedUploadedModelFile(project: Project, embeddedModel: EmbeddedModelFile): Project {
  const targetIndex = project.geometryFiles.findIndex((geometry) =>
    geometry.filename === embeddedModel.filename && geometry.metadata.source === "local-upload"
  );
  const fallbackIndex = project.geometryFiles.findIndex((geometry) => geometry.metadata.source === "local-upload");
  const geometryIndex = targetIndex >= 0 ? targetIndex : fallbackIndex;
  if (geometryIndex < 0) return project;

  return {
    ...project,
    geometryFiles: project.geometryFiles.map((geometry, index) =>
      index === geometryIndex
        ? {
            ...geometry,
            metadata: {
              ...geometry.metadata,
              embeddedModel
            }
          }
        : geometry
    )
  };
}

function embedDisplayModelFileIfNeeded(project: Project, displayModel: DisplayModel): Project {
  const sourceFile = displayModel.visualMesh ?? (displayModel.nativeCad?.contentBase64 ? displayModel.nativeCad : undefined);
  if (!sourceFile?.contentBase64) return project;

  const geometry = project.geometryFiles.find((item) => item.filename === sourceFile.filename && item.metadata.source === "local-upload")
    ?? project.geometryFiles.find((item) => item.metadata.source === "local-upload");
  if (!geometry || hasEmbeddedModelFile(geometry.metadata.embeddedModel)) return project;

  return embedUploadedModelFile(project, {
    filename: sourceFile.filename,
    contentType: typeof geometry.metadata.contentType === "string" ? geometry.metadata.contentType : contentTypeForFilename(sourceFile.filename),
    size: typeof geometry.metadata.originalSize === "number" ? geometry.metadata.originalSize : decodedBase64ByteLength(sourceFile.contentBase64),
    contentBase64: sourceFile.contentBase64
  });
}

function hasEmbeddedModelFile(value: unknown): value is EmbeddedModelFile {
  if (!value || typeof value !== "object") return false;
  const embedded = value as Partial<EmbeddedModelFile>;
  return (
    typeof embedded.filename === "string" &&
    typeof embedded.contentType === "string" &&
    typeof embedded.size === "number" &&
    typeof embedded.contentBase64 === "string" &&
    embedded.contentBase64.length > 0
  );
}

function contentTypeForFilename(filename: string): string {
  const extension = filename.trim().split(".").pop()?.toLowerCase();
  if (extension === "stl") return "model/stl";
  if (extension === "obj") return "model/obj";
  if (extension === "step" || extension === "stp") return "model/step";
  return "application/octet-stream";
}

function decodedBase64ByteLength(contentBase64: string): number {
  const normalized = contentBase64.trim();
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function suggestedProjectFilename(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "opencae-project"}.opencae.json`;
}
