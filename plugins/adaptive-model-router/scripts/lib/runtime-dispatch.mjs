import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { databasePath } from "./context.mjs";
import { RouterStore } from "./database.mjs";
import { readThreadSpawnIdentity, readNativeRootBirth } from "./subagent-session.mjs";
import { parseCarrierTaskName } from "./delegation-gate.mjs";
import { targetedChild } from "./stage-closure.mjs";
import { payloadHash } from "./io.mjs";
import { requestError } from "./request-errors.mjs";
import { inspectRuntimeBoundary } from "./runtime-boundary.mjs";
import {
  acquireRuntimeInvocation, beginRuntimeMigration, ensureRuntimeTask, finishRuntimeInvocation,
  runtimeGeneration, runtimeTask, runtimeReceiptDigest, restoreRuntime,
} from "./runtime-isolation.mjs";
import { inspectRuntimePackage, verifyRuntimePackage } from "./runtime-package.mjs";
import { observeRootOperationCoverage, inspectRootOperationCoverage } from "./runtime-root-operations.mjs";
import { observeEpochNativeEntry } from "./runtime-epoch.mjs";

function verifyStableShell(db, shellRoot) {
  if (!shellRoot) return; // Internal offline adapters do not impersonate a host entry.
  const entry = db.prepare("SELECT generation FROM runtime_host_entries WHERE path=? AND state='referenced'").get(realpathSync(shellRoot));
  if (!entry || inspectRuntimePackage(shellRoot).digest !== entry.generation) throw requestError("RUNTIME_COMPATIBILITY", "Stable host shell is not enrolled or its contents changed.");
  return entry.generation;
}

const carrierRoute = (db, context, taskName) => {
  const carrier = parseCarrierTaskName(taskName);
  if (!carrier.valid) return null;
  const digest = createHash("sha256").update(carrier.ticket).digest("hex");
  return db.prepare("SELECT route_id FROM delegation_attempts WHERE project_id=? AND context_key=? AND ticket_hash=?")
    .get(context.projectId, context.contextKey, digest)?.route_id
    || targetedChild(db, context, taskName)?.route_id || null;
};

function restoreStage(store, stageId) {
  if (!stageId) return;
  const db = store.db;
  const stage = db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(stageId);
  // Caller identity env can be partial or conflicting. Package persistence is
  // derived from the actual open SQLite database, never from a second env.
  if (stage && runtimeGeneration(db, stage.generation).state === "archived") restoreRuntime(db, stage.generation, dirname(store.path));
}

