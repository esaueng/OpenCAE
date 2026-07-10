import { afterEach, describe, expect, test, vi } from "vitest";
import { prepareBlobSaveToDisk, saveBlobToDisk } from "./fileSave";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file saving", () => {
  test("acquires the picker handle before writing the generated Blob", async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const createWritable = vi.fn(async () => ({ write, close }));
    const showSaveFilePicker = vi.fn(async () => ({ createWritable }));
    vi.stubGlobal("window", { showSaveFilePicker });
    vi.stubGlobal("navigator", { webdriver: false });

    const target = await prepareBlobSaveToDisk("report.pdf", { description: "PDF report", accept: { "application/pdf": [".pdf"] } });
    expect(showSaveFilePicker).toHaveBeenCalledOnce();
    expect(createWritable).not.toHaveBeenCalled();
    if (target === "cancelled") throw new Error("Unexpected cancellation");
    await target.save(new Blob(["report"]));
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("returns cancelled when the picker is dismissed", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    vi.stubGlobal("window", { showSaveFilePicker: vi.fn().mockRejectedValue(abort) });
    vi.stubGlobal("navigator", { webdriver: false });

    await expect(saveBlobToDisk(new Blob(), "report.pdf", { description: "PDF report", accept: { "application/pdf": [".pdf"] } }))
      .resolves.toBe("cancelled");
  });

  test("uses the anchor fallback when the picker API is unavailable", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const createObjectURL = vi.fn(() => "blob:report");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { body: { appendChild }, createElement: vi.fn(() => ({ click, remove, style: {}, href: "", download: "" })) });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    await expect(saveBlobToDisk(new Blob(), "report.pdf", { description: "PDF report", accept: { "application/pdf": [".pdf"] } }))
      .resolves.toBe("saved");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendChild).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
  });

  test("falls back to an anchor when the picker rejects the browser gesture", async () => {
    const click = vi.fn();
    const notAllowed = Object.assign(new Error("Must be handling a user gesture"), { name: "NotAllowedError" });
    vi.stubGlobal("window", { showSaveFilePicker: vi.fn().mockRejectedValue(notAllowed) });
    vi.stubGlobal("navigator", { webdriver: false });
    vi.stubGlobal("document", { body: { appendChild: vi.fn() }, createElement: vi.fn(() => ({ click, remove: vi.fn(), style: {}, href: "", download: "" })) });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() });

    await expect(saveBlobToDisk(new Blob(), "report.pdf", { description: "PDF report", accept: { "application/pdf": [".pdf"] } }))
      .resolves.toBe("saved");
    expect(click).toHaveBeenCalledOnce();
  });

  test("recognizes the embedded-browser user-gesture TypeError", async () => {
    const click = vi.fn();
    const gestureError = Object.assign(new Error("Failed to execute 'showSaveFilePicker' on 'Window': Must be handling a user gesture to show a file picker."), { name: "TypeError" });
    vi.stubGlobal("window", { showSaveFilePicker: vi.fn().mockRejectedValue(gestureError) });
    vi.stubGlobal("navigator", { webdriver: false });
    vi.stubGlobal("document", { body: { appendChild: vi.fn() }, createElement: vi.fn(() => ({ click, remove: vi.fn(), style: {}, href: "", download: "" })) });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() });

    await expect(saveBlobToDisk(new Blob(), "report.pdf", { description: "PDF report", accept: { "application/pdf": [".pdf"] } }))
      .resolves.toBe("saved");
    expect(click).toHaveBeenCalledOnce();
  });
});
