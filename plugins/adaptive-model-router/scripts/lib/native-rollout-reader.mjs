import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

// Archiving moves a rollout without changing its native identity. Only resolve
// that exact basename under the host's two known roots; callers still verify
// session_meta. Permission errors and malformed existing files never fall back.
export function resolveRolloutPath(path) {
  try { statSync(path); return path; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const root = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const name = basename(path);
  if (!/^rollout-\d{4}-\d{2}-\d{2}T[^/]+\.jsonl$/u.test(name)) return path;
  const within = (directory) => {
    const part = relative(join(root, directory), resolve(path));
    return part && part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep);
  };
  const candidate = within("sessions") ? join(root, "archived_sessions", name)
    : within("archived_sessions") ? join(root, "sessions", ...name.slice(8, 18).split("-"), name) : null;
  if (candidate) { try { statSync(candidate); return candidate; } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return path;
}

const BUSINESS_LINE_LIMIT = 16 * 1024 * 1024;
const COMPACTED_LINE_LIMIT = 32 * 1024 * 1024;
const DEFAULT_FILE_LIMIT = 512 * 1024 * 1024;
export const COLD_ROLLOUT_FILE_LIMIT = 1024 * 1024 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Native compaction carries complete replacement/guardian histories. It is
// metadata, never a live operation or input. Permit the observed native shape
// only; consumers still receive the complete parsed record and hash its bytes.
function compactedMetadata(entry) {
  const p = entry?.payload, usage = p?.latest_token_usage_record;
  const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
  const history = (value, types) => Array.isArray(value) && value.every((item) => object(item) && types.includes(item.type));
  return entry?.type === "compacted" && typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
    && Number.isSafeInteger(entry.ordinal) && entry.ordinal >= 0 && object(p) && typeof p.message === "string"
    && history(p.replacement_history, ["message", "compaction"])
    && history(p.guardian_history, ["message", "compaction", "custom_tool_call", "custom_tool_call_output", "agent_message", "reasoning", "function_call", "function_call_output"])
    && Number.isSafeInteger(p.window_number) && p.window_number >= 0
    && [p.first_window_id, p.previous_window_id, p.window_id].every(uuid)
    && typeof p.compaction_response_id === "string" && p.compaction_response_id.length > 0 && object(usage)
    && ["thread_id", "turn_id", "session_id", "root_turn_id", "response_id"].every((key) => typeof usage[key] === "string" && usage[key].length > 0)
    && ["usage", "turn_token_usage", "thread_token_usage"].every((key) => object(usage[key]));
}

/** Child verification requires a stable whole file. Message reconciliation can
 * instead pin a complete prefix while the active parent appends new events;
 * that prefix is independently rehashed before it is accepted. */
export function readStableRollout(path, accept, { allowAppend = false, allowCompactedMetadata = false, deadline = Infinity,
  maxBytes = DEFAULT_FILE_LIMIT } = {}) {
  // Cold installation may inspect long-lived parent logs beyond the normal
  // Hook budget. This only expands a finite streaming byte bound; record,
  // identity, complete-content hashing and caller time limits still apply.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > COLD_ROLLOUT_FILE_LIMIT)
    throw new Error("native transcript byte budget is invalid");
  if (maxBytes > DEFAULT_FILE_LIMIT && !Number.isFinite(deadline))
    throw new Error("expanded native transcript budget requires a finite deadline");
  path = resolveRolloutPath(path);
  const fd = openSync(path, "r");
  try {
    // Windows file IDs can exceed Number's exact integer range. Keep identity
    // and timestamps lossless; only the bounded byte count becomes a Number.
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error("native transcript exceeds evidence bounds");
    const size = Number(before.size);
    const hash = createHash("sha256");
    const lineLimit = allowCompactedMetadata ? COMPACTED_LINE_LIMIT : BUSINESS_LINE_LIMIT;
    let offset = 0, line = 0, fragments = [], fragmentBytes = 0;
    while (offset < size) {
      if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - offset));
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) throw new Error("native transcript changed during evidence read");
      offset += count;
      hash.update(chunk.subarray(0, count));
      let start = 0, end;
      while ((end = chunk.indexOf(0x0a, start)) >= 0 && end < count) {
        if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
        const length = fragmentBytes + end - start;
        if (length > lineLimit) throw new Error("native transcript line exceeds evidence bounds");
        const bytes = fragmentBytes ? Buffer.concat([...fragments, chunk.subarray(start, end)], length) : chunk.subarray(start, end);
        const entry = JSON.parse(bytes.toString("utf8"));
        if (length > BUSINESS_LINE_LIMIT && !compactedMetadata(entry)) throw new Error("native compaction metadata is unverified");
        if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
        accept(entry, ++line);
        fragments = []; fragmentBytes = 0; start = end + 1;
      }
      if (start < count) { fragments.push(chunk.subarray(start, count)); fragmentBytes += count - start; }
      if (fragmentBytes > lineLimit) throw new Error("native transcript line exceeds evidence bounds");
    }
    if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
    const after = fstatSync(fd, { bigint: true });
    const sameFile = (value) => value.dev === before.dev && value.ino === before.ino && value.size >= before.size;
    if (!sameFile(after) || !sameFile(statSync(path, { bigint: true }))) throw new Error("native transcript changed during evidence read");
    if (!allowAppend && !["size", "mtimeNs", "ctimeNs"].every((key) => before[key] === after[key])) throw new Error("native transcript changed during evidence read");
    if (fragmentBytes || !line) throw new Error("native transcript has incomplete records");
    const transcriptDigest = hash.digest("hex");
    if (allowAppend) {
      const verified = createHash("sha256");
      let position = 0;
      while (position < size) {
        if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
        const chunk = Buffer.alloc(Math.min(64 * 1024, size - position));
        const count = readSync(fd, chunk, 0, chunk.length, position);
        if (!count) throw new Error("native transcript changed during evidence read");
        verified.update(chunk.subarray(0, count)); position += count;
      }
      if (verified.digest("hex") !== transcriptDigest || !sameFile(fstatSync(fd, { bigint: true })) || !sameFile(statSync(path, { bigint: true }))) {
        throw new Error("native transcript changed during evidence read");
      }
    }
    const allocated = Number(before.blocks) * 512;
    return { transcriptDigest, transcriptBytes: Math.max(size, Number.isSafeInteger(allocated) ? allocated : size) };
  } finally { closeSync(fd); }
}

// A cheap freshness check after an expensive read. Never treat this metadata as
// content evidence by itself: callers first hash/verify the same stable file.
export function rolloutIdentity(path) {
  path = resolveRolloutPath(path);
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error("native transcript is not a regular file");
  return JSON.stringify([resolve(path), ...["dev", "ino", "size", "mtimeNs", "ctimeNs"].map((key) => String(stat[key]))]);
}
