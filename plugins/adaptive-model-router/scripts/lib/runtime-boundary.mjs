import { NativeOperationEvidence } from "./native-operation-evidence.mjs";
import { readStableRollout, rolloutIdentity } from "./native-rollout-reader.mjs";
import { payloadHash } from "./io.mjs";
import { createHash } from "node:crypto";
import { rootCoverageKey, settleCoveredRootBatches } from "./runtime-root-operations.mjs";

const proofs = new WeakMap();
const boundaryState = (db, context) => payloadHash([
  db.prepare("SELECT * FROM runtime_tasks WHERE project_id=? AND context_key=?").get(context.projectId, context.contextKey),
  db.prepare("SELECT * FROM runtime_defaults").all(),
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_epoch_ordinary_defaults'").get()
    ? db.prepare("SELECT * FROM runtime_epoch_ordinary_defaults ORDER BY writer_digest,shell_digest").all() : [],
  db.prepare("SELECT * FROM runtime_root_commands WHERE project_id=? AND context_key=? ORDER BY call_id").all(context.projectId, context.contextKey),
  db.prepare("SELECT value FROM meta WHERE key=?").get(rootCoverageKey(context)),
]);

// UserPromptSubmit is only a chance to inspect a boundary. Neither this Hook,
// root Stop, nor an expired invocation proves that the prior native turn ended.
export function inspectRuntimeBoundary(input, previousTurn, { db = null, context = null, deadline = Date.now() + 250 } = {}) {
  if (input.hook_event_name !== "UserPromptSubmit" || input.agent_id || input.agent_type
    || !previousTurn || !input.turn_id || previousTurn === input.turn_id || !input.transcript_path) return null;
  try {
    const state = db && context ? boundaryState(db, context) : null;
    const identity = rolloutIdentity(input.transcript_path);
    let owner = false, turn = null, completed = false, sawPrevious = false;
    const coverage = db && context ? JSON.parse(db.prepare("SELECT value FROM meta WHERE key=?").get(rootCoverageKey(context))?.value || "null") : null;
    const commands = db && context ? db.prepare("SELECT * FROM runtime_root_commands WHERE project_id=? AND context_key=?").all(context.projectId, context.contextKey)
      .map((row) => ({ callId: row.call_id, turnId: row.turn_id, commandDigest: row.command_digest,
        started: row.pre_seen === 1, terminal: row.post_seen === 1, conflicted: row.conflicted === 1 })) : [];
    const operations = new NativeOperationEvidence({ childId: input.session_id, commands });
    const prefix = createHash("sha256"); let covered = false;
    const pending = new Set();
    const source = readStableRollout(input.transcript_path, (entry, line) => {
      const item = entry.payload;
      operations.observe(entry);
      if (operations.calls.has(item?.call_id) && ["function_call", "custom_tool_call"].includes(item?.type)) operations.calls.get(item.call_id).prospectiveRootCoverage = covered;
      if (coverage && line <= coverage.throughLine) {
        prefix.update(JSON.stringify(entry) + "\n");
        if (line === coverage.throughLine) {
          if (prefix.digest("hex") !== coverage.prefixDigest) throw new Error("Root command coverage prefix changed");
          covered = true;
        }
      }
      if (line === 1) {
        owner = entry.type === "session_meta" && item?.id === input.session_id && !item.parent_thread_id && !item.source?.subagent;
        if (!owner) throw new Error("Native root ownership mismatch");
      }
      if (entry.type === "turn_context" || (entry.type === "event_msg" && item?.type === "task_started")) turn = item.turn_id;
      if (turn !== previousTurn) return;
      sawPrevious = true;
      if (entry.type === "response_item" && ["function_call", "custom_tool_call"].includes(item?.type)) {
        if (!item.call_id || pending.has(item.call_id) || completed) throw new Error("Unsettled native boundary");
        pending.add(item.call_id);
      }
      if (entry.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(item?.type)) {
        if (!pending.delete(item.call_id)) throw new Error("Unmatched native output");

      }
      if (entry.type === "event_msg" && item?.type === "task_complete" && item.turn_id === previousTurn) {
        if (pending.size || completed) throw new Error("Ambiguous native completion");
        completed = true;
      }
    }, { allowAppend: true, deadline });
    settleCoveredRootBatches(operations, commands);
    if (!owner || !sawPrevious || !completed || pending.size || operations.active.size || operations.unanswered.size) return null;
    if (identity !== rolloutIdentity(input.transcript_path) || Date.now() > deadline) return null;
    const proof = Object.freeze({ previousTurn, nextTurn: input.turn_id, digest: payloadHash({ ...source, previousTurn, nextTurn: input.turn_id }) });
    proofs.set(proof, { db, context, state, identity, path: input.transcript_path, deadline });
    return proof;
  } catch { return null; }
}

export function isRuntimeBoundaryProof(value, db = null, context = null) {
  const saved = proofs.get(value);
  if (!saved) return false;
  try {
    return Date.now() <= saved.deadline && rolloutIdentity(saved.path) === saved.identity
      && (!saved.db || (saved.db === db && saved.context.projectId === context?.projectId && saved.context.contextKey === context?.contextKey
        && saved.state === boundaryState(db, context)));
  } catch { return false; }
}
