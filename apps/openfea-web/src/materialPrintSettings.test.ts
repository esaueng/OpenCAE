import { describe, expect, test } from "vitest";
import { LAYER_DIRECTION_HELP_TEXT } from "./materialPrintSettings";

describe("material print settings copy", () => {
  test("explains layer direction in user-facing terms", () => {
    expect(LAYER_DIRECTION_HELP_TEXT).toContain("build plate");
    expect(LAYER_DIRECTION_HELP_TEXT).toContain("weaker across layer lines");
  });
});
