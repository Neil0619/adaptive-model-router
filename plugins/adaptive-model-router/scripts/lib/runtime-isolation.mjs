import { recordPrunedEvidence } from "./audit-records.mjs";
import { validColdRuntimeTransition } from "./runtime-cold-transition.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verifyRuntimePackage, copyRuntimePackage, managedRuntimeDestination } from "./runtime-package.mjs";
import { stageResponsibilities } from "./stage-closure.mjs";
import { payloadHash } from "./io.mjs";
import { isRuntimeBoundaryProof } from "./runtime-boundary.mjs";
import { validRuntimeCompatibility } from "./runtime-compatibility.mjs";
import { isNativeRootBirth } from "./subagent-session.mjs";
import { verifiedRuntimeQualification, runtimeSourceDigest } from "./lifecycle-qualification.mjs";
import { ensureHostEpochSchema, hasHostEpochSchema } from "./host-epoch-storage.mjs";

export function ensureRuntimeIsolationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_generations (
      digest TEXT PRIMARY KEY, record TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('published','archived')));
    CREATE TABLE IF NOT EXISTS runtime_defaults (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), current_digest TEXT NOT NULL REFERENCES runtime_generations(digest),
      rollback_digest TEXT REFERENCES runtime_generations(digest));
    CREATE TABLE IF NOT EXISTS runtime_tasks (
      project_id TEXT NOT NULL, context_key TEXT NOT NULL, generation TEXT NOT NULL REFERENCES runtime_generations(digest),
      turn_id TEXT, candidate TEXT REFERENCES runtime_generations(digest), boundary_digest TEXT,
      PRIMARY KEY(project_id,context_key));
    CREATE TABLE IF NOT EXISTS runtime_stages (
      route_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL,
      generation TEXT NOT NULL REFERENCES runtime_generations(digest));
    CREATE TABLE IF NOT EXISTS runtime_invocations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL,
      generation TEXT NOT NULL REFERENCES runtime_generations(digest), kind TEXT NOT NULL,
      pid INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','unknown','completed')), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_host_entries (
      path TEXT PRIMARY KEY, generation TEXT NOT NULL REFERENCES runtime_generations(digest),
      state TEXT NOT NULL CHECK(state IN ('referenced','released')));
    CREATE TABLE IF NOT EXISTS runtime_migrations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL, source TEXT NOT NULL,
      candidate TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('qualifying','passed','failed','unknown')),
      evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_call_receipts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
      generation TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','consumed','rejected')));
    CREATE TABLE IF NOT EXISTS runtime_root_commands (
      project_id TEXT NOT NULL, context_key TEXT NOT NULL, call_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      command_digest TEXT NOT NULL, pre_seen INTEGER NOT NULL CHECK(pre_seen IN (0,1)),
      post_seen INTEGER NOT NULL CHECK(post_seen IN (0,1)), conflicted INTEGER NOT NULL CHECK(conflicted IN (0,1)),
      PRIMARY KEY(project_id,context_key,call_id));
    CREATE TRIGGER IF NOT EXISTS enroll_late_legacy_task BEFORE INSERT ON delegation_attempts
      WHEN EXISTS (SELECT 1 FROM meta WHERE key='runtime_legacy_bootstrap')
      AND NOT EXISTS (SELECT 1 FROM runtime_tasks WHERE project_id=NEW.project_id AND context_key=NEW.context_key)
      BEGIN
        INSERT INTO runtime_tasks(project_id,context_key,generation)
          SELECT NEW.project_id,NEW.context_key,json_extract(value,'$.legacyDigest') FROM meta WHERE key='runtime_legacy_bootstrap';
        INSERT INTO runtime_stages(route_id,project_id,context_key,generation)
          SELECT NEW.route_id,NEW.project_id,NEW.context_key,generation FROM runtime_tasks WHERE project_id=NEW.project_id AND context_key=NEW.context_key;
      END;
    CREATE TRIGGER IF NOT EXISTS bind_legacy_runtime_stage BEFORE INSERT ON delegation_attempts
      WHEN EXISTS (SELECT 1 FROM runtime_tasks t JOIN runtime_generations g ON g.digest=t.generation
        WHERE t.project_id=NEW.project_id AND t.context_key=NEW.context_key
        AND json_extract(g.record,'$.descriptor.shellProtocolVersion')=1 AND t.candidate IS NULL)
      BEGIN INSERT OR IGNORE INTO runtime_stages(route_id,project_id,context_key,generation)
        SELECT NEW.route_id,NEW.project_id,NEW.context_key,generation FROM runtime_tasks
        WHERE project_id=NEW.project_id AND context_key=NEW.context_key; END;
    CREATE TRIGGER IF NOT EXISTS require_bound_runtime_stage BEFORE INSERT ON delegation_attempts
      WHEN EXISTS (SELECT 1 FROM runtime_tasks t WHERE t.project_id=NEW.project_id AND t.context_key=NEW.context_key)
      AND NOT EXISTS (SELECT 1 FROM runtime_tasks t JOIN runtime_generations g ON g.digest=t.generation
        WHERE t.project_id=NEW.project_id AND t.context_key=NEW.context_key
        AND json_extract(g.record,'$.descriptor.shellProtocolVersion')=1 AND t.candidate IS NULL)
      AND NOT EXISTS (SELECT 1 FROM runtime_stages s JOIN runtime_tasks t
        ON t.project_id=s.project_id AND t.context_key=s.context_key WHERE s.route_id=NEW.route_id
        AND s.project_id=NEW.project_id AND s.context_key=NEW.context_key AND s.generation=COALESCE(t.candidate,t.generation))
      BEGIN SELECT RAISE(ABORT,'runtime stage ownership is required before admission'); END;
  `);
}

export function runtimeTask(db, context) {
  return db.prepare("SELECT * FROM runtime_tasks WHERE project_id=? AND context_key=?").get(context.projectId, context.contextKey) || null;
}
export function publishedDefault(db) { return db.prepare("SELECT * FROM runtime_defaults WHERE singleton=1").get() || null; }
const sameExecutionContract = (a, b) => a.writerDigest === b.writerDigest && a.shellDigest === b.shellDigest;

// An epoch names the compatibility baseline; an ordinary release may have
// different package metadata while preserving every writer/shell contract.
// Keep the immutable epoch receipt rather than relabeling its original target.
export function runtimeEpochGenerationCompatible(db, context, generation) {
  if (!hasHostEpochSchema(db)) return false;
  const epoch = db.prepare(`SELECT e.generation FROM runtime_epoch_tasks e
    JOIN runtime_epoch_receipts r ON r.id=e.receipt_id AND r.candidate=e.generation
    WHERE e.project_id=? AND e.context_key=?`).get(context.projectId, context.contextKey);
  if (!epoch) return false;
  const baseline = runtimeGeneration(db, epoch.generation), selected = runtimeGeneration(db, generation);
  verifyRuntimePackage(baseline); verifyRuntimePackage(selected);
  return sameExecutionContract(baseline, selected);
}

function taskDefault(db, context, task) {
  if (task && runtimeEpochGenerationCompatible(db, context, task.generation)
    && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_epoch_ordinary_defaults'").get()) {
    const current = runtimeGeneration(db, task.generation);
    const family = db.prepare(`SELECT d.generation AS current_digest FROM runtime_epoch_ordinary_defaults d
      JOIN runtime_epoch_ordinary_publications p ON p.id=d.publication_id AND p.candidate=d.generation
      WHERE d.writer_digest=? AND d.shell_digest=?`).get(current.writerDigest, current.shellDigest);
    if (family) return family;
  }
  return publishedDefault(db);
}

function epochWriterConnection(db, source, other) {
  if (!hasHostEpochSchema(db)) return null;
  for (const row of db.prepare("SELECT * FROM runtime_epoch_publications ORDER BY rowid DESC").all()) {
    if (JSON.parse(row.record).verifier !== runtimeSourceDigest()) continue;
    const a = runtimeGeneration(db, row.source), b = runtimeGeneration(db, row.candidate);
    if ((sameExecutionContract(source, a) && sameExecutionContract(other, b))
      || (sameExecutionContract(source, b) && sameExecutionContract(other, a))) {
      verifyRuntimePackage(a); verifyRuntimePackage(b); return row.id;
    }
  }
  return null;
}
export function runtimeGeneration(db, digest) {
  const row = db.prepare("SELECT * FROM runtime_generations WHERE digest=?").get(digest);
  if (!row) throw new Error("Runtime generation is unavailable; restore its retained package");
  const record = JSON.parse(row.record);
  if (!existsSync(record.root)) {
    // Atomic rename and SQLite commit cannot be one transaction. Recover only
    // the exact digest at the deterministic peer location, never scan siblings.
    const directory = dirname(record.root);
    const alternate = join(dirname(directory), directory.endsWith("published") ? "archive" : "published", digest);
    verifyRuntimePackage({ ...record, root: alternate });
    record.root = alternate;
    db.prepare("UPDATE runtime_generations SET record=? WHERE digest=?").run(JSON.stringify(record), digest);
  }
  return { ...record, state: row.state };
}

// Requires the caller's BEGIN IMMEDIATE. Files are copied before publication;
// an interrupted copy is an unindexed orphan, never a discovered candidate.
export function publishRuntime(db, candidate, dataRoot, { bootstrap = false, shellRoot = null, compatibilityProof = null, coldProof = null, legacyRuntime = null } = {}) {
  candidate = verifyRuntimePackage(candidate);
  const defaults = publishedDefault(db);
  if (!defaults && !bootstrap) throw new Error("Stable shell cold bootstrap has not been enrolled");
  if (bootstrap && defaults) throw new Error("Stable shell is already enrolled; use explicit publication");
  if (bootstrap && (!shellRoot || verifyRuntimePackage({ ...candidate, root: realpathSync(shellRoot) }).digest !== candidate.digest)) {
    throw new Error("Cold bootstrap requires the exact registered stable shell package");
  }
  if (bootstrap && db.prepare("SELECT 1 FROM routes UNION ALL SELECT 1 FROM delegation_attempts UNION ALL SELECT 1 FROM delegation_children LIMIT 1").get()
    && !validColdRuntimeTransition(db, coldProof, Boolean(legacyRuntime))) throw new Error("Legacy history requires a verified cold host boundary; retain all data");
  if (legacyRuntime) {
    verifyRuntimePackage(legacyRuntime);
    if (!bootstrap || !validColdRuntimeTransition(db, coldProof, true)
      || !validRuntimeCompatibility(compatibilityProof, legacyRuntime.digest, candidate.digest, true)) {
      throw new Error("Legacy bootstrap requires exact installed A/B writer qualification and a cold process boundary");
    }
  }
  const ordinarySource = defaults && compatibilityProof?.source
    ? runtimeGeneration(db, compatibilityProof.source) : defaults && runtimeGeneration(db, defaults.current_digest);
  if (ordinarySource) verifyRuntimePackage(ordinarySource);
  const familyPublication = defaults && ordinarySource.digest !== defaults.current_digest;
  if (defaults && (familyPublication || candidate.digest !== defaults.current_digest)
    && (!validRuntimeCompatibility(compatibilityProof, ordinarySource.digest, candidate.digest)
      || !sameExecutionContract(ordinarySource, candidate)
      || (familyPublication && !epochWriterConnection(db, ordinarySource, runtimeGeneration(db, defaults.current_digest))))) {
    throw new Error("Exact A/B executable shared-writer qualification is required before publication");
  }
  const epochConnections = [];
  for (const row of db.prepare("SELECT digest FROM runtime_generations").all()) {
    const prior = runtimeGeneration(db, row.digest); verifyRuntimePackage(prior);
    if (prior.descriptor.shellProtocolVersion === 1) continue; // Pinned legacy domain, admitted once with its exact cold compatibility proof.
    if ((!sameExecutionContract(prior, candidate) && !epochWriterConnection(db, prior, ordinarySource || candidate))
      || prior.descriptor.storageContractVersion !== candidate.descriptor.storageContractVersion
      || prior.descriptor.databaseVersion !== candidate.descriptor.databaseVersion) {
      throw new Error("Unproven shared-writer or shell compatibility: publication refused; no database rollback is permitted");
    }
    if (!sameExecutionContract(prior, candidate)) epochConnections.push(epochWriterConnection(db, prior, ordinarySource));
  }
  let existing = db.prepare("SELECT record,state FROM runtime_generations WHERE digest=?").get(candidate.digest);
  if (existing?.state === "archived") restoreRuntime(db, candidate.digest, dataRoot);
  if (!existing) {
    const destination = managedRuntimeDestination(dataRoot, "published", candidate.digest);
    const copy = copyRuntimePackage(candidate, destination);
    db.prepare("INSERT INTO runtime_generations(digest,record,state) VALUES(?,?,'published')").run(copy.digest, JSON.stringify(copy));
  }
  if (!defaults) {
    if (legacyRuntime) {
      const legacy = copyRuntimePackage(legacyRuntime, managedRuntimeDestination(dataRoot, "published", legacyRuntime.digest));
      db.prepare("INSERT INTO runtime_generations(digest,record,state) VALUES(?,?,'published')").run(legacy.digest, JSON.stringify(legacy));
      // This records the executing generation at the cold boundary. It does
      // not invent which historical version originally created each ticket.
      db.prepare(`INSERT INTO runtime_tasks(project_id,context_key,generation)
        SELECT project_id,context_key,? FROM (SELECT project_id,context_key FROM host_model_state
          UNION SELECT project_id,context_key FROM routes UNION SELECT project_id,context_key FROM delegation_attempts)`)
        .run(legacy.digest);
      db.prepare(`INSERT INTO runtime_stages(route_id,project_id,context_key,generation)
        SELECT route_id,project_id,context_key,? FROM (
          SELECT route_id,project_id,context_key FROM routes WHERE action='delegate'
          UNION SELECT route_id,project_id,context_key FROM delegation_attempts
          UNION SELECT route_id,project_id,context_key FROM delegation_children)`).run(legacy.digest);
      db.prepare("INSERT INTO runtime_host_entries(path,generation,state) VALUES(?,?,'referenced')").run(realpathSync(legacyRuntime.root), legacy.digest);
      db.prepare("INSERT INTO meta(key,value) VALUES('runtime_legacy_bootstrap',?)").run(JSON.stringify({
        legacyDigest: legacy.digest, defaultDigest: candidate.digest, cutoverTime: Date.now(), basis: "executing generation at cold boundary; historical creator remains unknown",
        compatibility: { suite: compatibilityProof.suite, source: compatibilityProof.source, candidate: compatibilityProof.candidate } }));
    }
    db.prepare("INSERT INTO runtime_defaults(singleton,current_digest) VALUES(1,?)").run(candidate.digest);
    if (!shellRoot) throw new Error("Cold bootstrap requires the exact registered stable shell path");
    db.prepare("INSERT INTO runtime_host_entries(path,generation,state) VALUES(?,?,'referenced')").run(realpathSync(shellRoot), candidate.digest);
  } else if (familyPublication) {
    ensureHostEpochSchema(db);
    const record = { schema: "runtime-epoch-ordinary-publication/1", source: ordinarySource.digest, candidate: candidate.digest,
      suite: compatibilityProof.suite, epochConnections: [...new Set(epochConnections)].sort() };
    const id = payloadHash(record);
    db.prepare("INSERT OR IGNORE INTO runtime_epoch_ordinary_publications VALUES(?,?,?,?)")
      .run(id, ordinarySource.digest, candidate.digest, JSON.stringify(record));
    db.prepare(`INSERT INTO runtime_epoch_ordinary_defaults VALUES(?,?,?,?) ON CONFLICT(writer_digest,shell_digest)
      DO UPDATE SET generation=excluded.generation,publication_id=excluded.publication_id`)
      .run(candidate.writerDigest, candidate.shellDigest, candidate.digest, id);
  } else if (defaults.current_digest !== candidate.digest) {
    db.prepare("UPDATE runtime_defaults SET rollback_digest=current_digest,current_digest=? WHERE singleton=1").run(candidate.digest);
  }
  return { digest: candidate.digest, version: candidate.descriptor.runtimeVersion, taskBindingsChanged: 0,
    ...(familyPublication ? { scope: "compatible_epoch_tasks", sharedDefaultChanged: false } : {}) };
}

export function ensureRuntimeTask(db, context, { trustedHook = false, turnId = null, rootBirth = null } = {}) {
  let task = runtimeTask(db, context);
  if (!task) {
    if (!trustedHook) throw new Error("Trusted native Hook task identity is required before runtime admission");
    const defaults = publishedDefault(db);
    if (!defaults) throw new Error("Stable runtime shell requires deferred cold bootstrap; legacy hot-install is unsafe");
    if (db.prepare("SELECT 1 FROM delegation_attempts WHERE project_id=? AND context_key=? AND finalized_at IS NULL LIMIT 1").get(context.projectId, context.contextKey)) {
      throw new Error("Legacy task responsibility has no runtime binding; preserve its original shell");
    }
    const legacy = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='runtime_legacy_bootstrap'").get()?.value || "null");
    // Each non-revoked cold retirement adds a birth boundary without replacing
    // the original v1 bootstrap. Roots born between the two keep the former
    // default; missing or non-root metadata cannot acquire the latest epoch.
    const cutovers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_epoch_retirements'").get()
      ? db.prepare(`SELECT r.record FROM runtime_epoch_retirements r
        WHERE json_extract(r.record,'$.recovery') IS (SELECT id FROM runtime_epoch_entry_recoveries
          WHERE installation_id=r.installation_id ORDER BY rowid DESC LIMIT 1) ORDER BY r.rowid`)
        .all().map((row) => JSON.parse(row.record)).filter((row) => row.previousDefaults) : [];
    const birthKnown = isNativeRootBirth(rootBirth);
    let generation = defaults.current_digest;
    if (legacy && (!birthKnown || rootBirth.time <= legacy.cutoverTime)) generation = legacy.legacyDigest;
    else {
      const next = cutovers.find((cutover) => !birthKnown || rootBirth.time <= cutover.retiredAt);
      if (next) generation = next.previousDefaults.current_digest;
    }
    db.prepare("INSERT INTO runtime_tasks(project_id,context_key,generation,turn_id) VALUES(?,?,?,?)")
      .run(context.projectId, context.contextKey, generation, turnId);
    task = runtimeTask(db, context);
  }
  return task;
}

export function pendingRuntimeResponsibilities(db, context, { ignoreInvocation = null, ignoreReceipts = false } = {}) {
  const reasons = [];
  const scoped = (sql) => db.prepare(sql).get(context.projectId, context.contextKey);
  if (scoped("SELECT 1 FROM delegation_attempts WHERE project_id=? AND context_key=? AND finalized_at IS NULL")) reasons.push("unfinished_stage");
  if (scoped("SELECT 1 FROM delegation_children WHERE project_id=? AND context_key=? AND state!='settled'")) reasons.push("child");
  if (scoped(`SELECT 1 FROM delegation_messages m JOIN delegation_children c USING(route_id)
    WHERE c.project_id=? AND c.context_key=? AND (m.status IN ('pending','unknown')
      OR (m.status='accepted' AND (c.state!='settled' OR COALESCE(c.verified_revision,-1)<m.revision)))`)) reasons.push("message");
  if (scoped(`SELECT 1 FROM delegation_child_commands j JOIN delegation_children c USING(route_id)
    WHERE c.project_id=? AND c.context_key=? AND j.verified=0`)) reasons.push("command");
  if (scoped(`SELECT 1 FROM delegation_maintenance m JOIN delegation_children c USING(route_id)
    WHERE c.project_id=? AND c.context_key=? AND m.state!='verified'`)) reasons.push("maintenance");
  if (stageResponsibilities(db, context).length) reasons.push("retained_responsibility");
  if (db.prepare("SELECT 1 FROM meta WHERE key=?").get(`legacy_delegation_block:${context.projectId}:${context.contextKey}`)) reasons.push("legacy_unknown");
  if (db.prepare(`SELECT 1 FROM runtime_invocations WHERE project_id=? AND context_key=? AND state!='completed' AND id IS NOT ?`)
    .get(context.projectId, context.contextKey, ignoreInvocation)) reasons.push("in_flight_or_unknown_call");
  if (!ignoreReceipts && scoped("SELECT 1 FROM runtime_call_receipts WHERE project_id=? AND context_key=? AND state='pending'")) reasons.push("pending_native_call");
  return reasons;
}

export function acquireRuntimeInvocation(db, context, { kind, stageId = null, generation = null } = {}) {
  const task = runtimeTask(db, context);
  if (!task) throw new Error("Task runtime binding is missing");
  if (stageId) {
    const stage = db.prepare("SELECT * FROM runtime_stages WHERE route_id=?").get(stageId);
    if (!stage || stage.project_id !== context.projectId || stage.context_key !== context.contextKey) throw new Error("Stage runtime ownership is missing");
    generation = stage.generation;
  }
  generation ||= task.candidate || task.generation;
  const selected = runtimeGeneration(db, generation);
  if (selected.state !== "published") throw new Error("Bound runtime must be restored before admission");
  verifyRuntimePackage(selected);
  const invocation = { id: randomUUID(), generation, projectId: context.projectId, contextKey: context.contextKey, kind };
  db.prepare("INSERT INTO runtime_invocations(id,project_id,context_key,generation,kind,pid,state,created_at) VALUES(?,?,?,?,?,?,'active',?)")
    .run(invocation.id, context.projectId, context.contextKey, generation, kind, process.pid, new Date().toISOString());
  return { invocation, selected };
}

export function finishRuntimeInvocation(db, invocation, { completed = true } = {}) {
  db.prepare("UPDATE runtime_invocations SET state=? WHERE id=? AND state='active'")
    .run(completed ? "completed" : "unknown", invocation.id);
  const invocations = db.prepare(`DELETE FROM runtime_invocations WHERE project_id=? AND context_key=? AND state='completed'
    AND rowid NOT IN (SELECT rowid FROM runtime_invocations WHERE project_id=? AND context_key=? AND state='completed' ORDER BY rowid DESC LIMIT 128)`)
    .run(invocation.projectId, invocation.contextKey, invocation.projectId, invocation.contextKey);
  const receipts = db.prepare(`DELETE FROM runtime_call_receipts WHERE project_id=? AND context_key=? AND state!='pending'
    AND rowid NOT IN (SELECT rowid FROM runtime_call_receipts WHERE project_id=? AND context_key=? AND state!='pending' ORDER BY rowid DESC LIMIT 128)`)
    .run(invocation.projectId, invocation.contextKey, invocation.projectId, invocation.contextKey);
  const timestamp = new Date().toISOString();
  recordPrunedEvidence(db, invocation, "completed_invocation", Number(invocations.changes), timestamp);
  recordPrunedEvidence(db, invocation, "settled_receipt", Number(receipts.changes), timestamp);
}

// Called inside the existing route/ticket transaction. The lease prevents the
// preflight/await/admission TOCTOU window; the row persists beyond outcome prune.
export function bindRuntimeStage(db, context, routeId, invocation, qualification = false) {
  const task = runtimeTask(db, context);
  if (!task) return; // Direct offline core tests and pre-v2 stores are unchanged.
  if (task.candidate && !qualification) {
    const error = new Error("Candidate qualification is unfinished; business admission remains paused");
    error.code = "RUNTIME_CANDIDATE_QUALIFICATION_PENDING";
    throw error;
  }
  const lease = invocation && db.prepare("SELECT * FROM runtime_invocations WHERE id=? AND state='active'").get(invocation.id);
  if (!lease || lease.project_id !== context.projectId || lease.context_key !== context.contextKey
    || lease.generation !== (task.candidate || task.generation)) throw new Error("Runtime admission lease changed or is missing");
  db.prepare("INSERT INTO runtime_stages(route_id,project_id,context_key,generation) VALUES(?,?,?,?)")
    .run(routeId, context.projectId, context.contextKey, lease.generation);
}

export function beginRuntimeMigration(db, context, boundary) {
  const task = runtimeTask(db, context), defaults = taskDefault(db, context, task);
  if (!task || task.candidate || !defaults || defaults.current_digest === task.generation) return false;
  if (!isRuntimeBoundaryProof(boundary, db, context) || boundary.previousTurn !== task.turn_id) return false;
  if (pendingRuntimeResponsibilities(db, context).length) return false;
  const source = runtimeGeneration(db, task.generation), candidate = runtimeGeneration(db, defaults.current_digest);
  // Frozen v1 entry snapshots cannot participate in the v2 admission lease.
  // Keep their exact A and responsibilities until a separately proven native
  // entry retirement, rather than pretending a root Stop upgrades that shell.
  if (source.descriptor.shellProtocolVersion === 1) return false;
  // Cold enrollment keeps A tasks on their preserved writer until the new
  // entry verifier adopts them. Never send the new cold B through A's ordinary
  // candidate/qualification reader on a later UserPromptSubmit.
  if (hasHostEpochSchema(db) && db.prepare(`SELECT 1 FROM runtime_epoch_publications
    WHERE source=? AND candidate=? AND json_extract(record,'$.entryMode')='cold'`)
    .get(source.digest, candidate.digest)) return false;
  verifyRuntimePackage(source); verifyRuntimePackage(candidate);
  if (source.writerDigest !== candidate.writerDigest || source.shellDigest !== candidate.shellDigest) {
    // An explicit epoch advances this task independently of the shared
    // ordinary default. Retain that assignment at the next native turn; the
    // old default cannot authorize a reverse compatibility handover. A later
    // ordinary candidate with the same writer/shell still uses normal checks.
    if (runtimeEpochGenerationCompatible(db, context, task.generation)) return false;
    throw new Error("Task cannot cross this compatibility boundary");
  }
  db.prepare("UPDATE runtime_tasks SET candidate=?,boundary_digest=? WHERE project_id=? AND context_key=?")
    .run(candidate.digest, boundary.digest, context.projectId, context.contextKey);
  db.prepare("INSERT INTO runtime_migrations(id,project_id,context_key,source,candidate,state,evidence) VALUES(?,?,?,?,?,'qualifying',?)")
    .run(randomUUID(), context.projectId, context.contextKey, source.digest, candidate.digest, JSON.stringify(boundary));
  return true;
}

export function settleRuntimeMigration(db, context, { candidateQualification, candidateReady = false, oldQualificationValid = false, ignoreInvocation = null } = {}) {
  const task = runtimeTask(db, context);
  if (!task?.candidate) return { state: "stable" };
  const verified = verifiedRuntimeQualification(db, { ...context, runtimeDigest: task.candidate });
  if (!verified || payloadHash(verified) !== payloadHash(candidateQualification)) return { state: "blocked", pending: ["candidate_qualification_unproven"] };
  const pending = pendingRuntimeResponsibilities(db, context, { ignoreInvocation });
  if (pending.length || !["passed", "failed"].includes(candidateQualification?.state)) return { state: "blocked", pending };
  // A failed proof is never converted into success. A candidate whose failed
  // no-op is still missing Stop/outcome remains blocked by the original gate.
  const successful = candidateQualification.state === "passed";
  if (successful && !candidateReady) return { state: "blocked", pending: ["candidate_qualification_not_current"] };
  if (!successful && (!oldQualificationValid || verifiedRuntimeQualification(db, { ...context, runtimeDigest: task.generation })?.state !== "passed")) return { state: "blocked", pending: ["old_qualification_invalid"] };
  db.prepare("UPDATE runtime_migrations SET state=?,evidence=json_set(evidence,'$.qualificationRoute',?) WHERE project_id=? AND context_key=? AND state='qualifying'")
    .run(successful ? "passed" : "failed", candidateQualification.routeId, context.projectId, context.contextKey);
  db.prepare("UPDATE runtime_tasks SET generation=?,candidate=NULL WHERE project_id=? AND context_key=?")
    .run(successful ? task.candidate : task.generation, context.projectId, context.contextKey);
  return { state: successful ? "migrated" : "restored", generation: successful ? task.candidate : task.generation };
}

export function runtimeReferences(db, digest) {
  const references = [];
  if (hasHostEpochSchema(db)) {
    if (db.prepare("SELECT 1 FROM runtime_epoch_origins WHERE generation=?").get(digest)) references.push("epoch_origin");
    if (db.prepare("SELECT 1 FROM runtime_epoch_receipts WHERE source=? OR candidate=?").get(digest, digest)) references.push("epoch_continuation");
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_epoch_ordinary_defaults'").get()) {
      if (db.prepare("SELECT 1 FROM runtime_epoch_ordinary_defaults WHERE generation=?").get(digest)) references.push("epoch_ordinary_default");
      if (db.prepare("SELECT 1 FROM runtime_epoch_ordinary_publications WHERE source=? OR candidate=?").get(digest, digest)) references.push("epoch_ordinary_publication");
    }
  }
  const defaults = publishedDefault(db);
  if (defaults?.current_digest === digest) references.push("default");
  if (defaults?.rollback_digest === digest) references.push("rollback");
  if (db.prepare("SELECT 1 FROM runtime_tasks WHERE generation=? OR candidate=?").get(digest, digest)) references.push("task");
  if (db.prepare("SELECT 1 FROM runtime_invocations WHERE generation=? AND state!='completed'").get(digest)) references.push("in_flight_or_unknown_call");
  if (db.prepare("SELECT 1 FROM runtime_host_entries WHERE generation=? AND state='referenced'").get(digest)) references.push("host_entry");
  // Stage references include settled children: historical followups/messages
  // remain addressable. Explicit native retirement is a separate boundary.
  const stages = db.prepare("SELECT DISTINCT project_id,context_key FROM runtime_stages WHERE generation=?").all(digest);
  if (stages.some((stage) => pendingRuntimeResponsibilities(db, { projectId: stage.project_id, contextKey: stage.context_key }).length)) references.push("active_stage");
  if (db.prepare("SELECT 1 FROM runtime_call_receipts WHERE generation=? AND state='pending'").get(digest)) references.push("pending_native_call");
  return references;
}

export function archiveRuntime(db, digest, dataRoot) {
  const references = runtimeReferences(db, digest);
  if (references.length) throw new Error(`Runtime is referenced: ${references.join(", ")}`);
  const record = runtimeGeneration(db, digest);
  if (record.state === "archived") return { archived: true, idempotent: true };
  verifyRuntimePackage(record);
  const destination = managedRuntimeDestination(dataRoot, "archive", digest);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (record.root !== destination) renameSync(record.root, destination);
  db.prepare("UPDATE runtime_generations SET record=?,state='archived' WHERE digest=?")
    .run(JSON.stringify({ ...record, root: destination }), digest);
  return { archived: true, digest };
}

export function restoreRuntime(db, digest, dataRoot) {
  const record = runtimeGeneration(db, digest);
  if (record.state === "published") return record;
  verifyRuntimePackage(record);
  const destination = managedRuntimeDestination(dataRoot, "published", digest);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (record.root !== destination) renameSync(record.root, destination);
  db.prepare("UPDATE runtime_generations SET record=?,state='published' WHERE digest=?").run(JSON.stringify({ ...record, root: destination }), digest);
  return runtimeGeneration(db, digest);
}

export function runtimeReceiptDigest(name, args) { return payloadHash({ name, args }); }
