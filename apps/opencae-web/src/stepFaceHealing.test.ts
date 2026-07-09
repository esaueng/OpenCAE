import { describe, expect, test } from "vitest";
import type { DisplayModel, Project } from "@opencae/schema";
import type { StepFaceRegistry } from "./stepFaces";
import { hasLegacyStepUploadFaces, healLegacyStepFaces, legacyStepFaceHealMessage } from "./stepFaceHealing";

const LEGACY_FACES: DisplayModel["faces"] = [
  { id: "face-upload-top", label: "Top face", color: "#f59e0b", center: [0, 0.72, 0], normal: [0, 1, 0], stressValue: 72 },
  { id: "face-upload-bottom", label: "Bottom face", color: "#4da3ff", center: [0, -0.72, 0], normal: [0, -1, 0], stressValue: 48 },
  { id: "face-upload-left", label: "Left face", color: "#8b949e", center: [-1.1, 0, 0], normal: [-1, 0, 0], stressValue: 58 }
];

function legacyDisplayModel(overrides: Partial<DisplayModel> = {}): DisplayModel {
  return {
    id: "display-uploaded",
    name: "tablet-stand imported body",
    bodyCount: 1,
    faces: LEGACY_FACES,
    nativeCad: { format: "step", filename: "tablet-stand.step", contentBase64: "U1RFUA==" },
    ...overrides
  };
}

function registryWithDisplayFaces(displayFaces: StepFaceRegistry["displayFaces"]): StepFaceRegistry {
  return {
    faces: [],
    meshes: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    normalization: { scale: 1, offset: [0, 0, 0] },
    displayFaces
  };
}

function projectWithFaceSelections(): Project {
  const study = {
    id: "study-1",
    projectId: "project-1",
    name: "Dynamic Structural",
    type: "dynamic_structural" as const,
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: "body" }],
    materialAssignments: [],
    namedSelections: [
      {
        id: "selection-body-uploaded",
        name: "body",
        entityType: "body" as const,
        geometryRefs: [{ bodyId: "body-uploaded", entityType: "body" as const, entityId: "body-uploaded", label: "body" }],
        fingerprint: "body"
      },
      {
        id: "selection-fs1",
        name: "FS 1",
        entityType: "face" as const,
        geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: "face-upload-bottom", label: "Bottom face" }],
        fingerprint: "legacy-bottom"
      },
      {
        id: "selection-l1",
        name: "L 1",
        entityType: "face" as const,
        geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: "face-upload-left", label: "Left face" }],
        fingerprint: "legacy-left"
      }
    ],
    contacts: [],
    constraints: [{ id: "constraint-fs1", type: "fixed" as const, selectionRef: "selection-fs1", parameters: {}, status: "complete" as const }],
    loads: [{ id: "load-l1", type: "force" as const, selectionRef: "selection-l1", parameters: { value: 1, units: "N", direction: [0, -1, 0] }, status: "complete" as const }],
    meshSettings: { preset: "medium" as const, status: "not_started" as const },
    solverSettings: {},
    validation: [],
    runs: []
  };
  return {
    id: "project-1",
    name: "tablet-stand",
    schemaVersion: "1",
    unitSystem: "metric_mm",
    geometryFiles: [],
    studies: [study],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  } as unknown as Project;
}

describe("hasLegacyStepUploadFaces", () => {
  test("detects STEP models that still carry only placeholder faces", () => {
    expect(hasLegacyStepUploadFaces(legacyDisplayModel())).toBe(true);
  });

  test("ignores healthy STEP models, non-STEP uploads, and empty models", () => {
    expect(hasLegacyStepUploadFaces(legacyDisplayModel({
      faces: [{ id: "step-face-0", label: "+Z planar face", color: "#8b949e", center: [0, 0, 1], normal: [0, 0, 1], stressValue: 0 }]
    }))).toBe(false);
    expect(hasLegacyStepUploadFaces(legacyDisplayModel({ nativeCad: undefined }))).toBe(false);
    expect(hasLegacyStepUploadFaces(legacyDisplayModel({ faces: [] }))).toBe(false);
    expect(hasLegacyStepUploadFaces(null)).toBe(false);
  });
});

