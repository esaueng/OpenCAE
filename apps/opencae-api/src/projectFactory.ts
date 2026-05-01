import type { DisplayModel, Load, Project } from "@opencae/schema";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/db/sample-data";
import { stlDimensionsFromBase64 } from "@opencae/units";

export type SampleModelId = "bracket" | "plate" | "cantilever";
export type SampleAnalysisType = "static_stress" | "dynamic_structural";

const SAMPLE_META: Record<SampleModelId, { projectName: string; modelName: string; filename: string; displayName: string; dimensions: DisplayModel["dimensions"] }> = {
  bracket: {
    projectName: "Bracket Demo",
    modelName: "Bracket",
    filename: "bracket-demo.step",
    displayName: "bracket demo body",
    dimensions: { x: 120, y: 88, z: 34, units: "mm" }
  },
  plate: {
    projectName: "Beam Demo",
    modelName: "Beam",
    filename: "end-loaded-beam.step",
    displayName: "end loaded beam assembly",
    dimensions: { x: 160, y: 32, z: 36, units: "mm" }
  },
  cantilever: {
    projectName: "Cantilever Demo",
    modelName: "Cantilever",
    filename: "cantilever-beam.step",
    displayName: "cantilever demo body",
    dimensions: { x: 180, y: 24, z: 24, units: "mm" }
  }
};

export function normalizeSampleId(value: unknown): SampleModelId {
  return value === "plate" || value === "cantilever" ? value : "bracket";
}

export function normalizeSampleAnalysisType(value: unknown): SampleAnalysisType {
  return value === "dynamic_structural" ? "dynamic_structural" : "static_stress";
}

export function createBlankProject(options: { projectId: string; studyId: string; name?: string; now: string }): Project {
  const projectId = options.projectId;
  return {
    id: projectId,
    name: options.name ?? "Untitled Project",
    schemaVersion: bracketDemoProject.schemaVersion,
    unitSystem: "SI",
    geometryFiles: [],
    studies: [],
    createdAt: options.now,
    updatedAt: options.now
  };
}

export function createStaticStressStudy(project: Project, displayModel: DisplayModel, options: { studyId: string; now: string }): Project["studies"][number] {
  const geometry = project.geometryFiles[0];
  const modelName = geometry ? baseNameForModel(geometry.filename) : displayModel.name || "model";
  const bodyLabel = `${modelName} body`;
  return {
    id: options.studyId,
    projectId: project.id,
    name: "Static Stress",
    type: "static_stress",
    geometryScope: displayModel.bodyCount > 0
      ? [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: bodyLabel }]
      : [],
    materialAssignments: [],
    namedSelections: displayModel.bodyCount > 0 ? namedSelectionsForDisplayModel(bodyLabel, displayModel) : [],
    contacts: [],
    constraints: [],
    loads: [],
    meshSettings: {
      preset: "medium",
      status: "not_started"
    },
    solverSettings: {
      analysisType: "linear_static",
      smallDisplacement: true,
      createdAt: options.now
    },
    validation: [],
    runs: []
  };
}

