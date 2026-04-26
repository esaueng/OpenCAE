import { afterEach, describe, expect, test, vi } from "vitest";
import type { DisplayModel, Project } from "@opencae/schema";
import { createProject, importLocalProject, loadSampleProject, uploadModel } from "./api";

const project = {
  id: "project-1",
  name: "Uploaded Project",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [{
    id: "geometry-1",
    projectId: "project-1",
    filename: "uploaded-bracket.stl",
    localPath: "uploads/uploaded-bracket.stl",
    artifactKey: "project-1/geometry/uploaded-display.json",
    status: "ready",
    metadata: { source: "local-upload" }
  }],
  studies: [],
  createdAt: "2026-04-24T12:00:00.000Z",
  updatedAt: "2026-04-24T12:00:00.000Z"
} satisfies Project;

const displayModel = {
  id: "display-1",
  name: "Display",
  bodyCount: 0,
  faces: []
} satisfies DisplayModel;

const sizedAsciiStl = `
solid tray
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 268.8 0 0
vertex 0 289.9 246.05
endloop
endfacet
endsolid tray
`;

describe("api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("keeps uploaded model bytes on the project returned from upload", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ project, displayModel, message: "Uploaded." }), {
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = new File([new Uint8Array([1, 2, 3])], "uploaded-bracket.stl", { type: "model/stl" });
    const response = await uploadModel("project-1", file);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const requestBody = JSON.parse(requestInit?.body as string) as Record<string, unknown>;
    const expectedEmbeddedModel = {
      filename: "uploaded-bracket.stl",
      contentType: "model/stl",
      size: 3,
      contentBase64: "AQID"
    };

    expect(requestBody).toEqual(expectedEmbeddedModel);
    expect(response.project.geometryFiles[0]?.metadata.embeddedModel).toEqual(expectedEmbeddedModel);
  });

  test("uploads a model locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("NetworkError when attempting to fetch resource."))));

    const file = new File([sizedAsciiStl], "seed-tray.stl", { type: "model/stl" });
    const response = await uploadModel("project-1", file, project);

    expect(response.project.geometryFiles[0]?.filename).toBe("seed-tray.stl");
    expect(response.project.geometryFiles[0]?.metadata.previewFormat).toBe("stl");
    expect(response.project.geometryFiles[0]?.metadata.embeddedModel).toMatchObject({
      filename: "seed-tray.stl",
      contentType: "model/stl",
      size: sizedAsciiStl.length
    });
    expect(response.displayModel.visualMesh?.filename).toBe("seed-tray.stl");
    expect(response.displayModel.dimensions).toEqual({ x: 268.8, y: 246.1, z: 289.9, units: "mm" });
    expect(response.message).toContain("Previewing the uploaded mesh");
  });

  test("loads the sample project locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));

    const response = await loadSampleProject("bracket");

    expect(response.project.name).toBe("Bracket Demo");
    expect(response.displayModel.name).toBe("bracket demo body");
    expect(response.message).toBe("Bracket Demo loaded.");
  });

  test("creates a blank project locally when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));

    const response = await createProject();

    expect(response.project.name).toBe("Untitled Project");
    expect(response.project.geometryFiles).toHaveLength(0);
    expect(response.displayModel.name).toBe("No model loaded");
  });

  test("opens a local project file without requiring the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const file = new File([JSON.stringify({ project, displayModel })], "project.opencae.json", { type: "application/json" });

    const response = await importLocalProject(file);

    expect(response.project.name).toBe("Uploaded Project");
    expect(response.displayModel.name).toBe("Display");
    expect(response.message).toBe("Uploaded Project opened from local file.");
  });
});
