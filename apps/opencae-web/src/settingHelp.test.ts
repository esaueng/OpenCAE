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

  // Help that describes behaviour the app does not have is worse than no help:
  // these two entries each shipped a claim the code contradicted.
  test("does not promise model rotation the orientation buttons never perform", () => {
    // handleRotateModel only aims the camera (WorkspaceApp.tsx), and
    // rotateDisplayModel has no production call site, so displayModel.orientation
    // is always zero and Reset is always disabled.
    expect(SETTING_HELP.orientation.body).not.toMatch(/rotates the (imported )?model/i);
    expect(SETTING_HELP.orientation.body).toMatch(/camera/i);
  });

  test("tells the reader what the load case Enabled toggle actually does", () => {
    // The solver filters on loadCase.enabled (libs/opencae-core-adapter), and
    // only enabled cases become result variants.
    expect(SETTING_HELP.loadCases.body).toMatch(/enabled/i);
  });
});
