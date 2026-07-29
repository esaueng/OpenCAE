// Real-browser regression harness for STEP face selection across the two
// production display paths introduced by PR #79:
// - detailed viewport tessellation, with edge overlays and picking;
// - balanced result-playback tessellation, without the expensive edge overlay.
//
// The harness generates exact analytic cylinders at multiple model scales,
// raycasts their cylindrical wall and top face in a browser, assigns those
// persistent face references to a support/load, and proves that both LODs map
// the hits back to the same B-rep identities and fingerprints.
import * as THREE from "three";
import type { Study } from "@opencae/schema";
import { buildParametricPartStep } from "@opencae/step";
import {
  buildStepFaceRegistry,
  stepFaceIdForMeshTriangle,
  type StepFaceRecord,
  type StepFaceRegistry
} from "../stepFaces";
import { getOcctImporter, stepPreviewFromBase64 } from "../stepPreview";
import {
  readStepFileForDisplay,
  type StepDisplayLod
} from "../stepDisplayTessellation";

const CYLINDER_DIAMETERS_MM = [1, 25, 500] as const;
const FIXTURE_CREATED_AT = new Date("2026-07-29T00:00:00Z");
const SUPPORT_SELECTION_ID = "selection-cylinder-wall";
const LOAD_SELECTION_ID = "selection-cylinder-top";

type PickedFace = {
  faceId: string;
  fingerprint: string;
};

type LodProof = {
  triangleCount: number;
  edgeSegmentCount: number;
  wall: PickedFace;
  top: PickedFace;
};

export type StepSelectionScaleProof = {
  diameterMm: number;
  supportFaceId: string;
  loadFaceId: string;
  detailed: LodProof;
  balanced: LodProof;
};

export type StepSelectionProofResult = {
  ok: boolean;
  scales: StepSelectionScaleProof[];
  failures: string[];
};

