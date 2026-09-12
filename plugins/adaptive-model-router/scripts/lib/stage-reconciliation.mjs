import { readStableRollout } from "./native-rollout-reader.mjs";
import { parseJson, payloadHash } from "./io.mjs";
import { openPrivateState, sealPrivateState } from "./private-state.mjs";

const rootSourceKey = (context) => `root_transcript:${context.projectId}:${context.contextKey}`;
const stamp = () => new Date().toISOString();

export function rememberRootTranscript(db, context, path) {
  if (typeof path !== "string" || !path) return;
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(rootSourceKey(context), sealPrivateState(db, path));
}

export function rememberedRootTranscript(db, context) {
  const source = db.prepare("SELECT value FROM meta WHERE key=?").get(rootSourceKey(context));
  return source ? openPrivateState(db, source.value) : null;
}

const hostRecordKey = (author, callId) => `message_host:${payloadHash([author, callId])}`;
const measuredHost = (host) => host?.platform === "darwin" && typeof host.cliVersion === "string"
  && [host.executableDigest, host.executablePathDigest].every((value) => /^[a-f0-9]{64}$/u.test(value || ""));

// Called only by the real message Pre Hook. Creation-time session metadata and
// the host running a later reconciliation cannot attest this call's sender.
export function rememberMessageHost(db, child, input, author, host) {
  if (!child || !author || !input.turn_id || !input.tool_use_id) return;
  const kind = hostRecordKey(author, input.tool_use_id);
  const record = { callId: input.tool_use_id, turnId: input.turn_id, author,
    kind: input.tool_name.replace(/^collaboration/u, ""), inputDigest: payloadHash(input.tool_input),
    host: measuredHost(host) ? host : null };
  const before = db.prepare("SELECT record FROM delegation_stage_journal WHERE route_id=? AND kind=?").get(child.route_id, kind);
  const write = (name, value) => db.prepare("INSERT OR IGNORE INTO delegation_stage_journal(route_id,revision,kind,record,created_at) VALUES(?,?,?,?,?)")
    .run(child.route_id, child.revision, name, sealPrivateState(db, JSON.stringify(value)), stamp());
  if (!before) write(kind, record);
  else if (payloadHash(JSON.parse(openPrivateState(db, before.record))) !== payloadHash(record)) {
    write(`${kind}:conflict`, { reason: "native message host observations disagree" });
  }
}

function messageHost(db, child, call) {
  const key = hostRecordKey(call.author, call.callId);
  const rows = db.prepare("SELECT kind,record FROM delegation_stage_journal WHERE route_id=? AND kind IN (?,?)")
    .all(child.route_id, key, `${key}:conflict`);
  if (rows.length !== 1 || rows[0].kind !== key) return null;
  const record = JSON.parse(openPrivateState(db, rows[0].record));
  if (!measuredHost(record.host) || ["callId", "turnId", "author", "kind", "inputDigest"].some((field) => record[field] !== call[field])) return null;
  return { ...record.host, evidenceDigest: payloadHash(record) };
}

export function rejectionHostCurrent(db, child, row) {
  try {
    const records = db.prepare("SELECT record FROM delegation_stage_journal WHERE route_id=? AND revision=? AND kind LIKE 'message_rejection:%'")
      .all(child.route_id, row.revision);
    if (records.length !== 1) return false;
    const receipt = JSON.parse(openPrivateState(db, records[0].record));
    if (receipt.callId !== row.call_id || receipt.turnId !== row.caller_turn_id
      || payloadHash(receipt.owner) !== row.author || receipt.inputDigest !== row.input_digest
      || !["native_provider_resolution_rejection", "native_pre_dispatch_rejection"].includes(receipt.source)) return false;
    if (receipt.schema === undefined && receipt.hostEvidenceDigest === undefined) return true;
    if (receipt.schema !== 2) return false;
    const host = messageHost(db, child, { callId: row.call_id, turnId: row.caller_turn_id,
      author: receipt.owner, kind: row.kind, inputDigest: row.input_digest });
    return host?.cliVersion === "0.153.4" && host.evidenceDigest === receipt.hostEvidenceDigest;
  } catch { return false; }
}

