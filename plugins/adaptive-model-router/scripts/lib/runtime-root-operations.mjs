import { createHash } from "node:crypto";
import { payloadHash } from "./io.mjs";
import { readStableRollout, rolloutIdentity } from "./native-rollout-reader.mjs";
import { literalObject } from "./code-mode-tool-evidence.mjs";

export const rootCoverageKey = (context) => `runtime_root_coverage:${context.projectId}:${context.contextKey}`;

const prefixes = new WeakSet();
export function inspectRootOperationCoverage(db, context, input, { deadline = Date.now() + 250 } = {}) {
  if (!db.prepare("SELECT 1 FROM meta WHERE key=?").get(rootCoverageKey(context)) && input.transcript_path) {
    let throughLine = 0;
    const prefix = createHash("sha256");
    try {
      const identity = rolloutIdentity(input.transcript_path);
      readStableRollout(input.transcript_path, (entry, line) => {
        if (line === 1 && (entry.type !== "session_meta" || entry.payload.id !== input.session_id || entry.payload.parent_thread_id)) throw new Error("root coverage ownership mismatch");
        prefix.update(JSON.stringify(entry) + "\n"); throughLine = line;
      }, { allowAppend: true, deadline });
      if (identity !== rolloutIdentity(input.transcript_path)) return null;
      const proof = Object.freeze({ throughLine, prefixDigest: prefix.digest("hex"), identity, contextKey: context.contextKey, projectId: context.projectId });
      prefixes.add(proof); return proof;
    } catch { /* Missing trustworthy prefix cannot grant retrospective coverage. */ }
  }
  return null;
}

export function observeRootOperationCoverage(db, context, input, proof = null) {
  if (prefixes.has(proof) && proof.contextKey === context.contextKey && proof.projectId === context.projectId) {
    try {
      if (proof.identity === rolloutIdentity(input.transcript_path)) db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)")
        .run(rootCoverageKey(context), JSON.stringify({ throughLine: proof.throughLine, prefixDigest: proof.prefixDigest }));
    } catch { /* Changed evidence cannot establish prospective coverage. */ }
  }
  if (input.tool_name !== "Bash" || !["PreToolUse", "PostToolUse"].includes(input.hook_event_name)) return;
  const post = input.hook_event_name === "PostToolUse";
  if (!input.tool_use_id || !input.turn_id || typeof input.tool_input?.command !== "string" || (post && typeof input.tool_response !== "string")) return;
  const digest = payloadHash(input.tool_input.command);
  const previous = db.prepare("SELECT * FROM runtime_root_commands WHERE project_id=? AND context_key=? AND call_id=?")
    .get(context.projectId, context.contextKey, input.tool_use_id);
  const conflict = previous && (previous.command_digest !== digest || (!post && previous.turn_id !== input.turn_id));
  db.prepare(`INSERT INTO runtime_root_commands(project_id,context_key,call_id,turn_id,command_digest,pre_seen,post_seen,conflicted)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,context_key,call_id) DO UPDATE SET
      pre_seen=MAX(pre_seen,excluded.pre_seen),post_seen=MAX(post_seen,excluded.post_seen),conflicted=MAX(conflicted,excluded.conflicted)`)
    .run(context.projectId, context.contextKey, input.tool_use_id, previous?.turn_id || input.turn_id, digest, post ? 0 : 1, post ? 1 : 0, conflict ? 1 : 0);
}

