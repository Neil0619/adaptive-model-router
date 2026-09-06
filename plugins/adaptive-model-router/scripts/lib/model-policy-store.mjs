import { canonicalJson, parseJson } from "./io.mjs";
import { compileModelPolicy, DEFAULT_MODEL_POLICY, targetAllowed } from "./model-policy.mjs";
import { randomUUID } from "node:crypto";

const ACTIVE = "model_policy:active";
const REVISION = "model_policy:revision:";
const LINEAGE = "model_policy:activation-lineage";

function activationLineage(db, current) {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(LINEAGE);
  if (row) {
    const values = JSON.parse(row.value);
    if (!Array.isArray(values) || !values.length || values.at(-1) !== current.digest
      || values.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error("model policy activation lineage mismatch");
    }
    return values;
  }
  // Older v1 stores recorded the first parent of each immutable definition.
  // Preserve that chain once; subsequent activations track their own order.
  const values = [current.digest];
  while (true) {
    const record = db.prepare("SELECT value FROM meta WHERE key=?").get(REVISION + values[0]);
    const parent = record ? JSON.parse(record.value).parentDigest : null;
    if (!parent) return values;
    if (values.includes(parent)) throw new Error("model policy revision ancestry cycle");
    readModelPolicy(db, parent);
    values.unshift(parent);
  }
}

function inferenceLeases(db) {
  return db.prepare("SELECT key,value FROM meta WHERE key LIKE 'model_policy:inference:%'").all().map((row) => {
    const owner = parseJson(row.value, {});
    let dead = false;
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === "ESRCH"; }
    }
    return { key: row.key, dead };
  });
}

export function readModelPolicy(db, digest = null) {
  const selected = digest || db.prepare("SELECT value FROM meta WHERE key=?").get(ACTIVE)?.value;
  if (!selected || selected === DEFAULT_MODEL_POLICY.digest) return DEFAULT_MODEL_POLICY;
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(REVISION + selected);
  if (!row) throw new Error("model policy revision is missing");
  const record = JSON.parse(row.value);
  const policy = compileModelPolicy(record.definition);
  if (policy.digest !== selected) throw new Error("model policy revision digest mismatch");
  return policy;
}

export function retainModelPolicy(db, policy, parentDigest = null) {
  const existing = db.prepare("SELECT value FROM meta WHERE key=?").get(REVISION + policy.digest);
  if (existing) {
    if (canonicalJson(JSON.parse(existing.value).definition) !== canonicalJson(policy.definition)) throw new Error("model policy revision collision");
    return;
  }
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(REVISION + policy.digest,
    canonicalJson({ definition: policy.definition, parentDigest, createdAt: new Date().toISOString() }));
}

export function modelPolicyStatus(db, context = null) {
  const policy = readModelPolicy(db);
  const locks = context ? db.prepare(`SELECT model,effort FROM overrides WHERE mode='locked'
    AND (project_id=? OR scope='global') AND (context_key=? OR scope IN ('project','global'))`)
    .all(context.projectId, context.contextKey) : [];
  const invalidLocks = locks.filter((entry) => (entry.model && !policy.definition.allowedModels.some((model) =>
    model.model === entry.model && (!entry.effort || model.efforts.includes(entry.effort))))
    || (!entry.model && entry.effort && !policy.definition.allowedModels.some((model) => model.efforts.includes(entry.effort)))).length;
  return { id: policy.definition.id, schemaVersion: policy.definition.schemaVersion, digest: policy.digest,
    parentDigest: activationLineage(db, policy).at(-2) || null,
    allowedModels: policy.definition.allowedModels, targets: policy.definition.targets,
    legacyLearning: "observe-only", invalidLocks };
}

export function previewModelPolicy(db, definition) {
  const proposed = compileModelPolicy(definition);
  const current = readModelPolicy(db);
  const activeDelegations = Number(db.prepare("SELECT count(*) AS count FROM delegation_attempts WHERE finalized_at IS NULL").get().count)
    + Number(db.prepare("SELECT count(*) AS count FROM meta WHERE key LIKE 'legacy_delegation_block:%'").get().count)
    + inferenceLeases(db).filter((lease) => !lease.dead).length;
  const added = proposed.definition.allowedModels.flatMap((entry) => entry.efforts
    .filter((effort) => !targetAllowed(current, { model: entry.model, effort }))
    .map((effort) => ({ model: entry.model, effort })));
  const removed = current.definition.allowedModels.flatMap((entry) => entry.efforts
    .filter((effort) => !targetAllowed(proposed, { model: entry.model, effort }))
    .map((effort) => ({ model: entry.model, effort })));
  return { readOnly: true, currentDigest: current.digest, candidateDigest: proposed.digest,
    id: proposed.definition.id, added, removed, targets: proposed.definition.targets,
    activeDelegations, canActivate: activeDelegations === 0 };
}

export async function withModelPolicyLease(store, policy, operation) {
  const key = `model_policy:inference:${randomUUID()}`;
  store.transaction(() => {
    if (readModelPolicy(store.db).digest !== policy.digest) throw new Error("model policy changed before inference");
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(key, canonicalJson({ digest: policy.digest, pid: process.pid }));
  });
  try { return await operation(); }
  finally { store.transaction(() => store.db.prepare("DELETE FROM meta WHERE key=?").run(key)); }
}

export function activateModelPolicy(store, { definition, expectedDigest }) {
  const policy = compileModelPolicy(definition);
  return store.transaction(() => {
    const current = readModelPolicy(store.db);
    if (current.digest !== expectedDigest) return { activated: false, reasonCode: "MODEL_POLICY_CONFLICT", currentDigest: current.digest };
    const preview = previewModelPolicy(store.db, definition);
    if (!preview.canActivate) return { activated: false, reasonCode: "MODEL_POLICY_BUSY", activeDelegations: preview.activeDelegations };
    for (const lease of inferenceLeases(store.db).filter((entry) => entry.dead)) store.db.prepare("DELETE FROM meta WHERE key=?").run(lease.key);
    if (current.digest === policy.digest) return { activated: true, digest: policy.digest, unchanged: true };
    const lineage = activationLineage(store.db, current);
    retainModelPolicy(store.db, current);
    retainModelPolicy(store.db, policy, current.digest);
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(LINEAGE, canonicalJson([...lineage, policy.digest]));
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(ACTIVE, policy.digest);
    return { activated: true, digest: policy.digest, previousDigest: current.digest };
  });
}

export function rollbackModelPolicy(store, { expectedDigest }) {
  return store.transaction(() => {
    const current = readModelPolicy(store.db);
    if (current.digest !== expectedDigest) return { activated: false, reasonCode: "MODEL_POLICY_CONFLICT", currentDigest: current.digest };
    const lineage = activationLineage(store.db, current);
    const parent = lineage.at(-2);
    if (!parent) return { activated: false, reasonCode: "MODEL_POLICY_NO_PREVIOUS" };
    const target = readModelPolicy(store.db, parent);
    const preview = previewModelPolicy(store.db, target.definition);
    if (!preview.canActivate) return { activated: false, reasonCode: "MODEL_POLICY_BUSY", activeDelegations: preview.activeDelegations };
    for (const lease of inferenceLeases(store.db).filter((entry) => entry.dead)) store.db.prepare("DELETE FROM meta WHERE key=?").run(lease.key);
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(LINEAGE, canonicalJson(lineage.slice(0, -1)));
    store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(parent, ACTIVE);
    return { activated: true, digest: parent, previousDigest: current.digest };
  });
}
