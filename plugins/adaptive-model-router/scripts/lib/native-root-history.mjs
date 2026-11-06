import { realpathSync } from "node:fs";
import { readStableRollout, rolloutIdentity } from "./native-rollout-reader.mjs";
import { nativeSessionSourceIndex } from "./native-session-sources.mjs";
import { payloadHash } from "./io.mjs";

// Resuming a native paginated task creates a new same-thread segment. Its
// history_base names an exact ordinal AND raw byte boundary, not a new coverage
// baseline. Read the referenced prefix and the current segment as one history.
// Never concatenate all matching filenames or accept a cross-thread ancestry.
export function readNativeRootHistory(path, { contextId, cwd, deadline }, accept) {
  let index = null;
  const segments = [], visiting = new Set();
  function inspect(sourcePath, endByteOffset = null) {
    const identity = rolloutIdentity(sourcePath);
    let first, lastOrdinal, contiguous = true, count = 0;
    const source = readStableRollout(sourcePath, (entry, line) => {
      if (line === 1) {
        first = entry;
        const p = entry.payload;
        if (entry.type !== "session_meta" || p?.id !== contextId || p.parent_thread_id || p.source?.subagent
          || realpathSync(p.cwd) !== realpathSync(cwd)) throw new Error("native root segment identity differs");
      }
      if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0 || (line > 1 && entry.ordinal !== lastOrdinal + 1)) contiguous = false;
      lastOrdinal = entry.ordinal; count++;
    }, { deadline, endByteOffset });
    if (identity !== rolloutIdentity(sourcePath)) throw new Error("native root segment changed");
    return { path: sourcePath, endByteOffset, identity, first, lastOrdinal, contiguous, count, source };
  }
  function visit(segment) {
    if (visiting.has(segment.path) || segments.length + visiting.size >= 16) throw new Error("native root history cycle or depth exceeded");
    visiting.add(segment.path);
    const base = segment.first.payload.history_base;
    if (base !== undefined && base !== null) {
      if (segment.first.payload.history_mode !== "paginated" || !segment.contiguous
        || base.thread_id !== contextId || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 1
        || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 1
        || segment.first.ordinal !== base.end_ordinal_exclusive) throw new Error("native root history reference is invalid");
      index ||= nativeSessionSourceIndex(deadline);
      const candidates = [];
      for (const candidate of index.get(contextId) || []) {
        if (visiting.has(candidate)) continue;
        if (Date.now() > deadline) throw new Error("native root history read budget exhausted");
        let prefix;
        try { prefix = inspect(candidate, base.end_byte_offset); } catch { continue; }
        if (prefix.contiguous && prefix.lastOrdinal + 1 === base.end_ordinal_exclusive) candidates.push(prefix);
      }
      if (!candidates.length || new Set(candidates.map((c) => c.source.transcriptDigest)).size !== 1)
        throw new Error("native root history prefix is missing or ambiguous");
      visit(candidates[0]);
    } else if (segment.endByteOffset !== null && (!segment.contiguous || segment.first.ordinal !== 0))
      throw new Error("native root history origin is incomplete");
    visiting.delete(segment.path); segments.push(segment);
  }
  visit(inspect(path));
  let line = 0;
  for (const segment of segments) {
    const source = readStableRollout(segment.path, (entry) => accept(entry, ++line), { deadline, endByteOffset: segment.endByteOffset });
    if (source.transcriptDigest !== segment.source.transcriptDigest || rolloutIdentity(segment.path) !== segment.identity)
      throw new Error("native root history changed during verification");
  }
  if (segments.some((segment) => rolloutIdentity(segment.path) !== segment.identity)) throw new Error("native root history source changed");
  return { sources: segments.map(({ path: sourcePath, identity }) => [sourcePath, identity]),
    source: segments.length === 1 ? segments[0].source : {
      transcriptDigest: payloadHash(segments.map(({ source, endByteOffset }) => ({ digest: source.transcriptDigest, endByteOffset }))),
      transcriptBytes: segments.reduce((sum, segment) => sum + segment.source.transcriptBytes, 0),
    } };
}
