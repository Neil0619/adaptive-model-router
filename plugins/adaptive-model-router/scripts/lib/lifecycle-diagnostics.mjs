import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { databasePath } from "./context.mjs";
import { payloadHash } from "./io.mjs";
import { runtimeSourceDigest } from "./lifecycle-qualification.mjs";
import { resolveLifecyclePluginRoot } from "./hook-readiness.mjs";

const MODES = new Set(["subagent-start", "subagent-stop", "pre-tool-use", "post-tool-use"]);
const STAGES = new Set(["entry", "identity", "carrier", "result", "exit", "exception"]);
const REASONS = new Set(["missing_input_fields", "metadata_not_found", "metadata_denied", "metadata_unreadable",
  "metadata_invalid_json", "identity_mismatch", "identity_accepted", "state_unavailable"]);
const FACTS = new Set(["pathPresent", "childPresent", "sessionPresent", "parentPresent", "metaChildPresent",
  "metaSessionPresent", "spawnParentPresent", "pathPresentInMeta", "spawnPathPresent", "depthOne", "childMatches",
  "parentMatches", "metaSessionMatches", "spawnParentMatches", "pathsMatch", "pathShapeValid", "cwdMatches",
  "taskNameValid", "marked", "valid", "claimed", "correlated", "stopped", "contextInjected"]);
const FIELDS = ["session_id", "agent_id", "turn_id", "transcript_path", "agent_transcript_path", "cwd", "model", "agent_type"];
const noop = () => {};

function readActive(contextDigest) {
  let db;
  try {
    db = new DatabaseSync(databasePath(), { readOnly: true });
    const value = JSON.parse(db.prepare("SELECT value FROM meta WHERE key=?")
      .get(`native_lifecycle_diagnostic:${contextDigest}`)?.value);
    const now = Date.now(), issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
    return value.schema === 1 && value.enabled === true && value.contextDigest === contextDigest
      && /^[a-f0-9]{64}$/u.test(value.authorizationDigest) && issued <= now && now < expires
      && expires - issued === 3600000 ? value : null;
  } catch { return null; }
  finally { db?.close(); }
}

/** Opt-in source diagnostics, not lifecycle evidence or admission authority.
 * One task, one expiring operator authorization, closed fields, bounded output.
 * No prompt, carrier, tool arguments/results, raw id or raw path is retained. */
export function createLifecycleDiagnostic(input, mode) {
  if (!MODES.has(mode) || typeof input?.session_id !== "string" || !input.session_id.trim()) return noop;
  const contextDigest = payloadHash(input.session_id.trim());
  const authorization = readActive(contextDigest);
  if (!authorization) return noop;
  let source;
  try { source = { runtimeDigest: runtimeSourceDigest(), shellRootDigest: payloadHash(realpathSync(resolveLifecyclePluginRoot())) }; }
  catch { return noop; }
  const fields = Object.fromEntries(FIELDS.map((key) => {
    const value = input[key];
    return [key, { kind: value === null ? "null" : value === undefined ? "missing" : typeof value,
      ...(typeof value === "string" ? { digest: payloadHash(value), empty: value.length === 0 } : {}) }];
  }));
  const record = (stage, detail = {}) => {
    let fd;
    try {
      if (!STAGES.has(stage) || readActive(contextDigest)?.authorizationDigest !== authorization.authorizationDigest) return;
      const facts = Object.fromEntries(Object.entries(detail).filter(([key, value]) => FACTS.has(key) && typeof value === "boolean"));
      const value = { schema: "native-lifecycle-diagnostic/1", runDigest: authorization.authorizationDigest,
        observedAt: new Date().toISOString(), mode, stage, ...source, fields, facts,
        ...(REASONS.has(detail.reason) ? { reason: detail.reason } : {}) };
      const line = Buffer.from(`${JSON.stringify(value)}\n`);
      if (line.length > 4096) return;
      const directory = join(dirname(databasePath()), "diagnostics");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) return;
      const path = join(directory, `native-lifecycle-${authorization.authorizationDigest.slice(0, 24)}.jsonl`);
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      const stats = fstatSync(fd);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0 || stats.size + line.length > 65536) return;
      writeSync(fd, line);
    } catch { /* Diagnostics never alter Hook decisions or stdout. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  record("entry");
  return record;
}
