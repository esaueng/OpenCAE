import cors from "@fastify/cors";
import Fastify from "fastify";
import { inspectStepFile } from "@opencae/cad-service";
import { SQLiteDatabaseProvider } from "@opencae/db";
import { bracketDemoMaterial, bracketDemoProject, bracketDisplayModel, bracketResultFields, bracketResultSummary } from "@opencae/db/sample-data";
import { InMemoryJobQueueProvider, LocalRunStateProvider } from "@opencae/jobs";
import { MockMeshService } from "@opencae/mesh-service";
import { buildHtmlReport, buildPdfReport, LocalReportProvider, reportPdfKeyFor } from "@opencae/post-service";
import { ProjectSchema, type DisplayModel, type Load, type Project, type RunEvent, type Study, type StudyRun } from "@opencae/schema";
import { LocalMockComputeBackend } from "@opencae/solver-service";
import { FileSystemObjectStorageProvider } from "@opencae/storage";
import { validateStaticStressStudy } from "@opencae/study-core";
import {
  attachUploadedModelToProject,
  blankDisplayModel,
  createBlankProject,
  createSampleProject,
  normalizeSampleId,
  sampleDisplayModelFor,
  sampleProjectName,
  uploadedDisplayModelFor,
  type SampleModelId
} from "./projectFactory";

const api = Fastify({ logger: true });
await api.register(cors, { origin: true });

const db = new SQLiteDatabaseProvider();
const storage = new FileSystemObjectStorageProvider();
const jobs = new InMemoryJobQueueProvider();
const runState = new LocalRunStateProvider();
const meshService = new MockMeshService(storage);
const compute = new LocalMockComputeBackend(storage);
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
  const now = new Date().toISOString();
  const project = createSampleProject(sample, {
    projectId: bracketDemoProject.id,
    studyId: bracketDemoProject.studies[0]?.id ?? "study-bracket-static",
    now,
    includeSeedRun: sample === "bracket"
  });
  db.upsertProject(project);
  await ensureSampleArtifacts();
  return {
    message: `${sampleProjectName(sample)} loaded.`,
    project: db.getProject(bracketDemoProject.id),
    displayModel: sampleDisplayModelFor(sample)
  };
});

api.get("/api/projects", async () => ({ projects: db.listProjects() }));

api.post("/api/projects", async (request) => {
  const body = request.body as Partial<Project> & { sample?: SampleModelId; mode?: "blank" | "sample" } | undefined;
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
  const project = createSampleProject(sample, {
    projectId: `project-${crypto.randomUUID()}`,
    studyId: `study-${crypto.randomUUID()}`,
    name: body?.name ?? `Untitled ${sampleProjectName(sample)}`,
    now,
    includeSeedRun: false
  });
  db.upsertProject(project);
  await storage.putObject(project.geometryFiles[0]?.artifactKey ?? `${project.id}/geometry/display.json`, JSON.stringify(sampleDisplayModelFor(sample), null, 2));
  return { project, displayModel: sampleDisplayModelFor(sample), message: "Project created." };
});

api.post("/api/projects/import", async (request, reply) => {
  const body = request.body as { project?: unknown; displayModel?: unknown } | Project | undefined;
  const candidate = body && "project" in body ? body.project : body;
  const parsed = ProjectSchema.safeParse(candidate);
  if (!parsed.success) return reply.code(400).send({ error: "The selected file is not a valid OpenCAE project JSON." });

  const project = parsed.data;
  const displayModel = parseDisplayModel(body && "displayModel" in body ? body.displayModel : undefined) ?? await displayModelForProject(project);
  db.upsertProject(project);
  if (project.geometryFiles[0]?.artifactKey) {
    await storage.putObject(project.geometryFiles[0].artifactKey, JSON.stringify(displayModel, null, 2));
  }
  return { project, displayModel, message: `${project.name} opened from local file.` };
});

api.get("/api/projects/:projectId", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  return { project, displayModel: await displayModelForProject(project) };
});