export function createDynamicStructuralStudy(project: Project, displayModel: DisplayModel, options: { studyId: string; now: string }): Project["studies"][number] {
  const geometry = project.geometryFiles[0];
  const modelName = geometry ? baseNameForModel(geometry.filename) : displayModel.name || "model";
  const bodyLabel = `${modelName} body`;
  return {
    id: options.studyId,
    projectId: project.id,
    name: "Dynamic Structural",
    type: "dynamic_structural",
    geometryScope: displayModel.bodyCount > 0
      ? [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: bodyLabel }]
      : [],
    materialAssignments: [],
    namedSelections: displayModel.bodyCount > 0 ? namedSelectionsForDisplayModel(bodyLabel, displayModel) : [],
    contacts: [],
    constraints: [],
    loads: [],
    meshSettings: {
      preset: "medium",
      status: "not_started"
    },
    solverSettings: {
      startTime: 0,
      endTime: 0.1,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0.02,
      integrationMethod: "newmark_average_acceleration"
    },
    validation: [],
    runs: []
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

export function uploadedDisplayModelFor(filename: string, contentBase64?: string): DisplayModel {
  const modelName = baseNameForModel(filename);
  const nativeFormat = nativeCadFormatForFilename(filename);
  const previewFormat = previewFormatForFilename(filename);
  const dimensions = previewFormat === "stl"
    ? stlDimensionsFromBase64(contentBase64) ?? { x: 96, y: 48, z: 32, units: "mm" as const }
    : undefined;
  if (nativeFormat) {
    return {
      id: "display-uploaded",
      name: `${modelName} imported body`,
      bodyCount: 1,
      dimensions,
      faces: uploadedBoxFaces(),
      nativeCad: {
        format: nativeFormat,
        filename,
        contentBase64
      }
    };
  }

  if (!previewFormat || !contentBase64) {
    return {
      id: "display-uploaded",
      name: `${modelName} uploaded model`,
      bodyCount: 0,
      faces: []
    };
  }

  return {
    id: "display-uploaded",
    name: `${modelName} imported body`,
    bodyCount: 1,
    dimensions,
    faces: uploadedBoxFaces(),
    visualMesh: {
      format: previewFormat,
      filename,
      contentBase64
    }
  };
}

function uploadedBoxFaces(): DisplayModel["faces"] {
  return [
    { id: "face-upload-top", label: "Top face", color: "#f59e0b", center: [0, 0.72, 0], normal: [0, 1, 0], stressValue: 72 },
    { id: "face-upload-bottom", label: "Bottom face", color: "#4da3ff", center: [0, -0.72, 0], normal: [0, -1, 0], stressValue: 48 },
    { id: "face-upload-front", label: "Front face", color: "#22c55e", center: [0, 0, 0.52], normal: [0, 0, 1], stressValue: 64 },
    { id: "face-upload-back", label: "Back face", color: "#64748b", center: [0, 0, -0.52], normal: [0, 0, -1], stressValue: 54 },
    { id: "face-upload-left", label: "Left face", color: "#8b949e", center: [-1.1, 0, 0], normal: [-1, 0, 0], stressValue: 58 },
    { id: "face-upload-right", label: "Right face", color: "#8b949e", center: [1.1, 0, 0], normal: [1, 0, 0], stressValue: 84 }
  ];
}

function nativeCadFormatForFilename(filename: string): "step" | undefined {
  const extension = filename.trim().split(".").pop()?.toLowerCase();
  if (extension === "step" || extension === "stp") return "step";
  return undefined;
}


export function attachUploadedModelToProject(
  project: Project,
  options: { geometryId: string; filename: string; artifactKey: string; now: string; displayModel: DisplayModel }
): Project {
  const modelName = baseNameForModel(options.filename);
  const bodyLabel = `${modelName} body`;
  const studies = project.studies.map((study) => ({
    ...study,
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: bodyLabel }],
    materialAssignments: [],
    namedSelections: namedSelectionsForDisplayModel(bodyLabel, options.displayModel),
    constraints: [],
    loads: [],
    meshSettings: {
      ...study.meshSettings,
      status: "not_started" as const,
      meshRef: undefined,
      summary: undefined
    },
    runs: []
  }));
  return {
    ...project,
    geometryFiles: [{
      id: options.geometryId,
      projectId: project.id,
      filename: options.filename,
      localPath: `uploads/${options.filename}`,
      artifactKey: options.artifactKey,
      status: "ready",
      metadata: {
        source: "local-upload",
        nativeCadImport: Boolean(options.displayModel.nativeCad),
        displayModelRef: options.artifactKey,
        previewFormat: options.displayModel.visualMesh?.format ?? options.displayModel.nativeCad?.format,
        bodyCount: options.displayModel.bodyCount,
        faceCount: options.displayModel.faces.length
      }
    }],
    studies,
    updatedAt: options.now
  };
}

