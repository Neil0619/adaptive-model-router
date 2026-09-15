import { createHash } from "node:crypto";
import { canonicalJson, payloadHash } from "./io.mjs";
import { openPrivateState, sealPrivateState } from "./private-state.mjs";
import { readStableRollout, rolloutIdentity } from "./native-rollout-reader.mjs";
import { readChildTurnEvidence, readChildInputEvidence } from "./child-turn-evidence.mjs";
import { readChildCommands } from "./child-command-journal.mjs";
import { rememberedRootTranscript } from "./stage-reconciliation.mjs";
import { opaqueId, projectIdentityMaterial } from "./context.mjs";
import { knownOperationCall } from "./runtime-operation-contract.mjs";

export const CHECKPOINT_ACTIONS = ["checkpoint_requirements", "read_checkpoints", "resolve_checkpoint", "resolve_checkpoint_arrival"];
export const CHECKPOINT_FIELDS = {
  checkpointId: { type: "string", pattern: "^[a-f0-9]{64}$" },
  nativeInputId: { type: "string", minLength: 1, maxLength: 256 },
};
const TOKENS = new WeakMap();
// Evidence is scoped to one live DB handle and exact task/child. Only the
// source reader can populate it; callers receive detached projections.
const PROJECTIONS = new WeakMap();
const SENDER_READS = new WeakMap();
const acceptedRows = (db, child) => db.prepare("SELECT * FROM delegation_messages WHERE route_id=? AND status='accepted' AND kind!='interrupt_agent' ORDER BY revision").all(child.route_id);
const messageSummary = (row, reason) => ({ routeId: row.route_id, callId: row.call_id, revision: row.revision, inputDigest: row.input_digest, reason });

function withSenderReads(db, rows, run) {
  const previous = SENDER_READS.get(db);
  if (previous && rows.every((row) => previous.callIds.has(row.call_id))) return run(previous);
  const batch = { callIds: new Set(rows.map((row) => row.call_id)), sources: new Map(), childSources: new Map(), owners: new Map() };
  SENDER_READS.set(db, batch);
  try { return run(batch); }
  finally { if (previous) SENDER_READS.set(db, previous); else SENDER_READS.delete(db); }
}
function ownMessageSource(batch, path) {
  if (!batch?.currentChild) return;
  if (!batch.owners.has(path)) batch.owners.set(path, new Set());
  batch.owners.get(path).add(batch.currentChild);
}

// A batch retains only requested calls, not whole parsed transcripts. A source
// is read once and revalidated on every use; failures and changed identities
// cannot be retried into success within that batch. Nothing survives the call.
function senderSource(db, path, row, deadline) {
  const batch = SENDER_READS.get(db), cached = batch?.sources.get(path);
  ownMessageSource(batch, path);
  if (Date.now() > deadline) fail("native_message_read_budget_exhausted");
  if (cached) {
    if (cached.error) throw cached.error;
    if (rolloutIdentity(path) !== cached.identity) fail("sender_source_changed");
    return cached;
  }
  try {
    const identity = rolloutIdentity(path), calls = new Map(), activities = new Map(), wanted = batch?.callIds || new Set([row.call_id]);
    const prefix = createHash("sha256"); let meta = null, turn = null;
    readStableRollout(path, (entry, line) => {
      prefix.update(JSON.stringify(entry) + "\n");
      const item = entry.payload;
      if (line === 1) { if (entry.type !== "session_meta" || typeof item?.cwd !== "string") fail("sender_identity_missing"); meta = item; }
      if (entry.type === "turn_context" || (entry.type === "event_msg" && item?.type === "task_started")) turn = item.turn_id;
      if (entry.type === "event_msg" && item?.type === "item_completed" && wanted.has(item.item?.id)) {
        if (!activities.has(item.item.id)) activities.set(item.item.id, []);
        activities.get(item.item.id).push({ item, line });
      }
      if (entry.type !== "response_item" || !wanted.has(item?.call_id)) return;
      if (!calls.has(item.call_id)) calls.set(item.call_id, []);
      calls.get(item.call_id).push({ item, line, turn,
        ...(item.type === "function_call_output" ? { prefixDigest: prefix.copy().digest("hex") } : {}) });
    }, { deadline, allowCompactedMetadata: true });
    if (identity !== rolloutIdentity(path)) fail("sender_source_changed");
    const source = { identity, meta, calls, activities }; batch?.sources.set(path, source); return source;
  } catch (error) { batch?.sources.set(path, { error }); throw error; }
}
const projectionKey = (context, child) => canonicalJson([context.projectId, context.contextKey, child.route_id]);
const unavailableProjection = (reason) => ({ resolved: new Set(), reviewedArrivals: new Set(), pending: [], conflict: reason,
  nextAction: "refresh_checkpoint_sources_outside_transaction_then_retry_existing_action" });
