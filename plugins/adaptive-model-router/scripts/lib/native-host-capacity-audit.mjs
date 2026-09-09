import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseCarrierTaskName } from "./delegation-gate.mjs";
import { payloadHash } from "./io.mjs";
import { CAPACITY_RECOVERY_SCHEMA, CAPACITY_AUDIT_ADAPTER, CAPACITY_REJECTION, CAPACITY_REASON,
  CAPACITY_SOURCE_BYTE_LIMIT, capacityAttemptEligible } from "./host-capacity-recovery.mjs";

const MAX_LINE_BYTES = 16 * 1024 * 1024, MAX_RECORDS = 100_000;
const RECORD_TYPES = new Set(["session_meta", "event_msg", "response_item", "world_state", "turn_context",
  "token_usage_record", "inter_agent_communication_metadata", "compacted"]);
const EVENT_TYPES = new Set(["task_started", "task_complete", "item_completed", "token_count", "thread_settings_applied"]);
const RESPONSE_TYPES = new Set(["message", "agent_message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const present = value => typeof value === "string" && value.length > 0;
const requireFact = value => { if (!value) throw new Error("native host capacity rejection evidence is unproven"); };

// Take a fixed-size snapshot through a pinned regular-file descriptor. Each
// iterator rereads and hashes the whole snapshot, retaining at most one bounded
// JSON record. Appends are allowed; truncation, replacement, or a partial last
// record are not. No caller-selectable source or limit is exposed by the CLI.
function openNativeSnapshot(path) {
  requireFact(present(path));
  const actual = realpathSync(path), root = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  requireFact(actual === resolve(path) && !lstatSync(path).isSymbolicLink());
  requireFact(["sessions", "archived_sessions"].some(directory => {
    const child = relative(join(root, directory), actual);
    return child && child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
  }));
  const fd = openSync(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(fd);
    requireFact(before.isFile() && before.size > 0 && before.size <= CAPACITY_SOURCE_BYTE_LIMIT);
    return { size: before.size,
      *lines() {
        let offset = 0, pending = Buffer.alloc(0);
        while (offset < before.size) {
          const chunk = Buffer.alloc(Math.min(1024 * 1024, before.size - offset));
          const count = readSync(fd, chunk, 0, chunk.length, offset);
          requireFact(count > 0); offset += count;
          const bytes = Buffer.concat([pending, chunk.subarray(0, count)]);
          let start = 0, end;
          while ((end = bytes.indexOf(10, start)) !== -1) {
            requireFact(end - start + 1 <= MAX_LINE_BYTES);
            yield bytes.subarray(start, end + 1); start = end + 1;
          }
          pending = Buffer.from(bytes.subarray(start));
          requireFact(pending.length <= MAX_LINE_BYTES);
        }
        requireFact(pending.length === 0);
        const after = statSync(actual);
        requireFact(before.dev === after.dev && before.ino === after.ino && after.size >= before.size);
      }, close() { closeSync(fd); } };
  } catch (error) { closeSync(fd); throw error; }
}

function bufferSnapshot(bytes) {
  requireFact(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= CAPACITY_SOURCE_BYTE_LIMIT);
  return { size: bytes.length, *lines() {
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      requireFact(end - start + 1 <= MAX_LINE_BYTES);
      yield bytes.subarray(start, end + 1); start = end + 1;
    }
    requireFact(start === bytes.length);
  }, close() {} };
}

function scan(snapshot, visit) {
  const digest = createHash("sha256"); let count = 0, size = 0;
  for (const line of snapshot.lines()) {
    requireFact(++count <= MAX_RECORDS); size += line.length; digest.update(line);
    const text = line.toString("utf8"); requireFact(!text.includes("\uFFFD"));
    const record = JSON.parse(text);
    requireFact(RECORD_TYPES.has(record?.type) && record.payload && typeof record.payload === "object");
    if (record.type === "event_msg") requireFact(EVENT_TYPES.has(record.payload.type));
    if (record.type === "response_item") requireFact(RESPONSE_TYPES.has(record.payload.type));
    visit(record, count);
  }
  requireFact(size === snapshot.size);
  return digest.digest("hex");
}

function audit(snapshot, parent, attempt, contextId, cwd) {
  requireFact(parent?.id === contextId && parent.cliVersion === "0.153.4" && !parent.parentThreadId
    && present(parent.cwd) && resolve(parent.cwd) === resolve(cwd) && capacityAttemptEligible(attempt));
  let call = null, callCount = 0;
  const firstDigest = scan(snapshot, ({ type, payload }) => {
    if (type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)
      && payload.call_id === attempt.tool_use_id) { call = payload; callCount += 1; }
  });
  requireFact(callCount === 1 && call.type === "function_call" && call.name === "spawn_agent" && call.namespace === "collaboration");
  const args = JSON.parse(call.arguments), carrier = parseCarrierTaskName(args?.task_name);
  requireFact(carrier.valid && hash(carrier.ticket) === attempt.ticket_hash
    && Object.keys(args).length === 5 && Object.keys(args).every(key => ["task_name", "message", "fork_turns", "model", "reasoning_effort"].includes(key))
    && present(args.message) && args.fork_turns === "none" && args.model === attempt.model
    && args.reasoning_effort === attempt.effort && payloadHash(args) === attempt.dispatch_input_digest);
  const checkActivity = item => requireFact(item.id !== call.call_id && !String(item.agentPath ?? "").includes(args.task_name));
  const started = new Set(); let currentTurn = null, meta = null, metas = 0, mentions = 0, outputs = 0, result = null, callIndex = 0;
  const secondDigest = scan(snapshot, ({ type, payload: item }, index) => {
    if (type === "session_meta") { meta = item; metas += 1; }
    if (type === "event_msg") {
      if (item.type === "task_started") {
        requireFact(present(item.turn_id) && !started.has(item.turn_id)); started.add(item.turn_id);
      }
      if (item.type === "item_completed" && item.item?.type === "subAgentActivity") checkActivity(item.item);
    }
    if (type === "turn_context") { requireFact(present(item.turn_id) && started.has(item.turn_id)); currentTurn = item.turn_id; }
    if (type !== "response_item") return;
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      if (String(item.arguments ?? item.input ?? "").includes(args.task_name)) mentions += 1;
      if (item.call_id === call.call_id) { requireFact(currentTurn === attempt.root_turn_id); callIndex = index; }
    }
    if (["function_call_output", "custom_tool_call_output"].includes(item.type) && item.call_id === call.call_id) {
      requireFact(item.type === "function_call_output" && item.output === CAPACITY_REJECTION
        && currentTurn === attempt.root_turn_id && callIndex > 0 && index > callIndex);
      outputs += 1; result = item;
    }
  });
  requireFact(firstDigest === secondDigest && mentions === 1 && outputs === 1 && metas === 1
    && meta.id === contextId && !meta.parent_thread_id && meta.cli_version === "0.153.4"
    && meta.originator === "Codex Desktop" && meta.source === "vscode" && resolve(meta.cwd) === resolve(cwd));
  requireFact(Array.isArray(parent.turns) && parent.turns.length <= 10_000
    && parent.turns.filter(t => t.id === attempt.root_turn_id).length === 1);
  for (const turn of parent.turns) {
    requireFact(turn.itemsView === "full" && Array.isArray(turn.items) && turn.items.length <= MAX_RECORDS);
    for (const item of turn.items) if (item.type === "subAgentActivity") checkActivity(item);
  }
  return { projection: { schemaVersion: CAPACITY_RECOVERY_SCHEMA, recoveryKind: "host_agent_limit_rejected",
    cliVersion: "0.153.4", rawAuditAdapter: CAPACITY_AUDIT_ADAPTER, rejectionCode: CAPACITY_REASON,
    originalDispatchConsumed: true, parentTurnDigest: hash(attempt.root_turn_id), launchItemDigest: hash(call.call_id),
    rejectionItemDigest: payloadHash(result), dispatchInputDigest: payloadHash(args),
    rawAuditDigest: payloadHash([CAPACITY_AUDIT_ADAPTER, meta, attempt.root_turn_id, call, result]) },
    sourceBytes: snapshot.size, sourceDigest: secondDigest };
}

export async function inspectNativeHostCapacityRejection({ parent, read, attempt, contextId, cwd, readParentTranscript }) {
  const inspect = async (sourceParent, projectionParent) => {
    const snapshot = readParentTranscript ? bufferSnapshot(await readParentTranscript(sourceParent.path)) : openNativeSnapshot(sourceParent.path);
    try { return audit(snapshot, projectionParent, attempt, contextId, cwd); } finally { snapshot.close(); }
  };
  const first = await inspect(parent, parent);
  const next = await read(contextId); requireFact(next.path === parent.path);
  // Pin the source before the final projection read so newly reported child
  // activity cannot be hidden between the two independent evidence surfaces.
  const snapshot = readParentTranscript ? bufferSnapshot(await readParentTranscript(next.path)) : openNativeSnapshot(next.path);
  try {
    const finalParent = await read(contextId); requireFact(finalParent.path === parent.path);
    const second = audit(snapshot, finalParent, attempt, contextId, cwd);
    requireFact(payloadHash(first.projection) === payloadHash(second.projection));
    return second;
  } finally { snapshot.close(); }
}
