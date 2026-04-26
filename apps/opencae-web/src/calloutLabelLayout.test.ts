import { describe, expect, test } from "vitest";
import { layoutOutsideModelLabels, payloadMassLabelOffset } from "./calloutLabelLayout";

describe("callout label layout", () => {
  test("spreads payload mass labels into horizontal lanes and vertical rows", () => {
    expect([
      payloadMassLabelOffset(0),
      payloadMassLabelOffset(1),
      payloadMassLabelOffset(2),
      payloadMassLabelOffset(3),
      payloadMassLabelOffset(4),
      payloadMassLabelOffset(5)
    ]).toEqual([
      { tangent: -0.42, lift: 0.16 },
      { tangent: -0.14, lift: 0.16 },
      { tangent: 0.14, lift: 0.16 },
      { tangent: 0.42, lift: 0.16 },
      { tangent: -0.42, lift: 0.44 },
      { tangent: -0.14, lift: 0.44 }
    ]);
  });

  test("places clustered labels outside the model with even spacing", () => {
    const labels = layoutOutsideModelLabels(
      [
        { id: "l1", anchor: [-0.4, 0, 0] },
        { id: "l2", anchor: [-0.2, 0.05, 0] },
        { id: "l3", anchor: [0, 0.1, 0] },
        { id: "l4", anchor: [0.2, 0.15, 0] },
        { id: "l5", anchor: [0.4, 0.2, 0] }
      ],
      { min: [-1, -1, -0.1], max: [1, 1, 0.1] }
    );

    const positions = labels.map((label) => label.position);
    expect(positions.every(([x, y]) => Math.abs(x) > 1 || Math.abs(y) > 1)).toBe(true);
    expect(new Set(positions.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)).size).toBe(positions.length);
  });
});
