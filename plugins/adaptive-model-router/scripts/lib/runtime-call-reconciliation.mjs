import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { opaqueId } from "./context.mjs";
import { payloadHash } from "./io.mjs";
import { readStableRollout, resolveRolloutPath, rolloutIdentity } from "./native-rollout-reader.mjs";
import { rememberedRootTranscript } from "./stage-reconciliation.mjs";
import { verifyRuntimePackage } from "./runtime-package.mjs";
import { observationPath } from "./observability.mjs";
import { openReadOnlySnapshot } from "./read-only-snapshot.mjs";

const PROOFS = new WeakMap(), SCHEMA = "native-mcp-schema-rejection-recovery/1";
const ownPath = fileURLToPath(import.meta.url);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const verifierDigest = () => payloadHash(readdirSync(dirname(ownPath)).filter(name => name.endsWith(".mjs")).sort()
  .map(name => [name, sha(readFileSync(join(dirname(ownPath), name)))]));
const LOADED_VERIFIER = verifierDigest();
const check = (fact, reason) => { if (!fact) throw new Error(`Native call recovery blocked: ${reason}`); };
// Reviewed validation-before-dispatch implementation. A different MCP shell
// requires another code review, not a version-number or error-text inference.
const REVIEWED_SERVER = "bfe38a1cd4f83ee2580d3c0b84fb68f17b608178553733162822c3582bdb0c08";
// Complete dependency closure for the three schemas supported below. Service
// bytes are checked, never imported: service can project the running shell's
// inventory and imports unrelated business modules. Recovery executes neither.
const REVIEWED_VALIDATION = {
  "service": "59993287ae93a90d764c73f2ba68985c92b630b15d3ad4925a2fb86269dacd2a",
  "service-shell-contract": "d818b207ebbf02c6b7f53790a66678983e0fdd512674d3ce08fe149fe2f4cd39",
  "contracts": "d280956ef7e7663af48010294ce3496e494855489bb4667d0542642fa15ee896",
  "constants": "964ddefb1c75976cb53bb15051d667a88898d2db429f316494085d682c165d79",
  "audit-records": "da9421f9c7239f0b661c659707d8503c0e8f4df241a77b4e3c58179e9e417a18",
  "schema": "429e7a0cc8663e57268948016c9261ce162dba3c1738e392acdb7db521b99772",
  "request-errors": "d865446d2d13ef68c79bec11235471e45187a45bf6d6d8a204a4de9f8bcae970",
  "io": "5994274ea83c8390127c7c673799211ee373ef2d50c5ee9a94ed20b0a6862e46",
};
const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const rowsFor = (db, context) => db.prepare("SELECT * FROM runtime_call_receipts WHERE project_id=? AND context_key=? ORDER BY id")
  .all(context.projectId, context.contextKey);
const auditsFor = (db, context) => tableExists(db, "runtime_call_reconciliations")
  ? db.prepare("SELECT * FROM runtime_call_reconciliations WHERE project_id=? AND context_key=? ORDER BY receipt_id")
    .all(context.projectId, context.contextKey) : [];

function nativePath(db, context) {
  const remembered = rememberedRootTranscript(db, context);
  check(typeof remembered === "string" && remembered, "trusted native source missing");
  const path = resolveRolloutPath(remembered), root = realpathSync(process.env.CODEX_HOME || join(homedir(), ".codex"));
  check(!lstatSync(path).isSymbolicLink() && realpathSync(path) === resolve(path), "native source identity changed");
  check(["sessions", "archived_sessions"].some(folder => {
    const tail = relative(join(root, folder), path);
    return tail && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
  }), "original native source required");
  return path;
}

