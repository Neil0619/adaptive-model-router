import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stamp(path) {
  try {
    const s = lstatSync(path, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || s.size > 512n * 1024n * 1024n) throw new Error("Snapshot source is not a bounded regular file");
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// SQLite readOnly alone may create a WAL/SHM file beside its source. Query a
// private stable copy of BOTH the main file and WAL; immutable=1 would silently
// miss committed WAL transactions. No source connection is ever opened.
export function openReadOnlySnapshot(path) {
  if (!existsSync(path)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const directory = mkdtempSync(join(tmpdir(), "router-health-read-"));
    let db;
    try {
      chmodSync(directory, 0o700);
      const sources = [path, `${path}-wal`], before = sources.map(stamp);
      if (!before[0]) throw new Error("Snapshot source disappeared");
      const copy = join(directory, "snapshot.sqlite3");
      for (let i = 0; i < sources.length; i++) if (before[i]) {
        const destination = i ? `${copy}-wal` : copy;
        copyFileSync(sources[i], destination); chmodSync(destination, 0o600);
      }
      if (JSON.stringify(before) !== JSON.stringify(sources.map(stamp))) {
        if (!attempt) { rmSync(directory, { recursive: true, force: true }); continue; }
        throw new Error("Snapshot source changed during bounded read");
      }
      db = new DatabaseSync(copy, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=150;");
      const integrity = Object.values(db.prepare("PRAGMA quick_check(1)").get())[0];
      if (integrity !== "ok") throw new Error("Snapshot integrity failed");
      return { db, close() { try { db.close(); } finally { rmSync(directory, { recursive: true, force: true }); } } };
    } catch (error) {
      try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
      throw error;
    }
  }
  throw new Error("Snapshot unavailable");
}
