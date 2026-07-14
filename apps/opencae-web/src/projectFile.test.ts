import { describe, expect, test } from "vitest";
import type { DisplayModel, Project, ResultField, ResultSummary } from "@opencae/schema";
import { buildLocalProjectFile, embedUploadedModelFile, suggestedProjectFilename } from "./projectFile";

const project = {
  id: "project-1",
  name: "Bracket Demo",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-04-24T12:00:00.000Z",
  updatedAt: "2026-04-24T12:00:00.000Z"
} satisfies Project;

const displayModel = {
  id: "display-1",
  name: "Display",
  bodyCount: 0,
  faces: []
} satisfies DisplayModel;

describe("projectFile", () => {
  test("builds a reopenable local project payload", () => {
    const payload = buildLocalProjectFile(project, displayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.format).toBe("opencae-local-project");
    expect(payload.version).toBe(2);
    expect(payload.project.updatedAt).toBe("2026-04-24T13:00:00.000Z");
    expect(payload.displayModel).toBe(displayModel);
  });

  test("keeps project custom materials in the version-2 portable container", () => {
    const custom = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6,
      verification: "user_supplied_unverified" as const
    };
    const payload = buildLocalProjectFile({ ...project, customMaterials: [custom] }, displayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.version).toBe(2);
    expect(payload.project.customMaterials).toEqual([custom]);
  });

  test("keeps compact convergence records in the version-2 portable container", () => {
    const record: NonNullable<Project["convergenceRecords"]>[number] = {
      id: "convergence-1",
      studyId: "study-1",
      caseId: "case-default",
      createdAt: "2026-07-14T12:00:00.000Z",
      completedAt: "2026-07-14T12:01:00.000Z",
      probe: { point: [1, 2, 3], source: "explicit" },
      classification: "inconclusive",
      rungs: ["coarse", "medium", "fine"].map((requestedPreset) => ({
        requestedPreset: requestedPreset as "coarse" | "medium" | "fine",
        status: "skipped" as const,
        totalDofs: 120_000,
        skipReason: "Above the browser pipeline limit."
      }))
    };
    const payload = buildLocalProjectFile({ ...project, convergenceRecords: [record] }, displayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.version).toBe(2);
    expect(payload.project.convergenceRecords).toEqual([record]);
    expect(JSON.stringify(payload.project.convergenceRecords)).not.toContain("fields");
  });

  test("keeps saved model orientation in the local project payload", () => {
    const orientedDisplayModel = { ...displayModel, orientation: { x: 0, y: 90, z: 180 } } satisfies DisplayModel;
    const payload = buildLocalProjectFile(project, orientedDisplayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.displayModel.orientation).toEqual({ x: 0, y: 90, z: 180 });
  });

  test("can include simulation results in the local project payload", () => {
    const summary = {
      maxStress: 168.5,
      maxStressUnits: "MPa",
      maxDisplacement: 0.157,
      maxDisplacementUnits: "mm",
      safetyFactor: 1.64,
      reactionForce: 500,
      reactionForceUnits: "N"
    } satisfies ResultSummary;
    const fields = [{
      id: "field-1",
      runId: "run-1",
      type: "stress",
      location: "face",
      values: [12, 24],
      min: 12,
      max: 24,
      units: "MPa"
    }] satisfies ResultField[];

    const payload = buildLocalProjectFile(project, displayModel, "2026-04-24T13:00:00.000Z", {
      activeRunId: "run-1",
      completedRunId: "run-1",
      summary,
      fields,
      reportCaptures: {
        stress: { png: "data:image/png;base64,stress", fieldId: "field-1", selection: "static" }
      }
    });

    expect(payload.results?.summary).toBe(summary);
    expect(payload.results?.fields).toBe(fields);
    expect(payload.results?.completedRunId).toBe("run-1");
    expect(payload.results?.reportCaptures?.stress?.png).toBe("data:image/png;base64,stress");
  });

  test("keeps run variants in the backward-readable version-2 project container", () => {
    const summary = {
      maxStress: 10,
      maxStressUnits: "MPa",
      maxDisplacement: 0.1,
      maxDisplacementUnits: "mm",
      safetyFactor: 20,
      reactionForce: 100,
      reactionForceUnits: "N"
    } satisfies ResultSummary;
    const fields = [{
      id: "stress-service",
      runId: "run-variants",
      variantId: "case:service",
      type: "stress" as const,
      location: "node" as const,
      values: [10],
      min: 10,
      max: 10,
      units: "MPa"
    }];
    const variant = { id: "case:service", name: "Service", kind: "case" as const, caseId: "service", summary, fields };

    const payload = buildLocalProjectFile(project, displayModel, "2026-04-24T13:00:00.000Z", {
      completedRunId: "run-variants",
      summary,
      fields,
      variants: [variant],
      variantRefs: [{ id: variant.id, name: variant.name, kind: variant.kind, caseId: variant.caseId }],
      activeVariantId: variant.id
    });

    expect(payload.version).toBe(2);
    expect(payload.results?.variants?.[0]).toBe(variant);
    expect(payload.results?.activeVariantId).toBe("case:service");
  });

  test("embeds uploaded model bytes in the project geometry metadata", () => {
    const uploadedProject = {
      ...project,
      geometryFiles: [{
        id: "geometry-1",
        projectId: "project-1",
        filename: "uploaded-bracket.stl",
        localPath: "uploads/uploaded-bracket.stl",
        artifactKey: "project-1/geometry/uploaded-display.json",
        status: "ready",
        metadata: { source: "local-upload" }
      }]
    } satisfies Project;

    const embeddedModel = {
      filename: "uploaded-bracket.stl",
      contentType: "model/stl",
      size: 4,
      contentBase64: "AQIDBA=="
    };

    const nextProject = embedUploadedModelFile(uploadedProject, embeddedModel);
    const payload = buildLocalProjectFile(nextProject, displayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.project.geometryFiles[0]?.metadata.embeddedModel).toEqual(embeddedModel);
  });

  test("backs up uploaded display model bytes into the saved project payload", () => {
    const uploadedProject = {
      ...project,
      geometryFiles: [{
        id: "geometry-1",
        projectId: "project-1",
        filename: "uploaded-bracket.stl",
        localPath: "uploads/uploaded-bracket.stl",
        artifactKey: "project-1/geometry/uploaded-display.json",
        status: "ready",
        metadata: { source: "local-upload" }
      }]
    } satisfies Project;
    const uploadedDisplayModel = {
      ...displayModel,
      visualMesh: {
        format: "stl",
        filename: "uploaded-bracket.stl",
        contentBase64: "AQIDBA=="
      }
    } satisfies DisplayModel;

    const payload = buildLocalProjectFile(uploadedProject, uploadedDisplayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.project.geometryFiles[0]?.metadata.embeddedModel).toEqual({
      filename: "uploaded-bracket.stl",
      contentType: "model/stl",
      size: 4,
      contentBase64: "AQIDBA=="
    });
  });

  test("suggests a safe local filename", () => {
    expect(suggestedProjectFilename("Bracket Demo")).toBe("bracket-demo.opencae.json");
    expect(suggestedProjectFilename("  ")).toBe("opencae-project.opencae.json");
  });
});
