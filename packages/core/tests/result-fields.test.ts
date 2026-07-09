import { describe, expect, test } from "vitest";
import type { ResultFieldJson } from "../src";

describe("result field metadata", () => {
  test("describes solver mesh topology and sample location for accurate visualization", () => {
    const field: ResultFieldJson = {
      name: "displacement",
      values: [0, 1, 2],
      samples: [0, 2],
      frameIndex: 0,
      timeSeconds: 0,
      meshRef: "solver-volume",
      surfaceMeshRef: "solver-surface",
      coordinateSpace: "solver",
      sampleLocation: "node"
    };

    expect(field.meshRef).toBe("solver-volume");
    expect(field.surfaceMeshRef).toBe("solver-surface");
    expect(field.sampleLocation).toBe("node");
  });
});
