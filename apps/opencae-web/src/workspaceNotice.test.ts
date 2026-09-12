import { describe, expect, test } from "vitest";
import { workspaceNoticeFor } from "./workspaceNotice";

const quiet = { meshError: null, meshing: false, runError: null, solverRunning: false, resultsOutdatedBy: null, dismissedKey: null };

describe("workspaceNoticeFor", () => {
  test("is silent when nothing needs attention", () => {
    expect(workspaceNoticeFor(quiet)).toBeNull();
  });

  test("names the edit that cleared the results and points at Run", () => {
    const notice = workspaceNoticeFor({ ...quiet, resultsOutdatedBy: "Load updated." });
    expect(notice).toMatchObject({ tone: "warning", title: "Results outdated", step: "run" });
    expect(notice?.message).toBe("Load updated. The results shown are from before this change and cannot be reported or exported. Re-run to update them.");
  });

  test("surfaces a failed run everywhere, but not while a new run is in flight", () => {
    expect(workspaceNoticeFor({ ...quiet, runError: "Solve diverged." })).toMatchObject({ tone: "error", step: "run", message: "Solve diverged." });
    expect(workspaceNoticeFor({ ...quiet, runError: "Solve diverged.", solverRunning: true })).toBeNull();
  });

  test("ranks a mesh failure above a stale-results warning and hides while meshing", () => {
    expect(workspaceNoticeFor({ ...quiet, meshError: "Bad element.", resultsOutdatedBy: "Load updated." })).toMatchObject({ step: "mesh", tone: "error" });
    expect(workspaceNoticeFor({ ...quiet, meshError: "Bad element.", meshing: true })).toBeNull();
  });

  test("announces a file-open consequence and points at the Mesh step", () => {
    const notice = workspaceNoticeFor({ ...quiet, openNote: "The saved mesh was not restored." });
    expect(notice).toMatchObject({ tone: "warning", title: "Opened from file", step: "mesh" });
    // A failed run outranks it; cleared results do not.
    expect(workspaceNoticeFor({ ...quiet, openNote: "x", runError: "Solve diverged." })?.step).toBe("run");
    expect(workspaceNoticeFor({ ...quiet, openNote: "x", resultsOutdatedBy: "Load updated." })?.title).toBe("Opened from file");
  });

  test("stays dismissed for the same event and returns for a new one", () => {
    const first = workspaceNoticeFor({ ...quiet, resultsOutdatedBy: "Load updated." })!;
    expect(workspaceNoticeFor({ ...quiet, resultsOutdatedBy: "Load updated.", dismissedKey: first.key })).toBeNull();
    expect(workspaceNoticeFor({ ...quiet, resultsOutdatedBy: "Support removed.", dismissedKey: first.key })).not.toBeNull();
  });
});
