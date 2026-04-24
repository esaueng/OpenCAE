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
  const displayModel = sampleDisplayModelFor(sampleId);
  const faceLabels = new Map(displayModel.faces.map((face) => [face.id, face.label]));
  const selectionNames: Record<string, string> = {
    "selection-body-bracket": `${meta.modelName} body`,
    "selection-fixed-face": faceLabels.get("face-base-left") ?? "Fixed face",
    "selection-load-face": faceLabels.get("face-load-top") ?? "Load face",
    "selection-web-face": faceLabels.get("face-web-front") ?? "Feature face",
    "selection-base-face": faceLabels.get("face-base-bottom") ?? "Base face"
  };
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
      geometryScope: templateStudy.geometryScope.map((scope) => ({ ...scope, label: meta.modelName })),
      namedSelections: templateStudy.namedSelections.map((selection) => {
        const faceId = selection.geometryRefs[0]?.entityId;
        return {
          ...selection,
          name: selectionNames[selection.id] ?? selection.name,
          geometryRefs: selection.geometryRefs.map((ref) => ({
            ...ref,
            label: ref.entityType === "body" ? meta.modelName : faceLabels.get(ref.entityId) ?? ref.label
          })),
          fingerprint: faceId ? `${faceId}-${sampleId}-v1` : selection.fingerprint
        };
      }),
      runs: options.includeSeedRun ? templateStudy.runs : []
    }],
    createdAt: options.now,
    updatedAt: options.now
  };
}

export function sampleDisplayModelFor(sampleId: SampleModelId): DisplayModel {
  const meta = SAMPLE_META[sampleId];
  const facesBySample: Record<SampleModelId, DisplayModel["faces"]> = {
    bracket: bracketDisplayModel.faces,
    plate: [
      { id: "face-base-left", label: "Left clamp face", color: "#4da3ff", center: [-1.45, 0.0, 0.17], normal: [0, 0, 1], stressValue: 42 },
      { id: "face-load-top", label: "Right load pad", color: "#f59e0b", center: [1.42, 0.0, 0.17], normal: [0, 0, 1], stressValue: 118 },
      { id: "face-web-front", label: "Hole rim region", color: "#22c55e", center: [0.0, 0.0, 0.2], normal: [0, 0, 1], stressValue: 84 },
      { id: "face-base-bottom", label: "Plate top face", color: "#8b949e", center: [0.0, 0.0, 0.18], normal: [0, 0, 1], stressValue: 58 }
    ],
    cantilever: [
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.8, 0.18, 0], normal: [-1, 0, 0], stressValue: 132 },
      { id: "face-load-top", label: "Free end load face", color: "#f59e0b", center: [1.75, 0.18, 0], normal: [1, 0, 0], stressValue: 96 },
      { id: "face-web-front", label: "Top beam face", color: "#22c55e", center: [0.0, 0.42, 0], normal: [0, 1, 0], stressValue: 74 },
      { id: "face-base-bottom", label: "Beam bottom face", color: "#8b949e", center: [0.0, -0.08, 0], normal: [0, -1, 0], stressValue: 46 }
    ]
  };
  return {
    ...bracketDisplayModel,
    id: `display-${sampleId}`,
    name: meta.displayName,
    faces: facesBySample[sampleId]
  };
}

export function sampleProjectName(sampleId: SampleModelId): string {
  return SAMPLE_META[sampleId].projectName;
}
