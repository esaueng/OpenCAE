import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { inspectStepFile } from "@opencae/cad-service";
import { SQLiteDatabaseProvider } from "@opencae/db";
import { bracketDemoMaterial, bracketDemoProject, bracketDisplayModel, bracketResultFields, bracketResultSummary } from "@opencae/db/sample-data";
import { InMemoryJobQueueProvider, LocalRunStateProvider } from "@opencae/jobs";
import { MockMeshService } from "@opencae/mesh-service";
import { assertCompatibleManufacturingProcess } from "@opencae/materials";
import { buildHtmlReport, buildPdfReport, LocalReportProvider, reportPdfKeyFor } from "@opencae/post-service";
import { solveDynamicStudy } from "@opencae/solver-service";
import {
  ProjectSchema,
  ResultFieldSchema,
  ResultSummarySchema,
  StudySchema,
  classifyResultProvenance,
  isRunResultReadyStatus,
  runStatusForResultProvenance,
  type DisplayModel,
  type Load,
  type MeshQuality,
  type Project,
  type ResultField,
  type ResultProvenanceTier,
  type ResultSummary,
  type RunEvent,
  type Study,
  type StudyRun
} from "@opencae/schema";
import { mutatingRateLimit, pdfFilename, projectsReadRateLimit, sanitizeFilename, sanitizeProjectName } from "./security";
import { hasActualCoreVolumeMesh, openCaeCoreEligibility, trySolveOpenCaeCoreStudy } from "@opencae/core-adapter";
import { FileSystemObjectStorageProvider } from "@opencae/storage";
import { validateStaticStressStudy, validateStudy } from "@opencae/study-core";
import {
  attachUploadedModelToProject,
  blankDisplayModel,
  createBlankProject,
  createDynamicStructuralStudy,
  createSampleProject,
  createStaticStressStudy,
  normalizeSampleAnalysisType,
  normalizeSampleId,
  sampleDisplayModelFor,
  sampleProjectName,
  uploadedDisplayModelFor,
  type SampleModelId
} from "./projectFactory";

export const API_LISTEN_HOST = process.env.OPENCAE_API_HOST ?? "127.0.0.1";

const allowedCorsOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);

const api = Fastify({ logger: true, bodyLimit: 5_000_000 });
const RATE_LIMIT_ERROR_MESSAGE = "Too many API requests. Please try again later.";
await api.register(cors, {
  origin(origin, callback) {
    callback(null, !origin || allowedCorsOrigins.has(origin));
  }
});
await api.register(rateLimit, {
  global: false,
  errorResponseBuilder: () => ({
    statusCode: 429,
    error: RATE_LIMIT_ERROR_MESSAGE
  })
});

api.setErrorHandler((error: { statusCode?: number; message?: string }, request, reply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode === 429) {
    void reply.code(429).send({ statusCode: 429, error: RATE_LIMIT_ERROR_MESSAGE });
    return;
  }
  if (statusCode >= 500) {
    request.log.error({ err: error }, "Unhandled API error");
    void reply.code(500).send({ error: "Internal server error." });
    return;
  }
  void reply.code(statusCode).send({ error: error.message ?? "Request failed." });
});

const db = new SQLiteDatabaseProvider();
const storage = new FileSystemObjectStorageProvider();
const jobs = new InMemoryJobQueueProvider({
  onError: (jobId, error) => api.log.error({ err: error, jobId }, "Job failed")
});
const runState = new LocalRunStateProvider();
const meshService = new MockMeshService(storage);
const reports = new LocalReportProvider(storage);

db.migrate();
db.seed();
await ensureSampleArtifacts();

api.get("/health", async () => ({ ok: true, mode: "local", service: "opencae-api" }));

api.get("/api/sample-project", async (request) => {
  const sample = normalizeSampleId((request.query as { sample?: string }).sample);
  return {
  project: db.getProject(bracketDemoProject.id),
  displayModel: sampleDisplayModelFor(sample),
  material: bracketDemoMaterial,
  resultSummary: bracketResultSummary
};
});

api.post("/api/sample-project/load", async (request) => {
  const sample = normalizeSampleId((request.body as { sample?: string } | undefined)?.sample);
  const analysisType = normalizeSampleAnalysisType((request.body as { analysisType?: string } | undefined)?.analysisType);
  const now = new Date().toISOString();
  const project = createSampleProject(sample, {
    projectId: bracketDemoProject.id,
    studyId: bracketDemoProject.studies[0]?.id ?? "study-bracket-static",
    now,
    includeSeedRun: analysisType === "dynamic_structural" || sample === "bracket",
    analysisType
  });
  const dynamicResults = analysisType === "dynamic_structural" ? dynamicSampleResults(project) : undefined;
  db.upsertProject(project);
  await ensureSampleArtifacts();
  if (dynamicResults) await persistSampleResults(project, dynamicResults);
  return {
    message: analysisType === "dynamic_structural" ? `${sampleProjectName(sample)} dynamic sample loaded.` : `${sampleProjectName(sample)} loaded.`,
    project: db.getProject(bracketDemoProject.id),
    displayModel: sampleDisplayModelFor(sample),
    ...(dynamicResults ? { results: dynamicResults } : {})
  };
});

