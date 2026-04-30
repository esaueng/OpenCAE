import type { ResultField } from "@opencae/schema";
import { describe, expect, test } from "vitest";
import {
  hydratePreparedPlaybackFrame,
  packResultFieldsForPlayback,
  packedPreparedPlaybackFieldSlot,
  packedResultFieldsForPlaybackTransferables,
  planPlaybackFrameCache,
  preparePlaybackFrames,
  playbackFieldsForResultMode,
  preparedPlaybackTransferables,
  unpackResultFieldsForPlayback,
  playbackMemoryBudgetBytes
} from "./resultPlaybackCache";
import { resultSamplesForFaces } from "./resultFields";
import type { DisplayFace } from "@opencae/schema";

function resultField(frameIndex: number, values: number[]): ResultField {
  return {
    id: `stress-${frameIndex}`,
    runId: "run-1",
    type: "stress",
    location: "face",
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    units: "MPa",
    frameIndex,
    timeSeconds: frameIndex * 0.01
  };
}

function typedResultField(frameIndex: number, type: ResultField["type"], values: number[]): ResultField {
  return {
    ...resultField(frameIndex, values),
    id: `${type}-${frameIndex}`,
    type,
    units: type === "displacement" ? "mm" : type === "safety_factor" ? "" : "MPa"
  };
}

