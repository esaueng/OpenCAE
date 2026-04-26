import { describe, expect, test } from "vitest";
import type { DisplayFace, Load, NamedSelection, Study } from "@opencae/schema";
import { createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, loadMarkerDisplayLabel, loadMarkerFromLoad, payloadObjectForLoad, unitsForLoadType } from "./loadPreview";

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

  test("uses a picked face point for saved load markers", () => {
    const point: [number, number, number] = [1.2, 2.1, 3.05];
    const load: Load = {
      id: "load-point",
      type: "force",
      selectionRef: "selection-side",
      parameters: { value: 500, units: "N", direction: [0, 0, -1], applicationPoint: point },
      status: "complete"
    };

    expect(loadMarkerFromLoad(load, study, 0)?.point).toEqual(point);
  });

  test("reads payload object metadata for mass loads", () => {
    const load: Load = {
      id: "load-payload",
      type: "gravity",
      selectionRef: "selection-side",
      parameters: {
        value: 5,
        units: "kg",
        direction: [0, 0, -1],
        payloadObject: { id: "part-1", label: "Payload part", center: [1, 2, 3] }
      },
      status: "complete"
    };

    expect(payloadObjectForLoad(load)).toEqual({ id: "part-1", label: "Payload part", center: [1, 2, 3] });
  });

  test("treats gravity loads as payload mass inputs", () => {
    expect(unitsForLoadType("gravity")).toBe("kg");
    const load: Load = {
      id: "load-gravity",
      type: "gravity",
      selectionRef: "selection-side",
      parameters: { value: 10, units: "kg", direction: [0, 0, -1] },
      status: "complete"
    };

    expect(loadMarkerFromLoad(load, study, 0)).toMatchObject({
      type: "gravity",
      value: 10,
      units: "kg",
      direction: [0, 0, -1]
    });
  });

  test("does not create an unsaved marker for the selected load face", () => {
    const markers = createViewerLoadMarkers({
      study
    });

    expect(markers).toEqual([]);
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
      point: undefined,
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

  test("returns saved load markers without adding draft markers", () => {
    const savedLoad: Load = {
      id: "load-1",
      type: "force",
      selectionRef: "selection-side",
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    };
    const markers = createViewerLoadMarkers({
      study: { ...study, loads: [savedLoad] } as unknown as Study
    });

    expect(markers).toHaveLength(1);
    expect(markers[0]?.id).toBe("load-1");
  });

  test("formats the viewport load label for reuse in the sidebar", () => {
    const marker = loadMarkerFromLoad({
      id: "load-1",
      type: "force",
      selectionRef: "selection-side",
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    }, study, 0);

    expect(marker && loadMarkerDisplayLabel(marker)).toBe("L1 F 500 N -Z");
  });
});
