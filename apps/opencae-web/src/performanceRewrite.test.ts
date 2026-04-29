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
    expect(viteConfigSource).toContain("viewer-three");
    expect(viteConfigSource).toContain("cad-import");
    expect(packageJson.scripts["check:bundle"]).toBe("node ../../scripts/check-web-bundle-budget.mjs");
  });
});
