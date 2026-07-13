import { afterEach, describe, expect, test, vi } from "vitest";
import { cancelMeshWork, meshGeoScriptInWorker } from "./meshWorkerClient";

describe("mesh worker cancellation", () => {
  afterEach(() => {
    cancelMeshWork();
    vi.unstubAllGlobals();
  });

  test("rejects active mesh work as a cancellation and terminates the worker", async () => {
    const terminate = vi.fn();
    class PendingMeshWorker {
      addEventListener() {}
      postMessage() {}
      terminate = terminate;
    }
    vi.stubGlobal("Worker", PendingMeshWorker);

    const pending = meshGeoScriptInWorker({
      geoScript: "SetFactory(\"OpenCASCADE\");",
      elementOrder: 1,
      units: "mm"
    });
    cancelMeshWork("Mesh generation cancelled.");

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "Mesh generation cancelled."
    });
    expect(terminate).toHaveBeenCalledOnce();
  });
});