const detachedProjection = (value) => structuredClone(value);
const fail = (reason) => { throw new Error(`Message checkpoint blocked: ${reason}`); };
const present = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_message_checkpoints'").get());
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_message_checkpoints (
    id TEXT PRIMARY KEY, route_id TEXT NOT NULL, caller_turn_id TEXT NOT NULL, call_id TEXT NOT NULL,
    revision INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(route_id,caller_turn_id,call_id));
    CREATE TABLE IF NOT EXISTS runtime_message_continuations (
    id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL UNIQUE REFERENCES runtime_message_checkpoints(id),
    route_id TEXT NOT NULL, native_input_id TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_message_arrival_reviews (
    id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL REFERENCES runtime_message_checkpoints(id),
    route_id TEXT NOT NULL, native_input_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(checkpoint_id,native_input_id));`);
  for (const table of ["runtime_message_checkpoints", "runtime_message_continuations", "runtime_message_arrival_reviews"]) db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'message checkpoint evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'message checkpoint responsibility is retained'); END;`);
}
const key = (row) => canonicalJson([row.route_id, row.caller_turn_id, row.call_id]);
function childAt(db, context, routeId) {
  const child = db.prepare("SELECT * FROM delegation_children WHERE route_id=? AND project_id=? AND context_key=?").get(routeId, context.projectId, context.contextKey);
  if (!child) fail("owned_child_missing");
  return child;
}
function snapshot(db, child) {
  return payloadHash([db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(child.route_id),
    db.prepare("SELECT * FROM delegation_messages WHERE route_id=? ORDER BY revision").all(child.route_id),
    db.prepare("SELECT * FROM delegation_child_stops WHERE route_id=? ORDER BY rowid").all(child.route_id),
    db.prepare("SELECT * FROM runtime_invocations WHERE project_id=? AND context_key=? ORDER BY rowid").all(child.project_id, child.context_key),
    db.prepare("SELECT * FROM runtime_call_receipts WHERE project_id=? AND context_key=? ORDER BY rowid").all(child.project_id, child.context_key),
    present(db) ? db.prepare("SELECT * FROM runtime_message_checkpoints WHERE route_id=? ORDER BY rowid").all(child.route_id) : [],
    present(db) ? db.prepare("SELECT * FROM runtime_message_continuations WHERE route_id=? ORDER BY rowid").all(child.route_id) : [],
    present(db) ? db.prepare("SELECT * FROM runtime_message_arrival_reviews WHERE route_id=? ORDER BY rowid").all(child.route_id) : []]);
}
function childSource(db, child, deadline) {
  if (db.isTransaction) fail("checkpoint_source_preflight_required");
  const locator = JSON.parse(openPrivateState(db, child.locator)), identity = rolloutIdentity(locator.transcriptPath);
  const facts = readChildTurnEvidence(locator, { commands: readChildCommands(db, child.route_id), deadline });
  const wanted = new Set([facts.lastFinal?.line]);
  if (present(db)) for (const row of db.prepare("SELECT record FROM runtime_message_continuations WHERE route_id=?").all(child.route_id))
    wanted.add(JSON.parse(openPrivateState(db, row.record)).childPrefix.throughLine);
  if (present(db)) for (const row of db.prepare("SELECT record FROM runtime_message_arrival_reviews WHERE route_id=?").all(child.route_id))
    wanted.add(JSON.parse(openPrivateState(db, row.record)).childPrefix.throughLine);
  const inputs = [], prefixes = new Map(), hash = createHash("sha256");
  const source = readStableRollout(locator.transcriptPath, (entry, line) => {
    if (entry.type === "response_item" && !knownOperationCall(entry.payload)) fail("unknown_child_operation_contract");
    hash.update(JSON.stringify(entry) + "\n"); if (wanted.has(line)) prefixes.set(line, hash.copy().digest("hex"));
    if (entry.type === "response_item" && entry.payload?.type === "agent_message") inputs.push(entry.payload);
  }, { deadline });
  if (source.transcriptDigest !== facts.transcriptDigest || identity !== rolloutIdentity(locator.transcriptPath)) fail("child_source_changed");
  return { locator, identity, facts, inputs, prefixes, path: locator.transcriptPath };
}
function childMessageSource(db, child, deadline) {
  if (db.isTransaction) fail("checkpoint_source_preflight_required");
  const locator = JSON.parse(openPrivateState(db, child.locator)), identity = rolloutIdentity(locator.transcriptPath);
  const facts = readChildInputEvidence(locator, { deadline });
  if (identity !== rolloutIdentity(locator.transcriptPath)) fail("child_source_changed");
  SENDER_READS.get(db)?.childSources.set(locator.transcriptPath, identity);
  ownMessageSource(SENDER_READS.get(db), locator.transcriptPath);
  return { locator, identity, facts, inputs: facts.inputs, path: locator.transcriptPath };
}
function quiescent(db, child, source) {
  const facts = source.facts;
  const attempt = db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(child.route_id);
  if (child.state === "unknown" || (child.state !== "settled" && !attempt)
    || (attempt && (!attempt.ticket_consumed || !attempt.post_observed || attempt.ambiguous || attempt.no_child))) fail("child_ownership_or_ticket_pending");
  if (!facts.finished || facts.pendingCalls.length || facts.pendingOperations.length || !facts.lastFinal) fail("child_operations_or_turn_pending");
  if (!db.prepare("SELECT 1 FROM delegation_child_stops WHERE route_id=? AND turn_id=? AND result_digest IN (?,?)")
    .get(child.route_id, facts.lastFinal.turnId, facts.lastFinal.digest, facts.lastFinal.stopDigest || facts.lastFinal.digest)) fail("latest_child_Stop_missing");
}
const matches = (input, payload) => Array.isArray(input?.content) && input.content.some((part) =>
  (part.type === "encrypted_content" && part.encrypted_content === payload.message)
  || (part.type === "input_text" && part.text === payload.message));

