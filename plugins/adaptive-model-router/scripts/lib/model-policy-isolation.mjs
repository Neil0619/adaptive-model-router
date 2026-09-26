import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRuntimePackage, verifyRuntimePackage } from "./runtime-package.mjs";
import { runtimeSourceDigest } from "./lifecycle-qualification.mjs";
import { payloadHash } from "./io.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOKENS = new WeakMap();
const scriptDigest = () => createHash("sha256").update(readFileSync(join(ROOT, "scripts/verify-runtime-compatibility.mjs"))).digest("hex");
const table = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// Only the selected native service can obtain this local token. No tool input
// accepts a generation, proof flag or policy-reader label as authority.
export function prepareModelPolicyScope(store, operation) {
  const token = Object.freeze({}), invocation = store.runtimeInvocation;
  if (!invocation || !["preview_model_policy", "activate_model_policy", "rollback_model_policy"].includes(operation)) return token;
  try {
    const own = inspectRuntimePackage(ROOT);
    if (invocation.generation !== own.digest) return token;
    TOKENS.set(token, { db: store.db, invocation: { ...invocation }, kind: `mcp:${operation}`, own,
      verifier: runtimeSourceDigest(), verifierScriptDigest: scriptDigest() });
  } catch { /* Missing or changed packages grant no exception. */ }
  return token;
}

function isolatedSources(db, token) {
  const scope = token && TOKENS.get(token), sources = new Set();
  if (!scope || scope.db !== db || !table(db, "runtime_epoch_publications")) return sources;
  try {
    const call = db.prepare("SELECT * FROM runtime_invocations WHERE id=? AND state='active'").get(scope.invocation.id);
    if (!call || call.pid !== process.pid || call.kind !== scope.kind || call.generation !== scope.own.digest
      || call.project_id !== scope.invocation.projectId || call.context_key !== scope.invocation.contextKey) return sources;
    verifyRuntimePackage(scope.own);
    if (runtimeSourceDigest() !== scope.verifier || scriptDigest() !== scope.verifierScriptDigest) return sources;
    const selected = db.prepare("SELECT record,state FROM runtime_generations WHERE digest=?").get(call.generation);
    if (selected?.state !== "published") return sources;
    const selectedPackage = JSON.parse(selected.record);
    if (selectedPackage.digest !== call.generation) return sources;
    verifyRuntimePackage(selectedPackage);
    for (const row of db.prepare("SELECT * FROM runtime_epoch_publications WHERE candidate=?").all(call.generation)) {
      const { id, ...record } = JSON.parse(row.record), proof = record.modelPolicyIsolation;
      if (id !== row.id || payloadHash(record) !== id || record.source !== row.source || record.candidate !== row.candidate
        || record.verifier !== scope.verifier || record.schema !== "runtime-epoch-publication/1"
        || row.source === row.candidate || proof?.schema !== "model-policy-reader-isolation/1"
        || proof.sourceReader !== "legacy" || proof.candidateReader !== "v2"
        || proof.verifierScriptDigest !== scope.verifierScriptDigest) continue;
      const retained = db.prepare("SELECT record FROM runtime_generations WHERE digest=?").get(row.source);
      if (!retained) continue;
      const retainedPackage = JSON.parse(retained.record);
      if (retainedPackage.digest !== row.source) continue;
      verifyRuntimePackage(retainedPackage);
      sources.add(row.source);
    }
  } catch { return new Set(); }
  return sources;
}

export function modelPolicyResponsibilities(db, { v2Namespace = false, scopeToken = null } = {}) {
  const sources = v2Namespace ? isolatedSources(db, scopeToken) : new Set();
  const attempts = db.prepare("SELECT route_id,project_id,context_key FROM delegation_attempts WHERE finalized_at IS NULL").all();
  const blocks = db.prepare("SELECT key FROM meta WHERE key LIKE 'legacy_delegation_block:%'").all();
  let isolated = 0;
  if (sources.size) {
    for (const attempt of attempts) {
      const stage = db.prepare("SELECT generation FROM runtime_stages WHERE route_id=? AND project_id=? AND context_key=?")
        .get(attempt.route_id, attempt.project_id, attempt.context_key);
      if (stage && sources.has(stage.generation)) isolated++;
    }
    for (const block of blocks) {
      // A legacy marker aggregates a whole context. Its stored MIN(route_id)
      // cannot stand in for all retained stage owners in that context.
      const task = db.prepare("SELECT * FROM runtime_tasks WHERE 'legacy_delegation_block:' || project_id || ':' || context_key = ?").get(block.key);
      if (!task || task.candidate || !sources.has(task.generation)) continue;
      const epoch = table(db, "runtime_epoch_tasks") && db.prepare("SELECT generation FROM runtime_epoch_tasks WHERE project_id=? AND context_key=?")
        .get(task.project_id, task.context_key);
      if (epoch && !sources.has(epoch.generation)) continue;
      const stages = db.prepare("SELECT generation FROM runtime_stages WHERE project_id=? AND context_key=?").all(task.project_id, task.context_key);
      if (stages.some((stage) => !sources.has(stage.generation))) continue;
      isolated++;
    }
  }
  return { total: attempts.length + blocks.length, isolated, blocking: attempts.length + blocks.length - isolated };
}