export function beginHookDispatch(input, { env = process.env, shellRoot = null } = {}) {
  if (!input || typeof input.session_id !== "string" || !input.session_id.trim()) throw new Error("Trusted native Hook identity is missing");
  const spawn = input.agent_id || input.agent_type ? readThreadSpawnIdentity(input, {
    pathField: input.hook_event_name === "SubagentStop" && input.agent_transcript_path ? "agent_transcript_path" : "transcript_path",
  }) : null;
  if ((input.agent_id || input.agent_type) && !spawn) throw new Error("Trusted native child-parent identity is missing");
  // Native non-Router children keep the original Hook bypass. Do this before
  // opening state: no parent binding, stage, invocation or quota is borrowed.
  if (spawn && !parseCarrierTaskName(spawn.taskName).marked) return { unmanaged: true };
  if (!existsSync(databasePath())) throw new Error("Stable runtime is not enrolled; no database was created");
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId: spawn?.parentContextId || input.session_id, authoritative: true });
    // Native scans run before BEGIN IMMEDIATE. One shared deadline bounds both
    // whole-file proof and the first prospective Hook coverage prefix. Under
    // the write lock only file identity, task/default and receipt state recheck.
    const deadline = Date.now() + 250;
    const previous = runtimeTask(store.db, context);
    const rootBirth = !spawn && !previous ? readNativeRootBirth(input) : null;
    const boundary = !spawn ? inspectRuntimeBoundary(input, previous?.turn_id, { db: store.db, context, deadline }) : null;
    const coverage = !spawn ? inspectRootOperationCoverage(store.db, context, input, { deadline }) : null;
    return store.transaction(() => {
      const shellDigest = verifyStableShell(store.db, shellRoot);
      let task = ensureRuntimeTask(store.db, context, { trustedHook: !spawn, turnId: input.turn_id || null, rootBirth });
      let stageId = spawn ? carrierRoute(store.db, context, spawn.taskName) : null;
      if (spawn && !stageId) throw new Error("Child must inherit its trusted parent's existing stage ticket");
      const target = input.tool_input?.target;
      if (target) {
        const child = targetedChild(store.db, context, target);
        if (child) stageId = child.route_id;
        // Cross-root guesses never select a version. Existing lifecycle guards
        // decide whether this native sender is allowed to address that child.
      }
      stageId ||= carrierRoute(store.db, context, input.tool_input?.task_name);
      if (!spawn && !stageId) {
        beginRuntimeMigration(store.db, context, boundary);
        observeRootOperationCoverage(store.db, context, input, coverage);
        if (input.turn_id && ["UserPromptSubmit", "PreToolUse"].includes(input.hook_event_name)) {
          store.db.prepare("UPDATE runtime_tasks SET turn_id=? WHERE project_id=? AND context_key=?")
            .run(input.turn_id, context.projectId, context.contextKey);
        }
      }
      task = runtimeTask(store.db, context);
      restoreStage(store, stageId);
      const admitted = acquireRuntimeInvocation(store.db, context, { kind: `hook:${input.hook_event_name}`, stageId });
      // Only this reviewed dispatcher can add exact input/shell/lease evidence.
      // Frozen A dispatchers keep their original bytes and cannot self-attest.
      observeEpochNativeEntry(store, context, input, { invocation: admitted.invocation, shellRoot, stageId });
      // Native Pre is the authority on hosts that do not give MCP a trusted
      // per-task environment. contextId is an address, never caller authority.
      const name = /(?:adaptive[-_]model[-_]router)(?:__|_|\/)([a-z_]+)$/u.exec(input.tool_name || "")?.[1];
      if (!spawn && name && input.tool_use_id && input.hook_event_name === "PreToolUse") {
        if (input.tool_input?.contextId !== input.session_id) throw new Error("Router tool context differs from native caller");
        store.db.prepare("INSERT OR IGNORE INTO runtime_call_receipts(id,project_id,context_key,payload_digest,generation,state) VALUES(?,?,?,?,?,'pending')")
          .run(payloadHash([input.session_id, input.turn_id, input.tool_use_id]), context.projectId, context.contextKey,
            runtimeReceiptDigest(name, input.tool_input), admitted.invocation.generation);
      }
      if (!spawn && name && input.tool_use_id && input.hook_event_name === "PostToolUse"
        && input.tool_response?.error?.code === -32601) {
        store.db.prepare("UPDATE runtime_call_receipts SET state='rejected' WHERE id=? AND state='pending'")
          .run(payloadHash([input.session_id, input.turn_id, input.tool_use_id]));
      }
      return { ...admitted, context, shellDigest,
        stageOwnerDigest: stageId ? store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(stageId)?.generation : null,
        receiptKey: input.tool_use_id ? payloadHash([input.session_id, input.turn_id, input.tool_use_id]) : null,
        migration: Boolean(task.candidate) };
    });
  } finally { store.close(); }
}