function nativeHostTurn(meta, locator, row, call, result, resultLine, activities) {
  // Some native calls carry an inference-response ID in passthrough metadata.
  // Only the host's exact callId activity plus its result can explain that ID;
  // matching arguments or a nearby turn_context alone cannot authorize it.
  if (activities.length !== 1) fail("original_host_turn_unverified");
  const evidence = activities[0], event = evidence.item, activity = event.item;
  if (evidence.line <= call.line || evidence.line >= resultLine || event.thread_id !== meta.id
    || event.turn_id !== row.caller_turn_id || call.activeTurn !== row.caller_turn_id
    || result.internal_chat_message_metadata_passthrough?.turn_id !== row.caller_turn_id
    || activity?.type !== "SubAgentActivity" || activity.id !== row.call_id || activity.kind !== "interacted"
    || activity.agent_thread_id !== locator.childId || activity.agent_path !== locator.agentPath
    || !Number.isSafeInteger(event.started_at_ms) || event.started_at_ms < 0
    || !Number.isSafeInteger(event.completed_at_ms) || event.completed_at_ms < event.started_at_ms) fail("original_host_turn_unverified");
  return evidence;
}

function operation(db, context, child, row, { parentTranscriptPath = null, senderTranscriptPaths = [], deadline } = {}) {
  if (db.isTransaction) fail("checkpoint_source_preflight_required");
  const locator = JSON.parse(openPrivateState(db, child.locator));
  const rootSender = row.author === payloadHash("/root");
  // A sibling's accepted message depends on that sender, not the availability
  // of every historical child transcript. The selected source still has to
  // prove its native author, parent, exact input and result below.
  const knownSenders = rootSender ? [] : db.prepare("SELECT locator FROM delegation_children WHERE project_id=? AND context_key=?")
    .all(context.projectId, context.contextKey).flatMap((value) => {
      try {
        const sender = JSON.parse(openPrivateState(db, value.locator));
        return typeof sender.agentPath === "string" && payloadHash(sender.agentPath) === row.author
          && typeof sender.transcriptPath === "string" ? [sender.transcriptPath] : [];
      } catch { return []; } // An unrelated unreadable locator is not sender evidence.
    });
  const checkpointSource = present(db) && db.prepare("SELECT record FROM runtime_message_checkpoints WHERE route_id=? AND caller_turn_id=? AND call_id=?")
    .get(child.route_id, row.caller_turn_id, row.call_id);
  const retainedSource = checkpointSource && JSON.parse(openPrivateState(db, checkpointSource.record)).operation.path;
  const paths = [...new Set([parentTranscriptPath || retainedSource || (rootSender ? rememberedRootTranscript(db, context) : null), ...senderTranscriptPaths,
    ...knownSenders].filter(Boolean))];
  let found = null;
  for (const path of paths) {
    const { identity, meta, calls, activities } = senderSource(db, path, row, deadline);
    let author = null, call = null, completed = null;
    const salt = db.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
    if (!salt || opaqueId(salt, "project", projectIdentityMaterial(meta.cwd)) !== context.projectId) fail("sender_project_changed");
    if (meta.id === locator.parentContextId && !meta.parent_thread_id && !meta.source?.subagent) author = "/root";
    else if (meta.parent_thread_id === locator.parentContextId && meta.source?.subagent?.thread_spawn?.parent_thread_id === locator.parentContextId
      && meta.agent_path === meta.source.subagent.thread_spawn.agent_path) author = meta.agent_path;
    if (!author) fail("sender_identity_changed");
    for (const { item, line, turn, prefixDigest } of calls.get(row.call_id) || []) {
      if (payloadHash(author) !== row.author) continue;
      if (item.type === "function_call") {
        if (call || ![undefined, "collaboration"].includes(item.namespace) || item.name !== row.kind) fail("original_call_ambiguous");
        const input = JSON.parse(item.arguments), actualTurn = item.internal_chat_message_metadata_passthrough?.turn_id || turn;
        if (payloadHash(input) !== row.input_digest
          || ![locator.childId, locator.taskName, locator.agentPath].includes(input.target) || typeof input.message !== "string") fail("original_input_changed");
        call = { input, call: item, line, author, turnId: actualTurn, activeTurn: turn };
      } else if (item.type === "function_call_output") {
        if (!call || completed || item.output !== "") fail("original_result_unverified");
        const hostTurnEvidence = call.turnId !== row.caller_turn_id
          ? nativeHostTurn(meta, locator, row, call, item, line, activities.get(row.call_id) || []) : null;
        completed = { ...call, ...(hostTurnEvidence ? { hostTurnEvidence } : {}), result: item, resultLine: line, prefixDigest, path, identity };
      }
    }
    if (identity !== rolloutIdentity(path)) fail("sender_source_changed");
    if (completed) { if (found) fail("duplicate_sender_source"); found = completed; }
  }
  if (!found || row.status !== "accepted" || !["send_message", "followup_task"].includes(row.kind)) fail("original_accepted_call_source_missing");
  return found;
}

