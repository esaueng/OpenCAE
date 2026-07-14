import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_RECENT_PROJECTS, createRecentProjectService, isRecentProjectsSupported, pickRecentProjectFile, projectNameFromFile, requestRecentProjectFile, type RecentProjectEntry, type RecentProjectFileHandle, type RecentProjectPersistence } from "./recentProjects";
import { createLocalBlankProject } from "./localProjectFactory";

function handle(name: string, sameName = true): RecentProjectFileHandle {
  return {
    name,
    getFile: vi.fn(async () => new File(["{}"], name)),
    isSameEntry: vi.fn(async (other) => sameName && other.name === name),
    queryPermission: vi.fn(async (): Promise<PermissionState> => "granted"),
    requestPermission: vi.fn(async (): Promise<PermissionState> => "granted")
  };
}

function memoryPersistence(initial: RecentProjectEntry[] = []): RecentProjectPersistence & { entries: RecentProjectEntry[] } {
  const persistence = {
    entries: [...initial],
    readAll: async () => [...persistence.entries],
    replaceAll: async (entries: RecentProjectEntry[]) => { persistence.entries = [...entries]; }
  };
  return persistence;
}

afterEach(() => vi.unstubAllGlobals());

describe("recent projects", () => {
  test("persists handles, deduplicates with isSameEntry, and keeps the stable id", async () => {
    const persistence = memoryPersistence();
    const service = createRecentProjectService(persistence, { createId: () => "stable-id", now: () => 100 });
    await service.add(handle("wing.opencae.json"), { projectName: "Wing" });
    const updated = await service.add(handle("wing.opencae.json"), { projectName: "Wing Rev B", lastOpenedAt: 200 });

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ id: "stable-id", filename: "wing.opencae.json", projectName: "Wing Rev B", lastOpenedAt: 200 });
    expect(updated[0]!.handle.name).toBe("wing.opencae.json");
  });

  test("orders newest first, prunes beyond eight, removes, and clears", async () => {
    const persistence = memoryPersistence();
    let id = 0;
    const service = createRecentProjectService(persistence, { createId: () => `id-${id++}` });
    for (let index = 0; index < 10; index += 1) {
      await service.add(handle(`project-${index}.json`, false), { projectName: `Project ${index}`, lastOpenedAt: index });
    }
    expect((await service.list()).map((entry) => entry.lastOpenedAt)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    expect(persistence.entries).toHaveLength(MAX_RECENT_PROJECTS);
    const afterRemove = await service.remove(persistence.entries[0]!.id);
    expect(afterRemove).toHaveLength(7);
    await service.clear();
    expect(await service.list()).toEqual([]);
  });

  test("requests read permission only when opening and reports denial or stale handles", async () => {
    const deniedHandle = handle("denied.json");
    deniedHandle.queryPermission = vi.fn(async (): Promise<PermissionState> => "prompt");
    deniedHandle.requestPermission = vi.fn(async (): Promise<PermissionState> => "denied");
    const denied: RecentProjectEntry = { id: "denied", filename: deniedHandle.name, projectName: "Denied", lastOpenedAt: 1, handle: deniedHandle };
    await expect(requestRecentProjectFile(denied)).rejects.toThrow("permission was denied");
    expect(deniedHandle.getFile).not.toHaveBeenCalled();

    const staleHandle = handle("missing.json");
    staleHandle.getFile = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { name: "NotFoundError" }));
    const stale: RecentProjectEntry = { id: "stale", filename: staleHandle.name, projectName: "Missing", lastOpenedAt: 1, handle: staleHandle };
    await expect(requestRecentProjectFile(stale)).rejects.toThrow("missing or was moved");
  });

  test("validates project contents before replacing the workspace", async () => {
    const validProject = { ...createLocalBlankProject().project, name: "Fixture" };
    await expect(projectNameFromFile(new File([JSON.stringify({ project: validProject })], "valid.json"))).resolves.toBe("Fixture");
    await expect(projectNameFromFile(new File(["not json"], "bad.json"))).rejects.toThrow("not a valid OpenCAE project");
    await expect(projectNameFromFile(new File([JSON.stringify({ project: { id: "broken" } })], "bad.json"))).rejects.toThrow("not a valid OpenCAE project");
  });

  test("uses the handle picker only when both File System Access and IndexedDB are available", async () => {
    const selectedHandle = handle("fixture.opencae.json");
    const showOpenFilePicker = vi.fn(async () => [selectedHandle]);
    vi.stubGlobal("window", { showOpenFilePicker });
    vi.stubGlobal("indexedDB", {});
    expect(isRecentProjectsSupported()).toBe(true);
    await expect(pickRecentProjectFile()).resolves.toMatchObject({ handle: selectedHandle });
    expect(showOpenFilePicker).toHaveBeenCalledOnce();

    vi.stubGlobal("indexedDB", undefined);
    expect(isRecentProjectsSupported()).toBe(false);
  });
});
