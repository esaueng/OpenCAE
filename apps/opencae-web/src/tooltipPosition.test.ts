import { describe, expect, test } from "vitest";
import { getViewportTooltipPosition } from "./tooltipPosition";

describe("getViewportTooltipPosition", () => {
  test("keeps tooltips inside the viewport when a trigger sits near a clipped panel edge", () => {
    const position = getViewportTooltipPosition({
      triggerRect: { top: 590, right: 770, bottom: 612, left: 748 },
      viewport: { width: 864, height: 986 },
      tooltip: { width: 340, height: 142 },
      gap: 8,
      margin: 12
    });

    expect(position.left).toBeGreaterThanOrEqual(12);
    expect(position.left + 340).toBeLessThanOrEqual(852);
    expect(position.top).toBe(440);
  });

  test("places a Results export menu above a mobile trigger when it would cross the viewport footer", () => {
    const position = getViewportTooltipPosition({
      triggerRect: { top: 668, right: 354, bottom: 706, left: 94 },
      viewport: { width: 390, height: 844 },
      tooltip: { width: 260, height: 186 },
      gap: 4,
      margin: 12
    });

    expect(position).toEqual({ top: 478, left: 94 });
    expect(position.top + 186).toBeLessThanOrEqual(832);
  });
});