api.get("/api/projects", projectsReadRateLimit, async () => ({ projects: db.listProjects() }));

api.post("/api/projects", mutatingRateLimit, async (request) => {
  const body = request.body as Partial<Project> & { sample?: SampleModelId; analysisType?: string; mode?: "blank" | "sample" } | undefined;
  const now = new Date().toISOString();
  if (body?.mode !== "sample") {
    const project = createBlankProject({
      projectId: `project-${crypto.randomUUID()}`,
      studyId: `study-${crypto.randomUUID()}`,
      name: body?.name,
      now
    });
    db.upsertProject(project);
    return { project, displayModel: blankDisplayModel(), message: "Blank project created." };
  }

  const sample = normalizeSampleId(body?.sample);
  const analysisType = normalizeSampleAnalysisType(body?.analysisType);
  const project = createSampleProject(sample, {
    projectId: `project-${crypto.randomUUID()}`,
    studyId: `study-${crypto.randomUUID()}`,
    name: body?.name ?? `Untitled ${sampleProjectName(sample)}`,
    now,
    includeSeedRun: analysisType === "dynamic_structural",
    analysisType
  });
  const dynamicResults = analysisType === "dynamic_structural" ? dynamicSampleResults(project) : undefined;
  db.upsertProject(project);
  await storage.putObject(project.geometryFiles[0]?.artifactKey ?? `${project.id}/geometry/display.json`, JSON.stringify(sampleDisplayModelFor(sample), null, 2));
  if (dynamicResults) await persistSampleResults(project, dynamicResults);
  return { project, displayModel: sampleDisplayModelFor(sample), ...(dynamicResults ? { results: dynamicResults } : {}), message: "Project created." };
});

api.post("/api/projects/import", mutatingRateLimit, async (request, reply) => {
  const body = request.body as { project?: unknown; displayModel?: unknown; results?: unknown } | Project | undefined;
  const candidate = body && "project" in body ? body.project : body;
  const parsed = ProjectSchema.safeParse(candidate);
  if (!parsed.success) return reply.code(400).send({ error: "The selected file is not a valid OpenCAE project JSON." });

  const project = withCanonicalArtifactRefs(parsed.data);
  const displayModel = parseDisplayModel(body && "displayModel" in body ? body.displayModel : undefined) ?? await displayModelForProject(project);
  const results = parseLocalResults(body && "results" in body ? body.results : undefined, project);
  const importedProject = results ? projectWithImportedResultRefs(project, results) : project;
  db.upsertProject(importedProject);
  await persistImportedModelArtifacts(importedProject, displayModel);
  if (results) await persistImportedResults(importedProject, results);
  return { project: importedProject, displayModel, results, message: `${importedProject.name} opened from local file.` };
});

api.get("/api/projects/:projectId", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  return { project, displayModel: await displayModelForProject(project) };
});

api.put("/api/projects/:projectId", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as { name?: unknown } | undefined;
  const name = sanitizeProjectName(body?.name);
  if (!name) return reply.code(400).send({ error: "Project name is required." });
  const nextProject: Project = {
    ...project,
    name,
    updatedAt: new Date().toISOString()
  };
  db.upsertProject(nextProject);
  return { project: nextProject, message: "Project renamed." };
});