// Only the stable MCP shell's local name/schema validation catch calls this.
// Invalid args must never reach stage restoration, migration or service code.
// A unique native Pre proves the rejected call; contextId or task env alone
// cannot settle a receipt, and two equal payloads remain ambiguous.
export function rejectMcpValidationReceipt(name, args, { env = process.env, cwd = process.cwd(), shellRoot = null } = {}) {
  if (!shellRoot || typeof name !== "string" || !/^[a-z_]+$/u.test(name)
    || !args || typeof args !== "object" || Array.isArray(args)
    || typeof args.contextId !== "string" || !args.contextId.trim()
    || !existsSync(databasePath())) return null;
  // A validation error is not business admission. In particular, RouterStore's
  // constructor migrates schema and reconciles legacy attempts across tasks.
  // Open only the existing schema and reuse its non-creating context hashing
  // and transaction primitive; no enrollment, salt creation or reconciliation.
  const db = new DatabaseSync(databasePath());
  let rejected;
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
    const salt = db.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
    if (!salt) return null;
    const binding = { db, salt, identityCache: new Map(), runtimeContext: context => context };
    const context = RouterStore.prototype.context.call(binding, { cwd, contextId: args.contextId, create: false });
    rejected = RouterStore.prototype.transaction.call(binding, () => {
      const shellDigest = verifyStableShell(db, shellRoot);
      if (!runtimeTask(db, context)) return null;
      if (typeof env.CODEX_THREAD_ID === "string" && env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== args.contextId)
        throw requestError("CALLER_BINDING_UNPROVEN", "Validation rejection differs from trusted native task environment.");
      const digest = runtimeReceiptDigest(name, args);
      // Count before generation checks: a second matching old-generation Pre
      // is still ambiguous even if only one generation is currently available.
      const receipts = db.prepare("SELECT * FROM runtime_call_receipts WHERE project_id=? AND context_key=? AND payload_digest=? AND state='pending' LIMIT 2")
        .all(context.projectId, context.contextKey, digest);
      if (!receipts.length) return null;
      if (receipts.length !== 1) throw requestError("CALLER_BINDING_UNPROVEN", "Validation rejection has multiple matching native receipts.");
      const receipt = receipts[0];
      const generation = db.prepare("SELECT record FROM runtime_generations WHERE digest=?").get(receipt.generation);
      if (!generation) throw requestError("RUNTIME_COMPATIBILITY", "Validation receipt runtime is unavailable.");
      const record = JSON.parse(generation.record);
      if (record.digest !== receipt.generation) throw requestError("RUNTIME_COMPATIBILITY", "Validation receipt runtime identity differs.");
      verifyRuntimePackage(record); // No archive restore or generation rewrite.
      const changed = db.prepare("UPDATE runtime_call_receipts SET state='rejected' WHERE id=? AND project_id=? AND context_key=? AND payload_digest=? AND generation=? AND state='pending'")
        .run(receipt.id, context.projectId, context.contextKey, digest, receipt.generation);
      if (changed.changes !== 1) throw requestError("CALLER_BINDING_UNPROVEN", "Validation receipt changed before settlement.");
      return { context, receiptKey: receipt.id, shellDigest };
    });
    return rejected;
  } finally {
    try {
      try { if (db.isTransaction) db.exec("ROLLBACK"); }
      finally { db.close(); }
    }
    catch (error) {
      // A close failure after COMMIT must not masquerade as a rollback, hide
      // the settled identity, or make the caller retry against another Pre.
      if (rejected) rejected.cleanupError = error;
      else throw error;
    }
  }
}

export function beginMcpDispatch(name, args, { env = process.env, cwd = process.cwd(), shellRoot = null } = {}) {
  if (!existsSync(databasePath())) throw new Error("Stable runtime is not enrolled; no database was created");
  const store = new RouterStore();
  try {
    const context = store.context({ cwd, contextId: args.contextId, create: false });
    return store.transaction(() => {
      const shellDigest = verifyStableShell(store.db, shellRoot);
      ensureRuntimeTask(store.db, context);
      let generation = null;
      const receipt = store.db.prepare("SELECT * FROM runtime_call_receipts WHERE project_id=? AND context_key=? AND payload_digest=? AND state='pending' ORDER BY rowid LIMIT 1")
        .get(context.projectId, context.contextKey, runtimeReceiptDigest(name, args));
      if (typeof env.CODEX_THREAD_ID === "string" && env.CODEX_THREAD_ID) {
        if (env.CODEX_THREAD_ID !== args.contextId) throw requestError("CALLER_BINDING_UNPROVEN", "MCP context differs from trusted native task environment.");
      } else {
        if (!receipt) throw requestError("CALLER_BINDING_UNPROVEN", "Native MCP caller binding is unproven: require trusted task environment or matching PreToolUse receipt.");
      }
      if (receipt) {
        store.db.prepare("UPDATE runtime_call_receipts SET state='consumed' WHERE id=?").run(receipt.id);
        generation = receipt.generation;
      }
      const stageId = args.routeId && ["record_outcome", "manage_stage"].includes(name) ? args.routeId : null;
      restoreStage(store, stageId);
      return { ...acquireRuntimeInvocation(store.db, context, { kind: `mcp:${name}`, stageId, generation }), context,
        shellDigest, receiptKey: receipt?.id,
        stageOwnerDigest: stageId ? store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(stageId)?.generation : null };
    });
  } finally { store.close(); }
}

export function endRuntimeDispatch(dispatch, completed = true) {
  if (!dispatch || dispatch.unmanaged) return;
  const store = new RouterStore();
  try { store.transaction(() => finishRuntimeInvocation(store.db, dispatch.invocation, { completed })); }
  finally { store.close(); }
}
