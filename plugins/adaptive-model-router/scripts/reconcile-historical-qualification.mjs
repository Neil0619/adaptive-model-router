#!/usr/bin/env node
import { RouterStore } from "./lib/database.mjs";
import { databasePath } from "./lib/context.mjs";
import { recoverHistoricalQualification } from "./lib/historical-qualification-recovery.mjs";
import { openReadOnlySnapshot } from "./lib/read-only-snapshot.mjs";
import { environmentWithPluginData } from "./lib/plugin-data.mjs";

// Explicit historical repair. Preview uses a private database snapshot and
// never runs the schema constructor against the installation being inspected.
let store, snapshot;
try {
  Object.assign(process.env, environmentWithPluginData(import.meta.url));
  const input = {}, argv = process.argv.slice(2);
  let sourceGeneration;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply" && !input.apply) input.apply = true;
    else {
      const key = { "--context": "contextId", "--route": "routeId", "--expect-digest": "expectedEvidenceDigest", "--source-runtime": "sourceGeneration" }[flag];
      if (!key || (key === "sourceGeneration" ? sourceGeneration !== undefined : input[key] !== undefined)
        || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("invalid historical recovery arguments");
      const value = argv[++index];
      if (key === "sourceGeneration") sourceGeneration = value;
      else input[key] = value;
    }
  }
  if (!input.contextId || !input.routeId || (sourceGeneration && !/^[a-f0-9]{64}$/u.test(sourceGeneration))
    || (input.apply && !/^[a-f0-9]{64}$/u.test(input.expectedEvidenceDigest || ""))) throw new Error("missing historical recovery arguments");
  if (input.apply) store = new RouterStore();
  else {
    snapshot = openReadOnlySnapshot(databasePath());
    if (!snapshot) throw new Error("historical state unavailable");
    const salt = snapshot.db.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
    if (typeof salt !== "string" || !salt) throw new Error("historical identity unavailable");
    store = Object.assign(Object.create(RouterStore.prototype), {
      db: snapshot.db, salt, identityCache: new Map(), runtimeInvocation: null,
    });
  }
  const result = await recoverHistoricalQualification(input, { store, cwd: process.cwd(), sourceGeneration });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "unresolved") process.exitCode = 7;
} catch {
  process.stderr.write("Adaptive Router historical qualification evidence is unresolved; no recovery was applied.\n");
  process.exitCode = 7;
} finally {
  if (snapshot) snapshot.close();
  else store?.close();
}