api.post("/api/projects/:projectId/uploads", mutatingRateLimit, async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as { filename?: string; size?: number; contentType?: string; contentBase64?: string; modelMutation?: unknown } | undefined;
  const filename = sanitizeFilename(body?.filename);
  if (!filename) {
    return reply.code(400).send({
      error: "Only STEP, STP, STL, and OBJ model uploads are supported in the local viewer."
    });
  }
  const modelMutation = body?.modelMutation === undefined ? undefined : parseUploadModelMutation(body.modelMutation);
  if (body?.modelMutation !== undefined && !modelMutation) {
    return reply.code(400).send({ error: "Invalid model mutation token." });
  }
  if (modelMutation && !canApplyUploadModelMutation(project, modelMutation)) {
    return reply.code(409).send({ error: "This model upload was superseded by a newer workspace change." });
  }

  const contentBase64 = typeof body?.contentBase64 === "string" && body.contentBase64.length > 0 ? body.contentBase64 : undefined;
  const displayModel = uploadedDisplayModelFor(filename, contentBase64);
  const geometryId = `geom-upload-${crypto.randomUUID()}`;
  // Each accepted mutation gets its own object key. Otherwise an older
  // handler that is already awaiting storage could overwrite the display
  // artifact after a newer database mutation has committed.
  const artifactKey = `${project.id}/geometry/${geometryId}-display.json`;
  const nextProject = attachUploadedModelToProject(project, {
    geometryId,
    filename,
    artifactKey,
    now: new Date().toISOString(),
    displayModel
  });
  nextProject.geometryFiles[0]!.metadata = {
    ...nextProject.geometryFiles[0]!.metadata,
    originalSize: Number.isFinite(body?.size) ? body?.size : undefined,
    contentType: body?.contentType,
    ...(modelMutation ? {
      modelMutation: {
        clientId: modelMutation.clientId,
        generation: modelMutation.generation,
        baseGeometryId: modelMutation.expectedGeometryId,
        baseUpdatedAt: modelMutation.expectedUpdatedAt,
        appliedUpdatedAt: nextProject.updatedAt
      }
    } : {})
  };
  db.upsertProject(nextProject);
  await storage.putObject(artifactKey, JSON.stringify(displayModel, null, 2));
  if (contentBase64) {
    await storage.putObject(`${project.id}/uploads/${filename}`, Buffer.from(contentBase64, "base64"));
  }
  await storage.putObject(`${project.id}/uploads/${filename}.metadata.json`, JSON.stringify({ filename, size: body?.size, contentType: body?.contentType }, null, 2));
  const previewMessage = displayModel.visualMesh
    ? "Previewing the uploaded mesh in the viewport."
    : displayModel.nativeCad
      ? "Previewing a selectable STEP import body in the viewport."
      : "Preview is not available for this file.";
  return {
    project: nextProject,
    displayModel,
    message: `${filename} uploaded. ${previewMessage}`
  };
});

api.get("/api/projects/:projectId/files", async (request) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  return { files: project?.geometryFiles ?? [] };
});

api.get("/api/projects/:projectId/report", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });

  const run = latestCompletedRunForProject(project);
  const reportRef = run?.reportRef;
  if (!reportRef) return reply.code(404).send({ error: "Report not found. Run the simulation before generating a report." });

  const html = await storage.getObject(reportRef);
  reply.header("content-type", "text/html; charset=utf-8");
  return html.toString("utf8");
});

api.get("/api/projects/:projectId/report.pdf", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });

  const run = latestCompletedRunForProject(project);
  const reportRef = run?.reportRef;
  if (!reportRef) return reply.code(404).send({ error: "Report not found. Run the simulation before downloading a PDF." });

  const pdf = await pdfForReport(run, reportRef);
  reply.header("content-type", "application/pdf");
  reply.header("content-disposition", `attachment; filename="${pdfFilename(project.name)}"`);
  return pdf;
});

api.get("/api/projects/:projectId/studies", async (request) => {
  const { projectId } = request.params as { projectId: string };
  return { studies: db.getProject(projectId)?.studies ?? [] };
});

api.post("/api/projects/:projectId/studies", mutatingRateLimit, async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as { analysisType?: Study["type"] } | undefined;
  const displayModel = await displayModelForProject(project);
  const factory = body?.analysisType === "dynamic_structural" ? createDynamicStructuralStudy : createStaticStressStudy;
  const newStudy = factory(project, displayModel, {
    studyId: `study-${crypto.randomUUID()}`,
    now: new Date().toISOString()
  });
  db.upsertStudy(newStudy);
  return { study: newStudy };
});

api.get("/api/studies/:studyId", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  return { study };
});

api.put("/api/studies/:studyId", mutatingRateLimit, async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  if (!isRecord(request.body)) return reply.code(400).send({ error: "Invalid study update." });
  const merged = { ...study, ...request.body, id: study.id, projectId: study.projectId };
  const parsed = StudySchema.safeParse(merged);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid study update.", issues: parsed.error.issues.map((issue) => issue.message) });
  db.upsertStudy(parsed.data);
  return { study: parsed.data };
});

api.post("/api/studies/:studyId/validate", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const diagnostics = validateStaticStressStudy(study).map((diagnostic) => diagnostic.message);
  return { ready: diagnostics.length === 0, diagnostics };
});

api.post("/api/studies/:studyId/materials", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const body = request.body as { materialId?: string; parameters?: Record<string, unknown> } | undefined;
  const materialId = body?.materialId ?? bracketDemoMaterial.id;
  const parameters = body?.parameters ?? {};
  if (parameters.manufacturingProcessId !== undefined) {
    try {
      assertCompatibleManufacturingProcess(materialId, parameters.manufacturingProcessId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid material and manufacturing process." });
    }
  }
  const bodySelection = study.namedSelections.find((selection) => selection.entityType === "body");
  const assignment = {
    id: "assign-material-current",
    materialId,
    selectionRef: bodySelection?.id ?? "selection-body-bracket",
    parameters,
    status: "complete" as const
  };
  const next = { ...study, materialAssignments: [assignment] };
  db.upsertStudy(next);
  return { study: next, message: `Material assigned to ${bodySelection?.name ?? "model"}.` };
});

