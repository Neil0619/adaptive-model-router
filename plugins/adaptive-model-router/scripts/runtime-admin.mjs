#!/usr/bin/env node
import { resolve, join } from "node:path";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { prepareRuntimeCandidate, inspectRuntimePackage, copyRuntimePackage, canonicalDestination } from "./lib/runtime-package.mjs";
import { qualifyRuntimeCompatibility } from "./lib/runtime-compatibility.mjs";
import { RouterStore } from "./lib/database.mjs";
import { inspectColdRuntimeTransition, assertColdProcessInventory } from "./lib/runtime-cold-transition.mjs";
import { prepareRuntimeHostEntry } from "./lib/runtime-host-entry.mjs";
import { captureRuntimeHostEntries, restoreRuntimeHostEntries } from "./lib/runtime-host-retention.mjs";
import { archiveRuntime, publishRuntime, publishedDefault, runtimeGeneration, runtimeReferences, restoreRuntime, ensureRuntimeIsolationSchema } from "./lib/runtime-isolation.mjs";

// SQLite's readOnly open may create WAL/SHM companions beside the source. Read
// only a private, stable byte snapshot for preflight and references instead.
// Concurrent mutation fails closed; no production SQLite connection is opened.
function readOnlySnapshot(database) {
  const root = mkdtempSync(join(tmpdir(), "router-admin-readonly-")); chmodSync(root, 0o700);
  const target = join(root, "router.sqlite3"), suffixes = ["", "-wal"];
  const identity = (path) => {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Database snapshot requires regular files without symlinks");
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
  };
  try {
    const before = suffixes.map((suffix) => identity(database + suffix));
    for (let i = 0; i < suffixes.length; i++) if (before[i]) {
      copyFileSync(database + suffixes[i], target + suffixes[i]); chmodSync(target + suffixes[i], 0o600);
      if (identity(target + suffixes[i]).digest !== before[i].digest) throw new Error("Database changed while taking read-only snapshot");
    }
    if (JSON.stringify(suffixes.map((suffix) => identity(database + suffix))) !== JSON.stringify(before)) throw new Error("Database changed while taking read-only snapshot");
    const db = new DatabaseSync(target, { readOnly: true });
    return { db, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

const [action, ...arguments_] = process.argv.slice(2);
try {
  const options = Object.fromEntries(arguments_.map((argument) => {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match) throw new Error("Use explicit --name=value arguments; no default production home is selected");
    return [match[1], match[2]];
  }));
  const required = (name) => { if (!options[name]) throw new Error(`--${name}= is required`); return options[name]; };
  const actions = {
    "prepare-shell": ["source", "shell-root", "home"], prepare: ["source", "candidates"],
    bootstrap: ["candidate", "home", "shell-root"], publish: ["candidate", "home"],
    references: ["digest", "home"], archive: ["digest", "home"], restore: ["digest", "home"], "restore-host-entry": ["digest", "path", "home"],
    "capture-host-entries": ["anchor", "archive"], "restore-host-entries": ["archive", "versions-root"],
  };
  if (!actions[action]) throw new Error(`Supported actions: ${Object.keys(actions).join(", ")}`);
  for (const name of actions[action]) required(name);
  if (options["legacy-home"]) throw new Error("Separate legacy domains are not admitted: preserve one shared policy and global reservation ledger");
  if (action === "capture-host-entries") {
    process.stdout.write(`${JSON.stringify(captureRuntimeHostEntries(resolve(options.anchor), resolve(options.archive)))}\n`);
  } else if (action === "restore-host-entries") {
    assertColdProcessInventory();
    process.stdout.write(`${JSON.stringify(restoreRuntimeHostEntries(resolve(options.archive), resolve(options["versions-root"])))}\n`);
  } else if (action === "prepare-shell") {
    const shell = prepareRuntimeHostEntry(resolve(options.source), resolve(options["shell-root"]), resolve(options.home));
    process.stdout.write(`${JSON.stringify({ shellRoot: shell.root, marketplace: shell.marketplace, digest: shell.digest, registered: false })}\n`);
  } else if (action === "prepare") {
    const candidate = prepareRuntimeCandidate(resolve(options.source), resolve(options.candidates), { shellRoot: options["shell-root"] && resolve(options["shell-root"]) });
    process.stdout.write(`${JSON.stringify({ candidate: candidate.root, digest: candidate.digest, productionChanged: false })}\n`);
  } else {
    // Validate arguments and package bytes before any writable state open.
    const candidate = ["bootstrap", "publish"].includes(action) ? inspectRuntimePackage(resolve(options.candidate)) : null;
    const legacyRuntime = options["legacy-runtime"] ? inspectRuntimePackage(resolve(options["legacy-runtime"]), { legacy: true }) : null;
    if (action === "bootstrap" && inspectRuntimePackage(resolve(options["shell-root"])).digest !== candidate.digest) throw new Error("Stable shell content differs from candidate");
    const home = canonicalDestination(options.home), database = join(home, "router.sqlite3"), existing = existsSync(database);
    if (!existing && action !== "bootstrap") throw new Error("Stable runtime is not enrolled; no database was created");
    const cold = (action === "bootstrap" && (existing || legacyRuntime)) || action === "restore-host-entry";
    // A live host refusal precedes even a read-only SQLite open, so it cannot
    // create WAL companions or install additive schema in the rejected home.
    if (cold) assertColdProcessInventory();
    if (action === "bootstrap" && existing && !legacyRuntime) throw new Error("Existing data requires the exact retained legacy runtime for cold bootstrap");
    let source = null, legacyHistoryDigest = null;
    if (existing) {
      const snapshot = readOnlySnapshot(database), read = snapshot.db;
      try {
        const enrolled = Boolean(read.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_defaults'").get());
        const baseline = enrolled ? publishedDefault(read) : null;
        if (action === "bootstrap" && baseline) throw new Error("Stable shell is already enrolled; use explicit publication");
        if (action !== "bootstrap" && !baseline) throw new Error("Stable runtime is not enrolled; read-only inspection did not initialize legacy data");
        if (action === "references") {
          process.stdout.write(`${JSON.stringify(runtimeReferences(read, options.digest))}\n`);
        } else {
          if (baseline) source = JSON.parse(read.prepare("SELECT record FROM runtime_generations WHERE digest=?").get(baseline.current_digest).record);
          if (action === "bootstrap") legacyHistoryDigest = inspectColdRuntimeTransition(read, { preserveLegacy: true }).historyDigest;
          if (action === "restore-host-entry" && !read.prepare("SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'")
            .get(canonicalDestination(options.path), options.digest)) throw new Error("Only the exact retained host entry can be restored");
        }
      } finally { snapshot.close(); }
    }
    if (action !== "references") {
      const proof = candidate && source ? qualifyRuntimeCompatibility(source, candidate)
        : candidate && legacyRuntime ? qualifyRuntimeCompatibility(legacyRuntime, candidate, { coldLegacy: true }) : null;
      const processes = cold ? assertColdProcessInventory() : null;
      // Existing legacy stores are opened raw: do not run RouterStore's general
      // reconciler or migrate before an explicitly admitted additive bootstrap.
      const freshStore = existing ? null : new RouterStore({ path: database });
      const db = freshStore?.db || new DatabaseSync(database);
      const transaction = (callback) => { db.exec("BEGIN IMMEDIATE"); try { const value = callback(); db.exec("COMMIT"); return value; } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; } };
      try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF");
        let result;
        if (candidate) result = transaction(() => {
          const coldProof = legacyRuntime ? inspectColdRuntimeTransition(db, { inventory: () => processes || assertColdProcessInventory(), preserveLegacy: true }) : null;
          if (legacyHistoryDigest && coldProof.historyDigest !== legacyHistoryDigest) throw new Error("Legacy responsibility changed after cold preflight");
          ensureRuntimeIsolationSchema(db);
          return publishRuntime(db, candidate, home, { bootstrap: action === "bootstrap", shellRoot: options["shell-root"], compatibilityProof: proof, coldProof, legacyRuntime });
        });
        else if (action === "archive") result = transaction(() => archiveRuntime(db, options.digest, home));
        else if (action === "restore") result = transaction(() => restoreRuntime(db, options.digest, home));
        else if (action === "restore-host-entry") {
          const restored = copyRuntimePackage(runtimeGeneration(db, options.digest), canonicalDestination(options.path));
          result = { restored: restored.root, digest: restored.digest };
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally { if (freshStore) freshStore.close(); else db.close(); }
    }
  }
} catch (error) {
  process.stderr.write(`Runtime administration refused: ${error.message}\n`);
  process.exitCode = 2;
}
