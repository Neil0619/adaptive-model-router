import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppServerClient } from "./app-server.mjs";
import { canonicalJson, payloadHash } from "./io.mjs";
import { readTaskQualification, taskQualificationKey, runtimeSourceDigest } from "./lifecycle-qualification.mjs";
import { qualificationTargetMatches } from "./qualification-policy.mjs";
import { stageClosureStatus } from "./stage-closure.mjs";
import { readStableRollout, rolloutIdentity } from "./native-rollout-reader.mjs";
import { recoveryRecord, recoveryRecordIntact } from "./native-recovery-receipt.mjs";
import { openPrivateState } from "./private-state.mjs";

const SCHEMA = "historical-qualification-recovery/1", PREFIX = "historical_qualification_recovery:";
const COMPLETED = "completed_failed_qualification_no_work", INTERRUPTED = "consumed_interrupted_qualification_no_work";
const AUDITS = new WeakMap();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const present = (value) => typeof value === "string" && value.length > 0;
const denied = () => ({ status: "unresolved", ordinaryDelegationEnabled: false, gateReleased: false });
const check = (value) => { if (!value) throw new Error("historical qualification evidence is unproven"); };

function retainedState(db, context, routeId, cwd) {
  const q = readTaskQualification(db, context);
  const route = db.prepare("SELECT * FROM routes WHERE route_id=? AND project_id=? AND context_key=?").get(routeId, context.projectId, context.contextKey);
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=? AND project_id=? AND context_key=?").get(routeId, context.projectId, context.contextKey);
  const outcome = db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(routeId) || null;
  check(q?.schema === 1 && q.routeId === routeId && route?.action === "delegate"
    && route.reason_codes_json === '["HOST_LIFECYCLE_QUALIFICATION"]' && route.verification_gate === "structured-check"
    && qualificationTargetMatches(db, q, route) && (!cwd || q.binding.taskCwdDigest === payloadHash(realpathSync(cwd)))
    && digest(q.ticketHash) && attempt?.model === route.model && attempt.effort === route.effort
    && attempt.ticket_consumed === 1 && attempt.post_observed === 1 && attempt.no_child === 0
    && present(attempt.root_turn_id) && present(attempt.tool_use_id) && digest(attempt.dispatch_input_digest));
  const ledger = {};
  for (const table of ["delegation_children", "delegation_messages", "delegation_child_stops", "delegation_child_commands", "delegation_stage_journal", "delegation_maintenance"])
    ledger[table] = db.prepare(`SELECT * FROM ${table} WHERE route_id=? ORDER BY rowid`).all(routeId);
  const children = ledger.delegation_children;
  check(children.length <= 1 && !ledger.delegation_maintenance.some((m) => m.state === "active"));
  if (children.length) {
    const child = children[0], locator = JSON.parse(openPrivateState(db, child.locator));
    // Managed ledgers hash canonical JSON; legacy attempt identities hash the
    // normalized native string. Correlate both to the encrypted native locator.
    check(child.state === "settled" && child.project_id === context.projectId && child.context_key === context.contextKey
      && present(locator.childId) && child.agent_hash === payloadHash(locator.childId)
      && attempt.agent_id === sha(locator.childId.normalize("NFC")) && child.task_hash === payloadHash(locator.taskName));
  } else check(Object.values(ledger).every((rows) => rows.length === 0));
  return { qualification: q, route, attempt, outcome, ledger };
}

function verifyManagedClosure(db, context, state) {
  const child = state.ledger.delegation_children[0];
  if (!child) return;
  const maintenance = state.ledger.delegation_maintenance[0];
  const closure = stageClosureStatus(db, context, state.route.route_id, { deadline: Date.now() + 15_000, auditSettled: true });
  check(closure?.state === "ready" && ((child.revision === child.verified_revision && child.verified_digest === closure.token)
    || (maintenance?.state === "verified" && maintenance.verified_token === closure.token)));
}

