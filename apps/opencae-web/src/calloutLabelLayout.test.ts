import { describe, expect, test } from "vitest";
import { payloadMassLabelOffset } from "./calloutLabelLayout";

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
});