describe("result playback cache", () => {
  test("uses the desktop memory budget unless device memory is constrained", () => {
    expect(playbackMemoryBudgetBytes(8)).toBe(192 * 1024 * 1024);
    expect(playbackMemoryBudgetBytes(2)).toBe(64 * 1024 * 1024);
  });

  test("chooses full 60 fps presentation frames when they fit", () => {
    const fields = [resultField(0, [1, 2]), resultField(1, [3, 4]), resultField(2, [5, 6])];

    const plan = planPlaybackFrameCache({
      fields,
      frameIndexes: [0, 1, 2],
      playbackFps: 30,
      budgetBytes: 100_000
    });

    expect(plan.mode).toBe("full");
    expect(plan.presentationFps).toBe(60);
    expect(plan.framePositions.length).toBeGreaterThan(3);
  });

  test("falls back through reduced fps and integer solver frames before disabling cache", () => {
    const fields = [resultField(0, Array(100).fill(1)), resultField(1, Array(100).fill(2))];

    expect(planPlaybackFrameCache({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 3_600 }).mode).toBe("reducedFps");
    expect(planPlaybackFrameCache({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 1_900 }).mode).toBe("integerFrames");
    expect(planPlaybackFrameCache({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 900 }).mode).toBe("fallback");
  });

  test("prepares transferable typed-array frames and a packed Float32 playback buffer", () => {
    const prepared = preparePlaybackFrames({
      fields: [resultField(0, [0, 10]), resultField(1, [10, 30])],
      frameIndexes: [0, 1],
      playbackFps: 30,
      budgetBytes: 100_000
    });

    expect(prepared.mode).toBe("full");
    expect(prepared.frames[0]?.fields[0]?.values).toBeInstanceOf(Float32Array);
    expect(prepared.packed?.values).toBeInstanceOf(Float32Array);
    expect(prepared.packed?.framePositions).toBeInstanceOf(Float32Array);
    expect(prepared.actualBytes).toBeGreaterThan(0);

    const halfway = prepared.frames.find((frame) => Math.abs(frame.framePosition - 0.5) < 0.001);
    expect(halfway).toBeTruthy();
    expect(hydratePreparedPlaybackFrame(halfway!).fields[0]?.values).toEqual([5, 20]);
  });

  test("packs and unpacks worker playback input without losing frames or selected field values", () => {
    const fields = [
      resultField(0, [0, 10]),
      { ...resultField(0, [1, 2]), id: "disp-0", type: "displacement" as const, units: "mm" },
      resultField(1, [20, 40]),
      { ...resultField(1, [3, 4]), id: "disp-1", type: "displacement" as const, units: "mm" }
    ];

    const packed = packResultFieldsForPlayback(fields);

    expect(packed).not.toBeNull();
    expect(packed?.frameIndexes).toBeInstanceOf(Int32Array);
    expect(packed?.values).toBeInstanceOf(Float32Array);
    expect(packed?.frameCount).toBe(2);
    expect(packed?.fieldCount).toBe(2);

    const unpacked = unpackResultFieldsForPlayback(packed!);
    expect(unpacked).toHaveLength(4);
    expect(unpacked.filter((field) => field.type === "stress").map((field) => field.frameIndex)).toEqual([0, 1]);
    expect(unpacked.find((field) => field.type === "displacement" && field.frameIndex === 1)?.values).toEqual([3, 4]);
  });

  test("packed playback input preserves dense sample buffers", () => {
    const fields = [
      {
        ...resultField(0, [10, 20]),
        samples: [
          { point: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: 10 },
          { point: [1, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: 20 }
        ]
      },
      {
        ...resultField(1, [20, 40]),
        samples: [
          { point: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: 20 },
          { point: [1, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: 40 }
        ]
      }
    ];

    const packed = packResultFieldsForPlayback(fields);

    expect(packed?.sampleValues).toBeInstanceOf(Float32Array);
    expect(packed?.samplePoints).toBeInstanceOf(Float32Array);
    expect(packed?.sampleNormals).toBeInstanceOf(Float32Array);
    expect(unpackResultFieldsForPlayback(packed!)[1]?.samples?.map((sample) => sample.value)).toEqual([20, 40]);
    expect(packedResultFieldsForPlaybackTransferables(packed!)).toEqual(expect.arrayContaining([
      packed!.sampleOffsets.buffer,
      packed!.sampleLengths.buffer,
      packed!.sampleValues.buffer,
      packed!.samplePoints.buffer,
      packed!.sampleNormals.buffer
    ]));
  });

  test("prepares playback frames from packed worker input while preserving memory budget planning", () => {
    const fields = [resultField(0, [0, 10]), resultField(1, [10, 30])];
    const packedFields = packResultFieldsForPlayback(fields);

    expect(packedFields).not.toBeNull();
    expect(planPlaybackFrameCache({ packedFields: packedFields!, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 100_000 }).mode).toBe("full");

    const prepared = preparePlaybackFrames({
      packedFields: packedFields!,
      frameIndexes: [0, 1],
      playbackFps: 30,
      budgetBytes: 100_000
    });

    expect(prepared.frameCount).toBeGreaterThan(2);
    expect(prepared.frames[0]?.fields[0]?.values).toBeInstanceOf(Float32Array);
    expect(hydratePreparedPlaybackFrame(prepared.frames[0]!).fields[0]?.values).toEqual([0, 10]);
  });

  test("includes every packed playback buffer in worker transferables", () => {
    const prepared = preparePlaybackFrames({
      fields: [resultField(0, [0, 10]), resultField(1, [10, 30])],
      frameIndexes: [0, 1],
      playbackFps: 30,
      budgetBytes: 100_000
    });

    expect(prepared.packed).toBeTruthy();

    const transferables = preparedPlaybackTransferables(prepared);

    expect(transferables).toEqual(expect.arrayContaining([
      prepared.packed!.framePositions.buffer,
      prepared.packed!.frameIndexes.buffer,
      prepared.packed!.times.buffer,
      prepared.packed!.fieldOffsets.buffer,
      prepared.packed!.fieldLengths.buffer,
      prepared.packed!.fieldMins.buffer,
      prepared.packed!.fieldMaxes.buffer,
      prepared.packed!.values.buffer,
      prepared.packed!.sampleOffsets.buffer,
      prepared.packed!.sampleLengths.buffer,
      prepared.packed!.sampleValues.buffer,
      prepared.packed!.samplePoints.buffer,
      prepared.packed!.sampleNormals.buffer
    ]));
  });

  test("prepares a smaller playback cache for the selected result mode plus displacement", () => {
    const fields = [0, 1].flatMap((frameIndex) => [
      typedResultField(frameIndex, "stress", [10 + frameIndex, 20 + frameIndex]),
      typedResultField(frameIndex, "displacement", [0.1 + frameIndex, 0.2 + frameIndex]),
      typedResultField(frameIndex, "velocity", [1 + frameIndex, 2 + frameIndex]),
      typedResultField(frameIndex, "acceleration", [3 + frameIndex, 4 + frameIndex]),
      typedResultField(frameIndex, "safety_factor", [5 + frameIndex, 6 + frameIndex])
    ]);

    const selectedFields = playbackFieldsForResultMode(fields, "stress");
    const allModeCache = preparePlaybackFrames({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 100_000 });
    const selectedModeCache = preparePlaybackFrames({ fields: selectedFields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 100_000 });

    expect(new Set(selectedFields.map((field) => field.type))).toEqual(new Set(["stress", "displacement"]));
    expect(selectedModeCache.packed?.fieldDescriptors.map((descriptor) => descriptor.type).sort()).toEqual(["displacement", "stress"]);
    expect(selectedModeCache.actualBytes).toBeLessThan(allModeCache.actualBytes);
  });

  test("falls back to all playback fields when the selected result mode is unavailable", () => {
    const fields = [0, 1].flatMap((frameIndex) => [
      typedResultField(frameIndex, "stress", [10 + frameIndex]),
      typedResultField(frameIndex, "displacement", [0.1 + frameIndex])
    ]);

    expect(playbackFieldsForResultMode(fields, "velocity")).toBe(fields);
  });

  test("packedPreparedPlaybackFieldSlot retrieves node sample fields when no face field exists", () => {
    const fields: ResultField[] = [0, 1].map((frameIndex) => ({
      ...resultField(frameIndex, [frameIndex, frameIndex + 10]),
      location: "node" as const,
      samples: [
        { point: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: frameIndex },
        { point: [1, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: frameIndex + 10 }
      ]
    }));
    const prepared = preparePlaybackFrames({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 100_000 });

    const slot = packedPreparedPlaybackFieldSlot(prepared.packed!, 0, "stress");

    expect(slot?.descriptor.location).toBe("node");
    expect(slot?.sampleLength).toBe(2);
  });

  test("manual frame and packed frame return the same normalized color values for node samples", () => {
    const displayFaces: DisplayFace[] = [
      { id: "left", label: "Left", color: "#fff", center: [0, 0, 0], normal: [0, 1, 0], stressValue: 999 },
      { id: "right", label: "Right", color: "#fff", center: [1, 0, 0], normal: [0, 1, 0], stressValue: 888 }
    ];
    const fields: ResultField[] = [0, 1].map((frameIndex) => ({
      ...resultField(frameIndex, [0, 100]),
      location: "node" as const,
      min: 0,
      max: 100,
      samples: [
        { point: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: 0 },
        { point: [1, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], value: 100 }
      ]
    }));
    const manual = resultSamplesForFaces(displayFaces, fields.filter((field) => field.frameIndex === 1), "stress");
    const prepared = preparePlaybackFrames({ fields, frameIndexes: [0, 1], playbackFps: 30, budgetBytes: 100_000 });
    const slot = packedPreparedPlaybackFieldSlot(prepared.packed!, 1, "stress")!;
    const packedField: ResultField = {
      ...slot.descriptor,
      id: "packed-stress",
      values: Array.from(slot.values.slice(slot.offset, slot.offset + slot.length)),
      min: slot.min,
      max: slot.max,
      samples: Array.from({ length: slot.sampleLength }, (_, index) => {
        const packedIndex = slot.sampleOffset + index;
        const pointOffset = packedIndex * 3;
        return {
          point: [slot.samplePoints[pointOffset] ?? 0, slot.samplePoints[pointOffset + 1] ?? 0, slot.samplePoints[pointOffset + 2] ?? 0] as [number, number, number],
          normal: [slot.sampleNormals[pointOffset] ?? 0, slot.sampleNormals[pointOffset + 1] ?? 0, slot.sampleNormals[pointOffset + 2] ?? 0] as [number, number, number],
          value: slot.sampleValues[packedIndex] ?? 0
        };
      })
    };

    const packed = resultSamplesForFaces(displayFaces, [packedField], "stress");

    expect(packed.map((sample) => sample.normalized)).toEqual(manual.map((sample) => sample.normalized));
  });
});