api.post("/api/studies/:studyId/supports", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const body = request.body as { selectionRef?: string } | undefined;
  const support = {
    id: `constraint-${crypto.randomUUID()}`,
    type: "fixed" as const,
    selectionRef: body?.selectionRef ?? "selection-fixed-face",
    parameters: {},
    status: "complete" as const
  };
  const next = { ...study, constraints: [...study.constraints, support] };
  db.upsertStudy(next);
  return { study: next, message: "Fixed support added." };
});

api.post("/api/studies/:studyId/loads", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const body = request.body as Partial<Load> & { value?: number; selectionRef?: string; direction?: [number, number, number]; directionMode?: string; applicationPoint?: [number, number, number]; payloadObject?: unknown; payloadMaterialId?: string; payloadVolumeM3?: number; payloadMassMode?: string } | undefined;
  const type = body?.type ?? "force";
  if (!isLoadType(type)) return reply.code(400).send({ error: "Invalid load type." });
  if (body?.directionMode !== undefined && !isLoadDirectionMode(body.directionMode)) return reply.code(400).send({ error: "Invalid load direction mode." });
  const payloadVolumeM3 = body?.payloadVolumeM3;
  const load: Load = {
    id: `load-${crypto.randomUUID()}`,
    type,
    selectionRef: body?.selectionRef ?? "selection-load-face",
    parameters: { value: body?.value ?? 500, units: unitsForLoadType(type), direction: body?.direction ?? [0, 0, -1], ...(body?.directionMode ? { directionMode: body.directionMode } : {}), ...(body?.applicationPoint ? { applicationPoint: body.applicationPoint } : {}), ...(body?.payloadObject ? { payloadObject: body.payloadObject } : {}), ...(type === "gravity" && body?.payloadMaterialId ? { payloadMaterialId: body.payloadMaterialId } : {}), ...(type === "gravity" && Number.isFinite(payloadVolumeM3) ? { payloadVolumeM3 } : {}), ...(type === "gravity" && body?.payloadMassMode ? { payloadMassMode: body.payloadMassMode } : {}) },
    status: "complete"
  };
  const next = { ...study, loads: [...study.loads, load] };
  const loadDiagnostics = validateStaticStressStudy(next).filter((diagnostic) => diagnostic.id.includes(load.id));
  if (loadDiagnostics.length) {
    return reply.code(400).send({ error: "Invalid load.", diagnostics: loadDiagnostics });
  }
  db.upsertStudy(next);
  return { study: next, message: "Load added." };
});

api.post("/api/studies/:studyId/mesh", mutatingRateLimit, async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const body = request.body as { preset?: MeshQuality } | undefined;
  const preset = body?.preset ?? "medium";
  const mesh = await meshService.generateMesh(study, preset);
  const next: Study = {
    ...study,
    meshSettings: { preset, status: "complete", meshRef: mesh.artifactKey, summary: mesh.summary }
  };
  db.upsertStudy(next);
  return { study: next, mesh, message: "Mesh generated." };
});

