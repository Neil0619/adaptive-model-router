import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { databasePath, opaqueId } from "./context.mjs";
import { REASON_CODES } from "./constants.mjs";
import { errorObservation } from "./request-errors.mjs";
import { isSqliteBusy, sleepSync } from "./io.mjs";

export const OBSERVATION_RETENTION = Object.freeze({ days: 7, maxEvents: 100_000, maxContextEvents: 10_000 });
const TOOLS = new Set(["get_model_policy", "preview_model_policy", "activate_model_policy", "rollback_model_policy", "route_stage", "record_outcome", "manage_stage", "get_route_status", "get_route_history", "set_route_override", "list_policy_proposals", "approve_policy_proposal", "reject_policy_proposal", "rollback_policy", "rebase_policy_proposal", "get_learning_status", "reanchor_scoring_profile", "shadow_route_stage", "configure_router", "resolve_host_model_intent", "diagnose_router", "clear_project_data"]);
const HOOKS = new Set(["SessionStart", "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]);
const HEX = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const oneOf = (value, values, fallback = null) => values.includes(value) ? value : fallback;
const digest = (value) => typeof value === "string" && HEX.test(value) ? value : null;
const uuid = (value) => typeof value === "string" && UUID.test(value) ? value : null;
export const observationPath = (mainPath = databasePath()) => join(dirname(mainPath), "observations.sqlite3");
export const observationGapPath = (mainPath = databasePath()) => join(dirname(mainPath), "observations-gap.json");

function closedEvent(input, now) {
  return {
    schemaVersion: 1, eventId: uuid(input.eventId) || randomUUID(), callId: uuid(input.callId),
    observedAt: new Date(now).toISOString(),
    component: oneOf(input.component, ["mcp", "service", "hook", "launcher", "bridge", "retention"], "service"),
    transport: oneOf(input.transport, ["mcp", "stdio-bridge", "direct", "native-hook"], "direct"),
    event: oneOf(input.event, ["received", "finished", "detail", "pruned", "truncated"], "detail"),
    operation: oneOf(input.operation, ["succeeded", "rejected", "failed", "busy", "degraded", "unknown"], "unknown"),
    lifecycle: oneOf(input.lifecycle, ["active", "completed", "unknown"], "unknown"),
    tool: TOOLS.has(input.tool) ? input.tool : null, hookEvent: HOOKS.has(input.hookEvent) ? input.hookEvent : null,
    projectKey: digest(input.projectKey), contextKey: digest(input.contextKey),
    turnKey: digest(input.turnKey), nativeCallKey: digest(input.nativeCallKey),
    routeId: uuid(input.routeId), invocationId: uuid(input.invocationId), receiptKey: digest(input.receiptKey),
    runtimeDigest: digest(input.runtimeDigest), shellRuntimeDigest: digest(input.shellRuntimeDigest),
    runtimeState: oneOf(input.runtimeState, ["selected", "entered", "unknown"], "unknown"),
    stageOwnerRuntimeDigest: digest(input.stageOwnerRuntimeDigest),
    runtimeVersion: typeof input.runtimeVersion === "string" && /^\d+\.\d+\.\d+(?:[+.-][A-Za-z0-9.-]{1,96})?$/u.test(input.runtimeVersion) ? input.runtimeVersion : null,
    identitySource: oneOf(input.identitySource, ["native_dispatch", "native_hook", "declared_context", "unavailable"], "unavailable"),
    taskOrigin: oneOf(input.taskOrigin, ["interactive_root", "background_suggestion", "bounded_child", "unknown"], "unknown"),
    executionOrigin: oneOf(input.executionOrigin, ["interactive_root", "background_suggestion", "bounded_child", "unknown"], "unknown"),
    originSource: oneOf(input.originSource, ["native_metadata", "unavailable"], "unavailable"),
    errorCode: input.error ? errorObservation(input.error).errorCode : null,
    errorCategory: input.error ? errorObservation(input.error).errorCategory : null,
    durationMs: Number.isSafeInteger(input.durationMs) ? Math.max(0, Math.min(input.durationMs, 86_400_000)) : null,
    routeAction: oneOf(input.routeAction, ["delegate", "continue", "ask_user", "busy"]),
    reasonCodes: Array.isArray(input.reasonCodes) ? [...new Set(input.reasonCodes.filter((code) => REASON_CODES.includes(code)))].slice(0, 8) : [],
    count: Number.isSafeInteger(input.count) && input.count >= 0 ? input.count : null,
    evidenceKind: oneOf(input.evidenceKind, ["finalized_attempt", "completed_invocation", "settled_receipt", "hook_task_receipt", "lifecycle_diagnostic"]),
  };
}

// Stored observations are still data, not trusted executable schema. Reuse the
// writer's closed projection, reject damaged values and never echo unknown data.
export function parseStoredObservation(payload) {
  try {
    const value = JSON.parse(payload);
    if (!value || value.schemaVersion !== 1 || !uuid(value.eventId) || !Number.isFinite(Date.parse(value.observedAt))) return null;
    const normalized = closedEvent({ ...value, error: value.errorCode ? { code: value.errorCode } : null }, Date.parse(value.observedAt));
    if (Object.keys(value).some((key) => !Object.hasOwn(normalized, key)
      || JSON.stringify(value[key]) !== JSON.stringify(normalized[key]))) return null;
    return normalized;
  } catch { return null; }
}

function openWriter(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    try { chmodSync(path, 0o600); } catch { /* Windows uses inherited ACLs. */ }
    db.exec("PRAGMA busy_timeout=150; PRAGMA trusted_schema=OFF;");
    // Like the main store, first-time WAL enrollment needs an explicit bounded
    // retry: SQLite's busy timeout does not serialize concurrent PRAGMA calls.
    const deadline = Date.now() + 150;
    while (true) {
      try { db.exec("PRAGMA journal_mode=WAL"); break; }
      catch (error) {
        if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
        sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      observed_at TEXT NOT NULL, call_id TEXT, project_key TEXT, context_key TEXT,
      component TEXT NOT NULL, event TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_time ON events(observed_at,seq);
    CREATE INDEX IF NOT EXISTS events_context ON events(project_key,context_key,seq);
    CREATE INDEX IF NOT EXISTS events_call ON events(call_id,seq);
    CREATE TABLE IF NOT EXISTS coverage (
      id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL,
      pruned_age INTEGER NOT NULL DEFAULT 0, pruned_capacity INTEGER NOT NULL DEFAULT 0,
      pruned_through TEXT, last_written_at TEXT NOT NULL
    );`);
    return db;
  } catch (error) { db.close(); throw error; }
}

// Independent best-effort journal. A failed observation must not grant/deny an
// operation or change a Hook's stdout/exit policy. Failure leaves a durable gap
// marker when possible, and always a fixed, non-sensitive stderr diagnostic.
export function appendObservation(input, { mainPath = databasePath(), now = Date.now(), retention = OBSERVATION_RETENTION, stderr = process.stderr, requireExistingMain = false } = {}) {
  // A Hook must preserve the original no-enrollment bypass for ordinary native
  // children and uninitialized roots. Its fixed stderr diagnostic still works.
  if (requireExistingMain && !existsSync(mainPath)) return false;
  let db;
  try {
    const value = closedEvent(input, now);
    db = openWriter(observationPath(mainPath));
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT OR IGNORE INTO coverage(id,started_at,last_written_at) VALUES(1,?,?)").run(value.observedAt, value.observedAt);
    db.prepare("INSERT INTO events(event_id,observed_at,call_id,project_key,context_key,component,event,operation,payload_json) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(value.eventId, value.observedAt, value.callId, value.projectKey, value.contextKey, value.component, value.event, value.operation, JSON.stringify(value));
    const cutoff = new Date(now - retention.days * 86_400_000).toISOString();
    const age = db.prepare("SELECT count(*) AS n,max(observed_at) AS through FROM events WHERE observed_at<?").get(cutoff);
    db.prepare("DELETE FROM events WHERE observed_at<?").run(cutoff);
    let capacity = 0, through = age.through;
    const trim = (where, params) => {
      const rows = db.prepare(`SELECT count(*) AS n,max(observed_at) AS through FROM events WHERE ${where}`).get(...params);
      if (rows.n) { db.prepare(`DELETE FROM events WHERE ${where}`).run(...params); capacity += rows.n; if (!through || rows.through > through) through = rows.through; }
    };
    if (value.contextKey && db.prepare("SELECT count(*) AS n FROM events WHERE project_key=? AND context_key=?").get(value.projectKey, value.contextKey).n > retention.maxContextEvents)
      trim("project_key=? AND context_key=? AND seq NOT IN (SELECT seq FROM events WHERE project_key=? AND context_key=? ORDER BY seq DESC LIMIT ?)", [value.projectKey, value.contextKey, value.projectKey, value.contextKey, retention.maxContextEvents]);
    if (db.prepare("SELECT count(*) AS n FROM events").get().n > retention.maxEvents)
      trim("seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)", [retention.maxEvents]);
    db.prepare("UPDATE coverage SET pruned_age=pruned_age+?,pruned_capacity=pruned_capacity+?,pruned_through=CASE WHEN ? IS NULL THEN pruned_through ELSE max(coalesce(pruned_through,''),?) END,last_written_at=? WHERE id=1")
      .run(age.n, capacity, through, through, value.observedAt);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try { if (db?.isTransaction) db.exec("ROLLBACK"); } catch {}
    try { writeFileSync(observationGapPath(mainPath), JSON.stringify({ schemaVersion: 1, state: "incomplete", lastDropAt: new Date(now).toISOString(), droppedCount: "at_least_one", ...errorObservation(error) }), { mode: 0o600 }); } catch {}
    try { stderr.write("Adaptive Model Router observation unavailable; evidence coverage is incomplete.\n"); } catch {}
    return false;
  } finally { try { db?.close(); } catch {} }
}

export function observationIdentity({ store, contextId, context, cwd, input, mainPath = store?.path || databasePath(), trusted = false } = {}) {
  let db;
  try {
    // Read-only, no salt creation or RouterStore migration on an invalid call.
    db = store?.db || (existsSync(mainPath) ? new DatabaseSync(mainPath, { readOnly: true }) : null);
    const salt = store?.salt || db?.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
    if (!salt) return {};
    let bound = context;
    if (!bound && store && contextId) bound = store.context({ cwd, contextId, create: false });
    if (!bound && contextId) {
      const rows = db.prepare("SELECT project_id,context_key FROM host_model_state").all();
      const row = rows.find((r) => opaqueId(salt, "context", `${r.project_id}\0${contextId.normalize("NFC")}`) === r.context_key);
      if (row) bound = { projectId: row.project_id, contextKey: row.context_key };
    }
    if (!bound) return {};
    return { projectKey: bound.projectId, contextKey: bound.contextKey,
      identitySource: trusted ? input ? "native_hook" : "native_dispatch" : "declared_context",
      turnKey: typeof input?.turn_id === "string" ? opaqueId(salt, "observation-turn", input.turn_id) : null,
      nativeCallKey: typeof input?.tool_use_id === "string" ? opaqueId(salt, "observation-call", input.tool_use_id) : null };
  } catch { return {}; }
  finally { if (db && db !== store?.db) try { db.close(); } catch {} }
}

export function beginObservation(fields = {}, options = {}) {
  const started = Date.now(), callId = uuid(fields.callId) || randomUUID();
  let binding = { ...fields, callId }, finished = false;
  const emit = (extra) => appendObservation({ ...binding, ...extra, callId }, options);
  emit({ event: "received", lifecycle: "active" });
  return {
    callId,
    bind(value) { binding = { ...binding, ...value }; },
    detail(value) { emit({ event: "detail", ...value }); },
    finish({ result, error, operation, ...extra } = {}) {
      if (finished) return;
      finished = true;
      const category = error ? errorObservation(error).errorCategory : null;
      emit({ event: "finished", lifecycle: "completed", durationMs: Date.now() - started,
        routeId: result?.routeId, routeAction: result?.action, reasonCodes: result?.reasonCodes,
        operation: operation || (error ? ["input_validation", "retry_contract", "lifecycle_precondition", "caller_binding", "runtime_compatibility"].includes(category) ? "rejected" : "failed"
          : result?.action === "busy" ? "busy" : result?.action === "continue" && result?.reasonCodes?.some((c) => /UNAVAILABLE|UNPROVEN|REQUIRED|MISMATCH|PENDING|LIMIT|DISK/u.test(c)) ? "degraded" : "succeeded"),
        error, ...extra });
    },
  };
}

export function activeInvocationObservation({ invocationId = process.env.ADAPTIVE_ROUTER_INVOCATION_ID, input, mainPath = databasePath() } = {}) {
  let db;
  try {
    if (!uuid(invocationId) || !existsSync(mainPath)) return {};
    db = new DatabaseSync(mainPath, { readOnly: true });
    const r = db.prepare("SELECT * FROM runtime_invocations WHERE id=? AND state='active'").get(invocationId);
    if (!r || !r.kind.startsWith("hook:") || r.kind !== `hook:${input?.hook_event_name}`) return {};
    const salt = db.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
    if (typeof input?.session_id !== "string" || !salt
      || opaqueId(salt, "context", `${r.project_id}\0${input.session_id.normalize("NFC")}`) !== r.context_key) return {};
    const generation = JSON.parse(db.prepare("SELECT record FROM runtime_generations WHERE digest=?").get(r.generation)?.record);
    return { ...observationIdentity({ context: { projectId: r.project_id, contextKey: r.context_key }, input, mainPath, trusted: true }),
      invocationId, runtimeDigest: r.generation, runtimeVersion: generation.descriptor.runtimeVersion, runtimeState: "entered" };
  } catch { return {}; }
  finally { db?.close(); }
}

export function clearProjectObservations(projectId, mainPath = databasePath()) {
  const path = observationPath(mainPath);
  if (!existsSync(path)) return { cleared: true };
  let db;
  try { db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout=150"); db.prepare("DELETE FROM events WHERE project_key=?").run(projectId); return { cleared: true }; }
  catch { return { cleared: false, reason: "observation_store_unavailable" }; }
  finally { db?.close(); }
}
