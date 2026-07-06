/**
 * Records golden OpenCAE Core Cloud solve fixtures for the built-in sample projects.
 *
 * The fixtures freeze the DEPLOYED runner's exact request/response contract so the
 * local (in-browser) solve pipeline can be compared against it bit-for-bit. Run a
 * pristine runner built from the pinned production opencae-core ref (see
 * services/opencae-core-cloud/OPENCAE_CORE_REF and
 * apps/opencae-web/src/testdata/core-cloud-golden/README.md), then:
 *
 *   CORE_CLOUD_GOLDEN_URL=http://127.0.0.1:8080 \
 *   CORE_CLOUD_API_KEY=golden-local \
 *   pnpm exec tsx scripts/record-core-cloud-golden.mts
 *
 * Requests are produced by the same code path the web app uses for
 * POST /api/cloud-core/runs: openCaeCoreCloudSolveRequest() in
 * apps/opencae-web/src/lib/api.ts, which the Worker forwards verbatim to the
 * runner's /solve endpoint (apps/opencae-web/worker/index.ts, runCoreCloudSolve).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalSampleProject } from "../apps/opencae-web/src/localProjectFactory";
import { openCaeCoreCloudSolveRequest, type SampleAnalysisType, type SampleModelId } from "../apps/opencae-web/src/lib/api";
import type { Study } from "@opencae/schema";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const RUNNER_URL = process.env.CORE_CLOUD_GOLDEN_URL ?? "http://127.0.0.1:8080";
const API_KEY = process.env.CORE_CLOUD_API_KEY ?? "golden-local";
const CORE_REF = process.env.CORE_CLOUD_GOLDEN_CORE_REF
  ?? readFileSync(resolve(scriptDir, "../services/opencae-core-cloud/OPENCAE_CORE_REF"), "utf8").trim();
// Fixed timestamp keeps createdAt/updatedAt/run timestamps in requests deterministic.
const FIXED_NOW = "2026-07-05T00:00:00.000Z";

const OUTPUT_DIR = resolve(scriptDir, "../apps/opencae-web/src/testdata/core-cloud-golden");

interface GoldenCase {
  name: string;
  sample: SampleModelId;
  analysisType: SampleAnalysisType;
  /** Optional study overrides applied before the request is built (all values the app UI can produce). */
  adjustStudy?: (study: Study) => Study;
}

// Dynamic samples default to endTime 0.1 s at the medium mesh preset, which produces
// fixtures well over the 2 MB budget. Record them with the coarse preset and a 0.05 s
// window (11 output frames) instead - both are ordinary user-selectable settings, so
// the request still exercises the exact production contract.
function modestDynamicStudy(study: Study): Study {
  return {
    ...study,
    meshSettings: { ...study.meshSettings, preset: "coarse" },
    solverSettings: { ...study.solverSettings, endTime: 0.05 }
  };
}

const CASES: GoldenCase[] = [
  { name: "cantilever-static", sample: "cantilever", analysisType: "static_stress" },
  { name: "beam-static", sample: "plate", analysisType: "static_stress" },
  { name: "bracket-static", sample: "bracket", analysisType: "static_stress" },
  { name: "cantilever-dynamic", sample: "cantilever", analysisType: "dynamic_structural", adjustStudy: modestDynamicStudy },
  { name: "beam-dynamic", sample: "plate", analysisType: "dynamic_structural", adjustStudy: modestDynamicStudy }
];

async function recordCase(golden: GoldenCase, runnerVersion: string, coreVersion: string): Promise<void> {
  const { project, displayModel } = await createLocalSampleProject(golden.sample, golden.analysisType, FIXED_NOW);
  const baseStudy = project.studies[0] as Study | undefined;
  if (!baseStudy) throw new Error(`Sample ${golden.sample} produced no study.`);
  const study = golden.adjustStudy ? golden.adjustStudy(baseStudy) : baseStudy;
  const request = openCaeCoreCloudSolveRequest(`run-golden-${golden.name}`, study, displayModel);

  const response = await fetch(`${RUNNER_URL}/solve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(request)
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Solve for ${golden.name} failed with HTTP ${response.status}: ${JSON.stringify(body).slice(0, 800)}`);
  }

  const fixture = {
    meta: {
      coreRef: CORE_REF,
      runnerVersion,
      coreVersion,
      recordedAt: new Date().toISOString(),
      case: golden.name
    },
    request,
    response: body
  };
  const path = resolve(OUTPUT_DIR, `${golden.name}.json`);
  // Compact serialization: these are frozen machine-compared fixtures, and pretty
  // printing the large numeric arrays would triple the file size.
  writeFileSync(path, `${JSON.stringify(fixture)}\n`);
  const summary = (body as { summary?: { maxStress?: unknown; maxDisplacement?: unknown } }).summary;
  console.log(`recorded ${golden.name}: maxStress=${summary?.maxStress} maxDisplacement=${summary?.maxDisplacement}`);
}

async function main(): Promise<void> {
  const healthResponse = await fetch(`${RUNNER_URL}/health`);
  const health = await healthResponse.json() as { ok?: boolean; runnerVersion?: string; coreVersion?: string; gmshAvailable?: boolean };
  if (!healthResponse.ok || !health.ok) throw new Error(`Runner health check failed: ${JSON.stringify(health)}`);
  console.log(`runner ${RUNNER_URL}: runnerVersion=${health.runnerVersion} coreVersion=${health.coreVersion} gmshAvailable=${health.gmshAvailable}`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const golden of CASES) {
    await recordCase(golden, health.runnerVersion ?? "unknown", health.coreVersion ?? "unknown");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
