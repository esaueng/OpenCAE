import { describe, expect, test } from "vitest";
import type { DisplayFace, Load, NamedSelection, Study } from "@opencae/schema";
import { createViewerLoadMarkers, directionLabelForLoad, directionVectorForLabel, loadMarkerDisplayLabel, loadMarkerFromLoad, loadMarkerViewportPresentation, payloadObjectForLoad, unitsForLoadType } from "./loadPreview";

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

const secondSelection: NamedSelection = {
  id: "selection-back",
  name: "Back face",
  entityType: "face",
  geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-back", label: "Back face" }],
  fingerprint: "back"
};

const study = {
  loads: [],
  namedSelections: [selection, secondSelection]
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

  test("uses payload object center for gravity load markers when no point is saved", () => {
    const load: Load = {
      id: "load-payload",
      type: "gravity",
      selectionRef: "selection-side",
      parameters: {
        value: 5,
        units: "kg",
        direction: [0, 0, -1],
        payloadObject: { id: "rod-1", label: "Rod 1", center: [1.25, 2.5, 3.75] }
      },
      status: "complete"
    };

    expect(loadMarkerFromLoad(load, study, 0)?.point).toEqual([1.25, 2.5, 3.75]);
  });

  test("presents payload mass markers as part labels without arrows", () => {
    const load: Load = {
      id: "load-payload",
      type: "gravity",
      selectionRef: "selection-side",
      parameters: {
        value: 5,
        units: "kg",
        direction: [0, 0, -1],
        payloadObject: { id: "rod-1", label: "Part 2", center: [1.25, 2.5, 3.75] }
      },
      status: "complete"
    };
    const marker = loadMarkerFromLoad(load, study, 0);

    expect(marker?.payloadObject?.label).toBe("Part 2");
    expect(marker && loadMarkerViewportPresentation(marker)).toEqual({
      label: "Part 2",
      showArrow: false,
      tone: "payload-mass",
      color: "#34d399"
    });
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
      labelIndex: 0,
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

  test("uses edited load previews for viewer markers before the edit is saved", () => {
    const savedLoad: Load = {
      id: "load-1",
      type: "force",
      selectionRef: "selection-side",
      parameters: { value: 500, units: "N", direction: [0, 0, -1] },
      status: "complete"
    };
    const previewLoad: Load = {
      ...savedLoad,
      parameters: { ...savedLoad.parameters, direction: [0, 1, 0] }
    };

    const markers = createViewerLoadMarkers({
      study: { ...study, loads: [savedLoad] } as unknown as Study,
      loadPreviews: [previewLoad]
    });

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      id: "load-1",
      direction: [0, 1, 0],
      directionLabel: "+Y",
      labelIndex: 0,
      stackIndex: 0
    });
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

  test("numbers load labels globally across different faces", () => {
    const markers = createViewerLoadMarkers({
      study: {
        ...study,
        loads: [
          {
            id: "load-1",
            type: "force",
            selectionRef: "selection-side",
            parameters: { value: 500, units: "N", direction: [0, 0, -1] },
            status: "complete"
          },
          {
            id: "load-2",
            type: "force",
            selectionRef: "selection-back",
            parameters: { value: 500, units: "N", direction: [0, 0, -1] },
            status: "complete"
          }
        ]
      } as unknown as Study
    });

    expect(markers.map(loadMarkerDisplayLabel)).toEqual(["L1 F 500 N -Z", "L2 F 500 N -Z"]);
    expect(markers.map((marker) => marker.stackIndex)).toEqual([0, 0]);
  });
});
