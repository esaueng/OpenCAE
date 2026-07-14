import { describe, expect, test } from "vitest";
import { pngDataUrlToBlob, suggestedResultPngFilename } from "./resultPngExport";

describe("result PNG export", () => {
  test("names static and transient files from project, field, component, frame, and time", () => {
    expect(suggestedResultPngFilename({
      projectName: " Wing / Rev B! ",
      resultMode: "stress",
      stressComponent: "principal_max",
      field: { frameIndex: 3, timeSeconds: 0.05 }
    })).toBe("wing-rev-b_stress-sigma1_frame-0003_t-0p05s.png");
    expect(suggestedResultPngFilename({
      projectName: "",
      resultMode: "displacement"
    })).toBe("opencae-project_displacement_static.png");
  });

  test("converts a PNG data URL to an image Blob and rejects another media type", async () => {
    const blob = pngDataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(8);
    await expect(blob.arrayBuffer()).resolves.toMatchObject({ byteLength: 8 });
    expect(() => pngDataUrlToBlob("data:image/jpeg;base64,iVBORw0KGgo=")).toThrow("invalid PNG");
  });
});
