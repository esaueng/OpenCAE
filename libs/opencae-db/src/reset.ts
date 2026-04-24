import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.cwd(), "data/sqlite/opencae.local.sqlite");
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(path.resolve(process.cwd(), "data/artifacts"), { force: true, recursive: true });
fs.mkdirSync(path.resolve(process.cwd(), "data/artifacts"), { recursive: true });
console.log("Local OpenCAE data reset.");