function originalKind(state) {
  const { qualification: q, attempt: a, outcome: o } = state;
  const hooks = Object.keys(q.hooks).sort().join(",");
  check(Object.values(q.hooks).every((h) => h.runtimeDigest === q.binding.runtimeDigest && q.binding.shellRoots.includes(h.shellRoot)));
  if (q.state === "failed" && q.proof === null && q.failure === undefined && hooks === "post,pre,start,stop"
    && a.finalized_at && a.ambiguous === 0 && digest(a.agent_id) && (!a.early_agent_id || a.early_agent_id === a.agent_id)
    && a.stop_observed === 1 && a.outcome_recorded === 1 && a.outcome_status === "failed"
    && a.ticket_hash === null && a.context_package === null && Number.isSafeInteger(a.transcript_bytes) && a.transcript_bytes > 0
    && o?.status === "failed" && o.failure_type === "environment" && o.gate === "structured-check") {
    const normalized = { status: o.status, gate: o.gate, failureType: o.failure_type, retries: o.retries,
      retryBreakdown: { reasoning: o.retry_reasoning, environment: o.retry_environment, information: o.retry_information, tooling: o.retry_tooling },
      escalations: o.escalations, userCorrection: o.user_correction === 1 };
    check(payloadHash(normalized) === o.payload_hash); return COMPLETED;
  }
  if (q.state === "pending" && q.proof === undefined && hooks === "post,pre"
    && !a.finalized_at && a.ambiguous === 0 && a.agent_id === null && a.early_agent_id === null
    && a.stop_observed === 0 && a.outcome_recorded === 0 && a.outcome_status === null
    && a.transcript_bytes === null && a.early_transcript_bytes === null && a.ticket_hash === q.ticketHash
    && present(a.context_package) && o === null && state.ledger.delegation_children.length === 0) return INTERRUPTED;
  check(false);
}

function receiptMatches(receipt, context, routeId, state) {
  return receipt?.schemaVersion === SCHEMA && recoveryRecordIntact(receipt)
    && [COMPLETED, INTERRUPTED].includes(receipt.recoveryKind) && receipt.ordinaryDelegationEnabled === false
    && receipt.subjectDigest === payloadHash([context.projectId, context.contextKey, routeId])
    && receipt.qualificationKey === taskQualificationKey(context)
    && receipt.qualificationDigest === payloadHash(state.qualification) && receipt.routeDigest === payloadHash(state.route)
    && receipt.retainedOutcomeDigest === payloadHash(state.outcome) && receipt.afterStateDigest === payloadHash(state)
    && digest(receipt.evidenceDigest) && digest(receipt.nativeEvidence?.childSource?.transcriptDigest)
    && digest(receipt.nativeEvidence?.parentOperationsDigest) && state.attempt.finalized_at;
}

// DB-only predicate for admission's short transaction. The explicit operator
// path below re-audits complete native evidence before issuing retry authority.
export function historicalQualificationRecoveryBasis(db, context, qualification) {
  try {
    const state = retainedState(db, context, qualification.routeId);
    const receipt = JSON.parse(db.prepare("SELECT value FROM meta WHERE key=?").get(PREFIX + qualification.routeId)?.value);
    return payloadHash(qualification) === payloadHash(state.qualification) && receiptMatches(receipt, context, qualification.routeId, state)
      ? payloadHash({ receipt, state }) : null;
  } catch { return null; }
}

// Only a result produced by the full native verifier below owns this proof.
// Callers cannot supply source paths or manufacture a JSON "verified" flag.
export function historicalQualificationAuditCurrent(store, result, context = null) {
  try {
    const audit = AUDITS.get(result);
    if (!audit || audit.store !== store || !audit.basis
      || (context && ["projectId", "contextKey", "runtimeDigest"].some((field) => (context[field] || null) !== (audit.context[field] || null)))
      || !audit.sources.every(([path, identity]) => rolloutIdentity(path) === identity)) return false;
    return historicalQualificationRecoveryBasis(store.db, audit.context,
      readTaskQualification(store.db, audit.context)) === audit.basis;
  } catch { return false; }
}

// Exact native roots only. An operator may name the task, never supply its
// replacement transcript or a caller-authored "no work" assertion.
function nativePath(path) {
  const root = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  check(typeof path === "string" && realpathSync(path) === resolve(path) && !lstatSync(path).isSymbolicLink());
  check(["sessions", "archived_sessions"].some((folder) => {
    const tail = relative(join(root, folder), path);
    return tail && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
  }));
  return path;
}

