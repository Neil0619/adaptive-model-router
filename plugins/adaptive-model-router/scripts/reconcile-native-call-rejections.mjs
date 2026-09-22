#!/usr/bin/env node
import { RouterStore } from "./lib/database.mjs";
import { databasePath } from "./lib/context.mjs";
import { openReadOnlySnapshot } from "./lib/read-only-snapshot.mjs";
import { environmentWithPluginData } from "./lib/plugin-data.mjs";
import { prepareRejectedRuntimeCalls, commitRejectedRuntimeCalls } from "./lib/runtime-call-reconciliation.mjs";

// Explicit repair utility. No replay, background work, host exit, installation,
// trust change, or native-log editing. Preview never opens a production writer.
let store, snapshot;
try {
  Object.assign(process.env, environmentWithPluginData(import.meta.url));
  const args = process.argv.slice(2), input = {};
  for (let i = 0; i < args.length; i++) {
    const key = { "--context": "contextId", "--expect-digest": "expectedDigest" }[args[i]];
    if (args[i] === "--apply" && !input.apply) input.apply = true;
    else if (key && !input[key] && args[i + 1] && !args[i + 1].startsWith("--")) input[key] = args[++i];
    else throw new Error("invalid native call recovery arguments");
  }
  if (!input.contextId || (input.apply && !/^[a-f0-9]{64}$/u.test(input.expectedDigest || "")))
    throw new Error("supply --context; --apply also requires the reviewed preview --expect-digest");
  if (input.apply) store = new RouterStore();
  else {
    snapshot = openReadOnlySnapshot(databasePath());
    if (!snapshot) throw new Error("native receipt state unavailable");
    const salt = snapshot.db.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
    if (!salt) throw new Error("native receipt identity unavailable");
    store = Object.assign(Object.create(RouterStore.prototype), {
      db: snapshot.db, salt, path: databasePath(), identityCache: new Map(), runtimeInvocation: null,
    });
  }
  const proof = await prepareRejectedRuntimeCalls(store, { contextId: input.contextId, cwd: process.cwd() });
  const evidenceDigest = proof.evidenceDigest;
  if (input.apply && evidenceDigest !== input.expectedDigest) throw new Error("preview changed; no recovery committed");
  const result = input.apply ? commitRejectedRuntimeCalls(store, proof) : { preview: true, ...proof };
  console.log(JSON.stringify({ ...result, evidenceDigest }));
  if (result.unresolved.length) process.exitCode = 7;
} catch (error) {
  console.error(JSON.stringify({ status: "blocked", error: error.message, installationChanged: false })); process.exitCode = 7;
} finally { if (snapshot) snapshot.close(); else store?.close(); }
