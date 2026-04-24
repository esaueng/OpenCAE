import { FileSystemObjectStorageProvider } from "@opencae/storage";
import { buildHtmlReport, buildPdfReport } from "@opencae/post-service";
import { SQLiteDatabaseProvider } from "./index";
import { bracketDemoProject, bracketDisplayModel, bracketResultFields, bracketResultSummary } from "./sampleData";

const db = new SQLiteDatabaseProvider();
db.migrate();
db.seed();

const storage = new FileSystemObjectStorageProvider();
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

console.log("Seeded Bracket Demo project and artifacts.");
