import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { BottomPanel } from "./BottomPanel";

describe("BottomPanel", () => {
  test("keeps the GitHub link in the bottom status area", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Results ready"
        logs={["Ready"]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Complete"
      />
    );

    expect(html).toContain('class="status-github"');
    expect(html).toContain('href="https://github.com/esaueng/OpenCAE"');
    expect(html).toContain(">github</a>");
  });
});