function launch(parent, input, state, kind, cwd) {
  check(parent?.id === input.contextId && !parent.parentThreadId && realpathSync(parent.cwd) === realpathSync(cwd)
    && Array.isArray(parent.turns) && parent.turns.length > 0 && parent.turns.length <= 10_000);
  const activities = parent.turns.flatMap((turn) => {
    check(present(turn.id) && turn.itemsView === "full" && Array.isArray(turn.items));
    return turn.items.filter((i) => i.type === "subAgentActivity").map((item) => ({ ...item, rootTurnId: turn.id }));
  });
  const matches = activities.filter((item) => /^\/root\/router_[a-f0-9]{32}$/u.test(item.agentPath || "")
    && sha(item.agentPath.slice(13)) === state.qualification.ticketHash);
  const starts = matches.filter((i) => i.kind === "started"); check(starts.length === 1);
  const start = starts[0];
  check(start.id === state.attempt.tool_use_id && start.rootTurnId === state.attempt.root_turn_id && present(start.agentThreadId)
    && activities.filter((i) => i.agentThreadId === start.agentThreadId).length === matches.length);
  const interacted = matches.filter((i) => i.kind === "interacted"), completed = matches.filter((i) => i.kind === "completed");
  check(matches.every((i) => i.agentThreadId === start.agentThreadId && i.agentPath === start.agentPath));
  check(kind === COMPLETED ? matches.length === 3 && interacted.length === 1 && completed.length === 1
    : matches.length === 1);
  return { start, interacted, completed };
}

function auditParent(parent, binding, input, state) {
  const { start, interacted } = binding, expected = new Map([start, ...interacted].map((i) => [i.id, i]));
  const calls = new Map(), outputs = new Set(); let turn = null;
  const path = nativePath(parent.path), identity = rolloutIdentity(path);
  const source = readStableRollout(path, (entry, line) => {
    const p = entry.payload;
    if (line === 1) check(entry.type === "session_meta" && p.id === input.contextId && !p.parent_thread_id && !p.source?.subagent
      && realpathSync(p.cwd) === realpathSync(parent.cwd));
    if (entry.type === "turn_context" || (entry.type === "event_msg" && p?.type === "task_started")) turn = p.turn_id;
    if (entry.type !== "response_item") return;
    if (p.type === "function_call" && (p.namespace === "collaboration" || (!p.namespace
      && ["spawn_agent", "followup_task", "send_message", "interrupt_agent", "list_agents", "wait_agent"].includes(p.name)))) {
      const args = JSON.parse(p.arguments), item = expected.get(p.call_id);
      const addressesChild = [start.agentThreadId, start.agentPath, start.agentPath.slice(6)].includes(args.target)
        || args.task_name === start.agentPath.slice(6);
      if (!item) { check(!addressesChild); return; }
      check(!calls.has(p.call_id) && turn === item.rootTurnId);
      if (item === start) check(p.name === "spawn_agent" && args.task_name === start.agentPath.slice(6)
        && args.model === state.attempt.model && args.reasoning_effort === state.attempt.effort && args.fork_turns === "none"
        && present(args.message) && payloadHash(args) === state.attempt.dispatch_input_digest);
      else check(p.name === "followup_task" && addressesChild && present(args.message)
        && Object.keys(args).every((k) => ["target", "message"].includes(k)));
      calls.set(p.call_id, { ...item, callDigest: payloadHash(p) });
    } else if (["function_call_output", "custom_tool_call_output"].includes(p.type) && expected.has(p.call_id)) {
      check(calls.has(p.call_id) && !outputs.has(p.call_id) && turn === expected.get(p.call_id).rootTurnId);
      if (p.call_id === start.id) {
        const result = typeof p.output === "string" ? JSON.parse(p.output) : p.output;
        check(result && (result.task_name === start.agentPath || result.agent_id === start.agentThreadId)
          && (result.task_name == null || result.task_name === start.agentPath)
          && (result.agent_id == null || result.agent_id === start.agentThreadId));
      }
      outputs.add(p.call_id); calls.get(p.call_id).resultDigest = payloadHash(p);
    }
  }, { deadline: Date.now() + 15_000 });
  check(calls.size === expected.size && outputs.size === expected.size && identity === rolloutIdentity(path));
  return { path, identity, source, operationsDigest: payloadHash([...calls.values()]) };
}

