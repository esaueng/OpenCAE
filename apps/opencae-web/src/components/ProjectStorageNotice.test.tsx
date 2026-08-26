import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ProjectStorageNotice } from "./ProjectStorageNotice";

describe("ProjectStorageNotice", () => {
  test("offers remembered cloud and local choices without modal semantics", () => {
    const html = renderToStaticMarkup(
      <ProjectStorageNotice preference={null} busy={false} recoveryNeeded analyticsEnabled={true} onChooseCloud={vi.fn()} onChooseLocal={vi.fn()} onAnalyticsEnabledChange={vi.fn()} />
    );

    expect(html).toContain("Choose how to protect this project");
    expect(html).toContain("Encrypted recovery");
    expect(html).toContain("Local only");
    expect(html).toContain("Remembered in this browser");
    expect(html).toContain('aria-labelledby="project-storage-title"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal="true"');
  });

  test("shows and marks a previously saved local preference", () => {
    const html = renderToStaticMarkup(
      <ProjectStorageNotice preference="local" busy={false} recoveryNeeded={false} analyticsEnabled={true} onChooseCloud={vi.fn()} onChooseLocal={vi.fn()} onAnalyticsEnabledChange={vi.fn()} />
    );

    expect(html).toContain("This project stays local");
    expect(html).toMatch(/storage-choice local selected[^>]*aria-pressed="true"/);
    expect(html).toContain("OpenCAE will not upload recovery data");
    expect(html).toContain("No project upload");
  });

  test("explains the saved preference before a new project needs overflow recovery", () => {
    const html = renderToStaticMarkup(
      <ProjectStorageNotice preference={null} busy={false} recoveryNeeded={false} analyticsEnabled={true} onChooseCloud={vi.fn()} onChooseLocal={vi.fn()} onAnalyticsEnabledChange={vi.fn()} />
    );

    expect(html).toContain("Choose your recovery preference");
    expect(html).toContain("Browser autosave is active for this project");
    expect(html).not.toContain("The complete project is larger than browser autosave can hold");
  });

  test("replaces the blocking overflow confirmation in the workspace", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "../WorkspaceApp.tsx"), "utf8");

    expect(workspaceSource).toContain("<ProjectStorageNotice");
    expect(workspaceSource).toContain("readCloudBackupPreference()");
    expect(workspaceSource).toContain("writeCloudBackupPreference(preference)");
    expect(workspaceSource).toContain('title="Review project storage choice"');
    expect(workspaceSource.match(/\{renderStorageRecoveryNotice\(\)\}/g)).toHaveLength(2);
    expect(workspaceSource).not.toContain("storageRecoveryAvailable");
    expect(workspaceSource).not.toContain("This project is larger than the browser autosave limit.");
    expect(workspaceSource).not.toContain("Choose Cancel to keep everything local");
  });

  test("offers the full project download alongside the recovery choices", () => {
    const html = renderToStaticMarkup(
      <ProjectStorageNotice preference="local" busy={false} recoveryNeeded={false} analyticsEnabled={true} onChooseCloud={vi.fn()} onChooseLocal={vi.fn()} onAnalyticsEnabledChange={vi.fn()} onDownloadProject={vi.fn()} />
    );
    const withoutHandler = renderToStaticMarkup(
      <ProjectStorageNotice preference="local" busy={false} recoveryNeeded={false} analyticsEnabled={true} onChooseCloud={vi.fn()} onChooseLocal={vi.fn()} onAnalyticsEnabledChange={vi.fn()} />
    );

    expect(html).toContain("Download project file");
    expect(html).toContain("Complete project, saved to your disk");
    expect(withoutHandler).not.toContain("Download project file");
  });

  test("discloses anonymous analytics with an opt-out toggle", () => {
    const html = renderToStaticMarkup(
      <ProjectStorageNotice preference="local" busy={false} recoveryNeeded={false} analyticsEnabled={true} onChooseCloud={vi.fn()} onChooseLocal={vi.fn()} onAnalyticsEnabledChange={vi.fn()} />
    );
    const optedOut = renderToStaticMarkup(
      <ProjectStorageNotice preference="local" busy={false} recoveryNeeded={false} analyticsEnabled={false} onChooseCloud={vi.fn()} onChooseLocal={vi.fn()} onAnalyticsEnabledChange={vi.fn()} />
    );

    expect(html).toContain("Anonymous usage analytics");
    expect(html).toContain("Page views and outbound-link clicks go to Plausible");
    expect(html).toContain("never project, geometry, or simulation data");
    expect(html).toContain("next app launch");
    expect(html).toContain('type="checkbox"');
    expect(optedOut).toContain("Anonymous usage analytics");
  });

  test("routes the local project export through the storage card and Results menu, not the top bar", () => {
    const workspaceSource = readFileSync(resolve(__dirname, "../WorkspaceApp.tsx"), "utf8");

    expect(workspaceSource).not.toContain('aria-label="Download Project"');
    expect(workspaceSource).toContain("onSaveProject={handleSaveProject}");
    expect(workspaceSource).toContain("onDownloadProject={() => {");
    // Cmd/Ctrl+S keeps saving reachable without opening either surface.
    expect(workspaceSource).toContain("void handleSaveProject();");
  });
});
