import type { ResultSummary } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";

export class LocalReportProvider {
  constructor(private readonly storage: ObjectStorageProvider) {}

  async generateReport(args: { projectId: string; runId: string; summary: ResultSummary }): Promise<string> {
    const artifactKey = `${args.projectId}/reports/${args.runId}/report.html`;
    const html = `<!doctype html>
<html>
  <head><title>OpenCAE Static Stress Report</title></head>
  <body>
    <h1>OpenCAE Static Stress Report</h1>
    <p>Run: ${args.runId}</p>
    <ul>
      <li>Max stress: ${args.summary.maxStress} ${args.summary.maxStressUnits}</li>
      <li>Max displacement: ${args.summary.maxDisplacement} ${args.summary.maxDisplacementUnits}</li>
      <li>Safety factor: ${args.summary.safetyFactor}</li>
      <li>Reaction force: ${args.summary.reactionForce} ${args.summary.reactionForceUnits}</li>
    </ul>
  </body>
</html>`;
    await this.storage.putObject(artifactKey, html);
    return artifactKey;
  }
}
