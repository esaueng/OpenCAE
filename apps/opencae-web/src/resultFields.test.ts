import { describe, expect, test } from "vitest";
import type { DisplayFace, ResultField } from "@opencae/schema";
import { resultSamplesForFaces } from "./resultFields";

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
});
