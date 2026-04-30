import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(resolve(__dirname, "App.tsx"), "utf8");
const apiSource = readFileSync(resolve(__dirname, "lib/api.ts"), "utf8");
const viteConfigSource = readFileSync(resolve(__dirname, "../vite.config.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("Worker UI performance rewrite boundaries", () => {
  test("keeps the first app shell free of workspace, viewer, and solver imports", () => {
    expect(appSource).toContain("lazyWorkspaceImport");
    expect(appSource).toContain('import("./WorkspaceApp")');
    expect(appSource).not.toContain('from "./WorkspaceApp"');
    expect(appSource).not.toContain('from "./components/CadViewer"');
    expect(appSource).not.toContain('from "./lib/api"');
    expect(appSource).not.toContain("@react-three");
    expect(appSource).not.toContain("three");
    expect(appSource).not.toContain("@opencae/solver-service");
  });

  test("loads the viewer through a lazy boundary inside the workspace", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");

    expect(workspaceSource).toContain("lazyCadViewerImport");
    expect(workspaceSource).toContain('import("./components/CadViewer")');
    expect(workspaceSource).not.toContain('import { CadViewer');
  });

  test("keeps local solver code behind the browser performance worker", () => {
    expect(apiSource).not.toContain('from "@opencae/solver-service"');
    expect(apiSource).toContain("solveLocalStudyInWorker");
    expect(apiSource).toContain("fallbackSolveLocalStudy");
  });

  test("declares explicit chunks and a bundle budget command", () => {
    expect(viteConfigSource).toContain("manualChunks");
    expect(viteConfigSource).toContain("modulePreload: false");
    expect(viteConfigSource).toContain("viewer-three");
    expect(viteConfigSource).toContain("cad-import");
    expect(packageJson.scripts["check:bundle"]).toBe("node ../../scripts/check-web-bundle-budget.mjs");
  });

  test("keeps the Three viewer on demand rendering with bounded playback commits", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");

    expect(viewerSource).toContain('frameloop="demand"');
    expect(viewerSource).toContain("dpr={[1, 2]}");
    expect(viewerSource).toContain("invalidate()");
    expect(viewerSource).toContain("onChange={invalidateViewer}");
    expect(workspaceSource).toContain("PLAYBACK_UI_COMMIT_INTERVAL_MS = 250");
    expect(workspaceSource).not.toContain("PLAYBACK_STATE_COMMIT_INTERVAL_MS = 1000 / 60");
  });

  test("keeps playback frame delivery out of React subscriptions and hydrated result arrays", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");
    const cacheSource = readFileSync(resolve(__dirname, "resultPlaybackCache.ts"), "utf8");

    expect(workspaceSource).toContain("createResultPlaybackFrameController");
    expect(workspaceSource).toContain("setPackedFrame(cache.packed");
    expect(viewerSource).toContain("resultPlaybackFrameController");
    expect(viewerSource).toContain("usePackedPlaybackGeometry");
    expect(viewerSource).not.toContain("useSyncExternalStore");
    expect(cacheSource).toContain("values: Float32Array");
    expect(cacheSource).not.toContain("Array.from(field.values)");
  });

  test("idle-schedules autosave instead of writing localStorage synchronously from workspace renders", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "WorkspaceApp.tsx"), "utf8");
    const persistenceSource = readFileSync(resolve(__dirname, "appPersistence.ts"), "utf8");

    expect(workspaceSource).toContain("scheduleAutosavedWorkspaceWrite(buildAutosavedWorkspace");
    expect(workspaceSource).not.toContain("writeAutosavedWorkspace(buildAutosavedWorkspace");
    expect(persistenceSource).toContain("requestIdleCallback");
    expect(persistenceSource).toContain("delayMs = 650");
  });

  test("keeps imported CAD edge overlays optional during result playback", () => {
    const viewerSource = readFileSync(resolve(__dirname, "components/CadViewer.tsx"), "utf8");
    const stepPreviewSource = readFileSync(resolve(__dirname, "stepPreview.ts"), "utf8");
    const workerSource = readFileSync(resolve(__dirname, "workers/performanceWorker.ts"), "utf8");

    expect(stepPreviewSource).toContain("includeEdges?: boolean");
    expect(stepPreviewSource).toContain("if (includeEdges)");
    expect(stepPreviewSource).toContain("shareMaterials?: boolean");
    expect(viewerSource).toContain("const lightweightResultPlayback = Boolean(resultPlaybackFrameController)");
    expect(viewerSource).toContain("stepPreviewFromBase64(contentBase64, \"#63a9e5\", { includeEdges: !lightweightResultPlayback, shareMaterials: lightweightResultPlayback })");
    expect(viewerSource).toContain("{!lightweightResultPlayback && <Edges color=\"#43556a\" threshold={18} />}");
    expect(workerSource).toContain("stepPreviewFromBase64(request.payload.contentBase64, request.payload.color, { includeEdges: false, shareMaterials: true })");
  });
});
