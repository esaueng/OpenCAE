import type { ResultField } from "@opencae/schema";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { resultProbeCoordinateTransform, solverSurfaceProbePoint } from "./CadViewer";

describe("solver surface probe anchors", () => {
  test("follows the same deformed nodal geometry while retaining barycentric location", () => {
    const surfaceMesh = {
      id: "surface",
      nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
      triangles: [[0, 1, 2]] as [number, number, number][],
      nodeMap: [0, 1, 2]
    };
    const displacementField: ResultField = {
      id: "displacement",
      runId: "run",
      type: "displacement",
      location: "node",
      values: [1, 1, 1],
      vectors: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
      min: 1,
      max: 1,
      units: "mm",
      surfaceMeshRef: surfaceMesh.id
    };
    const anchor = {
      kind: "surface" as const,
      surfaceMeshId: surfaceMesh.id,
      triangle: [0, 1, 2] as [number, number, number],
      barycentric: [0.2, 0.3, 0.5] as [number, number, number]
    };
    const undeformed = solverSurfaceProbePoint({ surfaceMesh, anchor, displacementField, showDeformed: false, deformationScale: 1 });
    const deformed = solverSurfaceProbePoint({ surfaceMesh, anchor, displacementField, showDeformed: true, deformationScale: 1 });
    expect(undeformed).toEqual([0.3, 0.5, 0]);
    expect(deformed?.[0]).toBeCloseTo(0.3, 12);
    expect(deformed?.[1]).toBeCloseTo(0.5, 12);
    expect(deformed?.[2]).toBeGreaterThan(0);
  });

  test("round-trips sample-backed pins through the renderer's result-space transform", () => {
    const displayModel = {
      id: "uploaded-model",
      name: "Uploaded",
      bodyCount: 1,
      faces: [],
      dimensions: { x: 1000, y: 500, z: 250, units: "mm" as const }
    };
    const sampledField: ResultField = {
      id: "sampled-stress",
      runId: "run",
      type: "stress",
      location: "node",
      values: [1, 2],
      min: 1,
      max: 2,
      units: "MPa",
      samples: [
        { point: [0, 0, 0], normal: [0, 0, 1], value: 1 },
        { point: [0.001, 0.0005, 0.00025], normal: [0, 0, 1], value: 2 }
      ]
    };
    const transform = resultProbeCoordinateTransform(displayModel, [sampledField]);
    const modelPoint = new THREE.Vector3(0.4, -0.1, 0.2);
    const restored = transform?.fromResultPoint(transform.toResultPoint(modelPoint));

    expect(transform).toBeDefined();
    expect(restored?.distanceTo(modelPoint)).toBeLessThan(1e-12);
  });
});