function nativeSnapshot(path, reference) {
  const identity = rolloutIdentity(path), calls = new Map(), ends = new Map(), starts = new Map();
  let currentTurn = null;
  const source = readStableRollout(path, (entry, line) => {
    const p = entry.payload;
    if (line === 1) check(entry.type === "session_meta" && p?.id === reference.contextId && !p.parent_thread_id
      && !p.source?.subagent && realpathSync(p.cwd) === realpathSync(reference.cwd), "native root identity mismatch");
    if (entry.type === "turn_context") currentTurn = p.turn_id;
    if (entry.type !== "event_msg") return;
    if (p?.type === "task_started") {
      const previous = starts.get(p.turn_id); starts.set(p.turn_id, previous === undefined ? line : null);
      currentTurn = p.turn_id;
    }
    if (["task_complete", "turn_aborted"].includes(p?.type)) {
      const prior = ends.get(p.turn_id); ends.set(p.turn_id, prior === undefined && currentTurn === p.turn_id
        ? { line, kind: p.type, digest: payloadHash(entry) } : null);
      currentTurn = null;
    }
    if (p?.type !== "item_completed" || p.item?.type !== "McpToolCall") return;
    const item = p.item;
    if (!item.id) return;
    const key = payloadHash([reference.contextId, p.turn_id, item.id]);
    const found = calls.get(key) || [];
    found.push({ entry, line, recordDigest: payloadHash(entry), inTurn: currentTurn === p.turn_id && !ends.has(p.turn_id) }); calls.set(key, found);
  }, { allowAppend: true, allowCompactedMetadata: true, deadline: Date.now() + 15000 });
  check(rolloutIdentity(path) === identity, "native source changed during read");
  return { identity, source, calls, ends, starts };
}

function observations(store, context) {
  const snapshot = openReadOnlySnapshot(observationPath(store.path));
  if (!snapshot) return [];
  try {
    return snapshot.db.prepare("SELECT payload_json FROM events WHERE project_key=? AND context_key=? AND component='launcher' AND event='finished'")
      .all(context.projectId, context.contextKey).map(row => JSON.parse(row.payload_json));
  } finally { snapshot.close(); }
}

