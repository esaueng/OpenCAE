import type { DisplayModel, Load, Project } from "@opencae/schema";
import { ProjectSchema } from "@opencae/schema";
import { bracketDemoProject, bracketDisplayModel } from "@opencae/db/sample-data";
import { stlDimensionsFromBase64 } from "@opencae/units";
import type { EmbeddedModelFile, LocalResultBundle } from "./projectFile";
import type { SampleAnalysisType, SampleModelId, SampleProjectResponse } from "./lib/api";
import { fallbackSolveLocalStudy } from "./workers/localSolve";

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

export async function createLocalSampleProject(sample: SampleModelId = "bracket", analysisTypeOrNow: SampleAnalysisType | string = "static_stress", maybeNow?: string): Promise<SampleProjectResponse> {
  const analysisType: SampleAnalysisType = analysisTypeOrNow === "dynamic_structural" ? "dynamic_structural" : "static_stress";
  const now = analysisTypeOrNow === "dynamic_structural" || analysisTypeOrNow === "static_stress" ? maybeNow ?? new Date().toISOString() : analysisTypeOrNow;
  const meta = SAMPLE_META[sample];
  const templateStudy = bracketDemoProject.studies[0];
  const geometry = bracketDemoProject.geometryFiles[0];
  const displayModel = sampleDisplayModelFor(sample);
  const faceLabels = new Map(displayModel.faces.map((face) => [face.id, face.label]));
  const selectionNames: Record<string, string> = {
    "selection-body-bracket": `${meta.modelName} body`,
    "selection-fixed-face": faceLabels.get("face-base-left") ?? "Fixed face",
    "selection-load-face": faceLabels.get("face-load-top") ?? "Load face",
    "selection-web-face": faceLabels.get("face-web-front") ?? "Feature face",
    "selection-base-face": faceLabels.get("face-base-bottom") ?? "Base face"
  };
  const bodySelection = templateStudy?.namedSelections.find((selection) => selection.entityType === "body");
  const faceSelections = displayModel.faces.map((face) => {
    const templateSelection = templateStudy?.namedSelections.find((selection) => selection.geometryRefs[0]?.entityId === face.id);
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
      fingerprint: `${face.id}-${sample}-v1`
    };
  });
  const sampleStudyBase = templateStudy
    ? {
        ...templateStudy,
        id: templateStudy.id,
        projectId: bracketDemoProject.id,
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
        loads: sampleLoadsFor(sample, templateStudy.loads, displayModel, meta.displayName)
      }
    : undefined;
  const sampleStudy: Project["studies"][number] | undefined = sampleStudyBase
    ? analysisType === "dynamic_structural"
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
          runs: [dynamicSampleRun(sample, bracketDemoProject.id, templateStudy!.id, now)]
        }
      : {
          ...sampleStudyBase,
          name: "Static Stress",
          type: "static_stress",
          solverSettings: sampleStudyBase.solverSettings,
          runs: sample === "bracket" ? sampleStudyBase.runs : []
        }
    : undefined;

  const project: Project = {
    ...bracketDemoProject,
    id: bracketDemoProject.id,
    name: meta.projectName,
    unitSystem: "SI",
    geometryFiles: geometry
      ? [{
          ...geometry,
          id: `geom-${sample}-${bracketDemoProject.id}`,
          projectId: bracketDemoProject.id,
          filename: meta.filename,
          artifactKey: `${bracketDemoProject.id}/geometry/${sample}-display.json`,
          metadata: {
            ...geometry.metadata,
            source: "sample",
            sampleModel: sample,
            sampleAnalysisType: analysisType,
            displayModelRef: `${bracketDemoProject.id}/geometry/${sample}-display.json`,
            faceCount: displayModel.faces.length
          }
        }]
      : [],
    studies: sampleStudy ? [sampleStudy] : [],
    createdAt: now,
    updatedAt: now
  };

  const results = analysisType === "dynamic_structural" ? await dynamicSampleResults(project) : undefined;
  return {
    project,
    displayModel,
    ...(results ? { results } : {}),
    message: analysisType === "dynamic_structural" ? `${meta.projectName} dynamic sample loaded.` : `${meta.projectName} loaded.`
  };
}