function storedCheckpoint(db, id) {
  const row = present(db) && db.prepare("SELECT * FROM runtime_message_checkpoints WHERE id=?").get(id);
  if (!row) fail("checkpoint_missing");
  return { ...row, value: JSON.parse(openPrivateState(db, row.record)) };
}
function validateCheckpoint(db, context, child, checkpoint, deadline) {
  const row = db.prepare("SELECT * FROM delegation_messages WHERE route_id=? AND caller_turn_id=? AND call_id=?")
    .get(child.route_id, checkpoint.caller_turn_id, checkpoint.call_id);
  if (!row || row.revision !== checkpoint.revision) fail("checkpoint_message_revision_changed");
  const saved = checkpoint.value;
  const actual = operation(db, context, child, row, { parentTranscriptPath: saved.operation.path, deadline });
  if (actual.prefixDigest !== saved.operation.prefixDigest || payloadHash(actual.call) !== payloadHash(saved.operation.call)
    || payloadHash(actual.result) !== payloadHash(saved.operation.result)) fail("checkpoint_original_source_changed");
  return { row, actual };
}

function reviewDisposition(report, messageId) {
  const requirement = report?.requirements?.[0];
  if (!report?.basis || !report.resultReview || report.pendingOperations?.length || report.requirements?.length !== 1
    || requirement.messageId !== messageId || !requirement.source || !requirement.receipt || !requirement.owner
    || !["fulfilled", "cancelled", "superseded", "no_work"].includes(requirement.disposition)) fail("explicit_requirement_result_review_required");
}
function validateContinuation(db, context, child, source, value, deadline) {
  const fact = source.facts.messages.find((item) => item.id === value.input.id);
  if (!fact || fact.digest !== value.input.digest || fact.turnId !== value.input.turnId
    || source.prefixes.get(value.childPrefix.throughLine) !== value.childPrefix.digest) fail("continuation_child_source_changed");
  const supplemental = db.prepare("SELECT * FROM delegation_messages WHERE route_id=? AND revision=?").get(child.route_id, value.supplementalRevision);
  if (!supplemental) fail("continuation_supplement_missing");
  const actual = operation(db, context, child, supplemental, { parentTranscriptPath: value.supplementalCall.path, deadline });
  if (actual.prefixDigest !== value.supplementalCall.prefixDigest || payloadHash(actual.result) !== payloadHash(value.supplementalCall.result)) fail("continuation_sender_source_changed");
  return actual;
}

// Join native input identity to the exact source-owned opaque payload. Counts
// and ordering cannot distinguish a missing queue item from another input.
function acceptedInputEvidence(db, context, child, source, options) {
  const rows = acceptedRows(db, child);
  const activation = source.facts.messages.find((fact) => fact.author === "/root");
  const evidence = withSenderReads(db, rows, () => rows.map((row) => {
    const actual = operation(db, context, child, row, options);
    const inputs = source.facts.messages.filter((fact) => fact.id !== activation?.id
      && payloadHash(fact.author) === row.author && fact.triggerTurn === (row.kind === "followup_task")
      && source.inputs.some((item) => item.id === fact.id && matches(item, actual.input)));
    return { row, actual, inputs };
  }));
  const uses = new Map();
  for (const item of evidence) for (const fact of item.inputs) uses.set(fact.id, (uses.get(fact.id) || 0) + 1);
  return evidence.map((item) => ({ ...item, consumed: item.inputs.length === 1 && uses.get(item.inputs[0].id) === 1,
    ambiguous: item.inputs.length > 1 || item.inputs.some((fact) => uses.get(fact.id) !== 1) }));
}

export function pendingNativeMessageResponsibilities(db, context, child, deadline = Date.now() + 5000) {
  const rows = acceptedRows(db, child), summary = messageSummary;
  if (!rows.length) return [];
  try {
    const source = childMessageSource(db, child, deadline), projection = messageContinuationProjection(db, context, child, deadline);
    if (projection.conflict) return rows.map((row) => summary(row, "message_checkpoint_arrival_review_required"));
    return acceptedInputEvidence(db, context, child, source, { deadline }).flatMap((item) => {
      if (projection.resolved.has(key(item.row)) && item.inputs.every((fact) => projection.reviewedArrivals.has(fact.id))) return [];
      if (item.consumed) return [];
      if (item.ambiguous) return [summary(item.row, "native_input_call_binding_ambiguous")];
      return hasVerifiedMessageCheckpoint(db, context, child, item.row, deadline) ? []
        : [summary(item.row, "accepted_input_native_checkpoint_missing")];
    });
  } catch { return rows.map((row) => summary(row, "native_message_source_unverified")); }
}

