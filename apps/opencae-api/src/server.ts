import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { inspectStepFile } from "@opencae/cad-service";
import { SQLiteDatabaseProvider } from "@opencae/db";
import { bracketDemoMaterial, bracketDemoProject, bracketDisplayModel, bracketResultFields, bracketResultSummary } from "@opencae/db/sample-data";
import { InMemoryJobQueueProvider, LocalRunStateProvider } from "@opencae/jobs";
import { MockMeshService } from "@opencae/mesh-service";
import { buildHtmlReport, buildPdfReport, LocalReportProvider, reportPdfKeyFor } from "@opencae/post-service";
import {
  ProjectSchema,
  ResultFieldSchema,
  ResultSummarySchema,
  type DisplayModel,
  type Load,
  type MeshQuality,
  type Project,
  type ResultField,
  type ResultSummary,
  type RunEvent,
  type Study,
  type StudyRun
} from "@opencae/schema";
import { LocalMockComputeBackend, solveDynamicStudy } from "@opencae/solver-service";
import { FileSystemObjectStorageProvider } from "@opencae/storage";
import { validateStaticStressStudy, validateStudy } from "@opencae/study-core";
import { LocalCloudFeaBridge, LocalCloudFeaBridgeError } from "./cloudFeaLocal";
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
import { mutatingRateLimit, pdfFilename, projectsReadRateLimit, sanitizeFilename, sanitizeProjectName } from "./security";

const api = Fastify({ logger: true });
await api.register(cors, { origin: true });
await api.register(rateLimit, { global: false, max: 300, timeWindow: "1 minute" });

const db = new SQLiteDatabaseProvider();
const storage = new FileSystemObjectStorageProvider();
const jobs = new InMemoryJobQueueProvider();
const runState = new LocalRunStateProvider();
const meshService = new MockMeshService(storage);
const compute = new LocalMockComputeBackend(storage);
const reports = new LocalReportProvider(storage);
const cloudFea = new LocalCloudFeaBridge();

db.migrate();
db.seed();
await ensureSampleArtifacts();

api.get("/health", async () => ({ ok: true, mode: "local", service: "opencae-api" }));

api.get("/api/cloud-fea/health", async () => cloudFea.health());

api.post("/api/cloud-fea/runs", mutatingRateLimit, async (request, reply) => {
  try {
    const body = isRecord(request.body) ? request.body : {};
    const response = await cloudFea.createRun(body);
    return reply.code(202).send(response);
  } catch (error) {
    if (error instanceof LocalCloudFeaBridgeError) {
      return reply.code(error.status).send({ error: error.message });
    }
    throw error;
  }
});

api.get("/api/cloud-fea/runs/:runId/events", async (request) => {
  const { runId } = request.params as { runId: string };
  return { events: cloudFea.getEvents(runId) };
});

api.get("/api/cloud-fea/runs/:runId/results", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const results = cloudFea.getResults(runId);
  if (!results) return reply.code(404).send({ error: "Cloud FEA results are not ready." });
  return results;
});

api.get("/api/sample-project", async (request) => {
  const sample = normalizeSampleId((request.query as { sample?: string }).sample);
  return {
  project: db.getProject(bracketDemoProject.id),
  displayModel: sampleDisplayModelFor(sample),
  material: bracketDemoMaterial,
  resultSummary: bracketResultSummary
};
});