api.post("/api/projects/:projectId/uploads", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const body = request.body as { filename?: string; size?: number; contentType?: string; contentBase64?: string } | undefined;
  const filename = sanitizeFilename(body?.filename);
  if (!filename) {
    return reply.code(400).send({
      error: "Only STL and OBJ model uploads are supported in the local viewer. Convert STEP, IGES, or BREP to STL/OBJ before uploading."
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
    : "Native CAD preview is not available yet. Upload STL or OBJ when you need the viewport to match the file.";
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

api.post("/api/projects/:projectId/studies", async (request) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  const study = bracketDemoProject.studies[0];
  if (!project || !study) return { error: "Project not found" };
  const newStudy: Study = { ...study, id: `study-${crypto.randomUUID()}`, projectId, name: "Static Stress", runs: [] };
  db.upsertStudy(newStudy);
  return { study: newStudy };
});

api.get("/api/studies/:studyId", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  return { study };
});

api.put("/api/studies/:studyId", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const next = { ...study, ...(request.body as Partial<Study>) };
  db.upsertStudy(next);
  return { study: next };
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
  const body = request.body as { materialId?: string } | undefined;
  const bodySelection = study.namedSelections.find((selection) => selection.entityType === "body");
  const assignment = {
    id: "assign-material-current",
    materialId: body?.materialId ?? bracketDemoMaterial.id,
    selectionRef: bodySelection?.id ?? "selection-body-bracket",
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
  const body = request.body as Partial<Load> & { value?: number; selectionRef?: string; direction?: [number, number, number] } | undefined;
  const type = body?.type ?? "force";
  if (!isLoadType(type)) return reply.code(400).send({ error: "Invalid load type." });
  const load: Load = {
    id: `load-${crypto.randomUUID()}`,
    type,
    selectionRef: body?.selectionRef ?? "selection-load-face",
    parameters: { value: body?.value ?? 500, units: type === "pressure" ? "kPa" : "N", direction: body?.direction ?? [0, -1, 0] },
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

api.post("/api/studies/:studyId/mesh", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const body = request.body as { preset?: "coarse" | "medium" | "fine" } | undefined;
  const preset = body?.preset ?? "medium";
  const mesh = await meshService.generateMesh(study, preset);
  const next: Study = {
    ...study,
    meshSettings: { preset, status: "complete", meshRef: mesh.artifactKey, summary: mesh.summary }
  };
  db.upsertStudy(next);
  return { study: next, mesh, message: "Mesh generated." };
});

api.post("/api/studies/:studyId/runs", async (request, reply) => {
  const { studyId } = request.params as { studyId: string };
  const study = db.getStudy(studyId);
  if (!study) return reply.code(404).send({ error: "Study not found" });
  const runDiagnostics = validateStaticStressStudy(study);
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
    solverBackend: "local-static-superposition",
    solverVersion: "0.1.0",
    startedAt: new Date().toISOString(),
    diagnostics: []
  };
  db.upsertRun(run);
  publish(runId, "state", 0, "Simulation queued.");
  await jobs.enqueue(jobId, async () => {
    publish(runId, "state", 3, "Simulation running.");
    const result = await compute.runStaticSolve({
      study: studySnapshot,
      runId,
      meshRef: studySnapshot.meshSettings.meshRef ?? "mesh-not-generated",
      publish: (event) => {
        if (event.type === "complete") {
          runState.publish(runId, { ...event, type: "progress", progress: 96, message: "Finalizing result artifacts." });
          return;
        }
        runState.publish(runId, event);
      }
    });
    const reportRef = await reports.generateReport({ projectId: studySnapshot.projectId, runId, summary: result.summary });
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

function pdfFilename(name: string): string {
  const base = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "opencae";
  return `${base}-report.pdf`;
}

async function pdfForReport(run: StudyRun | undefined, reportRef: string): Promise<Buffer> {
  const pdfRef = reportPdfKeyFor(reportRef);
  try {
    return await storage.getObject(pdfRef);
  } catch {
    const summary = run?.resultRef ? await summaryForResult(run.resultRef) : bracketResultSummary;
    const pdf = buildPdfReport(run?.id ?? "run-bracket-demo-seeded", summary);
    await storage.putObject(pdfRef, pdf);
    return pdf;
  }
}

async function summaryForResult(resultRef: string): Promise<typeof bracketResultSummary> {
  const artifact = await storage.getObject(resultRef);
  const parsed = JSON.parse(artifact.toString("utf8")) as { summary?: typeof bracketResultSummary };
  return parsed.summary ?? bracketResultSummary;
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

function sanitizeFilename(filename: unknown): string | undefined {
  if (typeof filename !== "string") return undefined;
  const cleaned = filename.trim().split(/[\\/]/).pop()?.replace(/[^\w .-]/g, "_") ?? "";
  if (!cleaned) return undefined;
  const extension = cleaned.split(".").pop()?.toLowerCase();
  if (!extension || !["stl", "obj"].includes(extension)) return undefined;
  return cleaned;
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
