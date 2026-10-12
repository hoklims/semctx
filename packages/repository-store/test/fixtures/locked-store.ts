import { constants, Database } from "bun:sqlite";

const [path, mode] = process.argv.slice(2);
if (path === undefined) throw new Error("database path is required");
const db = new Database(path);
db.exec("PRAGMA journal_mode = WAL;");
db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
db.exec(mode === "reader" ? "BEGIN;" : "BEGIN IMMEDIATE;");
if (mode === "reader") db.query("SELECT value FROM meta WHERE key = 'probe'").get();
else db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('holder', 'committed')").run();
console.log("locked");
for await (const chunk of Bun.stdin.stream()) {
  if (new TextDecoder().decode(chunk).includes("delayed")) await Bun.sleep(500);
  db.exec("COMMIT;");
  db.close();
  break;
}