api.post("/api/sample-project/load", mutatingRateLimit, async (request) => {
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

  const project = parsed.data;
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

api.put("/api/projects/:projectId", mutatingRateLimit, async (request, reply) => {
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
  const body = request.body as { filename?: string; size?: number; contentType?: string; contentBase64?: string } | undefined;
  const filename = sanitizeFilename(body?.filename);
  if (!filename) {
    return reply.code(400).send({
      error: "Only STEP, STP, STL, and OBJ model uploads are supported in the local viewer."
    });
  }

  const contentBase64 = typeof body?.contentBase64 === "string" && body.contentBase64.length > 0 ? body.contentBase64 : undefined;
  const displayModel = uploadedDisplayModelFor(filename, contentBase64);
  const artifactKey = `${project.id}/geometry/uploaded-display.json`;
  const nextProject = attachUploadedModelToProject(project, {
    geometryId: `geom-upload-${crypto.randomUUID()}`,
    filename,
    artifactKey,
    now: new Date().toISOString(),
    displayModel
  });
  nextProject.geometryFiles[0]!.metadata = {
    ...nextProject.geometryFiles[0]!.metadata,
    originalSize: Number.isFinite(body?.size) ? body?.size : undefined,
    contentType: body?.contentType
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

api.post("/api/projects/:projectId/studies", mutatingRateLimit, async (request) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return { error: "Project not found" };
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
  const next = { ...study, ...(request.body as Partial<Study>) } as Study;
  db.upsertStudy(next);
  return { study: next };
});

api.post("/api/studies/:studyId/validate", mutatingRateLimit, async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const diagnostics = validateStaticStressStudy(study).map((diagnostic) => diagnostic.message);
  return { ready: diagnostics.length === 0, diagnostics };
});

api.post("/api/studies/:studyId/materials", mutatingRateLimit, async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const body = request.body as { materialId?: string; parameters?: Record<string, unknown> } | undefined;
  const bodySelection = study.namedSelections.find((selection) => selection.entityType === "body");
  const assignment = {
    id: "assign-material-current",
    materialId: body?.materialId ?? bracketDemoMaterial.id,
    selectionRef: bodySelection?.id ?? "selection-body-bracket",
    parameters: body?.parameters ?? {},
    status: "complete" as const
  };
  const next = { ...study, materialAssignments: [assignment] };
  db.upsertStudy(next);
  return { study: next, message: `Material assigned to ${bodySelection?.name ?? "model"}.` };
});

api.post("/api/studies/:studyId/supports", mutatingRateLimit, async (request, reply) => {
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

api.post("/api/studies/:studyId/loads", mutatingRateLimit, async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const body = request.body as Partial<Load> & { value?: number; selectionRef?: string; direction?: [number, number, number]; applicationPoint?: [number, number, number]; payloadObject?: unknown; payloadMaterialId?: string; payloadVolumeM3?: number; payloadMassMode?: string } | undefined;
  const type = body?.type ?? "force";
  if (!isLoadType(type)) return reply.code(400).send({ error: "Invalid load type." });
  const payloadVolumeM3 = body?.payloadVolumeM3;
  const load: Load = {
    id: `load-${crypto.randomUUID()}`,
    type,
    selectionRef: body?.selectionRef ?? "selection-load-face",
    parameters: { value: body?.value ?? 500, units: unitsForLoadType(type), direction: body?.direction ?? [0, 0, -1], ...(body?.applicationPoint ? { applicationPoint: body.applicationPoint } : {}), ...(body?.payloadObject ? { payloadObject: body.payloadObject } : {}), ...(type === "gravity" && body?.payloadMaterialId ? { payloadMaterialId: body.payloadMaterialId } : {}), ...(type === "gravity" && Number.isFinite(payloadVolumeM3) ? { payloadVolumeM3 } : {}), ...(type === "gravity" && body?.payloadMassMode ? { payloadMassMode: body.payloadMassMode } : {}) },
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
  const runId = `run-${crypto.randomUUID()}`;
  const jobId = `job-${crypto.randomUUID()}`;
  const run: StudyRun = {
    id: runId,
    studyId,
    status: "queued",
    jobId,
    meshRef: studySnapshot.meshSettings.meshRef,
    solverBackend: studySnapshot.type === "dynamic_structural" ? "local-dynamic-newmark" : "local-static-superposition",
    solverVersion: "0.1.0",
    startedAt: new Date().toISOString(),
    diagnostics: []
  };
  db.upsertRun(run);
  publish(runId, "state", 0, "Simulation queued.");
  await jobs.enqueue(jobId, async () => {
    publish(runId, "state", 3, "Simulation running.");
    const solveArgs = {
      study: studySnapshot,
      runId,
      meshRef: studySnapshot.meshSettings.meshRef ?? "mesh-not-generated",
      publish: (event: RunEvent) => {
        if (event.type === "complete") {
          runState.publish(runId, { ...event, type: "progress", progress: 96, message: "Finalizing result artifacts." });
          return;
        }
        runState.publish(runId, event);
      }
    };
    const result = studySnapshot.type === "dynamic_structural"
      ? await compute.runDynamicSolve(solveArgs)
      : await compute.runStaticSolve(solveArgs);
    const reportRef = await reports.generateReport({ projectId: studySnapshot.projectId, runId, summary: result.summary, study: studySnapshot, fields: result.fields });
    db.upsertRun({
      ...run,
      status: "complete",
      resultRef: result.resultRef,
      reportRef,
      finishedAt: new Date().toISOString()
    });
    publish(runId, "complete", 100, "Simulation complete.");
  });
  return { run, streamUrl: `/api/runs/${runId}/stream`, message: "Simulation running." };
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
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  for (const event of runState.getEvents(runId)) {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  const unsubscribe = runState.subscribe(runId, (event) => {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  request.raw.on("close", unsubscribe);
});

api.post("/api/runs/:runId/cancel", mutatingRateLimit, async (request, reply) => {
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
  const artifact = await storage.getObject(run.resultRef);
  return JSON.parse(artifact.toString("utf8"));
});

api.get("/api/runs/:runId/report", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = db.getRun(runId);
  if (!run && runId !== "run-bracket-demo-seeded") return reply.code(404).send({ error: "Run not found" });
  const reportRef = run?.reportRef ?? "project-bracket-demo/reports/report.html";
  const html = await storage.getObject(reportRef);
  reply.header("content-type", "text/html; charset=utf-8");
  return html.toString("utf8");
});

api.get("/api/runs/:runId/report.pdf", async (request, reply) => {
  const { runId } = request.params as { runId: string };
  const run = db.getRun(runId);
  if (!run && runId !== "run-bracket-demo-seeded") return reply.code(404).send({ error: "Run not found" });
  const reportRef = run?.reportRef ?? "project-bracket-demo/reports/report.html";
  const pdf = await pdfForReport(run, reportRef);
  reply.header("content-type", "application/pdf");
  reply.header("content-disposition", `attachment; filename="${pdfFilename(runId)}"`);
  return pdf;
});

function publish(runId: string, type: RunEvent["type"], progress: number | undefined, message: string): void {
  runState.publish(runId, { runId, type, progress, message, timestamp: new Date().toISOString() });
}

function isLoadType(type: unknown): type is Load["type"] {
  return type === "force" || type === "pressure" || type === "gravity";
}

function unitsForLoadType(type: Load["type"]) {
  if (type === "pressure") return "kPa";
  if (type === "gravity") return "kg";
  return "N";
}

function latestCompletedRunForProject(project: Project): StudyRun | undefined {
  return project.studies
    .flatMap((study) => study.runs)
    .filter((run) => run.reportRef || run.resultRef || run.status === "complete")
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
    fields: fields.data
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
              status: "complete",
              resultRef: run.resultRef ?? `${project.id}/results/${runId}/results.json`,
              reportRef: run.reportRef ?? `${project.id}/reports/${runId}.html`
            }
          : run
      )
    }))
  };
}

