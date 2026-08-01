import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AUTOSAVE_STORAGE_KEY, AUTOSAVE_UI_STORAGE_KEY } from "./autosaveStorage";
import { App } from "./App";

function stubWindowWithAutosave(entries: Record<string, string>, pathname = "/") {
  vi.stubGlobal("window", {
    location: { pathname },
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

    expect(html).toContain('class="workspace-restoring theme-dark"');
    expect(html).toContain("Restoring your workspace");
    expect(html).not.toContain("Create new project");
  });

  test("uses the saved light theme before the workspace chunk loads", () => {
    stubWindowWithAutosave({
      [AUTOSAVE_STORAGE_KEY]: "{}",
      [AUTOSAVE_UI_STORAGE_KEY]: JSON.stringify({
        version: 1,
        savedAt: "2026-07-27T22:00:00.000Z",
        ui: { themeMode: "light" }
      })
    });

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('class="workspace-restoring theme-light"');
    expect(html).not.toContain('class="workspace-restoring theme-dark"');
  });

  test("shows the start screen when there is nothing to restore", () => {
    stubWindowWithAutosave({});

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Create new project");
    expect(html).not.toContain('class="workspace-restoring"');
  });

  test("shows an explicit not-found page for unsupported direct routes", () => {
    stubWindowWithAutosave({}, "/definitely-not-a-route");

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Create new project");
  });
});