// A bounded, non-executing grammar for the ordinary parallel command batch.
// No arbitrary JavaScript, getters, computed tools or result text can prove
// execution coverage. Native command Hook receipts still carry the authority.
export function rootCommandBatch(input) {
  if (typeof input !== "string" || input.length > 65536) return null;
  const source = input.replace(/^\s*\/\/ @exec:[^\r\n]*\r?\n/u, "").trim();
  const match = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+Promise\.(all|allSettled)\s*\(\s*\[([\s\S]*)\]\s*\)\s*;\s*([\s\S]*)$/u.exec(source);
  if (!match || ["tools", "text", "Promise"].includes(match[1])) return null;
  const escaped = match[1].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const tail = new RegExp(`^for\\s*\\(\\s*const\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${escaped}\\s*\\)\\s*(?:\\{\\s*)?text\\s*\\(\\s*\\1\\s*\\)\\s*;?(?:\\s*\\})?\\s*$`, "u");
  // Output-only AST shapes: whitespace and local binding names carry no
  // authority. Index decoration/spreading of returned values cannot launch
  // work. All other statements, computed calls and callbacks remain opaque.
  const compact = match[4].replace(/\s+/gu, "");
  const indexed = new RegExp(`^for\\(let([A-Za-z_$][\\w$]*)=0;\\1<${escaped}\\.length;\\1\\+\\+\\)(?:\\{)?text\\(\\{\\1,\\.\\.\\.${escaped}\\[\\1\\]\\}\\);?(?:\\})?$`, "u");
  const each = new RegExp(`^${escaped}\\.forEach\\(\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\)=>text\\(\\{\\2,\\.\\.\\.\\1\\}\\)\\);?$`, "u");
  const directEach = new RegExp(`^${escaped}\\.forEach\\(text\\);?$`, "u");
  if (!tail.test(match[4]) && !indexed.test(compact) && !each.test(compact) && !directEach.test(compact)) return null;
  let body = match[3].trim(), count = 0;
  const commands = [];
  while (body) {
    const prefix = /^tools\.exec_command\s*\(/u.exec(body);
    if (!prefix || count++ >= 16) return null;
    let at = prefix[0].length, depth = 0, quoted = false, escapedString = false, end = -1;
    for (let i = at; i < body.length; i++) {
      const c = body[i];
      if (quoted) { if (escapedString) escapedString = false; else if (c === "\\") escapedString = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) return null;
    let args;
    try { args = literalObject(body.slice(at, end)); } catch { return null; }
    if (typeof args.cmd !== "string") return null;
    commands.push(payloadHash(args.cmd));
    body = body.slice(end).trim();
    if (!body.startsWith(")")) return null;
    body = body.slice(1).trim();
    if (!body) break;
    if (!body.startsWith(",")) return null;
    body = body.slice(1).trim();
  }
  return commands.length ? commands : null;
}

export function settleCoveredRootBatches(operations, commands) {
  for (const [callId, call] of operations.calls) {
    if (call.name !== "exec" || (call.namespace && call.namespace !== "functions")) continue;
    // These shell-owned Router methods are synchronous reads (including local
    // bookkeeping) and cannot return a spawned job. A native completed outer
    // call plus an exact awaited forwarding program suffices; arbitrary printed
    // JSON never grants that fact. Cell/session evidence remains in active.
    if (readOnlyRouterForward(call.input) && !operations.unanswered.has(callId)) {
      operations.active.delete(`unknown:${callId}`); continue;
    }
    if (!call.prospectiveRootCoverage) continue;
    const expected = rootCommandBatch(call.input);
    if (!expected) continue;
    const actual = commands.filter((command) => command.turnId === call.observedTurnId);
    // Exact counts avoid guessing which repeated command belongs to this
    // opaque batch. Each receipt must be native, prospective and terminal.
    if (expected.every((digest) => actual.filter((command) => command.commandDigest === digest && command.started && command.terminal && !command.conflicted).length === expected.filter((item) => item === digest).length)
      && !operations.unanswered.has(callId)) operations.active.delete(`unknown:${callId}`);
  }
}

export function readOnlyRouterForward(input) {
  if (typeof input !== "string" || input.length > 65536) return false;
  const source = input.replace(/^\s*\/\/ @exec:[^\r\n]*\r?\n/u, "").trim();
  const match = /^text\s*\(\s*await\s+tools\.mcp__adaptive_model_router__(get_route_status|get_route_history|get_model_policy|get_learning_status)\s*\(([\s\S]*)\)\s*\)\s*;?$/u.exec(source);
  if (!match) return false;
  try { const args = literalObject(match[2]); return typeof args.contextId === "string"; } catch { return false; }
}
