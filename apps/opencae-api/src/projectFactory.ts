import type { DisplayModel, Project } from "@opencae/schema";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/db/sample-data";

export type SampleModelId = "bracket" | "plate" | "cantilever";

const SAMPLE_META: Record<SampleModelId, { projectName: string; modelName: string; filename: string; displayName: string }> = {
  bracket: {
    projectName: "Bracket Demo",
    modelName: "Bracket",
    filename: "bracket-demo.step",
    displayName: "bracket demo body"
  },
  plate: {
    projectName: "Plate Demo",
    modelName: "Plate",
    filename: "plate-with-hole.step",
    displayName: "plate demo body"
  },
  cantilever: {
    projectName: "Cantilever Demo",
    modelName: "Cantilever",
    filename: "cantilever-beam.step",
    displayName: "cantilever demo body"
  }
};

export function normalizeSampleId(value: unknown): SampleModelId {
  return value === "plate" || value === "cantilever" ? value : "bracket";
}

export function createSampleProject(
  sampleId: SampleModelId,
  options: { projectId: string; studyId: string; name?: string; now: string; includeSeedRun: boolean }
): Project {
  const meta = SAMPLE_META[sampleId];
  const templateStudy = bracketDemoProject.studies[0];
  if (!templateStudy) throw new Error("Bracket demo study template is missing.");
  const geometry = bracketDemoProject.geometryFiles[0];
  const projectId = options.projectId;
  const studyId = options.studyId;
  return {
    ...bracketDemoProject,
    id: projectId,
    name: options.name ?? meta.projectName,
    geometryFiles: geometry
      ? [{
        ...geometry,
        id: `geom-${sampleId}-${projectId}`,
        projectId,
        filename: meta.filename,
        artifactKey: `${projectId}/geometry/${sampleId}-display.json`,
        metadata: { ...geometry.metadata, sampleModel: sampleId, displayModelRef: `${projectId}/geometry/${sampleId}-display.json` }
      }]
      : [],
    studies: [{
      ...templateStudy,
      id: studyId,
      projectId,
      name: "Static Stress",
      runs: options.includeSeedRun ? templateStudy.runs : []
    }],
    createdAt: options.now,
    updatedAt: options.now
  };
}

export function sampleDisplayModelFor(sampleId: SampleModelId): DisplayModel {
  const meta = SAMPLE_META[sampleId];
  return {
    ...bracketDisplayModel,
    id: `display-${sampleId}`,
    name: meta.displayName
  };
}

export function sampleProjectName(sampleId: SampleModelId): string {
  return SAMPLE_META[sampleId].projectName;
}
