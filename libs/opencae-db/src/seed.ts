import { FileSystemObjectStorageProvider } from "@opencae/storage";
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
  `<!doctype html><html><head><title>Bracket Demo Report</title></head><body><h1>Bracket Demo Static Stress Report</h1><p>Max stress: 142 MPa</p><p>Max displacement: 0.184 mm</p><p>Safety factor: 1.8</p><p>Reaction force: 500 N</p></body></html>`
);

console.log("Seeded Bracket Demo project and artifacts.");
