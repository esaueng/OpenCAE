import type { Study } from "@opencae/schema";
import type { StepBodyBounds } from "@opencae/mesh-intake";
import { payloadObjectForLoad } from "./loadPreview";
import {
  nearestStepFaceIdOnMeshes,
  stepBodyBoundsForMesh,
  stepFaceRecordForId,
  stepMeshIndexFromObjectId,
  type StepFaceRegistry
} from "./stepFaces";

/**
 * Internal meshing plan for a STEP assembly whose disconnected carried parts
 * are represented as payload loads. It is deliberately not persisted into
 * the user's study: the assembly stays visible and its original selections
 * remain editable after the solve.
 */
export type StepStructuralBodyPlan = {
  structuralMeshIndices: number[];
  structuralBodyBounds: StepBodyBounds[];
  excludedBodyCount: number;
  payloadContactFaceByLoadId: Record<string, string>;
};

/**
 * Identify the one connected structural body from its support/non-payload
 * selections. Payload object bodies and unselected disconnected bodies are
 * excluded from tetrahedral meshing, while their selected weights are mapped
 * onto the retained body at the closest physical contact face.
 */
export function planStepStructuralBodies(study: Study, registry: StepFaceRegistry): StepStructuralBodyPlan | null {
  const nonEmptyMeshIndices = registry.meshes
    .map((mesh, meshIndex) => ({ mesh, meshIndex }))
    .filter(({ mesh }) => mesh.positions.length >= 3)
    .map(({ meshIndex }) => meshIndex);
  if (nonEmptyMeshIndices.length <= 1) return null;

  const payloadLoads = study.loads
    .map((load) => ({ load, payload: payloadObjectForLoad(load) }))
    .filter(({ load, payload }) => load.type === "gravity" && stepMeshIndexFromObjectId(payload?.id) !== null);
  if (payloadLoads.length === 0) return null;

  const structuralMeshIndices = new Set<number>();
  const structuralSelectionRefs = [
    ...study.constraints.map((constraint) => constraint.selectionRef),
    ...study.loads.filter((load) => load.type !== "gravity").map((load) => load.selectionRef)
  ];
  for (const selectionRef of structuralSelectionRefs) {
    const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
    for (const ref of selection?.geometryRefs ?? []) {
      const face = stepFaceRecordForId(registry, ref.entityId);
      if (face) structuralMeshIndices.add(face.meshIndex);
    }
  }

  // The current solver has no bonded/contact interface model. Isolating more
  // than one structural body would only recreate the disconnected-component
  // failure, so activate this workflow only when the study identifies one.
  if (structuralMeshIndices.size !== 1) return null;
  const structural = [...structuralMeshIndices];
  const structuralBodyBounds = structural
    .map((meshIndex) => stepBodyBoundsForMesh(registry, meshIndex))
    .filter((bounds): bounds is StepBodyBounds => Boolean(bounds));
  if (structuralBodyBounds.length !== structural.length) return null;

  const payloadContactFaceByLoadId: Record<string, string> = {};
  for (const load of study.loads) {
    if (load.type !== "gravity") continue;
    const payload = payloadObjectForLoad(load);
    const payloadMeshIndex = stepMeshIndexFromObjectId(payload?.id);
    const selectionMeshIndex = meshIndexForSelection(study, registry, load.selectionRef);
    const excludedSelection = selectionMeshIndex !== null && !structuralMeshIndices.has(selectionMeshIndex);
    if (payloadMeshIndex === null) {
      // An ordinary gravity load already applied to the structural body is
      // safe to retain. A load on an excluded body cannot be remapped without
      // a stable payload-object identity, so leave the legacy failure honest.
      if (excludedSelection) return null;
      continue;
    }
    if (structuralMeshIndices.has(payloadMeshIndex)) continue;
    const bounds = stepBodyBoundsForMesh(registry, payloadMeshIndex);
    if (!bounds) return null;
    const direction = normalizedDirection(load.parameters.direction);
    const contactPoint = supportPointOnBounds(bounds, direction);
    const preferredNormal: [number, number, number] = [-direction[0], -direction[1], -direction[2]];
    const faceId = nearestStepFaceIdOnMeshes(registry, contactPoint, structural, preferredNormal);
    if (!faceId) return null;
    payloadContactFaceByLoadId[load.id] = faceId;
  }

  if (Object.keys(payloadContactFaceByLoadId).length === 0) return null;
  return {
    structuralMeshIndices: structural,
    structuralBodyBounds,
    excludedBodyCount: nonEmptyMeshIndices.length - structural.length,
    payloadContactFaceByLoadId
  };
}

/** Apply contact-face substitutions only to the study used to build the Core model. */
export function studyWithStepPayloadContacts(
  study: Study,
  registry: StepFaceRegistry,
  plan: StepStructuralBodyPlan
): Study {
  const contactSelections = Object.entries(plan.payloadContactFaceByLoadId).map(([loadId, faceId]) => {
    const displayFace = registry.displayFaces.find((face) => face.id === faceId);
    return {
      id: payloadContactSelectionId(loadId),
      name: `Payload contact · ${displayFace?.label ?? faceId}`,
      entityType: "face" as const,
      geometryRefs: [{
        bodyId: "body-uploaded",
        entityType: "face" as const,
        entityId: faceId,
        label: displayFace?.label ?? faceId
      }],
      fingerprint: `payload-contact:${faceId}`
    };
  });
  const replacedSelectionIds = new Set(contactSelections.map((selection) => selection.id));
  return {
    ...study,
    namedSelections: [
      ...study.namedSelections.filter((selection) => !replacedSelectionIds.has(selection.id)),
      ...contactSelections
    ],
    loads: study.loads.map((load) => {
      if (!plan.payloadContactFaceByLoadId[load.id]) return load;
      return { ...load, selectionRef: payloadContactSelectionId(load.id) };
    })
  };
}

export function stepStructuralBodyWarning(plan: StepStructuralBodyPlan): string {
  const count = plan.excludedBodyCount;
  return `Meshed the supported structural STEP body only; ${count.toLocaleString()} disconnected ${count === 1 ? "body was" : "bodies were"} treated as carried payload/visual geometry. Add a payload mass for every excluded body whose weight should be included.`;
}

function meshIndexForSelection(study: Study, registry: StepFaceRegistry, selectionRef: string): number | null {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  for (const ref of selection?.geometryRefs ?? []) {
    const face = stepFaceRecordForId(registry, ref.entityId);
    if (face) return face.meshIndex;
  }
  return null;
}

function normalizedDirection(value: unknown): [number, number, number] {
  const direction = Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component))
    ? value as [number, number, number]
    : [0, 0, -1] as [number, number, number];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return length > 1e-12
    ? [direction[0] / length, direction[1] / length, direction[2] / length]
    : [0, 0, -1];
}

function supportPointOnBounds(bounds: StepBodyBounds, direction: [number, number, number]): [number, number, number] {
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
  const halfSize = [
    (bounds.max[0] - bounds.min[0]) / 2,
    (bounds.max[1] - bounds.min[1]) / 2,
    (bounds.max[2] - bounds.min[2]) / 2
  ];
  let distance = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const component = Math.abs(direction[axis]!);
    if (component > 1e-12) distance = Math.min(distance, halfSize[axis]! / component);
  }
  if (!Number.isFinite(distance)) return center;
  return [
    center[0] + direction[0] * distance,
    center[1] + direction[1] * distance,
    center[2] + direction[2] * distance
  ];
}

function payloadContactSelectionId(loadId: string): string {
  return `selection-payload-contact-${loadId}`;
}
