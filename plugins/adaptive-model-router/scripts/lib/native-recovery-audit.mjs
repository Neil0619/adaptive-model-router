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

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const nonempty = (value) => typeof value === "string" && value.length > 0;
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));

// Additional-tools records declare host capabilities; they are not calls.
// Validate the known declaration grammar rather than ignoring arbitrary
// records under this label. JSON Schema and grammar bodies remain inert data.
function toolDeclaration(tool, namespaceAllowed = true) {
  if (!object(tool) || !nonempty(tool.name) || typeof tool.description !== "string") return false;
  if (tool.type === "namespace") return namespaceAllowed
    && onlyKeys(tool, ["type", "name", "description", "tools"])
    && Array.isArray(tool.tools) && tool.tools.every((entry) => toolDeclaration(entry, false));
  if (tool.type === "function") return onlyKeys(tool, ["type", "name", "description", "strict", "parameters"])
    && typeof tool.strict === "boolean" && object(tool.parameters);
  if (tool.type === "custom") return onlyKeys(tool, ["type", "name", "description", "format"])
    && onlyKeys(tool.format, ["type", "syntax", "definition"])
    && tool.format.type === "grammar" && ["lark", "regex"].includes(tool.format.syntax)
    && nonempty(tool.format.definition);
  return false;
}

function contractToolDeclaration(item) {
  requireFact(onlyKeys(item, ["type", "id", "role", "tools"])
    && item.role === "developer" && nonempty(item.id)
    && Array.isArray(item.tools) && item.tools.every((tool) => toolDeclaration(tool)));
}

// Settings snapshots are host metadata, not execution receipts. Accept additive
// fields inside this known envelope without depending on a host version or UI
// settings vocabulary. Every snapshot must still agree with the actual child;
// neither it nor a new field can authorize a response/tool action. Historical
// version-pinned readers retain their original event vocabulary.
function contractMetadata(event, child) {
  if (event.type !== "thread_settings_applied") return false;
  const settings = event.thread_settings;
  requireFact(event.thread_id === child.id && object(settings));
  requireFact(settings.model === child.model && settings.reasoning_effort === child.reasoningEffort);
  for (const [field, expected] of [["cwd", child.cwd], ["model_provider_id", child.modelProvider]]) {
    if (settings[field] !== undefined) requireFact(typeof settings[field] === "string"
      && (expected === undefined || settings[field] === expected));
  }
  if (settings.collaboration_mode !== undefined) {
    requireFact(object(settings.collaboration_mode) && object(settings.collaboration_mode.settings));
    const mode = settings.collaboration_mode.settings;
    requireFact(mode.model === child.model && mode.reasoning_effort === child.reasoningEffort);
  }
  return true;
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
// Historical readers keep their original labels and constraints. New calls use
// the semantic contract below; unknown executable records/actions still fail.
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
  if (version !== null) requireFact(child.cliVersion === version);
  const source = bytes.toString("utf8");
  requireFact(source.endsWith("\n") && !source.includes("\uFFFD"));
  const records = source.trimEnd().split("\n").map((line) => JSON.parse(line));
  requireFact(records.length <= 1_000 && records.every((record) => RECORD_TYPES.has(record?.type)
    && record.payload && typeof record.payload === "object"));
  const select = (type) => records.filter((record) => record.type === type).map((record) => record.payload);
  const [turn] = child.turns;
  const metas = select("session_meta");
  requireFact(metas.length === 1 && metas[0].id === child.id
    && metas[0].parent_thread_id === parentId
    && (version === null || metas[0].cli_version === child.cliVersion));
  const contexts = select("turn_context");
  requireFact(contexts.length === 1 && contexts[0].turn_id === turn.id
    && contexts[0].model === child.model && contexts[0].effort === child.reasoningEffort);
  const events = select("event_msg");
  requireFact(events.every((event) => EVENT_TYPES.has(event.type)
    || (version === null && contractMetadata(event, child))));
  if (version === null) for (const event of events.filter((entry) => entry.type === "item_completed")) {
    requireFact(event.thread_id === child.id && event.turn_id === turn.id && object(event.item));
    const item = event.item;
    requireFact(["Reasoning", "AgentMessage"].includes(item.type) && typeof item.id === "string");
    const native = turn.items.find((candidate) => candidate.id === item.id);
    requireFact(native && native.type === (item.type === "Reasoning" ? "reasoning" : "agentMessage"));
    if (item.type === "AgentMessage") {
      requireFact(item.phase === native.phase && Array.isArray(item.content)
        && item.content.every((part) => part.type === "Text" && typeof part.text === "string")
        && item.content.map((part) => part.text).join("") === native.text);
    }
  }
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
    if (version === null && item.type === "additional_tools") {
      contractToolDeclaration(item);
      continue;
    }
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

export function auditNativeContractNoWorkTranscript(bytes, child, parentId) {
  return auditNoWorkTranscript(bytes, child, parentId, null, "native-child-no-work/1");
}