// Explicit cold installation walks a finite captured child inventory, giving
// each child the same bounded read budget as a normal operation. The sender
// index belongs only to this batch. Normal task/Hook callers retain one shared
// five-second budget, and neither path reads a transcript under a writer lock.
export function pendingNativeMessageBatch(db, children, { coldBatch = false } = {}) {
  const rows = children.flatMap((child) => acceptedRows(db, child));
  if (!rows.length) return [];
  if (db.isTransaction) return rows.map((row) => messageSummary(row, "native_message_source_unverified"));
  const before = new Map(children.map((child) => [child.route_id, payloadHash([child, rows.filter((row) => row.route_id === child.route_id)])]));
  const deadline = Date.now() + 5000;
  return withSenderReads(db, rows, (batch) => {
    const pending = new Map(), changed = new Set();
    for (const child of children) {
      batch.currentChild = child.route_id;
      pending.set(child.route_id, pendingNativeMessageResponsibilities(db,
        { projectId: child.project_id, contextKey: child.context_key }, child, coldBatch ? Date.now() + 5000 : deadline));
    }
    batch.currentChild = null;
    for (const child of children) {
      const current = db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(child.route_id);
      if (payloadHash([current, acceptedRows(db, child)]) !== before.get(child.route_id)) changed.add(child.route_id);
    }
    for (const [path, identity] of [...batch.sources].filter(([, value]) => !value.error).map(([path, value]) => [path, value.identity])
      .concat([...batch.childSources])) {
      let same = false;
      try { same = rolloutIdentity(path) === identity; } catch { /* Missing sources invalidate only their consumers. */ }
      if (!same) for (const routeId of batch.owners.get(path) || []) changed.add(routeId);
    }
    return children.flatMap((child) => changed.has(child.route_id)
      ? rows.filter((row) => row.route_id === child.route_id).map((row) => messageSummary(row, "native_message_source_unverified"))
      : pending.get(child.route_id));
  });
}

export function prepareMessageCheckpoint(store, context, input) {
  const deadline = Date.now() + 5000, child = childAt(store.db, context, input.routeId), before = snapshot(store.db, child);
  if (child.revision !== input.expectedRevision) fail("stage_revision_changed");
  const source = childSource(store.db, child, deadline); quiescent(store.db, child, source);
  if (store.db.prepare("SELECT 1 FROM delegation_messages WHERE route_id=? AND status NOT IN ('accepted','rejected')").get(child.route_id)) fail("unknown_message_result");
  const checkpoints = [], sources = [[source.path, source.identity]];
  for (const { row, actual, consumed, ambiguous } of acceptedInputEvidence(store.db, context, child, source, { ...input, deadline })) {
    sources.push([actual.path, actual.identity]);
    if (ambiguous) fail("native_input_call_binding_ambiguous");
    if (consumed) continue;
    const value = { schema: "native-message-checkpoint/1", operation: actual,
      original: { routeId: child.route_id, callerTurnId: row.caller_turn_id, callId: row.call_id, inputDigest: row.input_digest, revision: row.revision },
      child: { sourceDigest: source.facts.transcriptDigest, final: source.facts.lastFinal, revision: child.revision },
      responsibility: "accepted original input is unconsumed; preserve opaque host payload and never retransmit it" };
    const id = payloadHash([value.schema, value.original, actual.prefixDigest, actual.call, actual.result]);
    checkpoints.push({ id, row, value });
  }
  const token = Object.freeze({}); TOKENS.set(token, { store, context, child, before, sources, deadline, kind: "checkpoint", checkpoints }); return token;
}

export function prepareMessageContinuation(store, context, input) {
  const deadline = Date.now() + 5000, child = childAt(store.db, context, input.routeId), before = snapshot(store.db, child);
  if (child.revision !== input.expectedRevision) fail("stage_revision_changed");
  if (store.db.prepare("SELECT 1 FROM runtime_invocations WHERE project_id=? AND context_key=? AND state!='completed' AND id!=?")
    .get(context.projectId, context.contextKey, store.runtimeInvocation?.id || "")
    || store.db.prepare("SELECT 1 FROM runtime_call_receipts WHERE project_id=? AND context_key=? AND state='pending'").get(context.projectId, context.contextKey)) fail("native_invocation_or_Pre_pending");
  const checkpoint = storedCheckpoint(store.db, input.checkpointId);
  if (checkpoint.route_id !== child.route_id) fail("checkpoint_owner_changed");
  const original = validateCheckpoint(store.db, context, child, checkpoint, deadline);
  const source = childSource(store.db, child, deadline); quiescent(store.db, child, source);
  if (source.inputs.some((item) => matches(item, original.actual.input))) fail("original_input_arrived_checkpoint_conflict");
  const arrived = source.inputs.find((item) => item.id === input.nativeInputId), fact = source.facts.messages.find((item) => item.id === input.nativeInputId);
  if (!arrived || !fact?.triggerTurn || fact.author !== "/root" || fact.turnId !== source.facts.lastFinal.turnId) fail("latest_native_followup_input_missing");
  if (store.db.prepare("SELECT 1 FROM delegation_messages WHERE route_id=? AND status NOT IN ('accepted','rejected')").get(child.route_id)) fail("unknown_message_result");
  const supplements = [];
  for (const row of store.db.prepare("SELECT * FROM delegation_messages WHERE route_id=? AND status='accepted' AND kind='followup_task' AND revision>? ORDER BY revision")
    .all(child.route_id, checkpoint.revision)) {
    const call = operation(store.db, context, child, row, { ...input, deadline });
    if (matches(arrived, call.input)) supplements.push({ row, call });
  }
  if (supplements.length !== 1) fail("new_followup_call_input_binding_unproven");
  const report = input.disposition; reviewDisposition(report, checkpoint.id);
  const value = { schema: "native-message-continuation/1", checkpointId: checkpoint.id, original: checkpoint.value.original,
    supplementalCall: supplements[0].call, supplementalRevision: supplements[0].row.revision,
    input: { id: fact.id, digest: fact.digest, author: fact.author, turnId: fact.turnId },
    childPrefix: { throughLine: source.facts.lastFinal.line, digest: source.prefixes.get(source.facts.lastFinal.line) },
    final: source.facts.lastFinal, disposition: report, meaning: "new native input resolves retained responsibility; original call remains accepted and unconsumed" };
  const id = payloadHash(value), token = Object.freeze({});
  TOKENS.set(token, { store, context, child, before, sources: [[source.path, source.identity], [original.actual.path, original.actual.identity],
    [supplements[0].call.path, supplements[0].call.identity]], deadline, kind: "continuation", id, checkpoint, value }); return token;
}

