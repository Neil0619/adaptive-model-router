import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";

export const SESSION_META_BYTE_LIMIT = 1024 * 1024;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function directoryIdentity(value) {
  try { return realpathSync(value); } catch { return resolve(value); }
}

function readFirstLine(path, byteLimit = SESSION_META_BYTE_LIMIT) {
  const descriptor = openSync(path, "r");
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("subagent transcript is not a regular file");
    const length = Math.min(stats.size, byteLimit + 1);
    const buffer = Buffer.alloc(length);
    const bytes = readSync(descriptor, buffer, 0, length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(0x0a);
    if (newline < 0 || newline > byteLimit) {
      throw new Error("subagent session metadata exceeds the bounded read limit");
    }
    return buffer.subarray(0, newline).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

const rootBirths = new WeakSet();
export function readNativeRootBirth(input) {
  try {
    const entry = JSON.parse(readFirstLine(input.transcript_path));
    const meta = entry.type === "session_meta" ? entry.payload : null;
    const time = Date.parse(meta?.timestamp || entry.timestamp);
    if (meta?.id !== input.session_id || meta.parent_thread_id || meta.source?.subagent || !Number.isFinite(time)
      || (meta.cwd && input.cwd && directoryIdentity(meta.cwd) !== directoryIdentity(input.cwd))) return null;
    const proof = Object.freeze({ time }); rootBirths.add(proof); return proof;
  } catch { return null; }
}
export const isNativeRootBirth = (proof) => rootBirths.has(proof);

// Descriptive metadata only. This result never grants lifecycle/admission
// authority and unknown host source shapes remain explicitly unknown.
export function readNativeTaskOrigin(input) {
  const unknown = { taskOrigin: "unknown", originSource: "unavailable" };
  try {
    if (input.agent_id || input.agent_type) return readThreadSpawnIdentity(input, {
      pathField: input.hook_event_name === "SubagentStop" ? "agent_transcript_path" : "transcript_path",
    }) ? { taskOrigin: "bounded_child", originSource: "native_metadata" } : unknown;
    const entry = JSON.parse(readFirstLine(input.transcript_path));
    const meta = entry.type === "session_meta" ? entry.payload : null;
    if (meta?.id !== input.session_id || meta.parent_thread_id || meta.source?.subagent
      || !meta.cwd || !input.cwd || directoryIdentity(meta.cwd) !== directoryIdentity(input.cwd)) return unknown;
    if (meta.thread_source === "background_suggestion") return { taskOrigin: "background_suggestion", originSource: "native_metadata" };
    if (meta.thread_source === "user" && ["cli", "vscode", "codex_desktop"].includes(meta.source)) return { taskOrigin: "interactive_root", originSource: "native_metadata" };
    return unknown;
  } catch { return unknown; }
}

/**
 * Read and validate the immutable thread-spawn identity written by Codex before
 * SubagentStart. This is the sole adapter for host rollout metadata; callers
 * receive only the fields needed to correlate a Router-managed child.
 */
export function readThreadSpawnIdentity(input, {
  pathField = "transcript_path",
  readLine = readFirstLine,
  onDiagnostic = null,
} = {}) {
  const observe = (reason, facts = {}) => {
    try { onDiagnostic?.({ reason, ...facts }); } catch { /* Observability cannot grant or reject a child. */ }
  };
  const transcriptPath = nonEmptyString(input?.[pathField]);
  const childId = nonEmptyString(input?.agent_id);
  const sessionId = nonEmptyString(input?.session_id);
  if (!transcriptPath || !childId || !sessionId) {
    observe("missing_input_fields", { pathPresent: Boolean(transcriptPath), childPresent: Boolean(childId), sessionPresent: Boolean(sessionId) });
    return null;
  }

  let line;
  try {
    line = readLine(transcriptPath);
  } catch (error) {
    observe(error?.code === "ENOENT" ? "metadata_not_found"
      : ["EACCES", "EPERM"].includes(error?.code) ? "metadata_denied" : "metadata_unreadable");
    return null;
  }
  let entry;
  try { entry = JSON.parse(line); }
  catch { observe("metadata_invalid_json"); return null; }
  const meta = entry?.type === "session_meta" && entry.payload && typeof entry.payload === "object"
    ? entry.payload
    : null;
  const spawn = meta?.source?.subagent?.thread_spawn;
  const parentId = nonEmptyString(meta?.parent_thread_id);
  const metaChildId = nonEmptyString(meta?.id);
  const metaSessionId = nonEmptyString(meta?.session_id);
  const spawnParentId = nonEmptyString(spawn?.parent_thread_id);
  const agentPath = nonEmptyString(meta?.agent_path);
  const spawnAgentPath = nonEmptyString(spawn?.agent_path);
  const metaCwd = nonEmptyString(meta?.cwd);
  const hookCwd = nonEmptyString(input?.cwd);
  const taskName = agentPath?.slice("/root/".length);
  const facts = { parentPresent: Boolean(parentId), metaChildPresent: Boolean(metaChildId),
    metaSessionPresent: Boolean(metaSessionId), spawnParentPresent: Boolean(spawnParentId),
    pathPresentInMeta: Boolean(agentPath), spawnPathPresent: Boolean(spawnAgentPath),
    depthOne: spawn?.depth === 1, childMatches: metaChildId === childId, parentMatches: sessionId === parentId,
    metaSessionMatches: metaSessionId === parentId, spawnParentMatches: spawnParentId === parentId,
    pathsMatch: agentPath === spawnAgentPath,
    pathShapeValid: Boolean(agentPath?.startsWith("/root/") && !taskName.includes("/")),
    cwdMatches: !metaCwd || !hookCwd || directoryIdentity(metaCwd) === directoryIdentity(hookCwd),
    taskNameValid: typeof taskName === "string" && /^[a-z0-9_]+$/u.test(taskName) };
  if (!Object.values(facts).every(Boolean)) { observe("identity_mismatch", facts); return null; }
  observe("identity_accepted", facts);
  return Object.freeze({
    parentContextId: parentId,
    childId,
    taskName,
    agentPath,
    transcriptPath,
  });
}
