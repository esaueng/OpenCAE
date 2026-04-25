import { describe, expect, test } from "vitest";
import type { DisplayFace } from "@opencae/schema";
import { faceForModelHit } from "./modelSelection";

const faces: DisplayFace[] = [
  { id: "face-upright-hole", label: "Upright through hole", color: "#4da3ff", center: [-1.2, 1.48, 0.58], normal: [0, 0, 1], stressValue: 76 },
  { id: "face-upright-front", label: "Upright front face", color: "#64748b", center: [-1.18, 1.42, 0.58], normal: [0, 0, 1], stressValue: 78 },
  { id: "face-base-left", label: "Base mounting holes", color: "#4da3ff", center: [0.65, 0.02, 0.58], normal: [0, 0, 1], stressValue: 36 },
  { id: "face-load-top", label: "Top load face", color: "#f59e0b", center: [-1.18, 2.53, 0], normal: [0, 1, 0], stressValue: 142 }
];

describe("model hit selection", () => {
  test("selects the upright through hole instead of the broad upright face", () => {
    const face = faceForModelHit("bracket", faces, { x: -1.2, y: 1.48, z: 0.55 });

    expect(face?.id).toBe("face-upright-hole");
  });

  test("selects the upright front face away from the through hole", () => {
    const face = faceForModelHit("bracket", faces, { x: -1.22, y: 2.1, z: 0.55 });

    expect(face?.id).toBe("face-upright-front");
  });

  test("selects base mounting holes at either base hole center", () => {
    expect(faceForModelHit("bracket", faces, { x: 0.24, y: 0, z: 0.55 })?.id).toBe("face-base-left");
    expect(faceForModelHit("bracket", faces, { x: 1.2, y: 0, z: 0.55 })?.id).toBe("face-base-left");
  });
});