export function prepareMessageArrivalReview(store, context, input) {
  const deadline = Date.now() + 5000, child = childAt(store.db, context, input.routeId), before = snapshot(store.db, child);
  if (child.revision !== input.expectedRevision) fail("stage_revision_changed");
  if (store.db.prepare("SELECT 1 FROM runtime_invocations WHERE project_id=? AND context_key=? AND state!='completed' AND id!=?")
    .get(context.projectId, context.contextKey, store.runtimeInvocation?.id || "")
    || store.db.prepare("SELECT 1 FROM runtime_call_receipts WHERE project_id=? AND context_key=? AND state='pending'").get(context.projectId, context.contextKey)) fail("native_invocation_or_Pre_pending");
  const checkpoint = storedCheckpoint(store.db, input.checkpointId);
  if (checkpoint.route_id !== child.route_id) fail("checkpoint_owner_changed");
  const continuation = store.db.prepare("SELECT * FROM runtime_message_continuations WHERE checkpoint_id=?").get(checkpoint.id);
  if (!continuation) fail("prior_continuation_missing");
  const original = validateCheckpoint(store.db, context, child, checkpoint, deadline);
  const source = childSource(store.db, child, deadline); quiescent(store.db, child, source);
  if (store.db.prepare("SELECT 1 FROM delegation_messages WHERE route_id=? AND status NOT IN ('accepted','rejected')").get(child.route_id)) fail("unknown_message_result");
  const supplement = validateContinuation(store.db, context, child, source, JSON.parse(openPrivateState(store.db, continuation.record)), deadline);
  const arrived = source.inputs.find((item) => item.id === input.nativeInputId), fact = source.facts.messages.find((item) => item.id === input.nativeInputId);
  if (!arrived || !fact || fact.author !== original.actual.author || fact.triggerTurn !== (original.row.kind === "followup_task")
    || !matches(arrived, original.actual.input) || fact.line >= source.facts.lastFinal.line) fail("actual_original_input_arrival_missing");
  reviewDisposition(input.disposition, input.nativeInputId);
  const value = { schema: "native-message-arrival-review/1", checkpointId: checkpoint.id, continuationId: continuation.id,
    input: { id: fact.id, digest: fact.digest, author: fact.author, turnId: fact.turnId },
    childPrefix: { throughLine: source.facts.lastFinal.line, digest: source.prefixes.get(source.facts.lastFinal.line) },
    final: source.facts.lastFinal, disposition: input.disposition,
    meaning: "the original input really arrived later; its latest result is explicitly reviewed without rewriting the prior continuation" };
  const token = Object.freeze({}); TOKENS.set(token, { store, context, child, before, sources: [[source.path, source.identity],
    [original.actual.path, original.actual.identity], [supplement.path, supplement.identity]], deadline, kind: "arrival", id: payloadHash(value), checkpoint, value }); return token;
}

