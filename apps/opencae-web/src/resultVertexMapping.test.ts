import { describe, expect, test } from "vitest";
import { createVertexResultMapping } from "./resultVertexMapping";

describe("result vertex mapping", () => {
  test("uses exact sample matches before weighted neighbors", () => {
    const mapping = createVertexResultMapping({
      basePositions: new Float32Array([0, 0, 0, 0.25, 0, 0]),
      samples: [
        { point: [0, 0, 0], value: 10 },
        { point: [1, 0, 0], value: 20 }
      ]
    });

    expect(mapping.weightsByVertex[0]).toEqual([{ sampleIndex: 0, weight: 1 }]);
    expect(mapping.weightsByVertex[1]?.map((weight) => weight.sampleIndex)).toEqual([0, 1]);
    expect(mapping.weightsByVertex[1]?.reduce((sum, weight) => sum + weight.weight, 0)).toBeCloseTo(1);
  });

  test("caps each vertex to the requested neighbor count", () => {
    const samples = Array.from({ length: 32 }, (_, index) => ({ point: [index, 0, 0] as [number, number, number], value: index }));

    const mapping = createVertexResultMapping({
      basePositions: new Float32Array([0.35, 0, 0]),
      samples,
      maxNeighbors: 8
    });

    expect(mapping.weightsByVertex[0]).toHaveLength(8);
  });

  test("applies 50k precomputed vertex mappings with simple weighted loops", () => {
    const vertexCount = 50_000;
    const basePositions = new Float32Array(vertexCount * 3);
    for (let index = 0; index < vertexCount; index += 1) {
      const offset = index * 3;
      basePositions[offset] = index / vertexCount;
      basePositions[offset + 1] = Math.sin(index * 0.01) * 0.01;
      basePositions[offset + 2] = 0;
    }
    const samples = Array.from({ length: 96 }, (_, index) => ({
      point: [index / 95, 0, 0] as [number, number, number],
      value: index / 95
    }));
    const values = new Float32Array(samples.map((sample) => sample.value));
    const mapping = createVertexResultMapping({ basePositions, samples, maxNeighbors: 8 });
    const output = new Float32Array(vertexCount);

    const start = performance.now();
    for (let vertexIndex = 0; vertexIndex < mapping.vertexCount; vertexIndex += 1) {
      let value = 0;
      for (const sampleWeight of mapping.weightsByVertex[vertexIndex] ?? []) {
        value += (values[sampleWeight.sampleIndex] ?? 0) * sampleWeight.weight;
      }
      output[vertexIndex] = value;
    }
    const elapsedMs = performance.now() - start;

    expect(output[0]).toBeGreaterThanOrEqual(0);
    expect(elapsedMs).toBeLessThan(250);
  });
});
