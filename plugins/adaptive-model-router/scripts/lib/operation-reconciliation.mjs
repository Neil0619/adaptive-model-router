import { payloadHash, parseJson } from "./io.mjs";
import { openPrivateState, sealPrivateState } from "./private-state.mjs";
import { readStableRollout } from "./native-rollout-reader.mjs";
import { readChildTurnEvidence } from "./child-turn-evidence.mjs";
import { readChildCommands } from "./child-command-journal.mjs";
import { rememberedRootTranscript } from "./stage-reconciliation.mjs";
import { forwardedToolCall, forwardedToolResult } from "./code-mode-tool-evidence.mjs";

const present = (value) => typeof value === "string" && value.trim().length > 0;
const terminal = new Set(["completed", "stopped", "not_started"]);
const reference = (value) => ({ source: value.source, line: value.line, digest: value.digest,
  callId: value.callId, turnId: value.turnId });

/** Evidence references name actual records, not text printed by the model.
 * Root verification may use its existing native command tools. Meaning and
 * business success remain the root's explicit judgment; this reader verifies
 * identity, exact call/result provenance and immutable references. */
function transcriptEvidence(path, source, locator) {
  if (!path) throw new Error(`${source} native evidence path is unavailable`);
  const calls = new Map(), records = new Map();
  let turnId = null;
  const identity = source === "root" ? locator.parentContextId : locator.childId;
  const file = readStableRollout(path, (entry, line) => {
    const value = entry.payload;
    if (line === 1) {
      if (entry.type !== "session_meta" || value?.id !== identity) throw new Error(`${source} transcript ownership mismatch`);
      if (source === "root") {
        if (value.parent_thread_id || value.source?.subagent) throw new Error("root transcript ownership mismatch");
      } else {
        const spawn = value.source?.subagent?.thread_spawn;
        if (value.parent_thread_id !== locator.parentContextId || value.session_id !== locator.parentContextId
          || value.agent_path !== locator.agentPath || spawn?.parent_thread_id !== locator.parentContextId
          || spawn.agent_path !== locator.agentPath || spawn.depth !== 1) throw new Error("child transcript ownership mismatch");
      }
    }
    if (entry.type === "turn_context" || (entry.type === "event_msg" && value?.type === "task_started")) turnId = value.turn_id;
    let record;
    if (entry.type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(value?.type)) {
        if (calls.has(value.call_id)) throw new Error("native evidence has duplicate call identity");
        calls.set(value.call_id, { ...value, turnId });
        record = { callId: value.call_id, turnId, kind: "call", isResult: false };
      } else if (["function_call_output", "custom_tool_call_output"].includes(value?.type)) {
        const call = calls.get(value.call_id);
        if (!call) return;
        const text = typeof value.output === "string" ? value.output : value.output?.[0]?.text;
        const native = (!call.namespace || call.namespace === "functions") && ["exec_command", "write_stdin"].includes(call.name);
        const forwarded = (!call.namespace || call.namespace === "functions") && call.name === "exec"
          ? forwardedToolCall(call.input ?? parseJson(call.arguments, {})?.code) : null;
        const forwardedResult = forwarded && /^Script completed(?:\n|$)/u.test(text || "")
          ? forwardedToolResult(value.output?.slice(1)) : null;
        const nativeEnd = native && typeof text === "string" && text.startsWith("Chunk ID: ")
          && /^Process exited with code -?[0-9]+$/mu.test(text.split("\nOutput:\n", 1)[0]);
        // A direct native tool error can support a no-start investigation. A
        // forwarded model print cannot; completed forwarding must be exact.
        const nativeError = native && typeof text === "string" && !text.startsWith("Chunk ID: ") && /error|failed|denied|rejected/iu.test(text);
        record = { callId: value.call_id, turnId: call.turnId, kind: "result",
          isResult: Boolean(nativeEnd || nativeError || forwardedResult?.state === "terminal"),
          executionStarted: Boolean(nativeEnd || forwardedResult?.state === "terminal") };
      }
    } else if (entry.type === "event_msg" && ["item_started", "item_completed"].includes(value?.type)
      && value.thread_id === identity && value.turn_id && typeof value.item?.id === "string") {
      const item = value.item;
      const command = item.type === "CommandExecution" && item.source === "unified_exec_startup";
      const patch = item.type === "FileChange";
      if (!command && !patch) return;
      const ended = value.type === "item_completed" && (command
        ? ["completed", "failed"].includes(item.status) && Number.isSafeInteger(item.exit_code)
        : ["completed", "failed", "declined"].includes(item.status) && item.changes && typeof item.changes === "object"
          && !Array.isArray(item.changes) && typeof item.stdout === "string" && typeof item.stderr === "string");
      record = { callId: item.id, turnId: value.turn_id, kind: "native_operation", isResult: Boolean(ended), executionStarted: true };
    }
    if (record) records.set(line, { ...record, source, line, digest: payloadHash(entry) });
  }, { allowAppend: source === "root" });
  return { records, ...file };
}