export function commitMessageCheckpoint(store, token) {
  const saved = TOKENS.get(token);
  if (saved?.store !== store) fail("source_owned_checkpoint_token_missing");
  return store.transaction(() => {
    if (Date.now() > saved.deadline || saved.sources.some(([path, identity]) => rolloutIdentity(path) !== identity)
      || snapshot(store.db, saved.child) !== saved.before) fail("source_or_stage_revision_changed");
    schema(store.db);
    if (saved.kind === "checkpoint") {
      for (const item of saved.checkpoints) store.db.prepare("INSERT OR IGNORE INTO runtime_message_checkpoints VALUES(?,?,?,?,?,?)")
        .run(item.id, item.row.route_id, item.row.caller_turn_id, item.row.call_id, item.row.revision, sealPrivateState(store.db, canonicalJson(item.value)));
      return { checkpointed: saved.checkpoints.length, state: "retained_unconsumed", checkpoints: saved.checkpoints.map((item) => item.id),
        nextAction: "explicitly_followup_same_child_from_original_context_then_review_native_result_and_resolve_checkpoint" };
    }
    const table = saved.kind === "arrival" ? "runtime_message_arrival_reviews" : "runtime_message_continuations";
    const previous = saved.kind === "arrival" ? store.db.prepare("SELECT * FROM runtime_message_arrival_reviews WHERE checkpoint_id=? AND native_input_id=?").get(saved.checkpoint.id, saved.value.input.id)
      : store.db.prepare("SELECT * FROM runtime_message_continuations WHERE checkpoint_id=?").get(saved.checkpoint.id);
    if (previous) {
      const old = JSON.parse(openPrivateState(store.db, previous.record));
      if (old.input.id !== saved.value.input.id || old.input.digest !== saved.value.input.digest
        || payloadHash(old.disposition) !== payloadHash(saved.value.disposition) || payloadHash(old.final) !== payloadHash(saved.value.final)) fail("checkpoint_already_resolved_differently");
      return { id: previous.id, checkpointId: saved.checkpoint.id, nativeInputId: old.input.id, state: saved.kind === "arrival" ? "late_arrival_reviewed" : "responsibility_resolved", idempotent: true,
        originalMessageStatus: "accepted", originalMessageConsumed: saved.kind === "arrival" };
    }
    store.db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?)`)
      .run(saved.id, saved.checkpoint.id, saved.child.route_id, saved.value.input.id, sealPrivateState(store.db, canonicalJson(saved.value)));
    store.db.prepare("UPDATE delegation_children SET verified_revision=NULL,verified_digest=NULL WHERE route_id=?").run(saved.child.route_id);
    return { id: saved.id, checkpointId: saved.checkpoint.id, nativeInputId: saved.value.input.id, state: saved.kind === "arrival" ? "late_arrival_reviewed" : "responsibility_resolved",
      originalMessageStatus: "accepted", originalMessageConsumed: saved.kind === "arrival" };
  });
}

export function readMessageCheckpoints(db, context, routeId) {
  const child = childAt(db, context, routeId);
  if (!present(db)) return { checkpoints: [], nextAction: "checkpoint_requirements_from_original_sender_source" };
  const projection = messageContinuationProjection(db, context, child);
  return { ...(projection.conflict ? { state: "pending", reason: projection.conflict, checkpointId: projection.checkpointId,
    nativeInputId: projection.nativeInputId, nextAction: projection.nextAction } : projection.pending.length
    ? { state: "pending", responsibilities: projection.pending, nextAction: projection.pending[0].nextAction }
    : { state: "reviewed", nextAction: "verify_current_result_and_close_existing_stage" }), checkpoints: db.prepare("SELECT * FROM runtime_message_checkpoints WHERE route_id=? ORDER BY revision").all(routeId).map((row) => {
    const value = JSON.parse(openPrivateState(db, row.record)), continuation = db.prepare("SELECT record FROM runtime_message_continuations WHERE checkpoint_id=?").get(row.id);
    return { id: row.id, ...value.original, source: { path: value.operation.path, callLine: value.operation.line, resultLine: value.operation.resultLine },
      opaquePayloadRetained: true, retransmitOpaquePayload: false, state: continuation ? "responsibility_resolved" : "retained_unconsumed",
      ...(continuation ? { continuation: JSON.parse(openPrivateState(db, continuation.record)).disposition } : {}),
      arrivalReviews: db.prepare("SELECT native_input_id,record FROM runtime_message_arrival_reviews WHERE checkpoint_id=?").all(row.id)
        .map((review) => ({ nativeInputId: review.native_input_id, disposition: JSON.parse(openPrivateState(db, review.record)).disposition })) };
  }) };
}

export function hasVerifiedMessageCheckpoint(db, context, child, row, deadline = Date.now() + 5000) {
  try {
    if (!present(db)) return false;
    const checkpoint = db.prepare("SELECT id FROM runtime_message_checkpoints WHERE route_id=? AND caller_turn_id=? AND call_id=?")
      .get(child.route_id, row.caller_turn_id, row.call_id);
    if (!checkpoint) return false;
    validateCheckpoint(db, context, child, storedCheckpoint(db, checkpoint.id), deadline); return true;
  } catch { return false; }
}

// Prepare all checkpoint projections needed by one public operation before
// opening its write transaction. A single budget covers every retained child.
export function prepareMessageProjections(db, context, { routeId = null, deadline = Infinity } = {}) {
  if (db.isTransaction) return false;
  deadline = Math.min(deadline, Date.now() + 5000);
  if (!present(db)) return true;
  const children = db.prepare(`SELECT * FROM delegation_children WHERE project_id=? AND context_key=?
    AND route_id IN (SELECT route_id FROM runtime_message_checkpoints) ${routeId ? "AND route_id=?" : ""} ORDER BY created_at`)
    .all(context.projectId, context.contextKey, ...(routeId ? [routeId] : []));
  // Each operation replaces its task cache, so an omitted/removed/new child
  // cannot borrow a previous operation's proof. Bound even a long-lived DB.
  const cache = new Map(); PROJECTIONS.set(db, cache);
  for (const child of children) {
    const key = projectionKey(context, child);
    if (Date.now() > deadline) break;
    const before = snapshot(db, child), sources = new Map();
    const value = scanMessageProjection(db, context, child, deadline, sources);
    let unchanged = false;
    try { unchanged = Date.now() <= deadline && snapshot(db, child) === before
      && [...sources].every(([path, identity]) => rolloutIdentity(path) === identity); } catch { /* Explicit pending below. */ }
    cache.set(key, { scope: canonicalJson([context.projectId, context.contextKey]), before, sources, deadline,
      value: unchanged ? value : unavailableProjection("checkpoint_projection_source_or_revision_changed") });
  }
  return true;
}

// In a write transaction this function never falls back to transcript reads.
// Metadata only is compared to evidence fully read outside that transaction.
export function messageContinuationProjection(db, context, child, deadline = Date.now() + 5000) {
  if (!present(db) || !db.prepare("SELECT 1 FROM runtime_message_checkpoints WHERE route_id=?").get(child.route_id))
    return { resolved: new Set(), reviewedArrivals: new Set(), pending: [] };
  if (!db.isTransaction) {
    const prior = PROJECTIONS.get(db)?.get(projectionKey(context, child));
    let fresh = false;
    try { fresh = prior && Date.now() <= Math.min(deadline, prior.deadline) && snapshot(db, child) === prior.before
      && [...prior.sources].every(([path, identity]) => rolloutIdentity(path) === identity); } catch { /* Refresh outside the transaction. */ }
    if (!fresh) prepareMessageProjections(db, context, { routeId: child.route_id, deadline });
  }
  const cached = PROJECTIONS.get(db)?.get(projectionKey(context, child));
  if (!cached) return unavailableProjection("checkpoint_projection_preflight_required");
  try {
    if (Date.now() > Math.min(deadline, cached.deadline) || snapshot(db, child) !== cached.before
      || [...cached.sources].some(([path, identity]) => rolloutIdentity(path) !== identity))
      return unavailableProjection("checkpoint_projection_source_or_revision_changed");
    return detachedProjection(cached.value);
  } catch { return unavailableProjection("checkpoint_projection_source_or_revision_changed"); }
}

// Read-only source projection. Original accepted rows and immutable prior
// continuations stay intact. Each actual late input requires its own review.
function scanMessageProjection(db, context, child, deadline, sources) {
  if (db.isTransaction) return unavailableProjection("checkpoint_projection_preflight_required");
  const resolved = new Set(), reviewedArrivals = new Set(), pending = [];
  const checkpoints = db.prepare("SELECT * FROM runtime_message_checkpoints WHERE route_id=? ORDER BY revision").all(child.route_id);
  try {
    const source = childSource(db, child, deadline); sources.set(source.path, source.identity);
    for (const checkpointRow of checkpoints) {
      const checkpoint = storedCheckpoint(db, checkpointRow.id), original = validateCheckpoint(db, context, child, checkpoint, deadline);
      sources.set(original.actual.path, original.actual.identity);
      const row = db.prepare("SELECT * FROM runtime_message_continuations WHERE checkpoint_id=?").get(checkpoint.id);
      const arrivals = source.inputs.filter((item) => matches(item, original.actual.input));
      if (!row) {
        if (!arrivals.length) pending.push({ checkpointId: checkpoint.id, originalCallId: original.row.call_id,
          nextAction: source.facts.messages.some((fact) => fact.triggerTurn && fact.author === "/root" && fact.turnId === source.facts.lastFinal?.turnId
            && fact.line > checkpoint.value.child.final.line) ? "review_new_child_input_and_resolve_checkpoint"
            : "explicitly_followup_same_child_from_original_context" });
        continue;
      }
      const value = JSON.parse(openPrivateState(db, row.record));
      const supplemental = validateContinuation(db, context, child, source, value, deadline);
      sources.set(supplemental.path, supplemental.identity);
      for (const arrived of arrivals) {
        const reviewRow = db.prepare("SELECT record FROM runtime_message_arrival_reviews WHERE checkpoint_id=? AND native_input_id=?").get(checkpoint.id, arrived.id);
        if (!reviewRow) return { resolved: new Set(), reviewedArrivals: new Set(), pending,
          conflict: "original_input_arrived_checkpoint_conflict", checkpointId: checkpoint.id, nativeInputId: arrived.id,
          nextAction: "review_latest_same_child_result_then_resolve_checkpoint_arrival" };
        const review = JSON.parse(openPrivateState(db, reviewRow.record)), fact = source.facts.messages.find((item) => item.id === arrived.id);
        if (review.continuationId !== row.id || !fact || fact.digest !== review.input.digest || fact.turnId !== review.input.turnId
          || fact.author !== original.actual.author || fact.triggerTurn !== (original.row.kind === "followup_task")
          || source.prefixes.get(review.childPrefix.throughLine) !== review.childPrefix.digest) fail("arrival_review_source_changed");
        reviewedArrivals.add(arrived.id);
      }
      resolved.add(key(original.row));
    }
    return { resolved, reviewedArrivals, pending };
  } catch (error) { return { resolved: new Set(), reviewedArrivals: new Set(), pending: [], conflict: error.message,
    nextAction: "restore_and_verify_original_checkpoint_sources" }; }
}
export const messageCheckpointKey = key;
