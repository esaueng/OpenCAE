import { describe, expect, test } from "vitest";
import { nextSelectedPayloadObject, shouldClearPayloadSelectionOnViewerMiss } from "./payloadSelection";

const selected = { id: "payload-1", label: "Part 1", center: [1, 2, 3] as [number, number, number] };
const replacement = { id: "payload-2", label: "Part 2", center: [3, 2, 1] as [number, number, number] };

describe("payload selection", () => {
  test("keeps the current payload object when payload mode receives a non-payload click", () => {
    expect(nextSelectedPayloadObject({ activeStep: "loads", draftLoadType: "gravity", current: selected })).toBe(selected);
  });

  test("replaces the current payload object when a new payload object is clicked", () => {
    expect(nextSelectedPayloadObject({ activeStep: "loads", draftLoadType: "gravity", current: selected, payloadObject: replacement })).toBe(replacement);
  });

  test("clears payload selection outside payload mass mode", () => {
    expect(nextSelectedPayloadObject({ activeStep: "loads", draftLoadType: "force", current: selected })).toBeNull();
    expect(nextSelectedPayloadObject({ activeStep: "supports", draftLoadType: "gravity", current: selected })).toBeNull();
  });

  test("clears payload selection when clicking empty viewer space in payload mode", () => {
    expect(shouldClearPayloadSelectionOnViewerMiss({ activeStep: "loads", draftLoadType: "gravity" })).toBe(true);
    expect(shouldClearPayloadSelectionOnViewerMiss({ activeStep: "loads", draftLoadType: "force" })).toBe(false);
  });
});