function rawState(db, child, commands, facts) {
  const messages = db.prepare("SELECT caller_turn_id,call_id,author,kind,input_digest,status FROM delegation_messages WHERE route_id=? ORDER BY revision").all(child.route_id);
  return payloadHash({ routeId: child.route_id, agentHash: child.agent_hash, commands, messages,
    inputs: facts.messages.map(({ line: _line, ...message }) => message), operations: facts.operationDigest });
}

function pendingOperations(facts) {
  const operations = facts.pendingOperations.map((op) => ({ ...op, operationId: `${op.kind}:${op.id}` }));
  for (const callId of facts.pendingCalls) if (!operations.some((op) => op.callId === callId)) {
    operations.push({ kind: "call", id: callId, callId, operationId: `call:${callId}`, state: "result_pending" });
  }
  return operations;
}

function reviewRecords(db, routeId) {
  return db.prepare("SELECT record FROM delegation_stage_journal WHERE route_id=? AND kind='operation_review' ORDER BY revision")
    .all(routeId).map((row) => JSON.parse(openPrivateState(db, row.record)));
}

function evidenceContext(db, context, child, commands, facts) {
  const locator = JSON.parse(openPrivateState(db, child.locator));
  const childEvidence = transcriptEvidence(locator.transcriptPath, "child", locator);
  if (childEvidence.transcriptDigest !== facts.transcriptDigest) throw new Error("child evidence changed while reading the operation snapshot");
  const rootPath = rememberedRootTranscript(db, context);
  const rootEvidence = transcriptEvidence(rootPath, "root", locator);
  const resolveReference = (ref) => {
    if (ref?.source === "command_journal") {
      const command = commands.find((row) => row.callId === ref.callId);
      if (!command || ref.digest !== payloadHash(command)) throw new Error("original command evidence changed");
      return { ...command, source: "command_journal", executionStarted: command.terminal, isResult: false };
    }
    const record = (ref?.source === "root" ? rootEvidence : ref?.source === "child" ? childEvidence : null)?.records.get(ref?.line);
    if (!record || ref.digest !== record.digest || (ref.callId && record.callId !== ref.callId)
      || (ref.turnId && record.turnId !== ref.turnId)) throw new Error("native evidence reference is missing or changed");
    return record;
  };
  return { locator, rootPath, rootEvidence, childEvidence, resolveReference };
}

function validateItem(item, op, evidence) {
  if (!op || !present(item.basis) || !present(item.resultReview)) throw new Error("Review must identify one current operation and its actual verification");
  const original = evidence.resolveReference(item.original);
  if (original.source === "root" || original.callId !== op.callId) throw new Error("original evidence does not identify this child operation");
  const receipts = item.evidence.map(evidence.resolveReference);
  if (item.conclusion === "unresolved") {
    if (!["source", "owner", "nextStep", "resumeCondition"].every((key) => present(item.unresolved?.[key]))) {
      throw new Error("Unknown work needs its source, owner, next step and resume condition");
    }
  } else {
    if (!terminal.has(item.conclusion) || !receipts.some((receipt) => receipt.isResult)) throw new Error("A terminal review needs an actual native result or root verification receipt");
    if (item.conclusion === "not_started" && (["process", "cell"].includes(op.kind) || original.executionStarted
      || [...evidence.childEvidence.records.values()].some((receipt) => receipt.callId === op.callId && receipt.executionStarted))) {
      throw new Error("An existing handle or execution result cannot be recorded as not started");
    }
  }
}

/** Re-evaluate retained judgments against current evidence at every closure.
 * A missing/changed receipt makes the operation pending again; history is kept.
 * This never turns an ended operation into a successful business outcome. */
