import { describe, expect, test } from "vitest";
import { buildApi } from "./server";

describe("OpenCAE API server", () => {
  test("rate limits project creation", async () => {
    const api = await buildApi();
    const responses = [];
    for (let index = 0; index < 31; index += 1) {
      responses.push(await api.inject({ method: "POST", url: "/api/projects", remoteAddress: "203.0.113.10", payload: {} }));
    }

    expect(responses.slice(0, 30).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[30]?.statusCode).toBe(429);
    expect(responses[30]?.json()).toMatchObject({ error: "Too many project creation requests. Please try again later." });
  });

  test("sanitizes report download filenames without regex replacement", async () => {
    const api = await buildApi();
    const create = await api.inject({
      method: "POST",
      url: "/api/projects",
      remoteAddress: "203.0.113.20",
      payload: { mode: "sample", sample: "bracket", analysisType: "dynamic_structural", name: "../../My Unsafe Project!!" }
    });
    const project = create.json().project as { id: string };

    const response = await api.inject({ method: "GET", url: `/api/projects/${project.id}/report.pdf` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="my-unsafe-project-report.pdf"');
  });
});