api.post("/api/studies/:studyId/runs", mutatingRateLimit, async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const runDiagnostics = validateStudy(study);
  if (runDiagnostics.length) return reply.code(400).send({ error: "Study is not ready.", diagnostics: runDiagnostics });
  const studySnapshot = structuredClone(study);
  const project = db.getProject(studySnapshot.projectId);
  const displayModel = project ? await displayModelForProject(project) : blankDisplayModel();
  const eligibility = openCaeCoreEligibility(studySnapshot, displayModel);
  const runId = `run-${crypto.randomUUID()}`;
  const jobId = `job-${crypto.randomUUID()}`;
  const run: StudyRun = {
    id: runId,
    studyId,
    status: "queued",
    jobId,
    meshRef: studySnapshot.meshSettings.meshRef,
    solverBackend: coreSolverBackendForRun(studySnapshot, displayModel, eligibility),
    solverVersion: "0.1.0",
    startedAt: new Date().toISOString(),
    diagnostics: []
  };
  db.upsertRun(run);
  publish(runId, "state", 0, "Simulation queued.");
  await jobs.enqueue(jobId, async () => {
    const runCancelled = () => jobs.getStatus(jobId) === "cancelled" || db.getRun(runId)?.status === "cancelled";
    try {
      if (runCancelled()) return;
      publish(runId, "state", 3, "OpenCAE Core simulation running.");
      publish(runId, "progress", 18, studySnapshot.type === "dynamic_structural" ? "OpenCAE Core dynamic Tet4 solver started." : "OpenCAE Core CPU Tet4 solver started.");
      const solved = trySolveOpenCaeCoreStudy({ study: studySnapshot, runId, displayModel });
      if (runCancelled()) return;
      if (!solved.ok) {
        const failed = {
          ...run,
          status: "failed" as const,
          finishedAt: new Date().toISOString(),
          diagnostics: [{
            id: "opencae-core-solve-failed",
            severity: "error" as const,
            source: "solver" as const,
            message: solved.reason,
            suggestedActions: []
          }]
        };
        db.upsertRun(failed);
        publish(runId, "error", 100, solved.reason);
        return;
      }
      publish(runId, "progress", 68, studySnapshot.type === "dynamic_structural" ? "Writing OpenCAE Core dynamic result frames." : "Writing OpenCAE Core result fields.");
      const resultRef = `${studySnapshot.projectId}/results/${runId}/results.json`;
      const resultTier = classifyResultProvenance(solved.result.summary.provenance);
      const resultStatus = runStatusForResultProvenance(solved.result.summary.provenance);
      const result = {
        ...solved.result,
        summary: {
          ...solved.result.summary,
          resultTier
        }
      };
      await storage.putObject(resultRef, JSON.stringify(result, null, 2));
      const reportRef = await reports.generateReport({ projectId: studySnapshot.projectId, runId, summary: result.summary, study: studySnapshot, fields: result.fields });
      if (runCancelled()) return;
      db.upsertRun({
        ...run,
        status: resultStatus,
        resultTier,
        resultRef,
        reportRef,
        finishedAt: new Date().toISOString()
      });
      publish(runId, "complete", 100, completeRunMessage(resultTier));
    } catch (error) {
      api.log.error({ err: error, runId }, "Run worker failed");
      if (runCancelled()) return;
      db.upsertRun({
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        diagnostics: [{
          id: "opencae-run-worker-failed",
          severity: "error" as const,
          source: "solver" as const,
          message: "The simulation failed while writing results. Check the API logs for details.",
          suggestedActions: []
        }]
      });
      publish(runId, "error", 100, "The simulation failed while writing results.");
    }
  });
  return { run, streamUrl: `/api/runs/${runId}/stream`, message: "OpenCAE Core simulation running." };
});

api.get("/api/runs/:runId", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = db.getRun(runId);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return { run };
});

api.get("/api/runs/:runId/events", async (request) => {
  const { runId } = request.params as { runId: string };
  return { events: runState.getEvents(runId) };
});

api.get("/api/runs/:runId/stream", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const writeEvent = (event: RunEvent) => {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const isTerminalEvent = (event: RunEvent) => event.type === "complete" || event.type === "error" || event.type === "cancelled";
  let reachedTerminal = false;
  for (const event of runState.getEvents(runId)) {
    writeEvent(event);
    if (isTerminalEvent(event)) reachedTerminal = true;
  }
  if (reachedTerminal) {
    reply.raw.end();
    return;
  }
  const heartbeat = setInterval(() => {
    reply.raw.write(":keep-alive\n\n");
  }, 15_000);
  const unsubscribe = runState.subscribe(runId, (event) => {
    writeEvent(event);
    if (isTerminalEvent(event)) {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    }
  });
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

api.post("/api/runs/:runId/cancel", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = db.getRun(runId);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  await jobs.cancel(run.jobId);
  const next = { ...run, status: "cancelled" as const, finishedAt: new Date().toISOString() };
  db.upsertRun(next);
  publish(runId, "cancelled", undefined, "Simulation cancelled.");
  return { run: next };
});

api.get("/api/runs/:runId/results", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = db.getRun(runId);
  if (!run?.resultRef) {
    if (runId === "run-bracket-demo-seeded") return { summary: bracketResultSummary, fields: bracketResultFields };
    return reply.code(404).send({ error: "Results not found" });
  }
  try {
    const artifact = await storage.getObject(run.resultRef);
    return JSON.parse(artifact.toString("utf8"));
  } catch {
    return reply.code(404).send({ error: "Results artifact is missing or unreadable." });
  }
});

api.get("/api/runs/:runId/report", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = db.getRun(runId);
  const reportRef = reportRefForRun(runId, run);
  if (!reportRef) return reply.code(404).send({ error: "Report not found. Run the simulation before generating a report." });
  try {
    const html = await storage.getObject(reportRef);
    reply.header("content-type", "text/html; charset=utf-8");
    return html.toString("utf8");
  } catch {
    return reply.code(404).send({ error: "Report artifact is missing or unreadable." });
  }
});

api.get("/api/runs/:runId/report.pdf", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = db.getRun(runId);
  const reportRef = reportRefForRun(runId, run);
  if (!reportRef) return reply.code(404).send({ error: "Report not found. Run the simulation before downloading a PDF." });
  const pdf = await pdfForReport(run, reportRef);
  reply.header("content-type", "application/pdf");
  reply.header("content-disposition", `attachment; filename="${pdfFilename(runId)}"`);
  return pdf;
});