export function applyOperationReviews(db, context, child, commands, facts) {
  const history = reviewRecords(db, child.route_id);
  if (!history.length) return facts;
  const snapshotDigest = rawState(db, child, commands, facts);
  const applicable = history.filter((entry) => entry.snapshotDigest === snapshotDigest);
  const operations = pendingOperations(facts);
  let evidence;
  try { evidence = applicable.length ? evidenceContext(db, context, child, commands, facts) : null; } catch { /* retain all work */ }
  const latest = new Map(applicable.flatMap((entry) => entry.items).map((item) => [item.operationId, item]));
  const accepted = [];
  const pending = operations.filter((op) => {
    const item = latest.get(op.operationId);
    if (item && evidence) {
      try {
        validateItem(item, op, evidence);
        accepted.push(item);
        if (terminal.has(item.conclusion)) return false;
      } catch { /* no unverified exception can clear an operation */ }
    }
    return true;
  });
  return { ...facts, pendingOperations: pending, finished: facts.turnFinished && pending.length === 0,
    operationSnapshotDigest: snapshotDigest, operationReviewDigest: payloadHash(accepted) };
}

export function readOperations(db, context, child) {
  const locator = JSON.parse(openPrivateState(db, child.locator));
  const commands = readChildCommands(db, child.route_id);
  const facts = readChildTurnEvidence(locator, { commands });
  const snapshotDigest = rawState(db, child, commands, facts);
  const evidence = evidenceContext(db, context, child, commands, facts);
  const history = reviewRecords(db, child.route_id);
  const latest = new Map(history.filter((entry) => entry.snapshotDigest === snapshotDigest)
    .flatMap((entry) => entry.items).map((item) => [item.operationId, item]));
  const operations = pendingOperations(facts).flatMap((op) => {
    const command = commands.find((row) => op.kind === "command" && row.callId === op.callId);
    const matching = [...evidence.childEvidence.records.values()].filter((row) => row.callId === op.callId);
    const call = matching.find((row) => row.kind === "call") || matching.find((row) => row.kind === "native_operation");
    const origin = command ? { source: "command_journal", callId: command.callId, digest: payloadHash(command) }
      : call ? reference(call) : null;
    const review = latest.get(op.operationId);
    let valid = false;
    try { if (review) { validateItem(review, op, evidence); valid = true; } } catch { /* show stale evidence */ }
    if (valid && terminal.has(review.conclusion)) return [];
    return [{ ...op, origin, ...(review ? { review, reviewValid: valid } : {}) }];
  });
  return { revision: child.revision, snapshotDigest, childId: locator.childId,
    childTranscriptPath: locator.transcriptPath, rootTranscriptPath: evidence.rootPath, operations,
    rootEvidence: [...evidence.rootEvidence.records.values()].filter((row) => row.isResult).slice(-30).map(reference) };
}

export function reconcileOperations(db, context, child, input) {
  const review = input.operationReview;
  if (!review?.items?.length) throw new Error("Operation reconciliation requires explicit evidence and operation coverage");
  const view = readOperations(db, context, child);
  if (review.snapshotDigest !== view.snapshotDigest) throw new Error("Operation snapshot changed; read and verify the current evidence");
  const inputHash = payloadHash(review);
  const previous = reviewRecords(db, child.route_id).at(-1);
  if (previous?.inputHash === inputHash && previous.appliedRevision === child.revision
    && [previous.expectedRevision, previous.appliedRevision].includes(input.expectedRevision)) return { idempotent: true, revision: child.revision };
  if (input.expectedRevision !== child.revision) throw new Error("Stage revision changed; inspect the latest operation snapshot");
  if (new Set(review.items.map((item) => item.operationId)).size !== review.items.length) throw new Error("Each operation needs exactly one review");
  const locator = JSON.parse(openPrivateState(db, child.locator));
  const commands = readChildCommands(db, child.route_id);
  const facts = readChildTurnEvidence(locator, { commands });
  if (rawState(db, child, commands, facts) !== view.snapshotDigest) throw new Error("Operation snapshot changed during verification");
  const evidence = evidenceContext(db, context, child, commands, facts);
  for (const item of review.items) validateItem(item, view.operations.find((op) => op.operationId === item.operationId), evidence);
  const revision = child.revision + 1;
  const record = { ...review, inputHash, expectedRevision: child.revision, appliedRevision: revision };
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO delegation_stage_journal(route_id,revision,kind,record,created_at) VALUES(?,?,'operation_review',?,?)")
    .run(child.route_id, revision, sealPrivateState(db, JSON.stringify(record)), timestamp);
  db.prepare("UPDATE delegation_children SET revision=?,verified_revision=NULL,verified_digest=NULL,updated_at=? WHERE route_id=?")
    .run(revision, timestamp, child.route_id);
  db.prepare("UPDATE delegation_child_commands SET verified=0 WHERE route_id=?").run(child.route_id);
  return { revision, resolved: review.items.filter((item) => terminal.has(item.conclusion)).length,
    unresolved: review.items.filter((item) => item.conclusion === "unresolved").length,
    nextAction: "inspect_stageClosure_and_verify_the_current_result" };
}
