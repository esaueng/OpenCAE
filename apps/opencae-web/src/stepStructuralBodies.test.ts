import type { Study } from "@opencae/schema";
import type { OcctMesh } from "occt-import-js";
import { describe, expect, it } from "vitest";
import { buildStepFaceRegistry, stepAttributionForRegistry } from "./stepFaces";
import {
  planStepStructuralBodies,
  stepFuseBodyGroups,
  stepStructuralBodyWarning,
  studyWithStepPayloadContacts
} from "./stepStructuralBodies";

describe("STEP structural body planning", () => {
  it("meshes the supported tray and maps a selected rod payload to its nearest tray face", () => {
    const registry = buildStepFaceRegistry([
      oneFaceBody([[-2, -2, 0], [2, -2, 0], [0, 2, 0]], [0, 0, -1]),
      oneFaceBody([[-0.5, -0.5, 1], [0.5, -0.5, 1], [0, 0.5, 1]], [0, 0, 2]),
      oneFaceBody([[4.5, -0.5, 1], [5.5, -0.5, 1], [5, 0.5, 1]], [5, 0, 2])
    ]);
    const study = payloadStudy();

    const plan = planStepStructuralBodies(study, registry);

    expect(plan).toEqual({
      structuralMeshIndices: [0],
      structuralBodyBounds: [{ min: [-2, -2, -1], max: [2, 2, 0] }],
      excludedBodyCount: 2,
      payloadContactFaceByLoadId: { "payload-rod-1": "step-face-0" }
    });
    expect(stepStructuralBodyWarning(plan!)).toContain("2 disconnected bodies were treated as carried payload/visual geometry");
    const structuralAttribution = stepAttributionForRegistry(registry, plan!.structuralMeshIndices);
    expect(structuralAttribution.faceIds).toEqual(["step-face-0"]);
    expect(structuralAttribution.indices).toHaveLength(3);

    const dispatchStudy = studyWithStepPayloadContacts(study, registry, plan!);
    const payloadLoad = dispatchStudy.loads.find((load) => load.id === "payload-rod-1");
    const contact = dispatchStudy.namedSelections.find((selection) => selection.id === payloadLoad?.selectionRef);
    expect(payloadLoad?.selectionRef).toBe("selection-payload-contact-payload-rod-1");
    expect(contact?.geometryRefs).toEqual([{
      bodyId: "body-uploaded",
      entityType: "face",
      entityId: "step-face-0",
      label: registry.displayFaces[0]!.label
    }]);
    // This substitution is dispatch-only; the editable study stays on the rod.
    expect(study.loads[0]?.selectionRef).toBe("selection-rod-top");
  });

  it("does not guess when selections identify multiple structural bodies", () => {
    const registry = buildStepFaceRegistry([
      oneFaceBody([[-2, -2, 0], [2, -2, 0], [0, 2, 0]], [0, 0, -1]),
      oneFaceBody([[-0.5, -0.5, 1], [0.5, -0.5, 1], [0, 0.5, 1]], [0, 0, 2]),
      oneFaceBody([[4.5, -0.5, 1], [5.5, -0.5, 1], [5, 0.5, 1]], [5, 0, 2])
    ]);
    const study = payloadStudy();
    study.loads.push({
      id: "force-on-third-body",
      type: "force",
      selectionRef: "selection-third",
      parameters: { value: 10, units: "N", direction: [0, 0, -1] },
      status: "ready"
    });
    study.namedSelections.push(faceSelection("selection-third", "step-face-2"));

    expect(planStepStructuralBodies(study, registry)).toBeNull();
  });

  it("resolves pairwise Boolean fuse selections to only their connected STEP bodies", () => {
    const registry = buildStepFaceRegistry([
      oneFaceBody([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [0, 0, 1]),
      oneFaceBody([[2, 0, 0], [4, 0, 0], [2, 2, 0]], [4, 2, 1]),
      oneFaceBody([[10, 0, 0], [12, 0, 0], [10, 2, 0]], [12, 2, 1])
    ]);
    const study = payloadStudy();
    study.namedSelections = [
      faceSelection("fuse-source", "step-face-0"),
      faceSelection("fuse-target", "step-face-1")
    ];
    study.contacts = [{ id: "fuse-1", status: "ready", type: "fuse", source: "fuse-source", target: "fuse-target", kinematics: "small_sliding" }];

    expect(stepFuseBodyGroups(study, registry)).toEqual([[
      { min: [0, 0, 0], max: [2, 2, 1] },
      { min: [2, 0, 0], max: [4, 2, 1] }
    ]]);
    expect(planStepStructuralBodies(study, registry)).toBeNull();
  });
});

function payloadStudy(): Study {
  return {
    id: "study-payload",
    projectId: "project-payload",
    type: "dynamic_structural",
    namedSelections: [
      faceSelection("selection-tray-support", "step-face-0"),
      faceSelection("selection-rod-top", "step-face-1")
    ],
    constraints: [{
      id: "support-1",
      type: "fixed",
      selectionRef: "selection-tray-support",
      parameters: {},
      status: "ready"
    }],
    loads: [{
      id: "payload-rod-1",
      type: "gravity",
      selectionRef: "selection-rod-top",
      parameters: {
        value: 5,
        units: "kg",
        direction: [0, 0, -1],
        payloadObject: {
          id: "step-object-2",
          label: "Rod 1",
          center: [0, 0, 1.5],
          volumeM3: 0.00064,
          volumeSource: "step",
          volumeStatus: "available"
        }
      },
      status: "ready"
    }]
  } as unknown as Study;
}

function faceSelection(id: string, faceId: string): Study["namedSelections"][number] {
  return {
    id,
    name: id,
    entityType: "face",
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: faceId, label: faceId }],
    fingerprint: `test:${faceId}`
  };
}

function oneFaceBody(
  triangle: [[number, number, number], [number, number, number], [number, number, number]],
  boundsPoint: [number, number, number]
): OcctMesh {
  return {
    attributes: { position: { array: [...triangle.flat(), ...boundsPoint] } },
    index: { array: [0, 1, 2] },
    brep_faces: [{ first: 0, last: 0 }]
  } as unknown as OcctMesh;
}
