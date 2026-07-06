// B4a old-data compatibility regression: projects saved BEFORE the client
// cloud-solve retirement carry `run-cloud-core-*` run ids, an explicit
// "opencae_core_cloud" backend choice, and result bundles with cloud-container
// provenance. They must keep loading:
//  - the backend aliases to "auto" (schema preprocess),
//  - the saved result bundle still parses and keeps its honest historical
//    "cloud container" provenance labeling,
//  - nothing ever fetches the removed client cloud endpoints: getResults on a
//    historical cloud run id fails with a clear explanation, and subscribeToRun
//    delivers a terminal synthetic event instead of opening an EventSource.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ResultField, ResultSummary } from "@opencae/schema";
import { openLocalProjectPayload, createLocalSampleProject } from "../localProjectFactory";
import { getResults, subscribeToRun } from "./api";
import type { RunEvent } from "@opencae/schema";

const HISTORICAL_CLOUD_RUN_ID = "run-cloud-core-8b7d1cba-legacy";

const cloudSummary = {
  maxStress: 42.5,
  maxStressUnits: "MPa",
  maxDisplacement: 0.31,
  maxDisplacementUnits: "mm",
  safetyFactor: 3.2,
  reactionForce: 500,
  reactionForceUnits: "N",
  provenance: {
    kind: "opencae_core_fea",
    solver: "opencae-core-cloud",
    resultSource: "computed",
    meshSource: "actual_volume_mesh",
    units: "mm-N-s-MPa"
  }
} as unknown as ResultSummary;

const cloudFields = [{
  id: "field-stress-1",
  runId: HISTORICAL_CLOUD_RUN_ID,
  type: "stress",
  location: "face",
  values: [42.5],
  min: 42.5,
  max: 42.5,
  units: "MPa"
}] as ResultField[];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("historical cloud runs from pre-B4a project files", () => {
  test("loads an old project with a cloud run id, cloud backend choice, and cloud-provenance results", async () => {
    const sample = await createLocalSampleProject("bracket", "static_stress", "2026-01-15T00:00:00.000Z");
    const oldPayload = {
      project: {
        ...sample.project,
        studies: sample.project.studies.map((study) => ({
          ...study,
          // Explicit cloud choice saved before the retirement.
          solverSettings: { ...study.solverSettings, backend: "opencae_core_cloud" }
        }))
      },
      displayModel: sample.displayModel,
      results: {
        activeRunId: HISTORICAL_CLOUD_RUN_ID,
        completedRunId: HISTORICAL_CLOUD_RUN_ID,
        summary: cloudSummary,
        fields: cloudFields
      }
    };
    // Round-trip through JSON exactly like a .opencae.json file import.
    const opened = openLocalProjectPayload(JSON.parse(JSON.stringify(oldPayload)));

    // The retired cloud backend aliases to "auto" (round-trip safe).
    expect(opened.project.studies[0]?.solverSettings.backend).toBe("auto");
    const reopened = openLocalProjectPayload(JSON.parse(JSON.stringify(opened)));
    expect(reopened.project.studies[0]?.solverSettings.backend).toBe("auto");

    // The saved cloud results still parse, with runIds and historical
    // provenance intact ("cloud container" labeling stays for old data).
    expect(opened.results?.completedRunId).toBe(HISTORICAL_CLOUD_RUN_ID);
    expect(opened.results?.fields[0]?.runId).toBe(HISTORICAL_CLOUD_RUN_ID);
    expect(opened.results?.summary.provenance?.solver).toBe("opencae-core-cloud");
    expect(opened.results?.summary.provenance?.resultSource).toBe("computed");
  });

  test("getResults on a historical cloud run id fails clearly without touching dead endpoints", async () => {
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => Promise.reject(new TypeError("historical cloud runs must not fetch")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getResults(HISTORICAL_CLOUD_RUN_ID)).rejects.toThrow(/retired OpenCAE Core Cloud/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("subscribeToRun on a historical cloud run id delivers one terminal event and opens no stream", async () => {
    class ForbiddenEventSource {
      constructor() {
        throw new Error("historical cloud runs must not open an EventSource");
      }
    }
    vi.stubGlobal("EventSource", ForbiddenEventSource);

    const seen: RunEvent[] = [];
    const source = subscribeToRun(HISTORICAL_CLOUD_RUN_ID, (event) => seen.push(event));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2000 });
    source.close();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("error");
    expect(seen[0]?.message).toMatch(/retired OpenCAE Core Cloud/i);
  });
});
