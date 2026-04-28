import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { inferConstraintSuggestion } from "./constraintInference";
import { queryHoveredEntity } from "./geometryQuery";
import { generateSnapCandidates } from "./snapGenerator";
import { getSnapSuggestion, smoothSnapPoint } from "./snapController";
import { selectBestSnapCandidate } from "./snapScoring";
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
      "face-projected",
      "face-closest"
    ]);
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
