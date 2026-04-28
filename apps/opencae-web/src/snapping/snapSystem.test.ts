import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { inferConstraintSuggestion } from "./constraintInference";
import { queryHoveredEntity } from "./geometryQuery";
import { generateSnapCandidates } from "./snapGenerator";
import { getSnapSuggestion, smoothSnapPoint } from "./snapController";
import { selectBestSnapCandidate } from "./snapScoring";
import { snapConstructionGuides, snapIndicatorStyle, snapMeasurementGuides, snapMeasurementRuler, snapPreviewArrowStyle } from "./Visualization";
import type { CursorRay, HoveredEntity, SnapCandidate } from "./types";

function rayToward(point: [number, number, number]): CursorRay {
  const origin: [number, number, number] = [point[0], point[1], 3];
  const direction = new THREE.Vector3(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]).normalize().toArray() as [number, number, number];
  return {
    origin,
    direction,
    cursorPoint: point,
    screenPosition: { x: 200, y: 200 }
  };
}

function boxMesh() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("geometry query", () => {
  test("classifies a central ray hit as a face entity", () => {
    const hovered = queryHoveredEntity(rayToward([0, 0, 1]), {
      objects: [boxMesh()],
      thresholdWorld: 0.08
    });

    expect(hovered).toMatchObject({
      type: "face",
      position: [0, 0, 1],
      normal: [0, 0, 1]
    });
  });

  test("classifies ray hits close to box topology as edge and vertex entities", () => {
    const mesh = boxMesh();

    const edge = queryHoveredEntity(rayToward([0, 0.99, 1]), { objects: [mesh], thresholdWorld: 0.08 });
    const vertex = queryHoveredEntity(rayToward([0.99, 0.99, 1]), { objects: [mesh], thresholdWorld: 0.08 });

    expect(edge?.type).toBe("edge");
    expect(edge).toMatchObject({ faceId: expect.any(String), position: [0, 1, 1] });
    expect(vertex?.type).toBe("vertex");
    expect(vertex).toMatchObject({ faceId: expect.any(String), position: [1, 1, 1] });
  });
});

