/**
 * Records golden OpenCAE Core Cloud solve fixtures for the built-in sample projects.
 *
 * PERMANENT KEEPER after the cloud retirement (B4b/B5, 2026-07): the fixtures
 * freeze the RETIRED cloud runner's exact request/response contract so the
 * local (in-browser) solve pipeline can be compared against it bit-for-bit
 * (libs/opencae-solve-pipeline/src/goldenParity.test.ts). Re-record only if
 * the frozen contract must be regenerated: build the runner from the archived
 * OpenCAE Core repo's services/opencae-core-cloud source at the ref recorded
 * in the fixtures' meta.coreRef (see
 * apps/opencae-web/src/testdata/core-cloud-golden/README.md), then:
 *
 *   CORE_CLOUD_GOLDEN_URL=http://127.0.0.1:8080 \
 *   CORE_CLOUD_API_KEY=golden-local \
 *   pnpm exec tsx scripts/record-core-cloud-golden.mts
 *
 * The request builder below is a frozen copy of the web app's retired
 * openCaeCoreCloudSolveRequest() (client cloud solves were removed in B4a).
 * It is built from the same @opencae/core-adapter pieces the production path
 * used, and is intentionally exempt from the cloud-retirement guard test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalSampleProject } from "../apps/opencae-web/src/localProjectFactory";
import type { SampleAnalysisType, SampleModelId } from "../apps/opencae-web/src/lib/api";
import {
  buildOpenCaeCoreModelForStudy,
  geometrySourceForStudy,
  hasActualCoreVolumeMesh,
  isComplexGeometry,
  studyForCoreGeometryDispatch,
  OPENCAE_CORE_MESH_REQUIRED_REASON,
  type CoreCloudGeometrySource
} from "@opencae/core-adapter";
import type { DisplayModel, MeshQuality, Study } from "@opencae/schema";

// Frozen copy of the retired client request builder (see file header).
const CLOUD_PROCEDURAL_MESH_SIZE_MM: Record<MeshQuality, number> = {
  coarse: 18,
  medium: 12,
  fine: 8,
  ultra: 6
};

function geometryWithMeshPreset(geometry: CoreCloudGeometrySource, study: Study): CoreCloudGeometrySource {
  if (geometry.kind !== "sample_procedural" || !geometry.descriptor) return geometry;
  const meshSize = CLOUD_PROCEDURAL_MESH_SIZE_MM[study.meshSettings.preset] ?? CLOUD_PROCEDURAL_MESH_SIZE_MM.medium;
  return { ...geometry, descriptor: { ...geometry.descriptor, meshSize } };
}

function openCaeCoreCloudSolveRequest(runId: string, study: Study, displayModel: DisplayModel | undefined) {
  const actualMesh = hasActualCoreVolumeMesh(study, displayModel);
  const geometry = actualMesh ? null : geometrySourceForStudy(study, displayModel);
  if (!actualMesh && !geometry && isComplexGeometry(displayModel, study)) {
    throw new Error(OPENCAE_CORE_MESH_REQUIRED_REASON);
  }
  if (geometry) {
    const useLinearGmshElements = geometry.kind === "sample_procedural" && geometry.sampleId === "bracket";
    return {
      runId,
      analysisType: study.type,
      // The cloud container meshes dispatched geometry in the upright solver frame and
      // applies study load directions verbatim, so hand it a solver-frame study.
      study: studyForCoreGeometryDispatch(study, displayModel),
      displayModel,
      geometry: geometryWithMeshPreset(geometry, study),
      coreVolumeMesh: null,
      solverSettings: {
        ...study.solverSettings,
        backend: "opencae_core_cloud",
        // Native curved Gmsh Tet10 elements can invert around the bracket's drilled holes.
        ...(useLinearGmshElements ? { elementOrder: 1 } : {})
      },
      resultSettings: {
        provenance: {
          kind: "opencae_core_fea",
          solver: "opencae-core-cloud",
          resultSource: "computed",
          meshSource: "actual_volume_mesh"
        },
        renderBounds: displayModel?.dimensions ?? null
      }
    };
  }

  const coreBuild = buildOpenCaeCoreModelForStudy(study, displayModel);
  return {
    runId,
    analysisType: study.type,
    study,
    coreModel: coreBuild.model,
    coreVolumeMesh: null,
    solverSettings: {
      ...study.solverSettings,
      backend: "opencae_core_cloud"
    },
    resultSettings: {
      provenance: {
        kind: "opencae_core_fea",
        solver: "opencae-core-cloud",
        resultSource: "computed",
        meshSource: coreBuild.meshSource
      },
      renderBounds: displayModel?.dimensions ?? null
    }
  };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const RUNNER_URL = process.env.CORE_CLOUD_GOLDEN_URL ?? "http://127.0.0.1:8080";
const API_KEY = process.env.CORE_CLOUD_API_KEY ?? "golden-local";
// The recorded meta.coreRef defaults to the imported Core ref; override with
// CORE_CLOUD_GOLDEN_CORE_REF when recording from another ref.
const CORE_REF = process.env.CORE_CLOUD_GOLDEN_CORE_REF
  ?? "bc6c305272bd2789634f5e4c9006e0eae21e116b";
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
