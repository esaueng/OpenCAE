import type { Load, ResultField, ResultSummary, RunEvent, Study } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";
import { bracketResultFields, bracketResultSummary } from "@opencae/db/sample-data";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class LocalMockComputeBackend {
  constructor(private readonly storage: ObjectStorageProvider) {}

  async runStaticSolve(args: {
    study: Study;
    runId: string;
    meshRef: string;
    publish: (event: RunEvent) => void;
  }): Promise<{ resultRef: string; reportRef: string; summary: ResultSummary; fields: ResultField[] }> {
    const messages = [
      [10, "Mock solver started: linear static."],
      [28, "Reading CAD-bound supports and loads."],
      [46, "Assembling mock stiffness matrix."],
      [68, "Estimating stress and displacement."],
      [88, "Writing result fields."],
      [100, "Simulation complete."]
    ] as const;

    const loadMetrics = summarizeLoads(args.study.loads);
    const summary = summaryForLoads(loadMetrics);
    const fields = fieldsForLoads(loadMetrics, args.runId);
    const solverInput = [
      "mock linear static input",
      `run=${args.runId}`,
      `mesh=${args.meshRef}`,
      ...args.study.loads.map((load) => JSON.stringify({ id: load.id, type: load.type, selectionRef: load.selectionRef, parameters: load.parameters }))
    ].join("\n") + "\n";

    await this.storage.putObject(`${args.study.projectId}/solver/${args.runId}/solver.inp`, solverInput);
    for (const [progress, message] of messages) {
      await delay(450);
      args.publish({
        runId: args.runId,
        type: progress === 100 ? "complete" : "progress",
        progress,
        message,
        timestamp: new Date().toISOString()
      });
      args.publish({
        runId: args.runId,
        type: "log",
        progress,
        message: progress === 100 ? "Mock solve complete." : message,
        timestamp: new Date().toISOString()
      });
    }

    const resultRef = `${args.study.projectId}/results/${args.runId}/results.json`;
    const summaryRef = `${args.study.projectId}/results/${args.runId}/summary.json`;
    const reportRef = `${args.study.projectId}/reports/${args.runId}/report.html`;
    await this.storage.putObject(
      `${args.study.projectId}/solver/${args.runId}/solver.log`,
      `Mock mesh generated: 42,381 nodes, 26,944 tetra elements.\nMock solver started: linear static.\nLoads evaluated: ${args.study.loads.length}.\nMock solve complete.\n`
    );
    await this.storage.putObject(resultRef, JSON.stringify({ summary, fields }, null, 2));
    await this.storage.putObject(summaryRef, JSON.stringify(summary, null, 2));
    return { resultRef, reportRef, summary, fields };
  }
}

function summarizeLoads(loads: Load[]) {
  const total = loads.reduce((sum, load) => sum + loadEquivalentForce(load), 0);
  const directional = loads.reduce((sum, load) => {
    const direction = Array.isArray(load.parameters.direction) ? load.parameters.direction : [0, -1, 0];
    const magnitude = loadEquivalentForce(load);
    const length = Math.hypot(Number(direction[0] ?? 0), Number(direction[1] ?? 0), Number(direction[2] ?? 0)) || 1;
    return sum + Math.abs(Number(direction[0] ?? 0) / length) * magnitude * 0.22;
  }, 0);
  return { total: total || 500, directional, count: loads.length };
}

function loadEquivalentForce(load: Load): number {
  const rawValue = Number(load.parameters.value ?? 0);
  const value = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 0;
  if (load.type === "pressure") return value * 8;
  if (load.type === "gravity") return value * 12;
  return value;
}

function summaryForLoads(loads: ReturnType<typeof summarizeLoads>): ResultSummary {
  const scale = Math.max(0.2, loads.total / 500);
  return {
    maxStress: round(bracketResultSummary.maxStress * (0.35 + scale * 0.65) + loads.directional / 60),
    maxStressUnits: bracketResultSummary.maxStressUnits,
    maxDisplacement: round(bracketResultSummary.maxDisplacement * (0.3 + scale * 0.7), 3),
    maxDisplacementUnits: bracketResultSummary.maxDisplacementUnits,
    safetyFactor: round(Math.max(0.2, bracketResultSummary.safetyFactor / Math.max(0.75, scale)), 2),
    reactionForce: round(loads.total),
    reactionForceUnits: "N"
  };
}

function fieldsForLoads(loads: ReturnType<typeof summarizeLoads>, runId: string): ResultField[] {
  const scale = Math.max(0.2, loads.total / 500);
  return bracketResultFields.map((field) => {
    if (field.type === "stress") {
      const values = field.values.map((value, index) => round(value * (0.45 + scale * 0.55) + loads.directional / (index + 8)));
      return { ...field, runId, values, min: Math.min(...values), max: Math.max(...values) };
    }
    if (field.type === "displacement") {
      const values = field.values.map((value) => round(value * (0.4 + scale * 0.6), 4));
      return { ...field, runId, values, min: Math.min(...values), max: Math.max(...values) };
    }
    const values = field.values.map((value) => round(Math.max(0.2, value / Math.max(0.75, scale)), 2));
    return { ...field, runId, values, min: Math.min(...values), max: Math.max(...values) };
  });
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