async function persistImportedModelArtifacts(project: Project, displayModel: DisplayModel): Promise<void> {
  const geometry = project.geometryFiles[0];
  if (!geometry?.artifactKey) return;
  await storage.putObject(geometry.artifactKey, JSON.stringify(displayModel, null, 2));
  if (displayModel.nativeCad?.contentBase64) {
    await storage.putObject(`${project.id}/uploads/${displayModel.nativeCad.filename}`, Buffer.from(displayModel.nativeCad.contentBase64, "base64"));
  }
  if (displayModel.visualMesh?.contentBase64) {
    await storage.putObject(`${project.id}/uploads/${displayModel.visualMesh.filename}`, Buffer.from(displayModel.visualMesh.contentBase64, "base64"));
  }
}

async function persistImportedResults(project: Project, results: ImportedResultBundle): Promise<void> {
  const runId = results.completedRunId ?? results.activeRunId ?? results.fields[0]?.runId;
  if (!runId) return;
  const run = project.studies.flatMap((study) => study.runs).find((item) => item.id === runId);
  const resultRef = run?.resultRef ?? `${project.id}/results/${runId}/results.json`;
  const reportRef = run?.reportRef ?? `${project.id}/reports/${runId}.html`;
  await storage.putObject(resultRef, JSON.stringify({ summary: results.summary, fields: results.fields }, null, 2));
  await storage.putObject(reportRef, buildHtmlReport(runId, results.summary));
}

function dynamicSampleResults(project: Project): ImportedResultBundle | undefined {
  const study = project.studies[0];
  const run = study?.runs[0];
  if (!study || !run || study.type !== "dynamic_structural") return undefined;
  const solved = solveDynamicStudy(study, run.id);
  return {
    activeRunId: run.id,
    completedRunId: run.id,
    summary: solved.summary,
    fields: solved.fields
  };
}

async function persistSampleResults(project: Project, results: ImportedResultBundle): Promise<void> {
  const runId = results.completedRunId ?? results.activeRunId ?? results.fields[0]?.runId;
  if (!runId) return;
  const run = project.studies.flatMap((study) => study.runs).find((item) => item.id === runId);
  const resultRef = run?.resultRef ?? `${project.id}/results/${runId}/results.json`;
  const reportRef = run?.reportRef ?? `${project.id}/reports/${runId}/report.html`;
  await storage.putObject(resultRef, JSON.stringify({ summary: results.summary, fields: results.fields }, null, 2));
  await storage.putObject(reportRef, buildHtmlReport(runId, results.summary));
  await storage.putObject(reportPdfKeyFor(reportRef), buildPdfReport(runId, results.summary));
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

const port = Number(process.env.PORT ?? 4317);
await api.listen({ port, host: "0.0.0.0" });
