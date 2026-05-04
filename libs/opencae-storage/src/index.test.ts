import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { FileSystemObjectStorageProvider } from ".";

const tempDirs: string[] = [];

async function tempStorageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencae-storage-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileSystemObjectStorageProvider", () => {
  test("stores nested valid keys under the configured root", async () => {
    const root = await tempStorageRoot();
    const storage = new FileSystemObjectStorageProvider(root);

    const target = await storage.putObject("project-a/results/run-1.json", "ok");

    expect(target).toBe(resolve(root, "project-a/results/run-1.json"));
    expect((await readFile(target)).toString("utf8")).toBe("ok");
    expect(await storage.listObjects()).toEqual(["project-a/results/run-1.json"]);
  });

  test("rejects parent-directory traversal keys", async () => {
    const root = await tempStorageRoot();
    const storage = new FileSystemObjectStorageProvider(root);

    expect(() => storage.getLocalPath("../outside.txt")).toThrow(/outside the storage root/);
    await expect(storage.putObject("project/../../outside.txt", "bad")).rejects.toThrow(/outside the storage root/);
  });

  test("rejects absolute keys outside the storage root", async () => {
    const root = await tempStorageRoot();
    const storage = new FileSystemObjectStorageProvider(root);

    expect(() => storage.getLocalPath("/tmp/opencae-escape.txt")).toThrow(/outside the storage root/);
  });

  test("lists objects from the storage root for an empty prefix", async () => {
    const root = await tempStorageRoot();
    const storage = new FileSystemObjectStorageProvider(root);

    await storage.putObject("a.txt", "a");
    await storage.putObject("nested/b.txt", "b");

    expect(await storage.listObjects()).toEqual(["a.txt", "nested/b.txt"]);
  });
});
