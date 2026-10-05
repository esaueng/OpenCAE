import { SQLiteDatabaseProvider } from "./index";

const db = new SQLiteDatabaseProvider();
db.migrate();
console.log("SQLite migration complete.");
