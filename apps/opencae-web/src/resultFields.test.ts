import { describe, expect, test } from "vitest";
import type { DisplayFace, ResultField } from "@opencae/schema";
import { resultProbeSamplesForFaces, resultSamplesForFaces } from "./resultFields";

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
