import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AUTOSAVE_STORAGE_KEY } from "./autosaveStorage";
import { App } from "./App";

function stubWindowWithAutosave(entries: Record<string, string>) {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => entries[key] ?? null,
      setItem: () => undefined,
      removeItem: () => undefined
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace restore shell", () => {
  test("does not flash the start screen while restoring a saved workspace", () => {
    // The workspace is a lazy chunk and its Suspense fallback used to be the
    // start screen, so reloading a saved project painted "Create new project"
    // before the restored workspace arrived.
    stubWindowWithAutosave({ [AUTOSAVE_STORAGE_KEY]: "{}" });

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('class="workspace-restoring"');
    expect(html).toContain("Restoring your workspace");
    expect(html).not.toContain("Create new project");
  });

  test("shows the start screen when there is nothing to restore", () => {
    stubWindowWithAutosave({});

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Create new project");
    expect(html).not.toContain('class="workspace-restoring"');
  });
});