function namedSelectionsForDisplayModel(bodyLabel: string, displayModel: DisplayModel) {
  const bodySelection = {
    id: "selection-body-uploaded",
    name: bodyLabel,
    entityType: "body" as const,
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: bodyLabel }],
    fingerprint: `body-uploaded-${bodyLabel}`
  };
  const faceSelections = displayModel.faces.map((face) => ({
    id: `selection-${face.id}`,
    name: face.label,
    entityType: "face" as const,
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: face.id, label: face.label }],
    fingerprint: `${face.id}-${face.label}`
  }));
  return [bodySelection, ...faceSelections];
}

export function createSampleProject(
  sampleId: SampleModelId,
  options: { projectId: string; studyId: string; name?: string; now: string; includeSeedRun: boolean; analysisType?: SampleAnalysisType }
): Project {
  const analysisType = options.analysisType ?? "static_stress";
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
  const sampleStudyBase = {
    ...templateStudy,
    id: studyId,
    projectId,
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
    loads: sampleLoadsFor(sampleId, templateStudy.loads, displayModel, meta.displayName)
  };
  const sampleStudy: Project["studies"][number] = analysisType === "dynamic_structural"
    ? {
        ...sampleStudyBase,
        name: "Dynamic Structural",
        type: "dynamic_structural",
        solverSettings: {
          startTime: 0,
          endTime: 0.1,
          timeStep: 0.005,
          outputInterval: 0.005,
          dampingRatio: 0.02,
          integrationMethod: "newmark_average_acceleration"
        },
        runs: options.includeSeedRun ? sampleRunsFor(sampleId, analysisType, projectId, studyId, templateStudy.runs, options.now) : []
      }
    : {
        ...sampleStudyBase,
        name: "Static Stress",
        type: "static_stress",
        solverSettings: templateStudy.solverSettings,
        runs: options.includeSeedRun ? sampleRunsFor(sampleId, analysisType, projectId, studyId, templateStudy.runs, options.now) : []
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
        metadata: {
          ...geometry.metadata,
          source: "sample",
          sampleModel: sampleId,
          sampleAnalysisType: analysisType,
          displayModelRef: `${projectId}/geometry/${sampleId}-display.json`,
          faceCount: displayModel.faces.length
        }
      }]
      : [],
    studies: [sampleStudy],
    createdAt: options.now,
    updatedAt: options.now
  };
}

function sampleRunsFor(
  sampleId: SampleModelId,
  analysisType: SampleAnalysisType,
  projectId: string,
  studyId: string,
  staticTemplateRuns: NonNullable<Project["studies"][number]>["runs"],
  now: string
) {
  if (analysisType === "static_stress") {
    return staticTemplateRuns.map((run) => ({ ...run, studyId }));
  }
  const runId = `run-${sampleId}-dynamic-seeded`;
  return [{
    id: runId,
    studyId,
    status: "complete" as const,
    jobId: `job-${sampleId}-dynamic-seeded`,
    meshRef: `${projectId}/mesh/mesh-summary.json`,
    resultRef: `${projectId}/results/${runId}/results.json`,
    reportRef: `${projectId}/reports/${runId}/report.html`,
    solverBackend: "local-dynamic-newmark",
    solverVersion: "0.1.0",
    startedAt: now,
    finishedAt: now,
    diagnostics: []
  }];
}

