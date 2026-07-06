// Shared scenario builder for the A-M3 STEP end-to-end proofs: the Node E2E
// test (stepUploadEndToEnd.test.ts) and the browser proof harness
// (meshHarness.ts ?meshProof=step) both drive the exact same synthetic
// upload — real registry faceIds selected as support/load, a display-frame
// study, and the wasm mesh summary that trySolveOpenCaeCoreStudy consumes.
import type { DisplayModel, MeshQuality, Study } from "@opencae/schema";
import type { CoreVolumeMeshArtifact, SelectionMappingDiagnostic } from "@opencae/mesh-intake";
import type { OpenCAEModelJson } from "@opencae/core";
import type { StepFaceRecord, StepFaceRegistry } from "../stepFaces";

export const STEP_PROOF_LOAD_NEWTONS = 500;
export const STEP_PROOF_SUPPORT_SELECTION = "selection-step-proof-support";
export const STEP_PROOF_LOAD_SELECTION = "selection-step-proof-load";

export type StepProofFaces = { supportFace: StepFaceRecord; loadFace: StepFaceRecord };

/**
 * Support = the most -X-facing planar face, load = the most +Z-facing face
 * (for box-with-bore that is the bored top face, so the load surface has a
 * real hole in it — exactly what generic box faces could not represent).
 */
export function chooseStepProofFaces(registry: StepFaceRegistry): StepProofFaces {
  return {
    supportFace: mostAligned(registry, [-1, 0, 0]),
    loadFace: mostAligned(registry, [0, 0, 1])
  };
}

export function stepProofScenario(registry: StepFaceRegistry, options: {
  filename: string;
  contentBase64: string;
}): { study: Study; displayModel: DisplayModel; faces: StepProofFaces } {
  const faces = chooseStepProofFaces(registry);
  const { min, max } = registry.bounds;
  const displayModel: DisplayModel = {
    id: "display-uploaded",
    name: `${options.filename} imported body`,
    bodyCount: 1,
    dimensions: {
      x: max[0] - min[0],
      y: max[1] - min[1],
      z: max[2] - min[2],
      units: "mm"
    },
    faces: registry.displayFaces,
    nativeCad: {
      format: "step",
      filename: options.filename,
      contentBase64: options.contentBase64
    }
  };

  const study: Study = {
    id: "study-step-proof",
    projectId: "project-step-proof",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "STEP proof body" }],
    materialAssignments: [{
      id: "assign-step-proof",
      materialId: "mat-aluminum-6061",
      selectionRef: "selection-body-uploaded",
      parameters: {},
      status: "complete"
    }],
    namedSelections: [
      {
        id: "selection-body-uploaded",
        name: "STEP proof body",
        entityType: "body",
        geometryRefs: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "STEP proof body" }],
        fingerprint: "body-uploaded-step-proof"
      },
      faceSelection(STEP_PROOF_SUPPORT_SELECTION, faces.supportFace),
      faceSelection(STEP_PROOF_LOAD_SELECTION, faces.loadFace)
    ],
    contacts: [],
    constraints: [{
      id: "constraint-step-proof-fixed",
      type: "fixed",
      selectionRef: STEP_PROOF_SUPPORT_SELECTION,
      parameters: {},
      status: "complete"
    }],
    loads: [{
      id: "load-step-proof-force",
      type: "force",
      selectionRef: STEP_PROOF_LOAD_SELECTION,
      parameters: {
        value: STEP_PROOF_LOAD_NEWTONS,
        units: "N",
        direction: [0, 0, -1]
      },
      status: "complete"
    }],
    meshSettings: { preset: "medium", status: "not_started" },
    solverSettings: {
      analysisType: "linear_static",
      smallDisplacement: true
    },
    validation: [],
    runs: []
  };

  return { study, displayModel, faces };
}

/** Mirror lib/wasmMeshing.ts: stash the built Core model as the study's wasm mesh summary. */
export function studyWithWasmMeshSummary(options: {
  study: Study;
  artifact: CoreVolumeMeshArtifact;
  model: OpenCAEModelJson;
  preset?: MeshQuality;
  mappingDiagnostics?: SelectionMappingDiagnostic[];
}): Study {
  const { study, artifact, model } = options;
  return {
    ...study,
    meshSettings: {
      preset: options.preset ?? "medium",
      status: "complete",
      meshRef: `${study.projectId}/mesh/wasm-gmsh-mesh.json`,
      summary: {
        nodes: artifact.metadata.nodeCount,
        elements: artifact.metadata.elementCount,
        warnings: [],
        quality: options.preset ?? "medium",
        source: "wasm_gmsh",
        units: "m",
        solverCoordinateSpace: "solver",
        artifacts: {
          actualCoreModel: { model },
          meshConnectivity: { connectedComponents: artifact.metadata.connectedComponentCount },
          ...(options.mappingDiagnostics?.length ? { selectionMapping: options.mappingDiagnostics } : {})
        }
      }
    }
  };
}

function faceSelection(selectionId: string, face: StepFaceRecord): Study["namedSelections"][number] {
  return {
    id: selectionId,
    name: face.faceId,
    entityType: "face",
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: face.faceId, label: face.faceId }],
    fingerprint: face.fingerprint
  };
}

function mostAligned(registry: StepFaceRegistry, direction: [number, number, number]): StepFaceRecord {
  return registry.faces.reduce((best, face) => (dot(face.avgNormal, direction) > dot(best.avgNormal, direction) ? face : best));
}

function dot(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}
