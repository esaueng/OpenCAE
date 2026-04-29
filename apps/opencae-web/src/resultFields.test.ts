import { describe, expect, test } from "vitest";
import type { DisplayFace, ResultField } from "@opencae/schema";
import { fieldsForResultFrame, nextLoopedResultFrameIndex, resultFrameIndexes, resultProbeSamplesForFaces, resultSamplesForFaces } from "./resultFields";

const faces: DisplayFace[] = [
  { id: "face-a", label: "A", color: "#fff", center: [0, 0, 0], normal: [0, 1, 0], stressValue: 10 },
  { id: "face-b", label: "B", color: "#fff", center: [1, 0, 0], normal: [0, 1, 0], stressValue: 20 }
];

describe("resultSamplesForFaces", () => {
  test("maps solver field values onto display faces by face order", () => {
    const fields: ResultField[] = [
      { id: "stress", runId: "run", type: "stress", location: "face", values: [110, 240], min: 110, max: 240, units: "MPa" }
    ];

    expect(resultSamplesForFaces(faces, fields, "stress")).toEqual([
      { face: faces[0], value: 110, normalized: 0 },
      { face: faces[1], value: 240, normalized: 1 }
    ]);
  });

  test("falls back to face stress values before a solved field is available", () => {
    expect(resultSamplesForFaces(faces, [], "stress").map((sample) => sample.value)).toEqual([10, 20]);
  });

  test("ranks displacement probes by solved face value instead of fixed face order", () => {
    const cantileverFaces: DisplayFace[] = [
      { id: "face-base-left", label: "Fixed end face", color: "#fff", center: [-1.8, 0.18, 0], normal: [-1, 0, 0], stressValue: 132 },
      { id: "face-load-top", label: "Free end load face", color: "#fff", center: [1.75, 0.18, 0], normal: [1, 0, 0], stressValue: 96 },
      { id: "face-web-front", label: "Top beam face", color: "#fff", center: [0, 0.42, 0], normal: [0, 1, 0], stressValue: 74 },
      { id: "face-base-bottom", label: "Beam bottom face", color: "#fff", center: [0, -0.08, 0], normal: [0, -1, 0], stressValue: 46 }
    ];
    const fields: ResultField[] = [
      { id: "displacement", runId: "run", type: "displacement", location: "face", values: [0.131, 12.559, 4.384, 1.2], min: 0.131, max: 12.559, units: "mm" }
    ];

    expect(resultProbeSamplesForFaces(cantileverFaces, fields, "displacement").map((probe) => [probe.tone, probe.face.id, probe.label])).toEqual([
      ["max", "face-load-top", "Disp: 12.559 mm"],
      ["mid", "face-web-front", "Disp: 4.384 mm"],
      ["min", "face-base-left", "Disp: 0.131 mm"]
    ]);
  });
});

describe("dynamic result frames", () => {
  test("sorts frame indexes and wraps playback to the first frame", () => {
    const fields: ResultField[] = [
      { id: "stress-2", runId: "run", type: "stress", location: "face", values: [3], min: 3, max: 3, units: "MPa", frameIndex: 2, timeSeconds: 0.01 },
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [2], min: 2, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ];

    const indexes = resultFrameIndexes(fields);

    expect(indexes).toEqual([0, 1, 2]);
    expect(nextLoopedResultFrameIndex(indexes, 0)).toBe(1);
    expect(nextLoopedResultFrameIndex(indexes, 2)).toBe(0);
    expect(nextLoopedResultFrameIndex(indexes, 99)).toBe(0);
  });

  test("renormalizes visible dynamic fields to the active frame range", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [0, 399.2], min: 0, max: 399.2, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [60.3, 327.5], min: 0, max: 399.2, units: "MPa", frameIndex: 1, timeSeconds: 0.025 }
    ];

    const visible = fieldsForResultFrame(fields, 1);

    expect(visible[0]).toMatchObject({ min: 60.3, max: 327.5 });
    expect(resultSamplesForFaces(faces, visible, "stress").map((sample) => sample.normalized)).toEqual([0, 1]);
  });
});
