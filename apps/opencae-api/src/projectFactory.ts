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

export function createBlankProject(options: { projectId: string; studyId: string; name?: string; now: string }): Project {
  const projectId = options.projectId;
  return {
    id: projectId,
    name: options.name ?? "Untitled Project",
    schemaVersion: bracketDemoProject.schemaVersion,
    unitSystem: "SI",
    geometryFiles: [],
    studies: [{
      id: options.studyId,
      projectId,
      name: "Static Stress",
      type: "static_stress",
      geometryScope: [],
      materialAssignments: [],
      namedSelections: [],
      contacts: [],
      constraints: [],
      loads: [],
      meshSettings: {
        preset: "medium",
        status: "not_started"
      },
      solverSettings: {
        analysisType: "linear_static",
        smallDisplacement: true
      },
      validation: [],
      runs: []
    }],
    createdAt: options.now,
    updatedAt: options.now
  };
}

export function blankDisplayModel(): DisplayModel {
  return {
    id: "display-blank",
    name: "No model loaded",
    bodyCount: 0,
    faces: []
  };
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
  const bodySelection = templateStudy.namedSelections.find((selection) => selection.entityType === "body");
  const faceSelections = displayModel.faces.map((face) => {
    const templateSelection = templateStudy.namedSelections.find((selection) => selection.geometryRefs[0]?.entityId === face.id);
    const selectionId = templateSelection?.id ?? `selection-${face.id}`;
    return {
      ...(templateSelection ?? {
        id: selectionId,
        entityType: "face" as const,
        geometryRefs: []
      }),
      id: selectionId,
      name: selectionNames[selectionId] ?? face.label,
      entityType: "face" as const,
      geometryRefs: [{ bodyId: "body-bracket", entityType: "face" as const, entityId: face.id, label: face.label }],
      fingerprint: `${face.id}-${sampleId}-v1`
    };
  });
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
        metadata: { ...geometry.metadata, sampleModel: sampleId, displayModelRef: `${projectId}/geometry/${sampleId}-display.json`, faceCount: displayModel.faces.length }
      }]
      : [],
    studies: [{
      ...templateStudy,
      id: studyId,
      projectId,
      name: "Static Stress",
      geometryScope: templateStudy.geometryScope.map((scope) => ({ ...scope, label: meta.modelName })),
      namedSelections: [
        ...(bodySelection
          ? [{
            ...bodySelection,
            name: `${meta.modelName} body`,
            geometryRefs: bodySelection.geometryRefs.map((ref) => ({ ...ref, label: meta.modelName }))
          }]
          : []),
        ...faceSelections
      ],
      runs: options.includeSeedRun ? templateStudy.runs : []
    }],
    createdAt: options.now,
    updatedAt: options.now
  };
}

export function sampleDisplayModelFor(sampleId: SampleModelId): DisplayModel {
  const meta = SAMPLE_META[sampleId];
  const facesBySample: Record<SampleModelId, DisplayModel["faces"]> = {
    bracket: [
      ...bracketDisplayModel.faces,
      { id: "face-upright-front", label: "Upright front face", color: "#64748b", center: [-1.18, 1.42, 0.58], normal: [0, 0, 1], stressValue: 78 },
      { id: "face-upright-left", label: "Upright outer side", color: "#64748b", center: [-1.57, 1.18, 0], normal: [-1, 0, 0], stressValue: 68 },
      { id: "face-upright-right", label: "Upright inner side", color: "#64748b", center: [-0.76, 1.22, 0], normal: [1, 0, 0], stressValue: 86 },
      { id: "face-base-front", label: "Base front face", color: "#64748b", center: [0.68, -0.24, 0.58], normal: [0, -1, 0], stressValue: 52 },
      { id: "face-base-end", label: "Base end face", color: "#64748b", center: [2.36, 0, 0], normal: [1, 0, 0], stressValue: 44 },
      { id: "face-rib-side", label: "Rib side face", color: "#22c55e", center: [-0.26, 0.78, 0.22], normal: [0, 0, 1], stressValue: 92 }
    ],
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