function reportRefForRun(runId: string, run: StudyRun | undefined): string | undefined {
  if (run?.reportRef) return run.reportRef;
  if (runId === "run-bracket-demo-seeded") return "project-bracket-demo/reports/report.html";
  return undefined;
}

function publish(runId: string, type: RunEvent["type"], progress: number | undefined, message: string): void {
  runState.publish(runId, { runId, type, progress, message, timestamp: new Date().toISOString() });
}

function completeRunMessage(resultTier: ResultProvenanceTier): string {
  if (resultTier === "production_fea") return "OpenCAE Core simulation complete.";
  if (resultTier === "core_preview") return "OpenCAE Core preview complete.";
  if (resultTier === "analytical_benchmark") return "Analytical benchmark result complete.";
  if (resultTier === "imported_legacy") return "Legacy result restored.";
  return "Estimate result complete.";
}

function isLoadType(type: unknown): type is Load["type"] {
  return type === "force" || type === "pressure" || type === "gravity";
}

function isLoadDirectionMode(value: unknown): value is string {
  return value === "-Y" || value === "+Y" || value === "+X" || value === "-X" || value === "+Z" || value === "-Z" || value === "Normal" || value === "Opposite normal";
}

function unitsForLoadType(type: Load["type"]) {
  if (type === "pressure") return "kPa";
  if (type === "gravity") return "kg";
  return "N";
}

function latestCompletedRunForProject(project: Project): StudyRun | undefined {
  return project.studies
    .flatMap((study) => study.runs)
    .filter((run) => run.reportRef || run.resultRef || isRunResultReadyStatus(run.status))
    .sort((left, right) => {
      const leftTime = Date.parse(left.finishedAt ?? left.startedAt ?? "");
      const rightTime = Date.parse(right.finishedAt ?? right.startedAt ?? "");
      return (rightTime || 0) - (leftTime || 0);
    })[0];
}

async function pdfForReport(run: StudyRun | undefined, reportRef: string): Promise<Buffer> {
  const pdfRef = reportPdfKeyFor(reportRef);
  const summary = run?.resultRef ? await summaryForResult(run.resultRef) : bracketResultSummary;
  const pdf = buildPdfReport(run?.id ?? "run-bracket-demo-seeded", summary);
  await storage.putObject(pdfRef, pdf);
  return pdf;
}

async function summaryForResult(resultRef: string): Promise<typeof bracketResultSummary> {
  const artifact = await storage.getObject(resultRef);
  const parsed = JSON.parse(artifact.toString("utf8")) as { summary?: typeof bracketResultSummary };
  return parsed.summary ?? bracketResultSummary;
}

interface ImportedResultBundle {
  activeRunId?: string;
  completedRunId?: string;
  summary: ResultSummary;
  fields: ResultField[];
  resultTier: ResultProvenanceTier;
}

function parseLocalResults(value: unknown, project: Project): ImportedResultBundle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ImportedResultBundle>;
  const summary = ResultSummarySchema.safeParse(candidate.summary);
  const fields = ResultFieldSchema.array().safeParse(candidate.fields);
  if (!summary.success || !fields.success || fields.data.length === 0) return undefined;
  const projectRunIds = new Set(project.studies.flatMap((study) => study.runs.map((run) => run.id)));
  const completedRunId = typeof candidate.completedRunId === "string" ? candidate.completedRunId : undefined;
  const activeRunId = typeof candidate.activeRunId === "string" ? candidate.activeRunId : undefined;
  const fieldRunId = fields.data[0]?.runId;
  const runId = completedRunId ?? activeRunId ?? fieldRunId;
  if (runId && projectRunIds.size > 0 && !projectRunIds.has(runId)) return undefined;
  return {
    activeRunId,
    completedRunId: completedRunId ?? runId,
    summary: summary.data,
    fields: fields.data,
    resultTier: classifyResultProvenance(summary.data.provenance)
  };
}

function projectWithImportedResultRefs(project: Project, results: ImportedResultBundle): Project {
  const runId = results.completedRunId ?? results.activeRunId ?? results.fields[0]?.runId;
  if (!runId) return project;
  return {
    ...project,
    studies: project.studies.map((study) => ({
      ...study,
      runs: study.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              status: runStatusForResultProvenance(results.summary.provenance),
              resultTier: results.resultTier,
              resultRef: run.resultRef ?? `${project.id}/results/${runId}/results.json`,
              reportRef: run.reportRef ?? `${project.id}/reports/${runId}.html`
            }
          : run
      )
    }))
  };
}