function auditChild(child, binding, input, state, kind, cwd) {
  const { start, completed } = binding, spawn = child?.source?.subAgent?.thread_spawn;
  check(child?.id === start.agentThreadId && child.parentThreadId === input.contextId && child.forkedFromId === null
    && realpathSync(child.cwd) === realpathSync(cwd) && spawn?.parent_thread_id === input.contextId
    && spawn.depth === 1 && spawn.agent_path === start.agentPath && Array.isArray(child.turns));
  const turns = child.turns;
  check(turns.length === (kind === COMPLETED ? 2 : 1));
  check(turns.every((t) => present(t.id) && t.itemsView === "full" && Array.isArray(t.items) && t.items.length <= 128
    && t.items.every((i) => present(i.id)) && new Set(t.items.map((i) => i.id)).size === t.items.length));
  if (kind === COMPLETED) {
    check(sha(child.id) === state.attempt.agent_id && child.model === state.attempt.model && child.reasoningEffort === state.attempt.effort
      && turns[0].status === "failed" && turns[0].error != null && turns[0].items.length === 0
      && turns[1].status === "completed" && turns[1].error == null
      && completed[0].id === `subagent-completed-${turns[1].id}`);
    check(turns[1].items.every((i) => i.type === "reasoning" || (i.type === "agentMessage" && i.phase === "final_answer")));
    const finals = turns[1].items.filter((i) => i.type === "agentMessage" && i.phase === "final_answer");
    check(finals.length === 1 && finals[0] === turns[1].items.at(-1) && finals[0].text === state.qualification.marker);
  } else check(child.model == null && child.reasoningEffort == null && turns[0].status === "interrupted"
    && turns[0].error == null && turns[0].items.length === 0);
  const path = nativePath(child.path), identity = rolloutIdentity(path);
  let turn = null, index = 0, ended = true, finals = 0, nextItem = 0;
  const contexts = new Set(), delivered = new Set(), produced = new Set(), itemEvents = new Set();
  const textParts = (parts, types) => {
    check(Array.isArray(parts) && parts.every((part) => types.includes(part.type) && typeof part.text === "string"));
    return parts.map((part) => part.text);
  };
  const source = readStableRollout(path, (entry, line) => {
    const p = entry.payload;
    check(line <= 1000 && p && typeof p === "object");
    if (line === 1) {
      check(entry.type === "session_meta" && p.id === child.id && p.session_id === input.contextId
        && p.parent_thread_id === input.contextId && p.agent_path === start.agentPath
        && payloadHash(p.source?.subagent?.thread_spawn) === payloadHash(spawn) && realpathSync(p.cwd) === realpathSync(cwd)); return;
    }
    if (entry.type === "event_msg") {
      if (p.type === "task_started") {
        check(ended && index < turns.length && p.turn_id === turns[index].id);
        turn = turns[index++]; ended = false; nextItem = 0; return;
      }
      check(turn && !ended);
      if (["task_complete", "turn_aborted"].includes(p.type)) {
        check(p.turn_id === turn.id && (kind === INTERRUPTED ? p.type === "turn_aborted"
          : p.type === "task_complete" && (turn.status === "failed" ? p.error != null : p.error == null)));
        check(turn.items.every((i) => produced.has(`${turn.id}:${i.id}`)));
        check(turn.status === "completed" ? p.last_agent_message === state.qualification.marker : p.last_agent_message == null);
        ended = true; return;
      }
      if (p.type === "item_completed") {
        check(kind === COMPLETED && p.thread_id === child.id && p.turn_id === turn.id && ["Reasoning", "AgentMessage"].includes(p.item?.type)
          && delivered.has(turn.id) && turn.items[nextItem]?.id === p.item.id
          && turn.items.some((i) => i.id === p.item.id && i.type === (p.item.type === "Reasoning" ? "reasoning" : "agentMessage")));
        const projected = turn.items.find((i) => i.id === p.item.id), key = `${turn.id}:${p.item.id}`;
        check(!itemEvents.has(key)); itemEvents.add(key);
        if (p.item.type === "AgentMessage") check(p.item.phase === projected.phase
          && textParts(p.item.content, ["Text"]).join("") === projected.text);
        else check(payloadHash(p.item.summary_text) === payloadHash(projected.summary)
          && payloadHash(p.item.raw_content) === payloadHash(projected.content));
      } else check(kind === COMPLETED && p.type === "token_count");
      return;
    }
    check(turn && !ended);
    if (entry.type === "turn_context") {
      check(kind === COMPLETED && p.turn_id === turn.id && p.model === state.attempt.model && p.effort === state.attempt.effort
        && !contexts.has(turn.id)); contexts.add(turn.id); return;
    }
    if (["world_state", "inter_agent_communication_metadata", "token_usage_record"].includes(entry.type)) {
      check(kind === COMPLETED);
      if (entry.type === "token_usage_record") check(turn.status === "completed" && p.thread_id === child.id
        && p.turn_id === turn.id && p.session_id === input.contextId);
      return;
    }
    check(entry.type === "response_item");
    if (p.type === "reasoning") {
      const projected = turn.items.find((i) => i.type === "reasoning" && i.id === p.id), key = `${turn.id}:${p.id}`;
      check(kind === COMPLETED && projected && delivered.has(turn.id) && turn.items[nextItem]?.id === p.id && !produced.has(key)
        && payloadHash(textParts(p.summary, ["summary_text", "text"])) === payloadHash(projected.summary)
        && payloadHash(textParts(p.content || [], ["reasoning_text", "text"])) === payloadHash(projected.content));
      produced.add(key); nextItem++; return;
    }
    if (p.type === "agent_message") {
      check(kind === COMPLETED && p.author === "/root" && p.recipient === start.agentPath
        && !delivered.has(turn.id) && nextItem === 0); delivered.add(turn.id); return;
    }
    check(p.type === "message" && ["system", "developer", "user", "assistant"].includes(p.role));
    if (kind === INTERRUPTED) check(p.role === "developer");
    if (p.role === "assistant") {
      const projected = turn.items.find((i) => i.type === "agentMessage" && i.id === p.id), key = `${turn.id}:${p.id}`;
      check(projected && projected.phase === p.phase && delivered.has(turn.id) && turn.items[nextItem]?.id === p.id && !produced.has(key)
        && textParts(p.content, ["text", "output_text", "input_text"]).join("") === projected.text);
      produced.add(key); nextItem++;
      if (p.phase === "final_answer") finals++;
    }
  }, { deadline: Date.now() + 15_000 });
  check(source.transcriptBytes <= 2 * 1024 * 1024 && index === turns.length && ended && identity === rolloutIdentity(path));
  check(kind === COMPLETED ? contexts.size === 2 && finals === 1 && delivered.size === 2 : contexts.size === 0 && finals === 0 && delivered.size === 0);
  return { path, identity, source, projectionDigest: payloadHash(turns), modelEvidence: kind === COMPLETED ? "observed" : "unobserved" };
}