describe("healLegacyStepFaces", () => {
  test("remaps selections whose placeholder normal dominantly matches one real face", () => {
    const registry = registryWithDisplayFaces([
      { id: "step-face-0", label: "-Y planar face", color: "#8b949e", center: [0, -0.9, 0], normal: [0, -1, 0], stressValue: 0 },
      { id: "step-face-1", label: "+Y planar face", color: "#8b949e", center: [0, 0.9, 0], normal: [0, 1, 0], stressValue: 0 },
      { id: "step-face-2", label: "-X planar face", color: "#8b949e", center: [-1, 0, 0], normal: [-1, 0, 0], stressValue: 0 }
    ]);
    const heal = healLegacyStepFaces(projectWithFaceSelections(), legacyDisplayModel(), registry);

    expect(heal.displayModel.faces.map((face) => face.id)).toEqual(["step-face-0", "step-face-1", "step-face-2"]);
    expect(heal.remapped).toEqual([
      { selectionName: "FS 1", fromFaceId: "face-upload-bottom", toFaceId: "step-face-0", toLabel: "-Y planar face" },
      { selectionName: "L 1", fromFaceId: "face-upload-left", toFaceId: "step-face-2", toLabel: "-X planar face" }
    ]);
    expect(heal.unresolved).toEqual([]);
    const selections = heal.project.studies[0]!.namedSelections;
    expect(selections.find((item) => item.id === "selection-fs1")?.geometryRefs[0]?.entityId).toBe("step-face-0");
    expect(selections.find((item) => item.id === "selection-l1")?.geometryRefs[0]?.entityId).toBe("step-face-2");
    // Body selections and untouched fields survive as-is.
    expect(selections.find((item) => item.id === "selection-body-uploaded")?.geometryRefs[0]?.entityId).toBe("body-uploaded");
    expect(heal.project.studies[0]!.constraints).toEqual(projectWithFaceSelections().studies[0]!.constraints);
  });

  test("leaves ambiguous selections unresolved instead of guessing", () => {
    // Two -Y-ish faces within the dominance margin: no confident winner.
    const registry = registryWithDisplayFaces([
      { id: "step-face-0", label: "-Y planar face", color: "#8b949e", center: [0, -0.9, 0.4], normal: [0, -0.98, 0.199], stressValue: 0 },
      { id: "step-face-1", label: "-Y skewed face", color: "#8b949e", center: [0, -0.9, -0.4], normal: [0, -0.995, -0.0999], stressValue: 0 },
      { id: "step-face-2", label: "-X planar face", color: "#8b949e", center: [-1, 0, 0], normal: [-1, 0, 0], stressValue: 0 }
    ]);
    const heal = healLegacyStepFaces(projectWithFaceSelections(), legacyDisplayModel(), registry);

    expect(heal.unresolved).toEqual([{ selectionName: "FS 1", fromFaceId: "face-upload-bottom" }]);
    expect(heal.remapped).toEqual([
      { selectionName: "L 1", fromFaceId: "face-upload-left", toFaceId: "step-face-2", toLabel: "-X planar face" }
    ]);
    // The unresolved selection keeps its placeholder ref (still broken, but honestly so).
    const fs1 = heal.project.studies[0]!.namedSelections.find((item) => item.id === "selection-fs1");
    expect(fs1?.geometryRefs[0]?.entityId).toBe("face-upload-bottom");
  });

  test("heal message names remapped and unresolved selections", () => {
    const registry = registryWithDisplayFaces([
      { id: "step-face-0", label: "-Y planar face", color: "#8b949e", center: [0, -0.9, 0], normal: [0, -1, 0], stressValue: 0 }
    ]);
    const heal = healLegacyStepFaces(projectWithFaceSelections(), legacyDisplayModel(), registry);
    const message = legacyStepFaceHealMessage(heal);

    expect(message).toContain("FS 1 → -Y planar face");
    expect(message).toContain("Re-select on the model");
    expect(message).toContain("L 1");
  });

  test("returns null message when no placeholder selections existed", () => {
    const project = projectWithFaceSelections();
    project.studies[0]!.namedSelections = project.studies[0]!.namedSelections.filter((item) => item.entityType !== "face");
    const registry = registryWithDisplayFaces([
      { id: "step-face-0", label: "-Y planar face", color: "#8b949e", center: [0, -0.9, 0], normal: [0, -1, 0], stressValue: 0 }
    ]);
    const heal = healLegacyStepFaces(project, legacyDisplayModel(), registry);

    expect(heal.remapped).toEqual([]);
    expect(heal.unresolved).toEqual([]);
    expect(legacyStepFaceHealMessage(heal)).toBeNull();
    expect(heal.displayModel.faces.map((face) => face.id)).toEqual(["step-face-0"]);
  });
});