function withCanonicalArtifactRefs(project: Project): Project {
  const isCanonicalRef = (ref: unknown): ref is string => typeof ref === "string" && ref.startsWith(`${project.id}/`) && !ref.includes("..");
  return {
    ...project,
    geometryFiles: project.geometryFiles.map((geometry, index) => ({
      ...geometry,
      artifactKey: isCanonicalRef(geometry.artifactKey) ? geometry.artifactKey : `${project.id}/geometry/imported-display-${index}.json`,
      metadata: isCanonicalRef(geometry.metadata.displayModelRef)
        ? geometry.metadata
        : { ...geometry.metadata, displayModelRef: undefined }
    })),
    studies: project.studies.map((study) => ({
      ...study,
      meshSettings: isCanonicalRef(study.meshSettings.meshRef)
        ? study.meshSettings
        : { ...study.meshSettings, meshRef: undefined },
      runs: study.runs.map((run) => ({
        ...run,
        meshRef: isCanonicalRef(run.meshRef) ? run.meshRef : undefined,
        resultRef: isCanonicalRef(run.resultRef) ? run.resultRef : undefined,
        reportRef: isCanonicalRef(run.reportRef) ? run.reportRef : undefined
      }))
    }))
  };
}

async function persistImportedModelArtifacts(project: Project, displayModel: DisplayModel): Promise<void> {
  const geometry = project.geometryFiles[0];
  if (!geometry?.artifactKey) return;
  await storage.putObject(geometry.artifactKey, JSON.stringify(displayModel, null, 2));
  const nativeCadFilename = sanitizeFilename(displayModel.nativeCad?.filename);
  if (displayModel.nativeCad?.contentBase64 && nativeCadFilename) {
    await storage.putObject(`${project.id}/uploads/${nativeCadFilename}`, Buffer.from(displayModel.nativeCad.contentBase64, "base64"));
  }
  const visualMeshFilename = sanitizeFilename(displayModel.visualMesh?.filename);
  if (displayModel.visualMesh?.contentBase64 && visualMeshFilename) {
    await storage.putObject(`${project.id}/uploads/${visualMeshFilename}`, Buffer.from(displayModel.visualMesh.contentBase64, "base64"));
  }
}

async function persistImportedResults(project: Project, results: ImportedResultBundle): Promise<void> {
  const runId = results.completedRunId ?? results.activeRunId ?? results.fields[0]?.runId;
  if (!runId) return;
  const run = project.studies.flatMap((study) => study.runs).find((item) => item.id === runId);
  const resultRef = run?.resultRef ?? `${project.id}/results/${runId}/results.json`;
  const reportRef = run?.reportRef ?? `${project.id}/reports/${runId}.html`;
  const summary = { ...results.summary, resultTier: results.resultTier };
  await storage.putObject(resultRef, JSON.stringify({ summary, fields: results.fields }, null, 2));
  await storage.putObject(reportRef, buildHtmlReport(runId, summary));
}

function dynamicSampleResults(project: Project): ImportedResultBundle | undefined {
  const study = project.studies[0];
  const run = study?.runs[0];
  if (!study || !run || study.type !== "dynamic_structural") return undefined;
  const sample = normalizeSampleId(project.geometryFiles[0]?.metadata.sampleModel);
  const solved = solveDynamicStudy(study, run.id, { displayModel: sampleDisplayModelFor(sample) });
  return {
    activeRunId: run.id,
    completedRunId: run.id,
    summary: solved.summary,
    fields: solved.fields,
    resultTier: classifyResultProvenance(solved.summary.provenance)
  };
}

async function persistSampleResults(project: Project, results: ImportedResultBundle): Promise<void> {
  const runId = results.completedRunId ?? results.activeRunId ?? results.fields[0]?.runId;
  if (!runId) return;
  const run = project.studies.flatMap((study) => study.runs).find((item) => item.id === runId);
  const resultRef = run?.resultRef ?? `${project.id}/results/${runId}/results.json`;
  const reportRef = run?.reportRef ?? `${project.id}/reports/${runId}/report.html`;
  const summary = { ...results.summary, resultTier: results.resultTier };
  await storage.putObject(resultRef, JSON.stringify({ summary, fields: results.fields }, null, 2));
  await storage.putObject(reportRef, buildHtmlReport(runId, summary));
  await storage.putObject(reportPdfKeyFor(reportRef), buildPdfReport(runId, summary));
}

async function displayModelForProject(project: Project): Promise<DisplayModel> {
  if (!project.geometryFiles.length) return blankDisplayModel();
  const geometry = project.geometryFiles[0];
  if (geometry?.metadata.source === "local-upload") {
    const displayModelRef = typeof geometry.metadata.displayModelRef === "string" ? geometry.metadata.displayModelRef : geometry.artifactKey;
    try {
      const artifact = await storage.getObject(displayModelRef);
      return parseDisplayModel(JSON.parse(artifact.toString("utf8"))) ?? uploadedDisplayModelFor(geometry.filename);
    } catch {
      return uploadedDisplayModelFor(geometry.filename);
    }
  }
  return sampleDisplayModelFor(normalizeSampleId(geometry?.metadata.sampleModel));
}

