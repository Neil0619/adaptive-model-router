import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseCarrierTaskName } from "./delegation-gate.mjs";
import { payloadHash } from "./io.mjs";

export const PREDISPATCH_RECOVERY_SCHEMA = "native-thread-predispatch-rejection-recovery/1";
const ADAPTER = "codex-0.153.4-parent-profile-rejection-v1";
const MAX_BYTES = 64 * 1024 * 1024;
const REJECTION = "Tool call blocked by PreToolUse hook: Router-marked Agent model or reasoning effort does not match the admitted route.. Tool: collaborationspawn_agent";
const RECORD_TYPES = new Set(["session_meta", "event_msg", "response_item", "world_state", "turn_context",
  "token_usage_record", "inter_agent_communication_metadata", "compacted"]);
const EVENT_TYPES = new Set(["task_started", "task_complete", "item_completed", "token_count", "thread_settings_applied"]);
const RESPONSE_TYPES = new Set(["message", "agent_message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const present = (value) => typeof value === "string" && value.length > 0;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const requireFact = (value) => { if (!value) throw new Error("native pre-dispatch rejection evidence is unproven"); };

export function isPredispatchRecoveryReceipt(receipt, context, routeId) {
  return receipt.schemaVersion === PREDISPATCH_RECOVERY_SCHEMA
    && receipt.recoveryKind === "rejected_before_dispatch"
    && receipt.rawAuditAdapter === ADAPTER && receipt.cliVersion === "0.153.4"
    && receipt.subjectDigest === payloadHash([context.projectId, context.contextKey, routeId])
    && receipt.status === "reconciled_failure" && receipt.failureType === "tooling"
    && receipt.source === "native_thread_read" && receipt.originalHandshakeProven === false
    && receipt.originalDispatchConsumed === false && receipt.transcriptBytes === 0
    && receipt.rejectionCode === "ROUTER_SPAWN_PROFILE_MISMATCH"
    && present(receipt.recordedAt) && Number.isFinite(Date.parse(receipt.recordedAt))
    && Number.isSafeInteger(receipt.sourceBytes) && receipt.sourceBytes > 0 && receipt.sourceBytes <= MAX_BYTES
    && ["evidenceDigest", "rawAuditDigest", "sourceDigest", "parentTurnDigest", "launchItemDigest",
      "rejectionItemDigest", "dispatchInputDigest"].every((key) => digest(receipt[key]));
}

// Read only the native thread/read path. Neither CLI nor MCP accepts a path or
// caller-written proof. Full, newline-terminated source is required; an active
// parent can append unrelated records after this bounded snapshot.
export function readNativeParentTranscript(path) {
  requireFact(present(path));
  const actual = realpathSync(path);
  requireFact(actual === resolve(path) && !lstatSync(path).isSymbolicLink());
  const codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  requireFact(["sessions", "archived_sessions"].some((directory) => {
    const child = relative(join(codexRoot, directory), actual);
    return child && child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
  }));
  const fd = openSync(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(fd);
    requireFact(before.isFile() && before.size > 0 && before.size <= MAX_BYTES);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireFact(count > 0);
      offset += count;
    }
    const after = statSync(actual);
    requireFact(before.dev === after.dev && before.ino === after.ino && after.size >= before.size);
    return bytes;
  } finally { closeSync(fd); }
}

export function auditNativePredispatchRejection(bytes, parent, attempt, contextId, cwd) {
  requireFact(parent?.id === contextId && parent.cliVersion === "0.153.4" && !parent.parentThreadId);
  requireFact(present(parent.cwd) && resolve(parent.cwd) === resolve(cwd));
  requireFact(attempt.ticket_consumed === 0 && attempt.post_observed === 0 && attempt.stop_observed === 0
    && attempt.outcome_recorded === 0 && attempt.no_child === 0 && !attempt.finalized_at
    && !attempt.agent_id && !attempt.early_agent_id && digest(attempt.ticket_hash));
  requireFact(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES);
  const source = bytes.toString("utf8");
  requireFact(source.endsWith("\n") && !source.includes("\uFFFD"));
  const records = source.trimEnd().split("\n").map((line) => JSON.parse(line));
  requireFact(records.length <= 100_000 && records.every((r) => RECORD_TYPES.has(r?.type)
    && r.payload && typeof r.payload === "object"));
  const metas = records.filter((r) => r.type === "session_meta").map((r) => r.payload);
  requireFact(metas.length === 1 && metas[0].id === contextId && !metas[0].parent_thread_id
    && metas[0].cli_version === "0.153.4" && metas[0].originator === "Codex Desktop"
    && metas[0].source === "vscode" && resolve(metas[0].cwd) === resolve(cwd));
  const calls = [], outputs = [], activities = [];
  const started = new Set();
  let currentTurn = null;
  for (const record of records) {
    const item = record.payload;
    if (record.type === "event_msg") {
      requireFact(EVENT_TYPES.has(item.type));
      if (item.type === "task_started") {
        requireFact(present(item.turn_id) && !started.has(item.turn_id));
        started.add(item.turn_id);
      }
      if (item.type === "item_completed" && item.item?.type === "subAgentActivity") activities.push(item.item);
    }
    if (record.type === "turn_context") {
      requireFact(present(item.turn_id) && started.has(item.turn_id));
      currentTurn = item.turn_id;
    }
    if (record.type !== "response_item") continue;
    requireFact(RESPONSE_TYPES.has(item.type));
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      calls.push({ item, turnId: currentTurn });
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) outputs.push({ item, turnId: currentTurn });
  }
  const matches = calls.filter(({ item }) => {
    if (item.type !== "function_call" || item.name !== "spawn_agent" || item.namespace !== "collaboration") return false;
    const args = JSON.parse(item.arguments);
    const carrier = parseCarrierTaskName(args?.task_name);
    return carrier.valid && hash(carrier.ticket) === attempt.ticket_hash;
  });
  requireFact(matches.length === 1);
  const [{ item: call, turnId }] = matches;
  requireFact(present(call.call_id) && present(turnId));
  const args = JSON.parse(call.arguments);
  requireFact(Object.keys(args).every((key) => ["task_name", "message", "fork_turns", "model", "reasoning_effort"].includes(key)));
  requireFact(present(args.message) && args.fork_turns === "none"
    && (args.model !== attempt.model || args.reasoning_effort !== attempt.effort));
  requireFact(calls.filter(({ item }) => item.call_id === call.call_id).length === 1);
  // A second use through any call surface is ambiguous, even if it did not use
  // the admitted direct spawn tool or was merely another failed attempt.
  requireFact(calls.filter(({ item }) => String(item.arguments ?? item.input ?? "").includes(args.task_name)).length === 1);
  const results = outputs.filter(({ item }) => item.call_id === call.call_id);
  requireFact(results.length === 1 && results[0].turnId === turnId
    && results[0].item.type === "function_call_output" && results[0].item.output === REJECTION);
  const result = results[0].item;
  requireFact(records.findIndex((r) => r.payload === call) < records.findIndex((r) => r.payload === result));
  requireFact(Array.isArray(parent.turns) && parent.turns.length <= 10_000);
  const turns = parent.turns.filter((turn) => turn.id === turnId);
  requireFact(turns.length === 1);
  for (const turn of parent.turns) {
    requireFact(turn.itemsView === "full" && Array.isArray(turn.items) && turn.items.length <= 100_000);
    activities.push(...turn.items.filter((item) => item.type === "subAgentActivity"));
  }
  requireFact(activities.every((item) => !String(item.agentPath ?? "").includes(args.task_name)));
  // Hash the exact host-authored subject, not unrelated live-parent output.
  // Every snapshot is fully scanned above, so appended replay/child evidence
  // still blocks recovery while ordinary parent progress does not cause a loop.
  return {
    schemaVersion: PREDISPATCH_RECOVERY_SCHEMA, recoveryKind: "rejected_before_dispatch",
    cliVersion: "0.153.4", rawAuditAdapter: ADAPTER,
    rejectionCode: "ROUTER_SPAWN_PROFILE_MISMATCH", originalDispatchConsumed: false,
    parentTurnDigest: hash(turnId), launchItemDigest: hash(call.call_id),
    rejectionItemDigest: payloadHash(result), dispatchInputDigest: payloadHash(args),
    rawAuditDigest: payloadHash([ADAPTER, metas[0], turnId, call, result]),
  };
}

export async function inspectNativePredispatchRejection({ parent, read, attempt, contextId, cwd,
  readParentTranscript = readNativeParentTranscript }) {
  const first = auditNativePredispatchRejection(await readParentTranscript(parent.path), parent, attempt, contextId, cwd);
  const next = await read(contextId);
  requireFact(next.path === parent.path);
  const bytes = await readParentTranscript(next.path);
  // Re-read the native projection after the source read too, closing a child
  // appearing between the two evidence surfaces. State is CAS-checked on apply.
  const finalParent = await read(contextId);
  requireFact(finalParent.path === parent.path);
  const second = auditNativePredispatchRejection(bytes, finalParent, attempt, contextId, cwd);
  requireFact(payloadHash(first) === payloadHash(second));
  return { projection: second, sourceBytes: bytes.length, sourceDigest: hash(bytes) };
}
