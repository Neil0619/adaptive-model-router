import { canonicalJson, parseJson } from "./io.mjs";
import { compileModelPolicy, DEFAULT_MODEL_POLICY, targetAllowed } from "./model-policy.mjs";
import { randomUUID } from "node:crypto";
import { modelPolicyResponsibilities, prepareModelPolicyScope } from "./model-policy-isolation.mjs";

const ACTIVE = "model_policy:active";
const ACTIVE_V2 = "model_policy:v2:active";
const REVISION = "model_policy:revision:";
const LINEAGE = "model_policy:activation-lineage";
const LINEAGE_V2 = "model_policy:v2:activation-lineage";

function activeKey(db) {
  return db.prepare("SELECT value FROM meta WHERE key=?").get(ACTIVE_V2) ? ACTIVE_V2 : ACTIVE;
}

function lineageKey(key) {
  return key === ACTIVE_V2 ? LINEAGE_V2 : LINEAGE;
}

function activationLineage(db, current) {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(lineageKey(activeKey(db)));
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
  const selected = digest || db.prepare("SELECT value FROM meta WHERE key=?").get(activeKey(db))?.value;
  if (!selected || selected === DEFAULT_MODEL_POLICY.digest) return DEFAULT_MODEL_POLICY;
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(REVISION + selected);
  if (!row) throw new Error("model policy revision is missing");
  const record = JSON.parse(row.value);
  const policy = compileModelPolicy(record.definition);
  if (policy.digest !== selected) throw new Error("model policy revision digest mismatch");
  return policy;
}

export function initializeModelPolicy(db) {
  // Retained v1 readers unconditionally open this key during startup. Never
  // seed it from the effective (possibly v2) policy, including on recovery.
  const legacyDigest = db.prepare("SELECT value FROM meta WHERE key=?").get(ACTIVE)?.value;
  const legacy = legacyDigest ? readModelPolicy(db, legacyDigest) : DEFAULT_MODEL_POLICY;
  if (legacy.definition.schemaVersion !== 1) throw new Error("legacy model policy pointer must remain schema 1");
  retainModelPolicy(db, legacy);
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(ACTIVE, legacy.digest);
  retainModelPolicy(db, readModelPolicy(db));
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
    legacyLearning: "observe-only", invalidLocks,
    ...(activeKey(db) === ACTIVE_V2 ? { activationScope: "v2-interpreters", legacyRuntimePolicy: legacyPolicyStatus(db) } : {}) };
}

function legacyPolicyStatus(db) {
  const digest = db.prepare("SELECT value FROM meta WHERE key=?").get(ACTIVE)?.value || DEFAULT_MODEL_POLICY.digest;
  const policy = readModelPolicy(db, digest);
  return { id: policy.definition.id, digest: policy.digest, schemaVersion: policy.definition.schemaVersion };
}

export function previewModelPolicy(db, definition, scopeToken = null) {
  const proposed = compileModelPolicy(definition);
  const current = readModelPolicy(db);
  const responsibilities = modelPolicyResponsibilities(db, { scopeToken,
    v2Namespace: proposed.definition.schemaVersion === 2 || activeKey(db) === ACTIVE_V2 });
  const leases = inferenceLeases(db).filter((lease) => !lease.dead).length;
  const activeDelegations = responsibilities.blocking + leases;
  const added = proposed.definition.allowedModels.flatMap((entry) => entry.efforts
    .filter((effort) => !targetAllowed(current, { model: entry.model, effort }))
    .map((effort) => ({ model: entry.model, effort })));
  const removed = current.definition.allowedModels.flatMap((entry) => entry.efforts
    .filter((effort) => !targetAllowed(proposed, { model: entry.model, effort }))
    .map((effort) => ({ model: entry.model, effort })));
  return { readOnly: true, currentDigest: current.digest, candidateDigest: proposed.digest,
    id: proposed.definition.id, added, removed, targets: proposed.definition.targets,
    activeDelegations, canActivate: activeDelegations === 0,
    totalResponsibilities: responsibilities.total + leases, isolatedLegacyResponsibilities: responsibilities.isolated,
    ...(proposed.definition.schemaVersion === 2 || activeKey(db) === ACTIVE_V2
      ? { activationScope: "v2-interpreters", legacyRuntimePolicy: legacyPolicyStatus(db) } : {}) };
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
  const scopeToken = prepareModelPolicyScope(store, "activate_model_policy");
  return store.transaction(() => {
    const current = readModelPolicy(store.db);
    if (current.digest !== expectedDigest) return { activated: false, reasonCode: "MODEL_POLICY_CONFLICT", currentDigest: current.digest };
    const preview = previewModelPolicy(store.db, definition, scopeToken);
    if (!preview.canActivate) return { activated: false, reasonCode: "MODEL_POLICY_BUSY", activeDelegations: preview.activeDelegations };
    for (const lease of inferenceLeases(store.db).filter((entry) => entry.dead)) store.db.prepare("DELETE FROM meta WHERE key=?").run(lease.key);
    if (current.digest === policy.digest) return { activated: true, digest: policy.digest, unchanged: true };
    const lineage = activationLineage(store.db, current);
    retainModelPolicy(store.db, current);
    retainModelPolicy(store.db, policy, current.digest);
    const key = policy.definition.schemaVersion === 2 ? ACTIVE_V2 : activeKey(store.db);
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(lineageKey(key), canonicalJson([...lineage, policy.digest]));
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, policy.digest);
    return { activated: true, digest: policy.digest, previousDigest: current.digest,
      ...(key === ACTIVE_V2 ? { activationScope: "v2-interpreters", legacyRuntimePolicy: legacyPolicyStatus(store.db) } : {}) };
  });
}

export function rollbackModelPolicy(store, { expectedDigest }) {
  const scopeToken = prepareModelPolicyScope(store, "rollback_model_policy");
  return store.transaction(() => {
    const current = readModelPolicy(store.db);
    if (current.digest !== expectedDigest) return { activated: false, reasonCode: "MODEL_POLICY_CONFLICT", currentDigest: current.digest };
    const lineage = activationLineage(store.db, current);
    const parent = lineage.at(-2);
    if (!parent) return { activated: false, reasonCode: "MODEL_POLICY_NO_PREVIOUS" };
    const target = readModelPolicy(store.db, parent);
    const preview = previewModelPolicy(store.db, target.definition, scopeToken);
    if (!preview.canActivate) return { activated: false, reasonCode: "MODEL_POLICY_BUSY", activeDelegations: preview.activeDelegations };
    for (const lease of inferenceLeases(store.db).filter((entry) => entry.dead)) store.db.prepare("DELETE FROM meta WHERE key=?").run(lease.key);
    const key = activeKey(store.db);
    store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(lineageKey(key), canonicalJson(lineage.slice(0, -1)));
    store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(parent, key);
    return { activated: true, digest: parent, previousDigest: current.digest,
      ...(key === ACTIVE_V2 ? { activationScope: "v2-interpreters", legacyRuntimePolicy: legacyPolicyStatus(store.db) } : {}) };
  });
}