function parseDisplayModel(value: unknown): DisplayModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DisplayModel>;
  if (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.bodyCount === "number" &&
    Array.isArray(candidate.faces) &&
    candidate.faces.every(isDisplayFace)
  ) {
    return candidate as DisplayModel;
  }
  return undefined;
}

type UploadModelMutation = {
  clientId: string;
  generation: number;
  expectedGeometryId: string | null;
  expectedUpdatedAt: string | null;
};

function parseUploadModelMutation(value: unknown): UploadModelMutation | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.clientId !== "string" ||
    value.clientId.length < 1 ||
    value.clientId.length > 128 ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !isNullableBoundedString(value.expectedGeometryId, 256) ||
    !isNullableBoundedString(value.expectedUpdatedAt, 128)
  ) return undefined;
  return value as UploadModelMutation;
}

function canApplyUploadModelMutation(project: Project, incoming: UploadModelMutation): boolean {
  const geometry = project.geometryFiles.find((candidate) => candidate.metadata.source === "local-upload")
    ?? project.geometryFiles[0];
  const current = parseStoredModelMutation(geometry?.metadata.modelMutation);
  const matchesCurrentRevision = incoming.expectedGeometryId === (geometry?.id ?? null) &&
    incoming.expectedUpdatedAt === project.updatedAt;
  if (current?.clientId === incoming.clientId) {
    // Requests from one workspace carry a monotonic generation. This makes
    // the newest action win even when its HTTP request arrives before an
    // older sibling request that started from the same project revision. Do
    // not bypass unrelated project edits made after that sibling committed.
    const sharesStartingRevision = current.baseGeometryId !== undefined &&
      current.baseUpdatedAt !== undefined &&
      incoming.expectedGeometryId === current.baseGeometryId &&
      incoming.expectedUpdatedAt === current.baseUpdatedAt;
    const noInterveningProjectEdit = current.appliedUpdatedAt === project.updatedAt;
    return incoming.generation > current.generation &&
      (matchesCurrentRevision || (sharesStartingRevision && noInterveningProjectEdit));
  }
  return matchesCurrentRevision;
}

function parseStoredModelMutation(value: unknown): {
  clientId: string;
  generation: number;
  baseGeometryId?: string | null;
  baseUpdatedAt?: string | null;
  appliedUpdatedAt?: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.clientId !== "string" ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) return undefined;
  return {
    clientId: value.clientId,
    generation: value.generation,
    ...(isNullableBoundedString(value.baseGeometryId, 256) ? { baseGeometryId: value.baseGeometryId } : {}),
    ...(isNullableBoundedString(value.baseUpdatedAt, 128) ? { baseUpdatedAt: value.baseUpdatedAt } : {}),
    ...(typeof value.appliedUpdatedAt === "string" && value.appliedUpdatedAt.length <= 128 ? { appliedUpdatedAt: value.appliedUpdatedAt } : {})
  };
}

function isNullableBoundedString(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDisplayFace(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const face = value as Partial<DisplayModel["faces"][number]>;
  return (
    typeof face.id === "string" &&
    typeof face.label === "string" &&
    typeof face.color === "string" &&
    typeof face.stressValue === "number" &&
    isVector3(face.center) &&
    isVector3(face.normal)
  );
}

function isVector3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function coreSolverBackendForRun(study: Study, displayModel: DisplayModel, eligibility: ReturnType<typeof openCaeCoreEligibility>): string {
  if (!eligibility.ok) return "opencae-core-ineligible";
  if (hasActualCoreVolumeMesh(study, displayModel)) {
    return study.type === "dynamic_structural" ? "opencae-core-mdof-tet" : "opencae-core-sparse-tet";
  }
  return study.type === "dynamic_structural" ? "opencae-core-preview-sdof" : "opencae-core-preview-tet4";
}

async function ensureSampleArtifacts(): Promise<void> {
  await inspectStepFile(storage);
  await storage.putObject("project-bracket-demo/geometry/bracket-display.json", JSON.stringify(bracketDisplayModel, null, 2));
  await storage.putObject(
    "project-bracket-demo/mesh/mesh-summary.json",
    JSON.stringify(bracketDemoProject.studies[0]?.meshSettings.summary, null, 2)
  );
  await storage.putObject(
    "project-bracket-demo/results/results.json",
    JSON.stringify({ summary: bracketResultSummary, fields: bracketResultFields }, null, 2)
  );
  await storage.putObject(
    "project-bracket-demo/reports/report.html",
    buildHtmlReport("run-bracket-demo-seeded", bracketResultSummary)
  );
  await storage.putObject(
    "project-bracket-demo/reports/report.pdf",
    buildPdfReport("run-bracket-demo-seeded", bracketResultSummary)
  );
}

export async function buildApi() {
  return api;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4317);
  await api.listen({ port, host: API_LISTEN_HOST });
}