export async function runStepSelectionProof(): Promise<StepSelectionProofResult> {
  const importer = await getOcctImporter();
  const scales: StepSelectionScaleProof[] = [];
  const failures: string[] = [];

  for (const diameterMm of CYLINDER_DIAMETERS_MM) {
    try {
      const { stepText } = buildParametricPartStep(
        "cylinder",
        { diameter: diameterMm, height: diameterMm },
        { createdAt: FIXTURE_CREATED_AT }
      );
      requireCondition(stepText.includes("CYLINDRICAL_SURFACE"), `${diameterMm} mm fixture lost its exact cylindrical surface`);
      requireCondition(stepText.includes("CIRCLE"), `${diameterMm} mm fixture lost its exact circular edges`);

      const contentBase64 = btoa(stepText);
      const detailed = await inspectLod(importer, contentBase64, stepText, "detailed");
      const wall = requireFace(
        detailed.registry.faces.find((face) => face.surfaceType === "cylindrical" && !face.cylinder?.interior),
        `${diameterMm} mm detailed cylindrical wall`
      );
      const top = requireFace(
        [...detailed.registry.faces]
          .filter((face) => face.surfaceType === "planar")
          .sort((left, right) => right.centroid[2] - left.centroid[2])[0],
        `${diameterMm} mm detailed top face`
      );
      const study = assignedCylinderStudy(wall, top);
      const supportSelection = requireSelection(study, study.constraints[0]?.selectionRef, "fixed support");
      const loadSelection = requireSelection(study, study.loads[0]?.selectionRef, "force load");

      const balanced = await inspectLod(importer, contentBase64, stepText, "balanced");
      const proof: StepSelectionScaleProof = {
        diameterMm,
        supportFaceId: requireGeometryFaceId(supportSelection, "fixed support"),
        loadFaceId: requireGeometryFaceId(loadSelection, "force load"),
        detailed: pickedLodProof(detailed, wall, top),
        balanced: pickedLodProof(balanced, wall, top)
      };

      requireCondition(detailed.registry.faces.length === 3, `${diameterMm} mm detailed registry did not contain exactly three cylinder faces`);
      requireCondition(balanced.registry.faces.length === 3, `${diameterMm} mm balanced registry did not contain exactly three cylinder faces`);
      requireCondition(proof.detailed.edgeSegmentCount > 0, `${diameterMm} mm detailed viewport path did not include its edge overlay`);
      requireCondition(proof.balanced.edgeSegmentCount === 0, `${diameterMm} mm lightweight playback path retained an edge overlay`);
      requireCondition(
        proof.detailed.triangleCount > proof.balanced.triangleCount,
        `${diameterMm} mm balanced playback mesh was not lighter than the detailed viewport mesh`
      );
      requireMappedAssignment(proof.detailed.wall, supportSelection, "detailed cylindrical-wall support");
      requireMappedAssignment(proof.detailed.top, loadSelection, "detailed top-face load");
      requireMappedAssignment(proof.balanced.wall, supportSelection, "balanced cylindrical-wall support");
      requireMappedAssignment(proof.balanced.top, loadSelection, "balanced top-face load");
      scales.push(proof);
    } catch (error) {
      failures.push(`${diameterMm} mm: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: failures.length === 0 && scales.length === CYLINDER_DIAMETERS_MM.length,
    scales,
    failures
  };
}

type InspectedLod = {
  registry: StepFaceRegistry;
  triangleCount: number;
  edgeSegmentCount: number;
  wallPick: PickedFace;
  topPick: PickedFace;
};

async function inspectLod(
  importer: Awaited<ReturnType<typeof getOcctImporter>>,
  contentBase64: string,
  stepText: string,
  lod: StepDisplayLod
): Promise<InspectedLod> {
  const imported = readStepFileForDisplay(importer, new TextEncoder().encode(stepText), lod);
  requireCondition(imported.success, `${lod} OCCT import failed${imported.errorCode ? ` (${imported.errorCode})` : ""}`);
  const registry = buildStepFaceRegistry(imported.meshes ?? []);
  const preview = await stepPreviewFromBase64(contentBase64, "#63a9e5", {
    includeEdges: lod === "detailed",
    shareMaterials: lod === "balanced",
    lod
  });

  try {
    return {
      registry,
      triangleCount: previewTriangleCount(preview.object),
      edgeSegmentCount: previewEdgeSegmentCount(preview.object),
      wallPick: raycastFace(preview.object, registry, new THREE.Vector3(4, 0.17, 0.13), new THREE.Vector3(-1, 0, 0)),
      topPick: raycastFace(preview.object, registry, new THREE.Vector3(0.23, 0.17, 4), new THREE.Vector3(0, 0, -1))
    };
  } finally {
    disposeObjectTree(preview.object);
  }
}

function pickedLodProof(
  inspected: InspectedLod,
  expectedWall: StepFaceRecord,
  expectedTop: StepFaceRecord
): LodProof {
  requireCondition(inspected.wallPick.faceId === expectedWall.faceId, `wall raycast resolved ${inspected.wallPick.faceId}, expected ${expectedWall.faceId}`);
  requireCondition(inspected.topPick.faceId === expectedTop.faceId, `top raycast resolved ${inspected.topPick.faceId}, expected ${expectedTop.faceId}`);
  return {
    triangleCount: inspected.triangleCount,
    edgeSegmentCount: inspected.edgeSegmentCount,
    wall: inspected.wallPick,
    top: inspected.topPick
  };
}

function raycastFace(
  object: THREE.Group,
  registry: StepFaceRegistry,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): PickedFace {
  object.updateMatrixWorld(true);
  const intersections = new THREE.Raycaster(origin, direction.normalize()).intersectObject(object, true);
  for (const intersection of intersections) {
    if (!(intersection.object instanceof THREE.Mesh) || typeof intersection.faceIndex !== "number") continue;
    const meshIndex = stepMeshIndexForObject(intersection.object);
    if (meshIndex === null) continue;
    const faceId = stepFaceIdForMeshTriangle(registry, meshIndex, intersection.faceIndex);
    const record = faceId ? registry.faces.find((face) => face.faceId === faceId) : undefined;
    if (record) return { faceId: record.faceId, fingerprint: record.fingerprint };
  }
  throw new Error(`raycast from ${origin.toArray().join(",")} did not resolve a STEP face`);
}

function stepMeshIndexForObject(object: THREE.Object3D): number | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    const objectId = current.userData?.opencaeObjectId;
    if (typeof objectId === "string") {
      const match = /^step-object-(\d+)$/.exec(objectId);
      return match ? Number.parseInt(match[1]!, 10) - 1 : null;
    }
    current = current.parent;
  }
  return null;
}

function assignedCylinderStudy(wall: StepFaceRecord, top: StepFaceRecord): Study {
  return {
    id: "study-step-selection-proof",
    projectId: "project-step-selection-proof",
    name: "Cylinder selection proof",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Cylinder" }],
    materialAssignments: [{
      id: "material-cylinder",
      materialId: "mat-aluminum-6061",
      selectionRef: "selection-cylinder-body",
      parameters: {},
      status: "complete"
    }],
    namedSelections: [
      {
        id: "selection-cylinder-body",
        name: "Cylinder",
        entityType: "body",
        geometryRefs: [{ bodyId: "body-uploaded", entityType: "body", entityId: "body-uploaded", label: "Cylinder" }],
        fingerprint: "body-uploaded-cylinder"
      },
      faceSelection(SUPPORT_SELECTION_ID, "Cylinder wall", wall),
      faceSelection(LOAD_SELECTION_ID, "Cylinder top", top)
    ],
    contacts: [],
    constraints: [{
      id: "constraint-cylinder-wall",
      type: "fixed",
      selectionRef: SUPPORT_SELECTION_ID,
      parameters: {},
      status: "complete"
    }],
    loads: [{
      id: "load-cylinder-top",
      type: "force",
      selectionRef: LOAD_SELECTION_ID,
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    }],
    meshSettings: { preset: "medium", status: "not_started" },
    solverSettings: { analysisType: "linear_static", smallDisplacement: true },
    validation: [],
    runs: []
  };
}

function faceSelection(id: string, name: string, face: StepFaceRecord): Study["namedSelections"][number] {
  return {
    id,
    name,
    entityType: "face",
    geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: face.faceId, label: face.faceId }],
    fingerprint: face.fingerprint
  };
}

function requireSelection(
  study: Study,
  selectionRef: string | undefined,
  role: string
): Study["namedSelections"][number] {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  if (!selection) throw new Error(`${role} did not retain its named selection`);
  return selection;
}

function requireGeometryFaceId(selection: Study["namedSelections"][number], role: string): string {
  const faceId = selection.geometryRefs.find((reference) => reference.entityType === "face")?.entityId;
  if (!faceId) throw new Error(`${role} selection did not retain a face reference`);
  return faceId;
}

function requireMappedAssignment(
  picked: PickedFace,
  selection: Study["namedSelections"][number],
  role: string
): void {
  requireCondition(picked.faceId === requireGeometryFaceId(selection, role), `${role} changed face identity to ${picked.faceId}`);
  requireCondition(picked.fingerprint === selection.fingerprint, `${role} changed topology fingerprint`);
}

function previewTriangleCount(object: THREE.Object3D): number {
  let count = 0;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    count += (geometry.getIndex()?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3;
  });
  return count;
}

function previewEdgeSegmentCount(object: THREE.Object3D): number {
  let count = 0;
  object.traverse((child) => {
    if (!(child instanceof THREE.LineSegments)) return;
    const positions = (child.geometry as THREE.BufferGeometry).getAttribute("position");
    count += (positions?.count ?? 0) / 2;
  });
  return count;
}

function disposeObjectTree(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments)) return;
    (child.geometry as THREE.BufferGeometry | undefined)?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material?.dispose();
  });
}

function requireFace(face: StepFaceRecord | undefined, label: string): StepFaceRecord {
  if (!face) throw new Error(`${label} was not found`);
  return face;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function renderProofResult(result: StepSelectionProofResult): void {
  let proof = document.getElementById("opencae-step-selection-proof");
  if (!proof) {
    proof = document.createElement("pre");
    proof.id = "opencae-step-selection-proof";
    proof.setAttribute("role", "status");
    proof.style.cssText = [
      "position:fixed",
      "inset:16px",
      "z-index:2147483647",
      "overflow:auto",
      "margin:0",
      "padding:20px",
      "border:2px solid #38bdf8",
      "border-radius:12px",
      "background:#07111dee",
      "color:#e0f2fe",
      "font:13px/1.5 ui-monospace,monospace",
      "white-space:pre-wrap"
    ].join(";");
    document.body.appendChild(proof);
  }
  const summary = result.scales.map((scale) => (
    `${scale.diameterMm} mm · support ${scale.supportFaceId} · load ${scale.loadFaceId} · ` +
    `triangles ${scale.detailed.triangleCount} detailed / ${scale.balanced.triangleCount} playback`
  ));
  proof.textContent = [
    `STEP selection LOD proof: ${result.ok ? "PASS" : "FAIL"}`,
    "",
    ...summary,
    ...(result.failures.length ? ["", ...result.failures] : [])
  ].join("\n");
}

declare global {
  interface Window {
    __opencaeStepSelectionProof?: {
      run: typeof runStepSelectionProof;
      lastResult?: StepSelectionProofResult;
    };
  }
}

window.__opencaeStepSelectionProof = { run: runStepSelectionProof };

if (new URLSearchParams(window.location.search).has("stepSelectionProof")) {
  void runStepSelectionProof().then((result) => {
    window.__opencaeStepSelectionProof!.lastResult = result;
    renderProofResult(result);
    document.title = `STEPSELECTION ${result.ok ? "OK" : "FAIL"} scales=${result.scales.length}`;
    console.log("[stepSelectionProof]", result);
  }).catch((error: unknown) => {
    const result: StepSelectionProofResult = {
      ok: false,
      scales: [],
      failures: [error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)]
    };
    window.__opencaeStepSelectionProof!.lastResult = result;
    renderProofResult(result);
    document.title = "STEPSELECTION FAIL";
    console.error("[stepSelectionProof]", result);
  });
}
