import cors from "@fastify/cors";
import Fastify from "fastify";
import { inspectStepFile } from "@opencae/cad-service";
import { SQLiteDatabaseProvider } from "@opencae/db";
import { bracketDemoMaterial, bracketDemoProject, bracketDisplayModel, bracketResultFields, bracketResultSummary } from "@opencae/db/sample-data";
import { InMemoryJobQueueProvider, LocalRunStateProvider } from "@opencae/jobs";
import { MockMeshService } from "@opencae/mesh-service";
import { LocalReportProvider } from "@opencae/post-service";
import type { Load, Project, RunEvent, Study, StudyRun } from "@opencae/schema";
import { LocalMockComputeBackend } from "@opencae/solver-service";
import { FileSystemObjectStorageProvider } from "@opencae/storage";
import { validateStaticStressStudy } from "@opencae/study-core";
import { createSampleProject, normalizeSampleId, sampleDisplayModelFor, sampleProjectName, type SampleModelId } from "./projectFactory";

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
  const body = request.body as Partial<Project> & { sample?: SampleModelId } | undefined;
  const sample = normalizeSampleId(body?.sample);
  const now = new Date().toISOString();
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

api.get("/api/projects/:projectId", async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const sample = normalizeSampleId(project.geometryFiles[0]?.metadata.sampleModel);
  return { project, displayModel: sampleDisplayModelFor(sample) };
});

api.post("/api/projects/:projectId/uploads", async (request) => {
  const { projectId } = request.params as { projectId: string };
  return { projectId, message: "Local upload endpoint scaffolded. Native CAD import is not enabled yet." };
});

api.get("/api/projects/:projectId/files", async (request) => {
  const { projectId } = request.params as { projectId: string };
  const project = db.getProject(projectId);
  return { files: project?.geometryFiles ?? [] };
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
  const assignment = {
    id: "assign-material-current",
    materialId: body?.materialId ?? bracketDemoMaterial.id,
    selectionRef: "selection-body-bracket",
    status: "complete" as const
  };
  const next = { ...study, materialAssignments: [assignment] };
  db.upsertStudy(next);
  return { study: next, message: "Material assigned to bracket." };
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
    solverBackend: "local-mock",
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
      publish: (event) => runState.publish(runId, event)
    });
    const reportRef = await reports.generateReport({ projectId: studySnapshot.projectId, runId, summary: result.summary });
    db.upsertRun({
      ...run,
      status: "complete",
      resultRef: result.resultRef,
      reportRef,
      finishedAt: new Date().toISOString()
    });
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
  const reportRef = run?.reportRef ?? "project-bracket-demo/reports/report.html";
  const html = await storage.getObject(reportRef);
  reply.header("content-type", "text/html; charset=utf-8");
  return html.toString("utf8");
});

function publish(runId: string, type: RunEvent["type"], progress: number | undefined, message: string): void {
  runState.publish(runId, { runId, type, progress, message, timestamp: new Date().toISOString() });
}

function isLoadType(type: unknown): type is Load["type"] {
  return type === "force" || type === "pressure" || type === "gravity";
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
    "<!doctype html><html><body><h1>Bracket Demo Static Stress Report</h1><p>Max stress: 142 MPa</p><p>Max displacement: 0.184 mm</p><p>Safety factor: 1.8</p><p>Reaction force: 500 N</p></body></html>"
  );
}

const port = Number(process.env.PORT ?? 4317);
await api.listen({ port, host: "0.0.0.0" });