describe("snap generation and scoring", () => {
  test("generates vertex, edge, and face snap candidates", () => {
    const vertex: HoveredEntity = { type: "vertex", id: "v-1", position: [1, 1, 1], faceId: "face-top" };
    const edge: HoveredEntity = {
      type: "edge",
      id: "e-1",
      position: [0.4, 1, 1],
      faceId: "face-top",
      endpoints: [[-1, 1, 1], [1, 1, 1]]
    };
    const face: HoveredEntity = {
      type: "face",
      id: "f-1",
      position: [0, 0, 1],
      normal: [0, 0, 1],
      faceId: "face-top"
    };

    expect(generateSnapCandidates(vertex, rayToward([0.8, 0.8, 1])).map((candidate) => candidate.kind)).toEqual(["vertex"]);
    expect(generateSnapCandidates(edge, rayToward([0.4, 0.9, 1])).map((candidate) => candidate.kind)).toEqual([
      "edge-endpoint",
      "edge-endpoint",
      "edge-midpoint",
      "edge-closest"
    ]);
    expect(generateSnapCandidates(face, rayToward([0.25, 0.5, 1])).map((candidate) => candidate.kind)).toEqual([
      "face-centroid",
      "face-centerline",
      "face-centerline",
      "face-projected",
      "face-closest"
    ]);
  });

  test("generates whole-unit face snap candidates with edge distance measurements", () => {
    const face: HoveredEntity = {
      type: "face",
      id: "f-1",
      position: [0, 0, 1],
      normal: [0, 0, 1],
      faceId: "face-top",
      snapAxes: [
        { direction: [1, 0, 0], minPoint: [-1, 0, 1], maxPoint: [1, 0, 1], unitsPerWorld: 50, units: "mm", unitStep: 1 },
        { direction: [0, 1, 0], minPoint: [0, -1, 1], maxPoint: [0, 1, 1], unitsPerWorld: 50, units: "mm", unitStep: 1 }
      ]
    };

    const result = getSnapSuggestion(rayToward([0.234, 0.02, 1]), {
      objects: [boxMesh()],
      mode: "loads",
      thresholdWorld: 0.08,
      smoothingAlpha: 1,
      ownerFace: { id: "face-top", position: face.position, normal: face.normal!, snapAxes: face.snapAxes }
    });

    expect(result).toMatchObject({
      candidateKind: "face-unit",
      rawSnapPoint: [0.24, 0, 1],
      measurements: [{ label: "38 mm from edge", start: [1, 0, 1], end: [0.24, 0, 1] }]
    });
  });

  test("snaps face hits to centerlines before free projected points", () => {
    const result = getSnapSuggestion(rayToward([0.03, 0.55, 1]), {
      objects: [boxMesh()],
      mode: "loads",
      thresholdWorld: 0.08,
      smoothingAlpha: 1,
      ownerFace: { id: "face-top", position: [0, 0, 1], normal: [0, 0, 1] }
    });

    expect(result).toMatchObject({
      candidateKind: "face-centerline",
      rawSnapPoint: [0, 0.55, 1]
    });
  });

  test("selects the best candidate using distance and CAD priority", () => {
    const candidates: SnapCandidate[] = [
      { kind: "face-centroid", point: [0, 0, 0], priority: 0.02 },
      { kind: "vertex", point: [0.015, 0, 0], priority: 0 }
    ];

    const best = selectBestSnapCandidate(candidates, [0, 0, 0], { distanceWeight: 1, thresholdWorld: 0.08 });

    expect(best?.candidate.kind).toBe("vertex");
    expect(best?.score).toBeCloseTo(0.015);
  });

  test("uses pixel threshold scoring when screen projection data is available", () => {
    const candidates: SnapCandidate[] = [
      { kind: "vertex", point: [10, 0, 0], priority: 0 }
    ];

    const best = selectBestSnapCandidate(candidates, [0, 0, 0], {
      thresholdWorld: 0.08,
      thresholdPixels: 18,
      screenPosition: { x: 200, y: 200 },
      projectToScreen: () => ({ x: 210, y: 200 })
    });

    expect(best?.candidate.kind).toBe("vertex");
    expect(best?.distanceToCursor).toBe(10);
  });
});

describe("constraint inference and controller", () => {
  test("infers placement suggestions from entity type", () => {
    expect(inferConstraintSuggestion({ type: "face", id: "face-1", position: [0, 0, 1], normal: [0, 0, 1] }, "loads")).toMatchObject({
      direction: [0, 0, 1],
      suggestionType: "force"
    });
    expect(inferConstraintSuggestion({ type: "edge", id: "edge-1", position: [0, 0, 0], endpoints: [[0, 0, 0], [1, 0, 0]] }, "loads")).toMatchObject({
      direction: [1, 0, 0],
      suggestionType: "distributed"
    });
    expect(inferConstraintSuggestion({ type: "vertex", id: "vertex-1", position: [0, 0, 0] }, "supports")).toMatchObject({
      direction: [0, 0, 1],
      suggestionType: "fixed"
    });
  });

  test("returns smoothed snap results while preserving owning face ids", () => {
    const result = getSnapSuggestion(rayToward([0.99, 0.99, 1]), {
      objects: [boxMesh()],
      mode: "loads",
      thresholdWorld: 0.08,
      smoothingAlpha: 0.35
    });

    expect(result).toMatchObject({
      hovered: { type: "vertex", faceId: expect.any(String) },
      rawSnapPoint: [1, 1, 1],
      suggestionType: "force"
    });
    expect(result?.snapPoint[0]).toBeCloseTo(0.9935);
    expect(smoothSnapPoint([0, 0, 0], [10, 0, 0], 0.35)).toEqual([3.5, 0, 0]);
  });
});

