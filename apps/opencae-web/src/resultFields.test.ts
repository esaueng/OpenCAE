import { describe, expect, test } from "vitest";
import type { DisplayFace, ResultField, ResultSummary } from "@opencae/schema";
import {
  createPackedResultPlaybackCache,
  createResultFrameCache,
  dynamicPlaybackFrames,
  fieldsForResultFrame,
  hasDynamicPlaybackFrames,
  interpolatedFieldsForFramePosition,
  nextLoopedResultFrameIndex,
  normalizeTransientFieldRanges,
  normalizeValueForRender,
  packedResultPlaybackTransferables,
  resultFrameIndexes,
  resultProbeSamplesForFaces,
  resultSamplesForFaces
} from "./resultFields";

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

  test("uses nodal CalculiX samples when face fields are not present", () => {
    const fields: ResultField[] = [
      {
        id: "stress-node",
        runId: "run",
        type: "stress",
        location: "node",
        values: [0, 140],
        min: 0,
        max: 140,
        units: "MPa",
        samples: [
          { point: [0, 0, 0], normal: [0, 1, 0], value: 0 },
          { point: [1, 0, 0], normal: [0, 1, 0], value: 140 }
        ]
      }
    ];

    const samples = resultSamplesForFaces(faces, fields, "stress");

    expect(samples.map((sample) => sample.value)).toEqual([0, 140]);
    expect(samples[0]?.fieldSamples?.map((sample) => sample.value)).toEqual([0, 140]);
  });

  test("does not blindly index a short node field across a larger face array or mix static stress fallback", () => {
    const manyFaces: DisplayFace[] = [
      ...faces,
      { id: "face-c", label: "C", color: "#fff", center: [2, 0, 0], normal: [0, 1, 0], stressValue: 999 },
      { id: "face-d", label: "D", color: "#fff", center: [3, 0, 0], normal: [0, 1, 0], stressValue: 888 },
      { id: "face-e", label: "E", color: "#fff", center: [4, 0, 0], normal: [0, 1, 0], stressValue: 777 }
    ];
    const fields: ResultField[] = [
      {
        id: "stress-node",
        runId: "run",
        type: "stress",
        location: "node",
        values: [1, 2, 3, 4],
        min: 0,
        max: 10,
        units: "MPa"
      }
    ];

    const samples = resultSamplesForFaces(manyFaces, fields, "stress");

    expect(samples.map((sample) => sample.value)).toEqual([0, 0, 0, 0, 0]);
    expect(samples.map((sample) => sample.normalized)).toEqual([0, 0, 0, 0, 0]);
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
  const dynamicSummary: ResultSummary = {
    maxStress: 100,
    maxStressUnits: "MPa",
    maxDisplacement: 1,
    maxDisplacementUnits: "mm",
    safetyFactor: 2,
    reactionForce: 500,
    reactionForceUnits: "N",
    transient: {
      analysisType: "dynamic_structural",
      integrationMethod: "newmark_average_acceleration",
      startTime: 0,
      endTime: 0.005,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0.02,
      frameCount: 2,
      peakDisplacementTimeSeconds: 0.005,
      peakDisplacement: 1
    }
  };

  test("detects dynamic playback frames only when result fields carry timed frame metadata", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [1], min: 0, max: 2, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [2], min: 0, max: 2, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ];

    expect(dynamicPlaybackFrames(fields)).toEqual([
      { frameIndex: 0, timeSeconds: 0 },
      { frameIndex: 1, timeSeconds: 0.005 }
    ]);
    expect(hasDynamicPlaybackFrames(dynamicSummary, fields)).toBe(true);
  });

  test("rejects static-looking dynamic results without multi-frame timed fields", () => {
    const unframedFields: ResultField[] = [
      { id: "stress", runId: "run", type: "stress", location: "face", values: [1], min: 1, max: 1, units: "MPa" }
    ];
    const missingTimeFields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [1], min: 0, max: 2, units: "MPa", frameIndex: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [2], min: 0, max: 2, units: "MPa", frameIndex: 1 }
    ];

    expect(hasDynamicPlaybackFrames(dynamicSummary, unframedFields)).toBe(false);
    expect(hasDynamicPlaybackFrames({ ...dynamicSummary, transient: undefined }, missingTimeFields)).toBe(false);
    expect(hasDynamicPlaybackFrames(dynamicSummary, missingTimeFields)).toBe(false);
    expect(hasDynamicPlaybackFrames({ ...dynamicSummary, transient: { ...dynamicSummary.transient!, frameCount: 1 } }, [
      { ...missingTimeFields[0]!, timeSeconds: 0 },
      { ...missingTimeFields[1]!, timeSeconds: 0.005 }
    ])).toBe(false);
  });

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

  test("preserves global dynamic field ranges for visible playback frames", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [0, 399.2], min: 0, max: 399.2, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [60.3, 327.5], min: 0, max: 399.2, units: "MPa", frameIndex: 1, timeSeconds: 0.025 }
    ];

    const visible = fieldsForResultFrame(fields, 1);

    expect(visible[0]).toMatchObject({ min: 0, max: 399.2 });
    expect(resultSamplesForFaces(faces, visible, "stress").map((sample) => sample.normalized)).toEqual([
      60.3 / 399.2,
      327.5 / 399.2
    ]);
  });

  test("normalizeTransientFieldRanges keeps identical min and max for all stress frames", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "node", values: [0, 20], min: 0, max: 20, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "node", values: [0, 100], min: 0, max: 100, units: "MPa", frameIndex: 1, timeSeconds: 0.005 },
      { id: "stress-2", runId: "run", type: "stress", location: "node", values: [0, 50], min: 0, max: 50, units: "MPa", frameIndex: 2, timeSeconds: 0.01 }
    ];

    const normalized = normalizeTransientFieldRanges(fields);

    expect(normalized.map((field) => [field.min, field.max])).toEqual([[0, 100], [0, 100], [0, 100]]);
  });

  test("interpolated dynamic fields retain global normalized min and max", () => {
    const fields = normalizeTransientFieldRanges([
      { id: "stress-0", runId: "run", type: "stress", location: "node", values: [0, 20], min: 0, max: 20, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "node", values: [0, 100], min: 0, max: 100, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ] satisfies ResultField[]);

    const interpolated = interpolatedFieldsForFramePosition(fields, 0.5);

    expect(interpolated[0]).toMatchObject({ values: [0, 60], min: 0, max: 100 });
  });

  test("same scalar value maps to the same normalized value at every dynamic frame", () => {
    const fields = normalizeTransientFieldRanges([
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [50, 20], min: 0, max: 50, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [50, 100], min: 50, max: 100, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ] satisfies ResultField[]);

    const first = resultSamplesForFaces(faces, fieldsForResultFrame(fields, 0), "stress")[0]?.normalized;
    const second = resultSamplesForFaces(faces, fieldsForResultFrame(fields, 1), "stress")[0]?.normalized;

    expect(first).toBe(0.5);
    expect(second).toBe(0.5);
  });

  test("keeps static fields locally scaled when building a non-framed result cache", () => {
    const fields: ResultField[] = [
      { id: "stress", runId: "run", type: "stress", location: "face", values: [5, 15], min: 0, max: 100, units: "MPa" }
    ];

    const visible = createResultFrameCache(fields).fieldsForFrame(0);

    expect(visible[0]).toMatchObject({ min: 5, max: 15 });
  });

  test("caches visible fields by frame to avoid repeat playback allocations", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [0, 10], min: 0, max: 10, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [5, 15], min: 0, max: 15, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ];
    const cache = createResultFrameCache(fields);

    const first = cache.fieldsForFrame(1);
    const second = cache.fieldsForFrame(1);

    expect(first).toBe(second);
    expect(cache.frameIndexes).toEqual([0, 1]);
  });

  test("interpolates visual fields between adjacent dynamic frames with stable global scaling", () => {
    const fields: ResultField[] = [
      {
        id: "stress-0",
        runId: "run",
        type: "stress",
        location: "face",
        values: [10, 30],
        min: 0,
        max: 100,
        units: "MPa",
        samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 20 }],
        frameIndex: 0,
        timeSeconds: 0
      },
      {
        id: "stress-1",
        runId: "run",
        type: "stress",
        location: "face",
        values: [30, 70],
        min: 0,
        max: 100,
        units: "MPa",
        samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 60 }],
        frameIndex: 1,
        timeSeconds: 0.005
      }
    ];

    const visible = interpolatedFieldsForFramePosition(fields, 0.5);

    expect(visible[0]).toMatchObject({
      values: [20, 50],
      min: 0,
      max: 100,
      timeSeconds: 0.0025
    });
    expect(visible[0]?.samples?.[0]?.value).toBe(40);
  });

  test("interpolates displacement sample vectors between adjacent dynamic frames", () => {
    const fields: ResultField[] = [
      {
        id: "displacement-0",
        runId: "run",
        type: "displacement",
        location: "node",
        values: [0],
        min: 0,
        max: 10,
        units: "mm",
        samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 0, vector: [0, 0, 0] }],
        frameIndex: 0,
        timeSeconds: 0
      },
      {
        id: "displacement-1",
        runId: "run",
        type: "displacement",
        location: "node",
        values: [10],
        min: 0,
        max: 10,
        units: "mm",
        samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 10, vector: [0, -10, 2] }],
        frameIndex: 1,
        timeSeconds: 0.005
      }
    ];

    const visible = interpolatedFieldsForFramePosition(fields, 0.5);

    expect(visible[0]?.samples?.[0]?.value).toBe(5);
    expect(visible[0]?.samples?.[0]?.vector).toEqual([0, -5, 1]);
  });

  test("interpolates playback fields from the frame cache without changing discrete cached frames", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [10, 30], min: 0, max: 100, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [30, 70], min: 0, max: 100, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ];
    const cache = createResultFrameCache(fields);

    const frameOneBefore = cache.fieldsForFrame(1);
    const visible = cache.fieldsForFramePosition(0.5);
    const frameOneAfter = cache.fieldsForFrame(1);

    expect(visible[0]).toMatchObject({ values: [20, 50], min: 0, max: 100, timeSeconds: 0.0025 });
    expect(frameOneAfter).toBe(frameOneBefore);
  });

  test("interpolates sparse cached frame positions against adjacent available frames", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [0], min: 0, max: 100, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-4", runId: "run", type: "stress", location: "face", values: [100], min: 0, max: 100, units: "MPa", frameIndex: 4, timeSeconds: 0.02 }
    ];
    const cache = createResultFrameCache(fields);

    expect(cache.frameIndexes).toEqual([0, 4]);
    expect(cache.fieldsForFramePosition(2)[0]).toMatchObject({ values: [50], timeSeconds: 0.01 });
    expect(cache.timeForFramePosition(2)).toBe(0.01);
  });

  test("prepares dynamic playback values in a packed Float32Array cache", () => {
    const fields: ResultField[] = [
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [10, 30], min: 0, max: 100, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [30, 70], min: 0, max: 100, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ];

    const cache = createPackedResultPlaybackCache(fields);

    expect(cache).not.toBeNull();
    expect(cache?.values).toBeInstanceOf(Float32Array);
    expect(cache?.frameIndexes).toBeInstanceOf(Int32Array);
    expect(cache?.times).toBeInstanceOf(Float32Array);
    expect(cache?.fieldOffsets).toBeInstanceOf(Int32Array);
    expect(cache?.fieldLengths).toBeInstanceOf(Int32Array);
    expect(cache?.fieldMins).toBeInstanceOf(Float32Array);
    expect(cache?.fieldMaxes).toBeInstanceOf(Float32Array);
    const visible = cache?.fieldsForFramePosition(0.5)[0];
    expect(visible).toMatchObject({
      values: [20, 50],
      min: 0,
      max: 100
    });
    expect(visible?.timeSeconds).toBeCloseTo(0.0025, 8);
  });

  test("packed playback cache preserves displacement sample vectors", () => {
    const cache = createPackedResultPlaybackCache([
      {
        id: "displacement-0",
        runId: "run",
        type: "displacement",
        location: "node",
        values: [0],
        min: 0,
        max: 10,
        units: "mm",
        samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 0, vector: [0, 0, 0] }],
        frameIndex: 0,
        timeSeconds: 0
      },
      {
        id: "displacement-1",
        runId: "run",
        type: "displacement",
        location: "node",
        values: [10],
        min: 0,
        max: 10,
        units: "mm",
        samples: [{ point: [0, 0, 0], normal: [0, 1, 0], value: 10, vector: [0, -10, 2] }],
        frameIndex: 1,
        timeSeconds: 0.005
      }
    ]);

    expect(cache).not.toBeNull();
    expect(cache?.sampleVectors).toBeInstanceOf(Float32Array);
    expect(cache?.fieldsForFrame(1)[0]?.samples?.[0]?.vector).toEqual([0, -10, 2]);
    expect(cache?.fieldsForFramePosition(0.5)[0]?.samples?.[0]?.vector).toEqual([0, -5, 1]);
  });

  test("normalizes zero-range render fields to the low end instead of midpoint yellow", () => {
    expect(normalizeValueForRender(12, 12, 12)).toBe(0);
    expect(normalizeValueForRender(Number.NaN, 12, 12)).toBe(0);
  });

  test("packed playback transferables include every backing buffer", () => {
    const cache = createPackedResultPlaybackCache([
      { id: "stress-0", runId: "run", type: "stress", location: "face", values: [10, 30], min: 0, max: 100, units: "MPa", frameIndex: 0, timeSeconds: 0 },
      { id: "stress-1", runId: "run", type: "stress", location: "face", values: [30, 70], min: 0, max: 100, units: "MPa", frameIndex: 1, timeSeconds: 0.005 }
    ]);

    expect(cache).not.toBeNull();
    const transferables = packedResultPlaybackTransferables(cache!);

    expect(transferables).toEqual(expect.arrayContaining([
      cache!.frameIndexes.buffer,
      cache!.times.buffer,
      cache!.fieldOffsets.buffer,
      cache!.fieldLengths.buffer,
      cache!.fieldMins.buffer,
      cache!.fieldMaxes.buffer,
      cache!.values.buffer
    ]));
  });
});