function retainedRejection(db, child, call, result, line) {
  const row = db.prepare("SELECT * FROM delegation_messages WHERE route_id=? AND caller_turn_id=? AND call_id=? AND author=?")
    .get(child.route_id, call.turnId, call.callId, payloadHash(call.author));
  if (row?.status !== "rejected") return null;
  const changed = () => { throw new Error("Native message terminal result changed; preserve the original sender responsibility."); };
  if (!rejectionHostCurrent(db, child, row)) return changed();
  const journal = db.prepare("SELECT record FROM delegation_stage_journal WHERE route_id=? AND kind=?")
    .get(child.route_id, `message_rejection:${payloadHash([call.author, call.callId])}`);
  if (!journal) return changed();
  const receipt = JSON.parse(openPrivateState(db, journal.record));
  return receipt.callId === call.callId && receipt.turnId === call.turnId && receipt.owner === call.author
    && receipt.inputDigest === call.inputDigest && receipt.resultDigest === payloadHash(result)
    && receipt.callLine === call.line && receipt.resultLine === line ? receipt : changed();
}

/** Reconcile actual calls, including a successful send whose Post Hook was lost.
 * Only the native input digest plus its exact call/turn/output can acknowledge
 * delivery. Do not infer delivery from the child's final text. */
export function reconcileStageMessages(db, context, child, parentPath = null, senderPaths = []) {
  const locator = JSON.parse(openPrivateState(db, child.locator));
  const source = db.prepare("SELECT value FROM meta WHERE key=?").get(rootSourceKey(context));
  const path = parentPath || (source ? openPrivateState(db, source.value) : null);
  if (!path) throw new Error("The root native transcript is needed to reconcile the original message calls.");
  const calls = new Map();
  const authors = new Set();
  const aliases = new Set([locator.childId, locator.taskName, locator.agentPath]);
  let providerMetadata;
  const nativeProviderFailure = (call, output) => {
    if (call.kind !== "followup_task" || typeof output !== "string") return null;
    const match = /^collab tool failed: Model provider `([A-Za-z0-9_-]{1,128})` not found$/u.exec(output);
    if (!match) return null;
    if (providerMetadata === undefined) {
      providerMetadata = null;
      readStableRollout(locator.transcriptPath, (entry, line) => {
        if (line !== 1) return;
        const meta = entry.payload, spawn = meta?.source?.subagent?.thread_spawn;
        if (entry.type !== "session_meta" || meta?.id !== locator.childId || meta.cli_version !== "0.153.4"
          || meta.parent_thread_id !== locator.parentContextId || meta.session_id !== locator.parentContextId
          || meta.agent_path !== locator.agentPath || spawn?.parent_thread_id !== locator.parentContextId
          || spawn.agent_path !== locator.agentPath || spawn.depth !== 1) return;
        providerMetadata = { provider: meta.model_provider, digest: payloadHash(entry) };
      });
    }
    return providerMetadata?.provider === match[1] ? providerMetadata : null;
  };
  for (const [index, senderPath] of [path, ...senderPaths].entries()) {
    let turnId = null, author = null;
    readStableRollout(senderPath, (entry, line) => {
    const item = entry.payload;
    if (line === 1) {
      if (index === 0) {
        if (entry.type !== "session_meta" || item?.id !== locator.parentContextId
          || item.parent_thread_id || item.source?.subagent) throw new Error("root transcript ownership mismatch");
        author = "/root";
      } else {
        const spawn = item?.source?.subagent?.thread_spawn;
        if (entry.type !== "session_meta" || !item.id || item.parent_thread_id !== locator.parentContextId
          || item.session_id !== locator.parentContextId || spawn?.parent_thread_id !== locator.parentContextId
          || spawn.depth !== 1 || spawn.agent_path !== item.agent_path || !/^\/root\/[^/]+$/u.test(item.agent_path)) {
          throw new Error("sender transcript ownership mismatch");
        }
        author = item.agent_path;
      }
      if (authors.has(author)) throw new Error("duplicate native sender evidence");
      authors.add(author);
    }
    if (entry.type === "turn_context" || (entry.type === "event_msg" && item?.type === "task_started")) turnId = item.turn_id;
    if (entry.type !== "response_item") return;
    if (item?.type === "function_call" && item.namespace === "collaboration"
      && ["send_message", "followup_task", "interrupt_agent"].includes(item.name)) {
      const args = JSON.parse(item.arguments);
      if (!aliases.has(args.target)) return;
      const key = `${author}:${item.call_id}`;
      if (!turnId || !item.call_id || calls.has(key)) throw new Error("native message identity is ambiguous");
      calls.set(key, { callId: item.call_id, turnId, author, kind: item.name,
        inputDigest: payloadHash(args), line, accepted: false, outputSeen: false });
    } else if (item?.type === "function_call_output" && calls.has(`${author}:${item.call_id}`)) {
      const call = calls.get(`${author}:${item.call_id}`);
      if (call.outputSeen) throw new Error("native message has duplicate results");
      call.outputSeen = true;
      const response = typeof item.output === "string" ? parseJson(item.output, null) : item.output;
      call.accepted = call.kind === "interrupt_agent" ? Boolean(response && Object.hasOwn(response, "previous_status")) : item.output === "";
      const host = messageHost(db, child, call);
      // Retain already verified historical receipts only when their exact
      // original evidence still matches. This does not attest their host anew.
      const retained = retainedRejection(db, child, call, item, line);
      // This exact host envelope is produced before dispatch, not by the
      // collaboration handler. Other errors remain ambiguous and pending.
      const hookRejected = (host?.cliVersion === "0.153.4" || retained?.source === "native_pre_dispatch_rejection") && typeof item.output === "string"
        && item.output.startsWith("Tool call blocked by PreToolUse hook: ")
        && item.output.endsWith(`. Tool: collaboration${call.kind}`);
      // This pinned native loader error occurs before followup delivery. Keep
      // its requirement with the sender; it proves neither child completion nor
      // a usable provider. Native input/operation/final checks still gate closure.
      const metadata = nativeProviderFailure(call, item.output);
      const providerRejected = metadata && (host?.cliVersion === "0.153.4"
        || (retained?.source === "native_provider_resolution_rejection" && retained.childMetadataDigest === metadata.digest));
      call.rejected = hookRejected || Boolean(providerRejected);
      if (call.rejected) call.rejection = retained || { schema: 2, callId: call.callId, turnId: call.turnId, owner: call.author,
        source: providerRejected ? "native_provider_resolution_rejection" : "native_pre_dispatch_rejection",
        ...(providerRejected ? { childMetadataDigest: metadata.digest } : {}), hostEvidenceDigest: host.evidenceDigest, inputDigest: call.inputDigest,
        resultDigest: payloadHash(item), callLine: call.line, resultLine: line };
    }
  }, { allowAppend: true });
  }
  const authorHashes = new Set([...authors].map(payloadHash));
  const rows = db.prepare("SELECT * FROM delegation_messages WHERE route_id=?").all(child.route_id)
    .filter((row) => authorHashes.has(row.author));
  for (const row of rows) {
    const call = [...calls.values()].find((c) => c.callId === row.call_id && payloadHash(c.author) === row.author);
    if (!call || call.turnId !== row.caller_turn_id || call.kind !== row.kind || call.inputDigest !== row.input_digest) {
      throw new Error("Registered native message is missing or changed; retain its responsibility.");
    }
    if ((row.status === "accepted" && !call.accepted) || (row.status === "rejected" && !call.rejected)) {
      throw new Error("Native message terminal result changed; preserve the original sender responsibility.");
    }
  }
  let revision = child.revision;
  for (const call of calls.values()) {
    const previous = rows.find((row) => row.call_id === call.callId && row.author === payloadHash(call.author));
    if (!previous) revision += 1;
    db.prepare(`INSERT INTO delegation_messages(route_id,caller_turn_id,call_id,author,kind,input_digest,
      revision,status,source_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(route_id,caller_turn_id,call_id) DO UPDATE SET
        status=excluded.status,source_order=excluded.source_order,updated_at=excluded.updated_at`)
      .run(child.route_id, call.turnId, call.callId, payloadHash(call.author), call.kind, call.inputDigest,
        previous?.revision ?? revision, call.accepted ? "accepted" : call.rejected ? "rejected" : "unknown", call.line, stamp(), stamp());
    if (call.rejected) db.prepare("INSERT OR IGNORE INTO delegation_stage_journal(route_id,revision,kind,record,created_at) VALUES(?,?,?,?,?)")
      .run(child.route_id, previous?.revision ?? revision, `message_rejection:${payloadHash([call.author, call.callId])}`,
        sealPrivateState(db, JSON.stringify(call.rejection)), stamp());
  }
  db.prepare(`UPDATE delegation_children SET revision=?,verified_revision=NULL,verified_digest=NULL,
    state=CASE WHEN state='unknown' THEN 'open' ELSE state END,updated_at=? WHERE route_id=?`)
    .run(revision, stamp(), child.route_id);
  rememberRootTranscript(db, context, path);
  return { reconciledCalls: calls.size, revision,
    pendingCalls: [...calls.values()].filter((call) => !call.accepted && !call.rejected).map(({ callId }) => callId),
    rejectedCalls: [...calls.values()].filter((call) => call.rejected).map((call) => ({ ...call.rejection,
      nextAction: "keep_undelivered_requirement_with_sender" })) };
}