describe("snap visualization guides", () => {
  test("keeps the cursor placement marker visually compact", () => {
    expect(snapIndicatorStyle({ candidateKind: "face-unit" })).toMatchObject({
      ringInnerRadius: 0.032,
      ringOuterRadius: 0.044,
      dotRadius: 0.013
    });
    expect(snapPreviewArrowStyle()).toMatchObject({
      length: 0.28,
      lineWidth: 1.45,
      opacity: 0.58,
      showHead: false
    });
  });

  test("builds face centerlines through the snap target", () => {
    const guides = snapConstructionGuides({
      hovered: { type: "face", id: "face-top", position: [0, 0, 1], normal: [0, 0, 1], faceId: "face-top" },
      snapPoint: [0.1, 0.2, 1],
      rawSnapPoint: [0, 0.2, 1],
      direction: [0, 0, 1],
      suggestionType: "force",
      candidateKind: "face-centerline",
      score: 0
    });

    expect(guides).toEqual([
      { kind: "centerline", points: [[-0.46, 0, 1], [0.46, 0, 1]], color: "#4da3ff", lineWidth: 2.2, opacity: 0.72 },
      { kind: "centerline", points: [[0, -0.46, 1], [0, 0.46, 1]], color: "#4da3ff", lineWidth: 2.2, opacity: 0.72 }
    ]);
  });

  test("exposes edge distance measurement guides", () => {
    const guides = snapMeasurementGuides({
      hovered: { type: "face", id: "face-top", position: [0, 0, 1], normal: [0, 0, 1], faceId: "face-top" },
      snapPoint: [0.24, 0, 1],
      rawSnapPoint: [0.24, 0, 1],
      direction: [0, 0, 1],
      suggestionType: "force",
      candidateKind: "face-unit",
      score: 0,
      measurements: [{ kind: "edge-distance", start: [1, 0, 1], end: [0.24, 0, 1], label: "38 mm from edge", value: 38, units: "mm" }]
    });

    expect(guides).toEqual([{ kind: "edge-distance", start: [1, 0, 1], end: [0.24, 0, 1], label: "38 mm from edge", value: 38, units: "mm" }]);
  });

  test("renders edge distance as a subtle ruler on the part", () => {
    const ruler = snapMeasurementRuler(
      { kind: "edge-distance", start: [1, 0, 1], end: [0.24, 0, 1], label: "38 mm from edge", value: 38, units: "mm" },
      [0, 0, 1]
    );

    expect(ruler.ticks).toHaveLength(3);
    expect(ruler.lineWidth).toBeLessThan(1.3);
    expect(ruler.opacity).toBeLessThan(0.7);
    expect(ruler.fontSize).toBeLessThan(0.06);
    expect(ruler.outlineWidth).toBeLessThan(0.006);
    expect(ruler.line[0][2]).toBeCloseTo(1.014);
    expect(ruler.labelPosition[1]).toBeLessThan(0);
  });

  test("builds an edge alignment line and midpoint tick at the snap target", () => {
    const guides = snapConstructionGuides({
      hovered: {
        type: "edge",
        id: "edge-1",
        position: [0, 0, 0],
        normal: [0, 0, 1],
        faceId: "face-top",
        endpoints: [[-1, 0, 0], [1, 0, 0]]
      },
      snapPoint: [0, 0, 0],
      rawSnapPoint: [0, 0, 0],
      direction: [1, 0, 0],
      suggestionType: "distributed",
      candidateKind: "edge-midpoint",
      score: 0
    });

    expect(guides).toEqual([
      { kind: "alignment", points: [[-1, 0, 0], [1, 0, 0]], color: "#63e6be", lineWidth: 3.4, opacity: 0.88 },
      { kind: "midpoint-tick", points: [[0, -0.14, 0], [0, 0.14, 0]], color: "#f8d77b", lineWidth: 3, opacity: 0.96 }
    ]);
  });
});