async function inspectNative(input, state, kind, cwd, readThread) {
  const parent = await readThread(input.contextId), binding = launch(parent, input, state, kind, cwd);
  const child = await readThread(binding.start.agentThreadId);
  const parentAudit = auditParent(parent, binding, input, state), childAudit = auditChild(child, binding, input, state, kind, cwd);
  return { sources: [[parentAudit.path, parentAudit.identity], [childAudit.path, childAudit.identity]], evidence: {
    adapter: SCHEMA, parentSource: parentAudit.source, childSource: childAudit.source,
    parentOperationsDigest: parentAudit.operationsDigest, childProjectionDigest: childAudit.projectionDigest,
    modelEvidence: childAudit.modelEvidence, childDigest: sha(child.id), noBusinessOutcomeCreated: true } };
}

/** Explicit operator recovery only. No public route/Hook automatically invokes
 * this path, and no missing historical Hook or outcome is ever synthesized. */
export async function recoverHistoricalQualification(input, { store, cwd, readThread, verifyRetainedNative = false, sourceGeneration } = {}) {
  let client;
  try {
    check(present(input?.contextId) && present(input.routeId) && (input.apply === undefined || typeof input.apply === "boolean")
      && (input.expectedEvidenceDigest === undefined || digest(input.expectedEvidenceDigest))
      && Object.keys(input).every((k) => ["contextId", "routeId", "apply", "expectedEvidenceDigest"].includes(k)));
    const context = { ...store.context({ cwd, contextId: input.contextId, create: false }), ...(sourceGeneration ? { runtimeDigest: sourceGeneration } : {}) };
    const state = retainedState(store.db, context, input.routeId, cwd);
    const raw = store.db.prepare("SELECT value FROM meta WHERE key=?").get(PREFIX + input.routeId)?.value;
    const prior = raw ? JSON.parse(raw) : null;
    if (raw) {
      check(receiptMatches(prior, context, input.routeId, state) && (!input.apply || input.expectedEvidenceDigest === prior.evidenceDigest));
      if (!verifyRetainedNative) return { status: "reconciled_failure", idempotent: true,
        evidenceDigest: prior.evidenceDigest, ordinaryDelegationEnabled: false, gateReleased: prior.recoveryKind === INTERRUPTED };
    }
    const kind = prior?.recoveryKind || originalKind(state), before = payloadHash(state);
    verifyManagedClosure(store.db, context, state);
    if (!readThread) {
      client = new AppServerClient({ timeoutMs: 20_000 }); await client.start();
      readThread = async (id) => (await client.request("thread/read", { threadId: id, includeTurns: true })).thread;
    }
    const first = await inspectNative(input, state, kind, cwd, readThread), second = await inspectNative(input, state, kind, cwd, readThread);
    check(payloadHash(first) === payloadHash(second) && before === payloadHash(retainedState(store.db, context, input.routeId, cwd)));
    if (prior) {
      check(["childSource", "parentOperationsDigest", "childProjectionDigest", "childDigest", "modelEvidence"]
        .every((field) => payloadHash(prior.nativeEvidence[field]) === payloadHash(first.evidence[field])));
      const result = { status: "reconciled_failure", idempotent: true, evidenceDigest: prior.evidenceDigest,
        rawAuditDigest: payloadHash(first.evidence), ordinaryDelegationEnabled: false, gateReleased: kind === INTERRUPTED };
      AUDITS.set(result, { store, context, sources: first.sources,
        basis: historicalQualificationRecoveryBasis(store.db, context, state.qualification) });
      return result;
    }
    const evidenceDigest = payloadHash({ subject: [context.projectId, context.contextKey, input.routeId], before, kind, native: first.evidence });
    if (!input.apply) return { status: "recoverable", evidenceDigest, recoveryKind: kind, ordinaryDelegationEnabled: false, gateReleased: false,
      modelEvidence: first.evidence.modelEvidence };
    check(input.expectedEvidenceDigest === evidenceDigest);
    return store.transaction(() => {
      check(first.sources.every(([path, identity]) => rolloutIdentity(path) === identity)
        && before === payloadHash(retainedState(store.db, context, input.routeId, cwd))
        && !store.db.prepare("SELECT 1 FROM meta WHERE key=?").get(PREFIX + input.routeId));
      const recordedAt = new Date().toISOString();
      if (kind === INTERRUPTED) {
        store.db.prepare("UPDATE delegation_attempts SET finalized_at=?,updated_at=?,ambiguous=1,ticket_hash=NULL,context_package=NULL WHERE route_id=? AND finalized_at IS NULL")
          .run(recordedAt, recordedAt, input.routeId);
      }
      const previousBytes = Math.max(state.attempt.transcript_bytes || 0,
        state.ledger.delegation_children[0]?.accounted_bytes || 0, state.ledger.delegation_maintenance[0]?.accounted_bytes || 0);
      const additionalBytes = Math.max(0, first.evidence.childSource.transcriptBytes - previousBytes);
      if (additionalBytes) {
        store.db.prepare(`INSERT INTO delegation_usage(project_id,context_key,total_transcript_bytes,untrusted,updated_at) VALUES(?,?,?,0,?)
          ON CONFLICT(project_id,context_key) DO UPDATE SET total_transcript_bytes=total_transcript_bytes+excluded.total_transcript_bytes,updated_at=excluded.updated_at`)
          .run(context.projectId, context.contextKey, additionalBytes, recordedAt);
        if (state.ledger.delegation_children.length) store.db.prepare("UPDATE delegation_children SET accounted_bytes=MAX(accounted_bytes,?),updated_at=? WHERE route_id=?")
          .run(first.evidence.childSource.transcriptBytes, recordedAt, input.routeId);
      }
      const receipt = recoveryRecord({ schemaVersion: SCHEMA, recoveryKind: kind, evidenceDigest, recordedAt,
        subjectDigest: payloadHash([context.projectId, context.contextKey, input.routeId]), originalStateDigest: before,
        qualificationKey: taskQualificationKey(context), qualificationDigest: payloadHash(state.qualification), routeDigest: payloadHash(state.route),
        retainedOutcomeDigest: payloadHash(state.outcome), afterStateDigest: payloadHash(retainedState(store.db, context, input.routeId, cwd)),
        nativeEvidence: first.evidence, storageAccounting: { previousBytes, additionalBytes },
        ordinaryDelegationEnabled: false, sourceVerifier: runtimeSourceDigest() });
      store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(PREFIX + input.routeId, canonicalJson(receipt));
      return { status: "reconciled_failure", idempotent: false, recoveryKind: kind, evidenceDigest,
        ordinaryDelegationEnabled: false, gateReleased: kind === INTERRUPTED, modelEvidence: first.evidence.modelEvidence };
    });
  } catch { return denied(); }
  finally { client?.close(); }
}