function dynamicSampleRun(sample: SampleModelId, projectId: string, studyId: string, now: string) {
  const runId = `run-${sample}-dynamic-seeded`;
  return {
    id: runId,
    studyId,
    status: "complete" as const,
    jobId: `job-${sample}-dynamic-seeded`,
    meshRef: `${projectId}/mesh/mesh-summary.json`,
    resultRef: `${projectId}/results/${runId}/results.json`,
    reportRef: `${projectId}/reports/${runId}/report.html`,
    solverBackend: "local-dynamic-newmark",
    solverVersion: "0.1.0",
    startedAt: now,
    finishedAt: now,
    diagnostics: []
  };
}

async function dynamicSampleResults(project: Project): Promise<LocalResultBundle | undefined> {
  const study = project.studies[0];
  const run = study?.runs[0];
  if (!study || !run) return undefined;
  const solved = await fallbackSolveLocalStudy({ study, runId: run.id });
  return {
    activeRunId: run.id,
    completedRunId: run.id,
    summary: solved.summary,
    fields: solved.fields
  };
}

function sampleLoadsFor(sample: SampleModelId, templateLoads: Load[], displayModel: DisplayModel, payloadLabel: string): Load[] {
  if (sample === "cantilever") {
    const loadFace = displayModel.faces.find((face) => face.id === "face-load-top");
    return templateLoads.map((load) => load.selectionRef === "selection-load-face"
      ? {
          ...load,
          type: "force",
          parameters: {
            ...load.parameters,
            value: 500,
            units: "N",
            direction: [0, -1, 0],
            applicationPoint: loadFace?.center ?? [1.9, 0.18, 0]
          },
          status: "complete"
        }
      : load);
  }
  if (sample !== "plate") return templateLoads;
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

export function createLocalBlankProject(now = new Date().toISOString()): SampleProjectResponse {
  const projectId = `project-${newLocalId()}`;
  return {
    project: {
      id: projectId,
      name: "Untitled Project",
      schemaVersion: bracketDemoProject.schemaVersion,
      unitSystem: "SI",
      geometryFiles: [],
      studies: [],
      createdAt: now,
      updatedAt: now
    },
    displayModel: {
      id: "display-blank",
      name: "No model loaded",
      bodyCount: 0,
      faces: []
    },
    message: "Blank project created."
  };
}

export function createLocalStaticStressStudy(project: Project, displayModel: DisplayModel, studyId = `study-${newLocalId()}`, now = new Date().toISOString()): Project["studies"][number] {
  return createStaticStressStudyForProject(project, displayModel, studyId, now);
}

export function createLocalDynamicStructuralStudy(project: Project, displayModel: DisplayModel, studyId = `study-${newLocalId()}`, now = new Date().toISOString()): Project["studies"][number] {
  return createDynamicStructuralStudyForProject(project, displayModel, studyId, now);
}

export function openLocalProjectPayload(payload: unknown): SampleProjectResponse {
  const candidate = hasObjectKey(payload, "project") ? payload.project : payload;
  const parsed = ProjectSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("The selected file is not a valid OpenCAE project JSON.");

  const displayModel = hasObjectKey(payload, "displayModel") && isDisplayModel(payload.displayModel)
    ? payload.displayModel
    : displayModelForProject(parsed.data);
  const results = hasObjectKey(payload, "results") && isLocalResultBundle(payload.results) ? payload.results : undefined;
  return {
    project: parsed.data,
    displayModel,
    ...(results ? { results } : {}),
    message: `${parsed.data.name} opened from local file.`
  };
}

export function createLocalUploadResponse(project: Project, embeddedModel: EmbeddedModelFile, now = new Date().toISOString()): SampleProjectResponse {
  const displayModel = uploadedDisplayModelFor(embeddedModel.filename, embeddedModel.contentBase64);
  const artifactKey = `${project.id}/geometry/uploaded-display.json`;
  const nextProject = attachUploadedModelToProject(project, {
    geometryId: `geom-upload-${newLocalId()}`,
    filename: embeddedModel.filename,
    artifactKey,
    now,
    displayModel
  });
  const geometry = nextProject.geometryFiles[0];
  if (geometry) {
    geometry.metadata = {
      ...geometry.metadata,
      embeddedModel,
      originalSize: embeddedModel.size,
      contentType: embeddedModel.contentType
    };
  }
  const previewMessage = displayModel.visualMesh
    ? "Previewing the uploaded mesh in the viewport."
    : displayModel.nativeCad
      ? "Previewing a selectable STEP import body in the viewport."
      : "Preview is not available for this file.";
  return {
    project: nextProject,
    displayModel,
    message: `${embeddedModel.filename} uploaded. ${previewMessage}`
  };
}

function sampleDisplayModelFor(sample: SampleModelId): DisplayModel {
  const meta = SAMPLE_META[sample];
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
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.9, 0.14, 0], normal: [-1, 0, 0], stressValue: 82 },
      { id: "face-load-top", label: "End payload mass", color: "#f59e0b", center: [1.48, 0.49, 0], normal: [0, 1, 0], stressValue: 118 },
      { id: "face-web-front", label: "Beam top face", color: "#22c55e", center: [0.0, 0.38, 0], normal: [0, 1, 0], stressValue: 92 },
      { id: "face-base-bottom", label: "Beam body", color: "#8b949e", center: [0.0, 0.14, 0.0], normal: [0, 0, 1], stressValue: 58 }
    ],
    cantilever: [
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], stressValue: 132 },
      { id: "face-load-top", label: "Free end load face", color: "#f59e0b", center: [1.9, 0.18, 0], normal: [1, 0, 0], stressValue: 96 },
      { id: "face-web-front", label: "Top beam face", color: "#22c55e", center: [0.0, 0.42, 0], normal: [0, 1, 0], stressValue: 74 },
      { id: "face-base-bottom", label: "Beam bottom face", color: "#8b949e", center: [0.0, -0.08, 0], normal: [0, -1, 0], stressValue: 46 }
    ]
  };
  return {
    ...bracketDisplayModel,
    id: `display-${sample}`,
    name: meta.displayName,
    dimensions: meta.dimensions,
    faces: facesBySample[sample]
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

function createStaticStressStudyForProject(project: Project, displayModel: DisplayModel, studyId: string, now: string): Project["studies"][number] {
  const geometry = project.geometryFiles[0];
  const modelName = geometry ? baseNameForModel(geometry.filename) : displayModel.name || "model";
  const bodyLabel = `${modelName} body`;
  return {
    id: studyId,
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
      createdAt: now
    },
    validation: [],
    runs: []
  };
}

