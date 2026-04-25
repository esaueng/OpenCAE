import { describe, expect, test } from "vitest";
import type { DisplayFace, Load, NamedSelection, Study } from "@opencae/schema";
import { createDraftLoadMarker, createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, loadMarkerFromLoad } from "./loadPreview";

const face: DisplayFace = {
  id: "face-side",
  label: "Side face",
  color: "#fff",
  center: [1, 2, 3],
  normal: [0, 0, 1],
  stressValue: 0
};

const selection: NamedSelection = {
  id: "selection-side",
  name: "Side face",
  entityType: "face",
  geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-side", label: "Side face" }],
  fingerprint: "side"
};

const study = {
  loads: [],
  namedSelections: [selection]
} as unknown as Study;

describe("load preview helpers", () => {
  test("maps direction labels to saved vectors", () => {
    expect(directionVectorForLabel("-Y", face)).toEqual([0, -1, 0]);
    expect(directionVectorForLabel("+X", face)).toEqual([1, 0, 0]);
    expect(directionVectorForLabel("+Z", face)).toEqual([0, 0, 1]);
    expect(directionVectorForLabel("-Z", face)).toEqual([0, 0, -1]);
    expect(directionVectorForLabel("Normal", face)).toEqual([0, 0, 1]);
  });

  test("creates a draft marker for the currently selected face", () => {
    expect(createDraftLoadMarker({ selectedFace: face, type: "pressure", value: 125, directionLabel: "Normal", stackIndex: 2 })).toEqual({
      id: "draft-load-preview",
      faceId: "face-side",
      type: "pressure",
      value: 125,
      units: "kPa",
      direction: [0, 0, 1],
      directionLabel: "Normal",
      stackIndex: 2,
      preview: true
    });
  });

  test("reads saved load direction and label for existing markers", () => {
    const load: Load = {
      id: "load-1",
      type: "force",
      selectionRef: "selection-side",
      parameters: { value: 500, units: "N", direction: [1, 0, 0] },
      status: "complete"
    };

    expect(loadMarkerFromLoad(load, study, 0)).toEqual({
      id: "load-1",
      faceId: "face-side",
      type: "force",
      value: 500,
      units: "N",
      direction: [1, 0, 0],
      directionLabel: "+X",
      stackIndex: 0
    });
    expect(directionLabelForLoad(load)).toBe("+X");
  });

  test("reads saved Z load directions", () => {
    const load: Load = {
      id: "load-z",
      type: "force",
      selectionRef: "selection-side",
      parameters: { value: 250, units: "N", direction: [0, 0, -1] },
      status: "complete"
    };

    expect(loadMarkerFromLoad(load, study, 0)?.directionLabel).toBe("-Z");
    expect(directionLabelForLoad(load)).toBe("-Z");
  });

  test("omits the draft marker while an existing load is being edited", () => {
    const savedLoad: Load = {
      id: "load-1",
      type: "force",
      selectionRef: "selection-side",
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    };
    const markers = createViewerLoadMarkers({
      study: { ...study, loads: [savedLoad] } as unknown as Study,
      selectedFace: face,
      draftLoad: { type: "force", value: 500, directionLabel: "-Z" },
      includeDraftPreview: false
    });

    expect(markers).toHaveLength(1);
    expect(markers[0]?.id).toBe("load-1");
  });
});
