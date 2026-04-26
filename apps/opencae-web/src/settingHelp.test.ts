import { describe, expect, test } from "vitest";
import { REQUIRED_SETTING_HELP_IDS, SETTING_HELP } from "./settingHelp";

describe("setting help content", () => {
  test("documents every major configuration option with text and a visual", () => {
    for (const id of REQUIRED_SETTING_HELP_IDS) {
      const help = SETTING_HELP[id];

      expect(help, id).toBeDefined();
      expect(help.title.trim().length, id).toBeGreaterThan(3);
      expect(help.body.trim().length, id).toBeGreaterThan(40);
      expect(help.visual, id).toBeDefined();
    }
  });
});