// Side-effect-free preparation: no RouterStore constructor, migrations,
// runtimeGeneration archive recovery, schema creation, or journal writes.
export async function prepareRejectedRuntimeCalls(store, reference) {
  check(verifierDigest() === LOADED_VERIFIER, "loaded verifier changed");
  const context = store.context({ ...reference, create: false }), rows = rowsFor(store.db, context), audits = auditsFor(store.db, context);
  for (const row of audits) {
    const record = JSON.parse(row.record), { digest, ...body } = record;
    check(digest === payloadHash(body) && record.schema === SCHEMA && record.receiptId === row.receipt_id
      && record.decision === "rejected_before_business_dispatch", "retained audit changed");
  }
  const path = nativePath(store.db, context), native = nativeSnapshot(path, reference), observed = observations(store, context);
  const salt = store.db.prepare("SELECT value FROM meta WHERE key='local_salt'").get()?.value;
  check(typeof salt === "string" && salt, "context identity missing");
  const eligible = [], unresolved = [], packages = new Map();
  for (const row of rows.filter(r => r.state === "pending")) {
    try {
      check(!audits.some(a => a.receipt_id === row.id), "already audited receipt unexpectedly pending");
      const matches = native.calls.get(row.id);
      check(matches?.length === 1, "exact native result missing or duplicated");
      const { entry, line, recordDigest, inTurn } = matches[0], p = entry.payload, item = p.item;
      const start = native.starts.get(p.turn_id), end = native.ends.get(p.turn_id);
      check(inTurn && Number.isInteger(start) && start < line && end?.line > line, "native turn is unfinished or conflicting");
      check(p.thread_id === reference.contextId && item.server === "adaptive-model-router"
        && item.pluginId === "adaptive-model-router@adaptive-model-router" && item.status === "failed"
        && item.arguments?.contextId === reference.contextId && Number.isFinite(p.started_at_ms)
        && Number.isFinite(p.completed_at_ms) && p.completed_at_ms >= p.started_at_ms, "native MCP ownership or terminal status mismatch");
      check(payloadHash({ name: item.tool, args: item.arguments }) === row.payload_digest, "native payload differs from Pre receipt");
      const pre = observed.filter(o => o.receiptKey === row.id && o.hookEvent === "PreToolUse");
      check(pre.length === 1 && pre[0].identitySource === "native_hook" && pre[0].transport === "native-hook"
        && pre[0].lifecycle === "completed" && pre[0].operation === "succeeded"
        && pre[0].runtimeDigest === row.generation && pre[0].projectKey === context.projectId && pre[0].contextKey === context.contextKey
        && pre[0].turnKey === opaqueId(salt, "observation-turn", p.turn_id)
        && pre[0].nativeCallKey === opaqueId(salt, "observation-call", item.id), "validating shell observation unavailable or conflicting");
      const shellDigest = pre[0].shellRuntimeDigest;
      let pkg = packages.get(shellDigest);
      if (!pkg) {
        const original = store.db.prepare("SELECT * FROM runtime_generations WHERE digest=?").get(shellDigest);
        check(original, "validating shell was not retained");
        const record = JSON.parse(original.record);
        check(record.digest === shellDigest && original.digest === shellDigest, "retained runtime identity mismatch");
        verifyRuntimePackage(record);
        check(sha(readFileSync(join(record.root, "scripts/mcp-server.mjs"))) === REVIEWED_SERVER, "unreviewed validating shell");
        for (const [name, expected] of Object.entries(REVIEWED_VALIDATION))
          check(sha(readFileSync(join(record.root, "scripts/lib", `${name}.mjs`))) === expected, "unreviewed schema dependency");
        const [contracts, schema, errors] = await Promise.all(["contracts", "schema", "request-errors"].map(name =>
          import(pathToFileURL(join(record.root, "scripts/lib", `${name}.mjs`)).href)));
        pkg = { original, record, contracts, schema, errors }; packages.set(shellDigest, pkg);
      }
      const supported = { route_stage: pkg.contracts.ROUTE_INPUT_SCHEMA, record_outcome: pkg.contracts.OUTCOME_INPUT_SCHEMA,
        get_route_status: { type: "object", additionalProperties: false, required: ["contextId"],
          properties: { contextId: { type: "string", minLength: 1, maxLength: 256 } } } };
      const definition = supported[item.tool];
      check(definition, "unknown tools need separate native dispatch proof");
      let validationError;
      try { pkg.schema.assertSchema(definition, item.arguments, `${item.tool} input`); }
      catch (error) { validationError = error; }
      check(validationError?.code === "INVALID_INPUT", "input was not rejected by the original shell schema");
      const expected = { content: [{ type: "text", text: pkg.errors.publicRequestError(validationError) }], isError: true };
      check(payloadHash(item.result) === payloadHash(expected), "native result is not the exact schema rejection");
      eligible.push({ row, tool: item.tool, line, nativeRecordDigest: recordDigest, turnDigest: payloadHash(p.turn_id),
        callDigest: payloadHash(item.id), terminalKind: end.kind, terminalLine: end.line,
        terminalDigest: end.digest, preObservationDigest: payloadHash(pre[0]), shellDigest });
    } catch (error) { unresolved.push({ receiptId: row.id, reason: error.message }); }
  }
  const evidenceDigest = payloadHash({ schema: SCHEMA, context, sourcePathDigest: payloadHash(path), verifier: LOADED_VERIFIER,
    eligible, unresolved, audits, packages: [...packages.values()].map(pkg => pkg.original) });
  const token = Object.freeze({ schema: SCHEMA, evidenceDigest, eligible: eligible.map(e => ({ receiptId: e.row.id, tool: e.tool, sourceLine: e.line,
    nativeRecordDigest: e.nativeRecordDigest, receiptDigest: payloadHash(e.row), shellDigest: e.shellDigest })),
    unresolved, alreadyReconciled: audits.length, nativeSource: native.source });
  PROOFS.set(token, { store, context, reference: { ...reference }, rows, audits, path, native, eligible, observed,
    packages, verifier: LOADED_VERIFIER, expiresAt: Date.now() + 30000 });
  return token;
}

function auditSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_call_reconciliations (
    receipt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, context_key TEXT NOT NULL,
    record TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS runtime_call_reconciliations_immutable_update BEFORE UPDATE ON runtime_call_reconciliations
      BEGIN SELECT RAISE(ABORT,'native call recovery is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS runtime_call_reconciliations_immutable_delete BEFORE DELETE ON runtime_call_reconciliations
      BEGIN SELECT RAISE(ABORT,'native call recovery is retained'); END;
    CREATE TRIGGER IF NOT EXISTS runtime_call_reconciliations_immutable_replace BEFORE INSERT ON runtime_call_reconciliations
      WHEN EXISTS(SELECT 1 FROM runtime_call_reconciliations WHERE receipt_id=NEW.receipt_id)
      BEGIN SELECT RAISE(ABORT,'native call recovery is immutable'); END;`);
}

export function commitRejectedRuntimeCalls(store, token) {
  const proof = PROOFS.get(token);
  check(proof?.store === store, "source-owned proof required");
  check(Date.now() <= proof.expiresAt && verifierDigest() === proof.verifier, "recovery proof expired or verifier changed");
  check(nativePath(store.db, proof.context) === proof.path && rolloutIdentity(proof.path) === proof.native.identity, "native source changed");
  const fresh = nativeSnapshot(proof.path, proof.reference);
  check(fresh.source.transcriptDigest === proof.native.source.transcriptDigest, "native prefix changed");
  const freshObservations = observations(store, proof.context);
  for (const entry of proof.eligible) check(freshObservations.filter(o => o.receiptKey === entry.row.id && o.hookEvent === "PreToolUse").length === 1
    && freshObservations.some(o => payloadHash(o) === entry.preObservationDigest), "shell observation changed");
  for (const pkg of proof.packages.values()) verifyRuntimePackage(pkg.record);
  return store.transaction(() => {
    check(verifierDigest() === proof.verifier && rolloutIdentity(proof.path) === fresh.identity
      && nativePath(store.db, proof.context) === proof.path, "native source or verifier changed");
    check(payloadHash(rowsFor(store.db, proof.context)) === payloadHash(proof.rows)
      && payloadHash(auditsFor(store.db, proof.context)) === payloadHash(proof.audits), "receipt ledger changed");
    for (const pkg of proof.packages.values()) {
      check(payloadHash(store.db.prepare("SELECT * FROM runtime_generations WHERE digest=?").get(pkg.original.digest))
        === payloadHash(pkg.original), "retained runtime changed");
      verifyRuntimePackage(pkg.record);
    }
    // The observation journal is a separate database. Re-read the exact
    // validating-shell evidence after acquiring the business write lock too;
    // a changed/pruned/duplicated observation cannot authorize this commit.
    const lockedObservations = observations(store, proof.context);
    for (const entry of proof.eligible) {
      const exact = lockedObservations.filter(o => o.receiptKey === entry.row.id && o.hookEvent === "PreToolUse");
      check(exact.length === 1 && payloadHash(exact[0]) === entry.preObservationDigest, "shell observation changed");
    }
    if (proof.eligible.length) auditSchema(store.db);
    const records = proof.eligible.map(entry => {
      const record = { schema: SCHEMA, receiptId: entry.row.id, beforeDigest: payloadHash(entry.row), generation: entry.row.generation,
        shellDigest: entry.shellDigest, nativeRecordDigest: entry.nativeRecordDigest, sourceLine: entry.line,
        turnDigest: entry.turnDigest, callDigest: entry.callDigest, terminalKind: entry.terminalKind, terminalLine: entry.terminalLine,
        terminalDigest: entry.terminalDigest,
        sourceDigest: fresh.source.transcriptDigest, sourcePathDigest: payloadHash(proof.path), preObservationDigest: entry.preObservationDigest,
        verifier: proof.verifier, decision: "rejected_before_business_dispatch", recordedAt: new Date().toISOString() };
      record.digest = payloadHash(record);
      store.db.prepare("INSERT INTO runtime_call_reconciliations VALUES(?,?,?,?)")
        .run(entry.row.id, proof.context.projectId, proof.context.contextKey, JSON.stringify(record));
      const changed = store.db.prepare("UPDATE runtime_call_receipts SET state='rejected' WHERE id=? AND state='pending'").run(entry.row.id);
      check(changed.changes === 1, "receipt ledger changed");
      return record;
    });
    PROOFS.delete(token);
    return { schema: SCHEMA, reconciled: records.length, alreadyReconciled: proof.audits.length,
      unresolved: token.unresolved, records, businessOutcomesChanged: false, installationChanged: false };
  });
}
