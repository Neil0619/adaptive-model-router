import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

export const RECOVERY_AUDIT_ADAPTER = "codex-0.153.0-alpha.5-no-work/1";
export const LIFECYCLE_AUDIT_ADAPTER = "codex-0.153.0-no-work/1";
export const LIFECYCLE_1533_AUDIT_ADAPTER = "codex-0.153.3-no-work/1";
export const LIFECYCLE_1534_AUDIT_ADAPTER = "codex-0.153.4-no-work/1";
export const LIFECYCLE_1540_ALPHA_6_2_AUDIT_ADAPTER = "codex-0.154.0-alpha.6.2-no-work/1";
const MAX_BYTES = 2 * 1024 * 1024;
const RECORD_TYPES = new Set(["session_meta", "event_msg", "response_item", "world_state",
  "turn_context", "inter_agent_communication_metadata", "token_usage_record"]);
const EVENT_TYPES = new Set(["task_started", "task_complete", "item_completed", "token_count"]);

function requireFact(value) {
  if (!value) throw new Error("native recovery transcript coverage is unproven");
}

export function readNativeRecoveryTranscript(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    requireFact(offset > 0 && offset <= MAX_BYTES);
    return buffer.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

// thread/read's full projection omits code-mode calls. This deliberately narrow
// adapter checks the complete bounded source stream as well, not message text.
// The transcript is not a stable public Hook interface: unknown builds, record
// types or actions fail closed and require a separately reviewed adapter.
export function auditNativeRecoveryTranscript(bytes, child, parentId) {
  return auditNoWorkTranscript(bytes, child, parentId, "0.153.0-alpha.5", RECOVERY_AUDIT_ADAPTER);
}

// The 0.153.0 native probe stream was reviewed separately. Do not silently
// rebind historical recovery receipts to this adapter or accept a version range.
export function auditNativeLifecycleTranscript(bytes, child, parentId) {
  return auditNoWorkTranscript(bytes, child, parentId, "0.153.0", LIFECYCLE_AUDIT_ADAPTER);
}

// Reviewed against the 0.153.3 native GPT-6 no-op source stream. It has the
// same bounded record/action vocabulary; keep its build and receipt separate.
export function auditNativeLifecycle1533Transcript(bytes, child, parentId) {
  return auditNoWorkTranscript(bytes, child, parentId, "0.153.3", LIFECYCLE_1533_AUDIT_ADAPTER);
}

// The native macOS and Windows 0.153.4 hosts retain the reviewed 0.153.3 record/action
// vocabulary. Keep its receipt separately pinned; unknown actions fail closed.
export function auditNativeLifecycle1534Transcript(bytes, child, parentId) {
  return auditNoWorkTranscript(bytes, child, parentId, "0.153.4", LIFECYCLE_1534_AUDIT_ADAPTER);
}

// Reviewed against the complete native macOS Desktop no-tool stream. Its
// record/action vocabulary is unchanged; adjacent builds remain unproven.
export function auditNativeLifecycle1540Alpha62Transcript(bytes, child, parentId) {
  return auditNoWorkTranscript(bytes, child, parentId, "0.154.0-alpha.6.2", LIFECYCLE_1540_ALPHA_6_2_AUDIT_ADAPTER);
}

function auditNoWorkTranscript(bytes, child, parentId, version, adapter) {
  requireFact(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES);
  requireFact(child.cliVersion === version);
  const source = bytes.toString("utf8");
  requireFact(source.endsWith("\n") && !source.includes("\uFFFD"));
  const records = source.trimEnd().split("\n").map((line) => JSON.parse(line));
  requireFact(records.length <= 1_000 && records.every((record) => RECORD_TYPES.has(record?.type)
    && record.payload && typeof record.payload === "object"));
  const select = (type) => records.filter((record) => record.type === type).map((record) => record.payload);
  const [turn] = child.turns;
  const metas = select("session_meta");
  requireFact(metas.length === 1 && metas[0].id === child.id
    && metas[0].parent_thread_id === parentId && metas[0].cli_version === child.cliVersion);
  const contexts = select("turn_context");
  requireFact(contexts.length === 1 && contexts[0].turn_id === turn.id
    && contexts[0].model === child.model && contexts[0].effort === child.reasoningEffort);
  const events = select("event_msg");
  requireFact(events.every((event) => EVENT_TYPES.has(event.type)));
  for (const type of ["task_started", "task_complete"]) {
    const matches = events.filter((event) => event.type === type);
    requireFact(matches.length === 1 && matches[0].turn_id === turn.id);
  }
  const allowedInteractions = new Set(turn.items.filter((item) => item.type === "subAgentActivity"
    && item.kind === "interacted" && item.agentThreadId === parentId && item.agentPath === "/root")
    .map((item) => item.id));
  const calls = new Set();
  const outputs = new Set();
  const finals = [];
  for (const item of select("response_item")) {
    if (item.type === "reasoning" || item.type === "agent_message") continue;
    if (item.type === "message") {
      requireFact(["system", "developer", "user", "assistant"].includes(item.role));
      if (item.role === "assistant") {
        const native = turn.items.find((candidate) => candidate.type === "agentMessage" && candidate.id === item.id);
        requireFact(native && native.phase === item.phase && Array.isArray(item.content));
        requireFact(item.content.every((part) => ["output_text", "input_text"].includes(part.type)));
        requireFact(item.content.map((part) => part.text).join("") === native.text);
        if (item.phase === "final_answer") finals.push(item.id);
      }
      continue;
    }
    if (item.type === "function_call") {
      requireFact(item.name === "send_message" && item.namespace === "collaboration"
        && allowedInteractions.has(item.call_id) && !calls.has(item.call_id));
      calls.add(item.call_id);
      continue;
    }
    requireFact(item.type === "function_call_output" && calls.has(item.call_id) && !outputs.has(item.call_id));
    outputs.add(item.call_id);
  }
  requireFact(finals.length === 1 && calls.size === allowedInteractions.size && calls.size === outputs.size);
  return { rawAuditAdapter: adapter,
    rawAuditDigest: createHash("sha256").update(bytes).digest("hex"), sourceBytes: bytes.length };
}