function createDynamicStructuralStudyForProject(project: Project, displayModel: DisplayModel, studyId: string, now: string): Project["studies"][number] {
  const geometry = project.geometryFiles[0];
  const modelName = geometry ? baseNameForModel(geometry.filename) : displayModel.name || "model";
  const bodyLabel = `${modelName} body`;
  return {
    id: studyId,
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

function displayModelForProject(project: Project): DisplayModel {
  const sample = normalizeSampleId(project.geometryFiles[0]?.metadata.sampleModel);
  if (project.geometryFiles.length) return sampleDisplayModelFor(sample);
  return { id: "display-blank", name: "No model loaded", bodyCount: 0, faces: [] };
}

function normalizeSampleId(value: unknown): SampleModelId {
  return value === "plate" || value === "cantilever" ? value : "bracket";
}

function nativeCadFormatForFilename(filename: string): "step" | undefined {
  const extension = filename.trim().split(".").pop()?.toLowerCase();
  if (extension === "step" || extension === "stp") return "step";
  return undefined;
}

function previewFormatForFilename(filename: string): "stl" | "obj" | undefined {
  const extension = filename.trim().split(".").pop()?.toLowerCase();
  if (extension === "stl" || extension === "obj") return extension;
  return undefined;
}

function baseNameForModel(filename: string): string {
  const safeName = filename.trim().split(/[\\/]/).pop() || "Uploaded model";
  const withoutExtension = safeName.replace(/\.[^.]+$/, "");
  return withoutExtension || "Uploaded model";
}

function hasObjectKey<Key extends string>(value: unknown, key: Key): value is Record<Key, unknown> {
  return Boolean(value && typeof value === "object" && key in value);
}

function isDisplayModel(value: unknown): value is DisplayModel {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Partial<DisplayModel>).id === "string" &&
    typeof (value as Partial<DisplayModel>).name === "string" &&
    typeof (value as Partial<DisplayModel>).bodyCount === "number" &&
    Array.isArray((value as Partial<DisplayModel>).faces)
  );
}

function isLocalResultBundle(value: unknown): value is LocalResultBundle {
  return Boolean(
    value &&
    typeof value === "object" &&
    hasObjectKey(value, "summary") &&
    hasObjectKey(value, "fields") &&
    Array.isArray(value.fields)
  );
}

function newLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
