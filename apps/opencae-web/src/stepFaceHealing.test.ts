import { beforeAll, describe, expect, test } from "vitest";
import type { DisplayModel, Project } from "@opencae/schema";
import { buildStepFaceRegistry, type StepFaceRegistry } from "./stepFaces";
import {
  hasLegacyStepUploadFaces,
  hasUnresolvedStepFaceSelections,
  healLegacyStepFaces,
  healStepFaceSelections,
  legacyStepFaceHealMessage,
  parsePickedFaceId,
  remapStepFaceSelectionsInStudy
} from "./stepFaceHealing";

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

describe("picked-face selections against a synthetic two-face registry", () => {
  // Hand-built tessellation standing in for a 60 x 40 x 20 mm part: a top
  // face at z=20 (+Z normals) and a side face at x=0 (-X normals). Synthetic
  // instead of an occt import so this file adds no second wasm initialization
  // to the root CI test run (stepFaces.test.ts covers the real tessellation).
  let registry: StepFaceRegistry;
  let topFaceId: string;

  beforeAll(() => {
    const positions = [
      // Top face at z=20.
      0, 0, 20, 60, 0, 20, 60, 40, 20, 0, 40, 20,
      // Side face at x=0.
      0, 0, 0, 0, 40, 0, 0, 40, 20, 0, 0, 20
    ];
    const indices = [
      0, 1, 2, 0, 2, 3, // +Z winding
      4, 6, 5, 4, 7, 6 // -X winding
    ];
    registry = buildStepFaceRegistry([
      {
        attributes: { position: { array: positions } },
        index: { array: indices },
        brep_faces: [{ first: 0, last: 1 }, { first: 2, last: 3 }]
      } as never
    ]);
    expect(registry.faces).toHaveLength(2);
    topFaceId = registry.faces.find((face) => face.avgNormal[2] > 0.9)!.faceId;
  });

  const toViewer = (model: [number, number, number]): [number, number, number] => [
    model[0] * registry.normalization.scale + registry.normalization.offset[0],
    model[1] * registry.normalization.scale + registry.normalization.offset[1],
    model[2] * registry.normalization.scale + registry.normalization.offset[2]
  ];

  function pickedProjectAndModel(pickedCenter: [number, number, number], options: { includeDisplayFace?: boolean } = {}) {
    const pickedId = `face-upload-picked-${[...pickedCenter, 0, 0, 1].map((value) => value.toFixed(2).replace("-", "m").replace(".", "p")).join("-")}`;
    const pickedFace: DisplayModel["faces"][number] = { id: pickedId, label: "Top face", color: "#4da3ff", center: pickedCenter, normal: [0, 0, 1], stressValue: 72 };
    const displayModel = legacyDisplayModel({
      faces: [...registry.displayFaces, ...(options.includeDisplayFace === false ? [] : [pickedFace])]
    });
    const project = projectWithFaceSelections();
    project.studies[0]!.namedSelections = project.studies[0]!.namedSelections.map((selection) =>
      selection.id === "selection-fs1"
        ? { ...selection, geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: pickedId, label: "Top face" }] }
        : selection
    );
    // Leave L 1 on a real registry face so only the pick needs healing.
    project.studies[0]!.namedSelections = project.studies[0]!.namedSelections.map((selection) =>
      selection.id === "selection-l1"
        ? { ...selection, geometryRefs: [{ bodyId: "body-uploaded", entityType: "face" as const, entityId: registry.displayFaces[0]!.id, label: registry.displayFaces[0]!.label }] }
        : selection
    );
    return { project, displayModel, pickedId };
  }

  test("detects unresolved picked selections", () => {
    const { project, displayModel } = pickedProjectAndModel(toViewer([10, 10, 20]));
    expect(hasUnresolvedStepFaceSelections(project, displayModel)).toBe(true);
    expect(hasUnresolvedStepFaceSelections(project, { ...displayModel, nativeCad: undefined })).toBe(false);
  });

  test("heals a picked support onto the face the pick landed on", () => {
    const { project, displayModel, pickedId } = pickedProjectAndModel(toViewer([10, 10, 20]));
    const heal = healStepFaceSelections(project, displayModel, registry);

    expect(heal.remapped).toEqual([expect.objectContaining({ selectionName: "FS 1", fromFaceId: pickedId, toFaceId: topFaceId })]);
    expect(heal.unresolved).toEqual([]);
    const fs1 = heal.project.studies[0]!.namedSelections.find((item) => item.id === "selection-fs1");
    expect(fs1?.geometryRefs[0]?.entityId).toBe(topFaceId);
    // The placeholder face entry is dropped once its selection points at a real face.
    expect(heal.displayModel.faces.some((face) => face.id === pickedId)).toBe(false);
  });

  test("heals from the id's encoded point when the display face entry is gone", () => {
    const { project, displayModel } = pickedProjectAndModel(toViewer([10, 10, 20]), { includeDisplayFace: false });
    const heal = healStepFaceSelections(project, displayModel, registry);
    expect(heal.remapped[0]?.toFaceId).toBe(topFaceId);
  });

  test("reports picks that no longer land on any surface instead of guessing", () => {
    // Interior point: 10 mm from the nearest surface, far beyond tolerance.
    const { project, displayModel, pickedId } = pickedProjectAndModel(toViewer([30, 20, 10]));
    const heal = healStepFaceSelections(project, displayModel, registry);

    expect(heal.remapped).toEqual([]);
    expect(heal.unresolved).toEqual([{ selectionName: "FS 1", fromFaceId: pickedId }]);
    expect(legacyStepFaceHealMessage(heal)).toContain("Re-select on the model");
    // The unresolved placeholder face stays visible for its marker.
    expect(heal.displayModel.faces.some((face) => face.id === pickedId)).toBe(true);
  });

  test("remapStepFaceSelectionsInStudy resolves picks for mesh dispatch without touching unresolvable ones", () => {
    const { project, displayModel, pickedId } = pickedProjectAndModel(toViewer([10, 10, 20]));
    const study = remapStepFaceSelectionsInStudy(project.studies[0]!, displayModel, registry);
    const fs1 = study.namedSelections.find((item) => item.id === "selection-fs1");
    expect(fs1?.geometryRefs[0]?.entityId).toBe(topFaceId);

    const stuck = pickedProjectAndModel(toViewer([30, 20, 10]));
    const unchanged = remapStepFaceSelectionsInStudy(stuck.project.studies[0]!, stuck.displayModel, registry);
    expect(unchanged.namedSelections.find((item) => item.id === "selection-fs1")?.geometryRefs[0]?.entityId).toBe(stuck.pickedId);
    void pickedId;
  });

  test("parsePickedFaceId decodes the m/p encoding", () => {
    expect(parsePickedFaceId("face-upload-picked-m0p01-1p17-0p02-0p00-0p00-1p00")).toEqual({
      center: [-0.01, 1.17, 0.02],
      normal: [0, 0, 1]
    });
    expect(parsePickedFaceId("face-upload-top")).toBeNull();
    expect(parsePickedFaceId("face-upload-picked-borked")).toBeNull();
  });
});
