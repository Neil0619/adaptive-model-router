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

/** Child verification requires a stable whole file. Message reconciliation can
 * instead pin a complete prefix while the active parent appends new events;
 * that prefix is independently rehashed before it is accepted. */
export function readStableRollout(path, accept, { allowAppend = false, deadline = Infinity } = {}) {
  path = resolveRolloutPath(path);
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new Error("native transcript exceeds evidence bounds");
    const hash = createHash("sha256");
    let offset = 0, line = 0, fragment = Buffer.alloc(0);
    while (offset < before.size) {
      if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) throw new Error("native transcript changed during evidence read");
      offset += count;
      hash.update(chunk.subarray(0, count));
      fragment = Buffer.concat([fragment, chunk.subarray(0, count)]);
      let end;
      while ((end = fragment.indexOf(0x0a)) >= 0) {
        if (end > 16 * 1024 * 1024) throw new Error("native transcript line exceeds evidence bounds");
        accept(JSON.parse(fragment.subarray(0, end).toString("utf8")), ++line);
        fragment = fragment.subarray(end + 1);
      }
      if (fragment.length > 16 * 1024 * 1024) throw new Error("native transcript line exceeds evidence bounds");
    }
    const after = fstatSync(fd);
    const sameFile = (value) => value.dev === before.dev && value.ino === before.ino && value.size >= before.size;
    if (!sameFile(after) || !sameFile(statSync(path))) throw new Error("native transcript changed during evidence read");
    if (!allowAppend && !["size", "mtimeMs", "ctimeMs"].every((key) => before[key] === after[key])) throw new Error("native transcript changed during evidence read");
    if (fragment.length || !line) throw new Error("native transcript has incomplete records");
    const transcriptDigest = hash.digest("hex");
    if (allowAppend) {
      const verified = createHash("sha256");
      let position = 0;
      while (position < before.size) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - position));
        const count = readSync(fd, chunk, 0, chunk.length, position);
        if (!count) throw new Error("native transcript changed during evidence read");
        verified.update(chunk.subarray(0, count)); position += count;
      }
      if (verified.digest("hex") !== transcriptDigest || !sameFile(fstatSync(fd)) || !sameFile(statSync(path))) {
        throw new Error("native transcript changed during evidence read");
      }
    }
    const allocated = Number.isSafeInteger(before.blocks) ? before.blocks * 512 : before.size;
    return { transcriptDigest, transcriptBytes: Math.max(before.size, allocated) };
  } finally { closeSync(fd); }
}