export function sampleDisplayModelFor(sampleId: SampleModelId): DisplayModel {
  const meta = SAMPLE_META[sampleId];
  const facesBySample: Record<SampleModelId, DisplayModel["faces"]> = {
    bracket: [
      ...bracketDisplayModel.faces,
      { id: "face-upright-hole", label: "Upright through hole", color: "#4da3ff", center: [-1.2, 1.48, 0.58], normal: [0, 0, 1], stressValue: 76 },
      { id: "face-upright-front", label: "Upright front face", color: "#64748b", center: [-1.18, 1.42, 0.58], normal: [0, 0, 1], stressValue: 78 },
      { id: "face-upright-left", label: "Upright outer side", color: "#64748b", center: [-1.57, 1.18, 0], normal: [-1, 0, 0], stressValue: 68 },
      { id: "face-upright-right", label: "Upright inner side", color: "#64748b", center: [-0.76, 1.22, 0], normal: [1, 0, 0], stressValue: 86 },
      { id: "face-base-front", label: "Base front face", color: "#64748b", center: [0.68, -0.24, 0.58], normal: [0, -1, 0], stressValue: 52 },
      { id: "face-base-end", label: "Base end face", color: "#64748b", center: [2.36, 0, 0], normal: [1, 0, 0], stressValue: 44 },
      { id: "face-rib-side", label: "Rib side face", color: "#22c55e", center: [-0.26, 0.78, 0.22], normal: [0, 0, 1], stressValue: 92 }
    ],
    plate: [
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.82, 0.14, 0], normal: [-1, 0, 0], stressValue: 82 },
      { id: "face-load-top", label: "End payload mass", color: "#f59e0b", center: [1.48, 0.56, 0], normal: [0, 1, 0], stressValue: 118 },
      { id: "face-web-front", label: "Beam top face", color: "#22c55e", center: [0.0, 0.38, 0], normal: [0, 1, 0], stressValue: 92 },
      { id: "face-base-bottom", label: "Beam body", color: "#8b949e", center: [0.0, 0.14, 0.0], normal: [0, 0, 1], stressValue: 58 }
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
    dimensions: meta.dimensions,
    faces: facesBySample[sampleId]
  };
}

function sampleLoadsFor(sampleId: SampleModelId, templateLoads: Load[], displayModel: DisplayModel, payloadLabel: string): Load[] {
  if (sampleId === "cantilever") {
    const loadFace = displayModel.faces.find((face) => face.id === "face-load-top");
    return templateLoads.map((load) => load.selectionRef === "selection-load-face"
      ? {
          ...load,
          type: "force",
          parameters: {
            ...load.parameters,
            value: 500,
            units: "N",
            direction: [0, 0, -1],
            applicationPoint: loadFace?.center ?? [1.75, 0.18, 0]
          },
          status: "complete"
        }
      : load);
  }
  if (sampleId !== "plate") return templateLoads;
  const payloadFace = displayModel.faces.find((face) => face.id === "face-load-top");
  const volumeM3 = dimensionsVolumeM3(displayModel.dimensions);
  const center = payloadFace?.center ?? [0, 0, 0] as [number, number, number];
  return templateLoads.map((load) => load.selectionRef === "selection-load-face"
    ? {
        ...load,
        type: "gravity",
        parameters: {
          value: volumeM3 * 2700,
          units: "kg",
          direction: [0, -1, 0],
          applicationPoint: center,
          payloadMaterialId: "payload-aluminum-6061",
          payloadVolumeM3: volumeM3,
          payloadMassMode: "material",
          payloadObject: {
            id: `payload-${displayModel.id}`,
            label: "end payload mass",
            center,
            volumeM3,
            volumeSource: "bounds-fallback",
            volumeStatus: "estimated"
          }
        },
        status: "complete"
      }
    : load);
}

function dimensionsVolumeM3(dimensions: DisplayModel["dimensions"]) {
  if (!dimensions) return 0;
  return Math.max(dimensions.x, 0) * Math.max(dimensions.y, 0) * Math.max(dimensions.z, 0) / 1_000_000_000;
}

export function sampleProjectName(sampleId: SampleModelId): string {
  return SAMPLE_META[sampleId].projectName;
}

function baseNameForModel(filename: string): string {
  const safeName = filename.trim().split(/[\\/]/).pop() || "Uploaded model";
  const withoutExtension = safeName.replace(/\.[^.]+$/, "");
  return withoutExtension || "Uploaded model";
}

function previewFormatForFilename(filename: string): "stl" | "obj" | undefined {
  const extension = filename.trim().split(".").pop()?.toLowerCase();
  if (extension === "stl" || extension === "obj") return extension;
  return undefined;
}
