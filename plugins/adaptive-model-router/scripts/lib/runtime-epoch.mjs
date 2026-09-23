import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { canonicalJson, payloadHash } from "./io.mjs";
import { ensureHostEpochSchema, hasHostEpochSchema } from "./host-epoch-storage.mjs";
import { copyRuntimePackage, managedRuntimeDestination, inspectRuntimePackage, verifyRuntimePackage } from "./runtime-package.mjs";
import { runtimeGeneration, runtimeTask, runtimeEpochGenerationCompatible } from "./runtime-isolation.mjs";
import { runtimeSourceDigest, commitHistoricalQualificationAdoption, readTaskQualification } from "./lifecycle-qualification.mjs";
import { historicalQualificationAuditCurrent } from "./historical-qualification-recovery.mjs";
import { readStableRollout, rolloutIdentity } from "./native-rollout-reader.mjs";
import { NativeOperationEvidence } from "./native-operation-evidence.mjs";
import { readChildTurnEvidence } from "./child-turn-evidence.mjs";
import { readChildCommands } from "./child-command-journal.mjs";
import { targetedChild, stageClosureStatus } from "./stage-closure.mjs";
import { openPrivateState, sealPrivateState } from "./private-state.mjs";
import { opaqueId } from "./context.mjs";
import { readHookIdentityDiagnostic } from "./hook-diagnostics.mjs";
import { settleCoveredRootBatches, rootCoverageKey } from "./runtime-root-operations.mjs";
import { assertColdEpochRetirement, assertColdMessageCheckpoint } from "./runtime-cold-install.mjs";
import { knownOperationCall, knownRootOperationCall } from "./runtime-operation-contract.mjs";
import { installedEpochEntry } from "./installed-epoch-entry.mjs";
import { applyOperationReviews } from "./operation-reconciliation.mjs";
import { RootEpochOperations } from "./root-epoch-operations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PUBLICATIONS = new WeakMap(), HANDOVERS = new WeakMap();
const LIVE_OBSERVATIONS = new Map();
const fail = (reason) => { throw new Error(`Host compatibility epoch blocked: ${reason}`); };
const requireFact = (fact, reason) => { if (!fact) fail(reason); };
// These exact frozen entry implementations acquire their invocation and select
// task/stage generation under BEGIN IMMEDIATE. Descriptor numbers alone cannot
// establish this property. Changed/unregistered writers require another review.
const REVIEWED_V2_ENTRY = {
  "scripts/lib/runtime-dispatch.mjs": "3d21b29baaefd54e323ad0fdf30b8211de3e0079004bc63f3f1d87fa7d587442",
  "scripts/lib/runtime-isolation.mjs": "a4b89ef7572694db9e3381ce73dec0a87a46ec149026b852f26d2e823bfa0079",
  "scripts/node-launcher.mjs": "0a7e3a24b250ae68630a833d73bdcce1dbb873bc0e740e01873ad5feb96c949a",
  "scripts/mcp-server.mjs": "b1019aa693dcd39987eb95c94c820f47d9a91737ba544ba62a05f8c4ab706feb",
};
// These retained B/C1/C2 packages were independently checked for atomic
// generation selection/registration, receipt consumption, completion retention
// and retirement blocking. Bind the complete entry tuple to each exact package;
// a changed document, manifest or other writer is a new, unreviewed package.
const REVIEWED_INSTALLED_EPOCH_ENTRY = { ...Object.fromEntries([
  "8732d9524390ff549a3e9fc616dacc41ffc7341ae8d6049ace8de0d27cc05989",
  "316a1facca3b8b1cc8f71a5da80c8e8e1d1aeb08bab5e2c5b737e16144cdc84a",
  "4b950f2687b1a8da98ce87a66a5c813a51f7ccd76c8292f7ad38e9d7862176a9",
].map((digest) => [digest, {
  "scripts/lib/runtime-dispatch.mjs": "4569a2191dabb39965e35b8f336bca36b2fc990b90986b91a9c47c90c19ebfe9",
  "scripts/lib/runtime-isolation.mjs": "3e5ca8e0976845eb65ea92a93897222bbcdcd3420de8746715ed74d4ad9416a8",
  "scripts/node-launcher.mjs": "0a7e3a24b250ae68630a833d73bdcce1dbb873bc0e740e01873ad5feb96c949a",
  "scripts/mcp-server.mjs": "b1019aa693dcd39987eb95c94c820f47d9a91737ba544ba62a05f8c4ab706feb",
}])),
  // Exact approved observability r4 entry, reviewed before the diagnostic-only
  // launcher change. Keep admission bound to the whole frozen package.
  "168f5886af293a5a5d701fb83949accc813a84c88f16d7ee53e2c334d62d6d1a": {
    "scripts/lib/runtime-dispatch.mjs": "35560c929d26953c8d81c90740cec955441d620d4c692e0fb63b646fba325ebb",
    "scripts/lib/runtime-isolation.mjs": "899b5a71515a91ab8940c6ac47d61280bd86ccc52efd323af70766920069851d",
    "scripts/node-launcher.mjs": "f37b4a8e47f1d23b34f217c9073729105b5b2300c6b7b923981b2fa673c271be",
    "scripts/mcp-server.mjs": "bfe38a1cd4f83ee2580d3c0b84fb68f17b608178553733162822c3582bdb0c08",
  },
  // Exact installed diagnostics patch, before rejection-only Pre settlement.
  // This grants no transition by itself: its actual A/B suite still runs.
  "69425bc27ec7e7359f80c9d18f34b626d32d00be03f8a8f18da03d2f73479853": {
    "scripts/lib/runtime-dispatch.mjs": "35560c929d26953c8d81c90740cec955441d620d4c692e0fb63b646fba325ebb",
    "scripts/lib/runtime-isolation.mjs": "899b5a71515a91ab8940c6ac47d61280bd86ccc52efd323af70766920069851d",
    "scripts/node-launcher.mjs": "25d0b9eda72404e564e65771b097f097bce3c1a4b2afab4797d4e85c26dfb2ab",
    "scripts/mcp-server.mjs": "bfe38a1cd4f83ee2580d3c0b84fb68f17b608178553733162822c3582bdb0c08",
  },
  // Exact installed validation patch, before request-JSON error classification.
  // Preserve whole-package admission and the executable A/B verification gate.
  "08a717303357af962c0c55171ab292312944ef8d135488f12d808204e016db25": {
    "scripts/lib/runtime-dispatch.mjs": "d3b1088865056609540366bc7964931a36a3302d6ea12eb87d7a859914817f72",
    "scripts/lib/runtime-isolation.mjs": "899b5a71515a91ab8940c6ac47d61280bd86ccc52efd323af70766920069851d",
    "scripts/node-launcher.mjs": "25d0b9eda72404e564e65771b097f097bce3c1a4b2afab4797d4e85c26dfb2ab",
    "scripts/mcp-server.mjs": "152c99883f326ef329b979a49c296b1129fcf1b41eeedeee5035ac713cfc3a7f",
  },
};

function reviewedEntry(record, { cold = false } = {}) {
  verifyRuntimePackage(record);
  if (cold && record.descriptor.shellProtocolVersion === 1) {
    requireFact(record.digest === "9d23b8ae47f6d9bd6b388a33b75c7f94741546116efa29d3e33d9ebc72a1c9b2", "unreviewed_legacy_source");
    return;
  }
  requireFact(record.descriptor.shellProtocolVersion === 2, "v1_native_entry_retirement_unproven");
  const reviewedInstalled = REVIEWED_INSTALLED_EPOCH_ENTRY[record.digest];
  if (reviewedInstalled) {
    requireFact(Object.entries(reviewedInstalled).every(([path, digest]) => sha(readFileSync(join(record.root, path))) === digest),
      "unreviewed_invocation_registration");
    return;
  }
  for (const [path, digest] of Object.entries(REVIEWED_V2_ENTRY)) {
    const bytes = readFileSync(join(record.root, path));
    // The exact pre-lifecycle-adapter default was reviewed independently of
    // the later MCP shell. Its begin/end and candidate invocation transaction
    // are unchanged; only qualification calls differ. Keep this exception on
    // the complete frozen package, and still run its own real A/B suite.
    const reviewedColdDefault = cold && record.digest === "22a9d720b0aabc5be18d12478f3b0e50c97c411ca1dfd32ca64934dbdb19ae31"
      && path === "scripts/mcp-server.mjs" && sha(bytes) === "fed9fa85256277b85487656fd444e528babe8abc938ebd113519fd44b71658cf";
    requireFact(reviewedColdDefault || sha(bytes) === digest || bytes.equals(readFileSync(join(ROOT, path))), "unreviewed_invocation_registration");
  }
}

// Executable A/B verification is owned by this source, not by a candidate's
// manifest or a JSON 'passed' assertion. Its temporary home is always isolated.
export function qualifyHostEpochPublication(source, candidate, { cold = false } = {}) {
  reviewedEntry(source, { cold }); verifyRuntimePackage(candidate);
  requireFact(runtimeSourceDigest(candidate.root) === runtimeSourceDigest(), "candidate_verifier_source_differs");
  for (const field of ["schemaVersion", "shellProtocolVersion", "toolContractVersion", "storageContractVersion", "databaseVersion"]) {
    requireFact((cold && field === "shellProtocolVersion") || source.descriptor[field] === candidate.descriptor[field], `legacy_${field}_shape_changed`);
  }
  requireFact(cold ? Object.entries(source.descriptor.entrypoints).every(([name, path]) => candidate.descriptor.entrypoints[name] === path)
    : payloadHash(source.descriptor.entrypoints) === payloadHash(candidate.descriptor.entrypoints), "legacy_entrypoint_shape_changed");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "router-writer-qualification-")));
  try {
    const env = { ...process.env, ADAPTIVE_ROUTER_HOME: join(directory, "state"), PLUGIN_DATA: join(directory, "state"),
      CODEX_HOME: join(directory, "codex"), ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "" };
    for (const script of ["verify-runtime-compatibility.mjs", cold ? "verify-cold-epoch-compatibility.mjs" : "verify-host-epoch-compatibility.mjs"]) {
      const result = spawnSync(process.execPath, [join(ROOT, "scripts", script), source.root, candidate.root, directory],
        { env, encoding: "utf8", timeout: 45_000, windowsHide: true });
      requireFact(result.status === 0 && !result.error, `A_B_constructor_dispatch_verification_failed:${String(result.stderr || result.error?.message).slice(-1200)}`);
    }
    verifyRuntimePackage(source); verifyRuntimePackage(candidate);
    const record = { schema: "runtime-epoch-publication/1", source: source.digest, candidate: candidate.digest,
      verifier: runtimeSourceDigest(), suite: cold ? "real-A-B-writers-and-isolated-cold-entry/2" : "real-A-B-writers-and-isolated-v2-entry/2",
      ...(cold ? { entryMode: "cold" } : {}) };
    record.id = payloadHash(record);
    const token = Object.freeze({}); PUBLICATIONS.set(token, { source, candidate, record }); return token;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function publishHostEpoch(store, token) {
  const saved = PUBLICATIONS.get(token);
  requireFact(saved, "source_owned_publication_proof_missing");
  reviewedEntry(saved.source, { cold: saved.record.entryMode === "cold" }); verifyRuntimePackage(saved.candidate);
  ensureHostEpochSchema(store.db);
  // Copy before taking the write lock; an interrupted copy is an unindexed
  // digest-addressed orphan and is verified, never overwritten, on retry.
  const candidate = copyRuntimePackage(saved.candidate,
    managedRuntimeDestination(dirname(store.path), "published", saved.candidate.digest));
  return store.transaction(() => {
    requireFact(store.db.prepare("SELECT 1 FROM runtime_generations WHERE digest=?").get(saved.source.digest), "source_not_enrolled");
    verifyRuntimePackage(candidate); reviewedEntry(runtimeGeneration(store.db, saved.source.digest), { cold: saved.record.entryMode === "cold" });
    requireFact(saved.record.verifier === runtimeSourceDigest(), "verifier_changed");
    store.db.prepare("INSERT OR IGNORE INTO runtime_generations(digest,record,state) VALUES(?,?,'published')")
      .run(candidate.digest, canonicalJson(candidate));
    store.db.prepare("INSERT OR IGNORE INTO runtime_epoch_publications(id,source,candidate,record) VALUES(?,?,?,?)")
      .run(saved.record.id, saved.source.digest, candidate.digest, canonicalJson(saved.record));
    // Deliberately do not change default or candidate. Frozen A cannot identify
    // a dormant task by first observation, and cannot settle an epoch proof.
    return { ...saved.record, taskBindingsChanged: 0, defaultChanged: false };
  });
}

const scoped = (db, table, context) => db.prepare(`SELECT * FROM ${table} WHERE project_id=? AND context_key=? ORDER BY rowid`)
  .all(context.projectId, context.contextKey);
function snapshot(db, context) {
  const tables = ["runtime_tasks", "runtime_stages", "runtime_invocations", "runtime_call_receipts", "runtime_root_commands",
    "routes", "outcomes", "delegation_attempts", "delegation_children"];
  const state = Object.fromEntries(tables.map((table) => [table, scoped(db, table, context)]));
  const stages = new Set(state.runtime_stages.map((row) => row.route_id));
  for (const table of ["delegation_messages", "delegation_child_stops", "delegation_child_commands", "delegation_stage_journal", "delegation_maintenance"])
    state[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().filter((row) => stages.has(row.route_id));
  for (const table of ["runtime_message_checkpoints", "runtime_message_continuations", "runtime_message_arrival_reviews"]) state[table] = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().filter((row) => stages.has(row.route_id)) : [];
  state.coverage = db.prepare("SELECT value FROM meta WHERE key=?").get(rootCoverageKey(context)) || null;
  state.epoch = scoped(db, "runtime_epoch_tasks", context);
  state.ordinaryDefaults = db.prepare("SELECT * FROM runtime_epoch_ordinary_defaults ORDER BY writer_digest,shell_digest").all();
  state.entries = db.prepare("SELECT * FROM runtime_host_entries ORDER BY path").all();
  state.nativeEntries = scoped(db, "runtime_epoch_native_entries", context);
  state.nativeEntryCompletions = db.prepare(`SELECT c.* FROM runtime_epoch_completed_invocations c
    JOIN runtime_epoch_native_entries e ON e.invocation_id=c.invocation_id
    WHERE e.project_id=? AND e.context_key=? ORDER BY c.invocation_id`).all(context.projectId, context.contextKey);
  state.qualifications = db.prepare("SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key")
    .all(`native_qualification:${context.projectId}:${context.contextKey}%`);
  return state;
}

function assertLedgerQuiescence(state) {
  requireFact(!state.runtime_tasks[0]?.candidate, "ordinary_candidate_owns_task");
  requireFact(!state.runtime_invocations.some((row) => row.state !== "completed"), "in_flight_or_unknown_Hook_MCP_call");
  requireFact(!state.runtime_call_receipts.some((row) => row.state === "pending"), "unconsumed_native_Pre_call");
  requireFact(!state.delegation_messages.some((row) => !["accepted", "rejected"].includes(row.status)), "unknown_message_delivery");
  requireFact(!state.delegation_attempts.some((row) => !row.finalized_at
    && (row.ticket_consumed !== 1 || row.post_observed !== 1 || row.ambiguous || row.no_child
      || !state.delegation_children.some((child) => child.route_id === row.route_id))), "unresolved_ticket_or_child_lifecycle");
  requireFact(!state.delegation_children.some((row) => row.state === "unknown"), "unknown_child_ownership");
}

function rootQuiescence(db, context, reference, deadline) {
  const commands = scoped(db, "runtime_root_commands", context).map((row) => ({ callId: row.call_id,
    turnId: row.turn_id, commandDigest: row.command_digest, started: row.pre_seen === 1,
    terminal: row.post_seen === 1, conflicted: row.conflicted === 1 }));
  const operations = new NativeOperationEvidence({ childId: reference.contextId, commands });
  const rootOperations = new RootEpochOperations(reference.contextId);
  const coverage = JSON.parse(db.prepare("SELECT value FROM meta WHERE key=?").get(rootCoverageKey(context))?.value || "null");
  const prefix = createHash("sha256"); let covered = false, turn = null, ended = false, birth = null;
  const seenCalls = new Set(), pendingCalls = new Set();
  const identity = rolloutIdentity(reference.transcriptPath);
  const source = readStableRollout(reference.transcriptPath, (entry, line) => {
    const p = entry.payload;
    if (line === 1) {
      requireFact(entry.type === "session_meta" && p.id === reference.contextId && !p.parent_thread_id && !p.source?.subagent,
        "native_root_identity_unproven");
      birth = { id: p.id, timestamp: entry.timestamp || p.timestamp, source: p.source ?? null, cwd: p.cwd };
      requireFact(realpathSync(p.cwd) === realpathSync(reference.cwd), "native_root_cwd_changed");
    }
    operations.observe(entry);
    rootOperations.observe(entry, operations);
    if (operations.calls.has(p?.call_id) && ["function_call", "custom_tool_call"].includes(p?.type)) operations.calls.get(p.call_id).prospectiveRootCoverage = covered;
    if (coverage && line <= coverage.throughLine) {
      prefix.update(JSON.stringify(entry) + "\n");
      if (line === coverage.throughLine) { requireFact(prefix.digest("hex") === coverage.prefixDigest, "root_coverage_changed"); covered = true; }
    }
    if (entry.type === "turn_context" || (entry.type === "event_msg" && p?.type === "task_started")) {
      if (turn !== p.turn_id) { turn = p.turn_id; ended = false; }
    }
    if (entry.type === "response_item" && ["function_call", "custom_tool_call"].includes(p?.type)) {
      requireFact(knownRootOperationCall(p), "unknown_external_operation_contract");
      requireFact(p.call_id && !seenCalls.has(p.call_id) && !ended, "duplicate_or_late_native_call");
      seenCalls.add(p.call_id); pendingCalls.add(p.call_id);
    }
    if (entry.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(p?.type) && p.call_id)
      requireFact(pendingCalls.delete(p.call_id), "unmatched_native_result");
    if (entry.type === "event_msg" && p?.type === "task_complete") {
      requireFact(p.turn_id === turn && !ended && !pendingCalls.size, "native_turn_completion_unproven"); ended = true;
    }
  }, { deadline });
  settleCoveredRootBatches(operations, commands);
  const retainedOperations = rootOperations.reconcile(operations);
  requireFact(turn === reference.turnId && ended && !pendingCalls.size && !operations.active.size && !operations.unanswered.size,
    "root_native_operations_or_turn_pending");
  requireFact(identity === rolloutIdentity(reference.transcriptPath), "root_source_changed");
  return { source, birth, identity, path: reference.transcriptPath, retainedOperations };
}

// A stopped child may retain accepted but unconsumed inputs and deferred work.
// Only execution quiescence is required here; closure/consumption is still owned
// by the original stage ledger and no outcome is produced by the epoch.
export async function prepareHostEpochHandover(store, reference, { candidate, adoptionToken = null, recoveryAudit = null, shellRoot, inspect = null } = {}) {
  ensureHostEpochSchema(store.db);
  const context = store.context({ cwd: reference.cwd, contextId: reference.contextId, create: false });
  const task = runtimeTask(store.db, context);
  requireFact(task, "task_not_observed_by_v2_dispatch_yet");
  const source = runtimeGeneration(store.db, task.generation), target = runtimeGeneration(store.db, candidate);
  const scopedQualification = readTaskQualification(store.db, { ...context, runtimeDigest: source.digest });
  const qualificationContext = { ...context, runtimeDigest: scopedQualification ? source.digest : undefined };
  const priorQualification = scopedQualification || readTaskQualification(store.db, qualificationContext);
  if (recoveryAudit || (priorQualification && priorQualification.state !== "passed")) {
    requireFact(!adoptionToken && priorQualification && historicalQualificationAuditCurrent(store, recoveryAudit, qualificationContext),
      "historical_qualification_recovery_unproven");
    requireFact(!readTaskQualification(store.db, { ...context, runtimeDigest: candidate }), "candidate_qualification_already_exists");
  }
  const nativeEntry = await installedEpochEntry(store.db, shellRoot);
  const assertRetirement = (generation) => nativeEntry.shell.digest === candidate
    ? assertColdEpochRetirement(store.db, generation, candidate) : nativeEntry.assertRetirement(generation);
  const cold = Boolean(store.db.prepare("SELECT 1 FROM runtime_epoch_publications WHERE source=? AND candidate=? AND json_extract(record,'$.entryMode')='cold'").get(source.digest, candidate));
  if (cold) { assertRetirement(source.digest); assertColdMessageCheckpoint(store.db, context); }
  reviewedEntry(source, { cold }); verifyRuntimePackage(target);
  // Returning to a frozen pre-epoch writer would bypass its checking state:
  // that writer cannot run the new admission guard or confirm its own entry.
  // Keep the current assignment until an epoch-capable rollback is available.
  requireFact(runtimeSourceDigest(target.root) === runtimeSourceDigest(), "rollback_or_target_epoch_entry_unproven");
  const publication = store.db.prepare("SELECT * FROM runtime_epoch_publications WHERE source=? AND candidate=?").get(source.digest, candidate)
    || store.db.prepare("SELECT * FROM runtime_epoch_publications WHERE source=? AND candidate=?").get(candidate, source.digest);
  requireFact(publication && JSON.parse(publication.record).verifier === runtimeSourceDigest(), "epoch_publication_missing_or_changed");
  if (nativeEntry.shell.digest !== candidate) {
    const entryPublication = store.db.prepare("SELECT record FROM runtime_epoch_publications WHERE source=? AND candidate=?")
      .get(nativeEntry.shell.digest, candidate);
    requireFact(entryPublication && JSON.parse(entryPublication.record).verifier === runtimeSourceDigest(), "installed_entry_publication_missing");
  }
  // Inventory and binding are read by the verifier. The public entry accepts
  // references only; a supplied binding/passed/proof is never an admission grant.
  inspect ||= (await import("./hook-readiness.mjs")).inspectLifecycleHookReadiness;
  const readiness = await inspect({ store, context: { ...context, runtimeDigest: candidate }, contextId: reference.contextId,
    cwd: reference.cwd, pluginRoot: shellRoot, historicalAdoption: false });
  const binding = readiness.binding;
  const state = snapshot(store.db, context);
  // Ordinary migrations only advance the task. Its retained stages can still
  // name an earlier package, including after route/outcome history pruning.
  // Verify each real source independently and carry that source into the
  // receipt; the current task generation is never substituted for its origin.
  const stageSources = new Map([[source.digest, source]]), stages = [];
  for (const stage of state.runtime_stages) {
    let original = stageSources.get(stage.generation);
    if (!original) {
      original = runtimeGeneration(store.db, stage.generation);
      reviewedEntry(original, { cold }); stageSources.set(stage.generation, original);
    }
    if (cold) assertRetirement(original.digest);
    const equivalent = original.writerDigest === source.writerDigest && original.shellDigest === source.shellDigest;
    const ownPublication = equivalent && !cold ? publication : store.db.prepare(
      "SELECT * FROM runtime_epoch_publications WHERE source=? AND candidate=?").get(original.digest, candidate)
      || store.db.prepare("SELECT * FROM runtime_epoch_publications WHERE source=? AND candidate=?").get(candidate, original.digest);
    requireFact(ownPublication && JSON.parse(ownPublication.record).verifier === runtimeSourceDigest(),
      `stage_epoch_publication_missing:${stage.route_id}`);
    stages.push({ routeId: stage.route_id, source: original.digest, candidate, publicationId: ownPublication.id,
      equivalenceSource: !cold && equivalent && original.digest !== source.digest ? source.digest : null });
  }
  requireFact(state.delegation_children.every((child) => stages.some((stage) => stage.routeId === child.route_id)),
    "retained_child_stage_binding_missing");
  for (const entry of state.entries.filter((entry) => entry.state === "referenced")) reviewedEntry(runtimeGeneration(store.db, entry.generation), { cold });
  assertLedgerQuiescence(state);
  requireFact(binding?.schema === 2 && binding.taskCwdDigest === payloadHash(realpathSync(reference.cwd)), "current_hook_binding_missing");
  const hook = readHookIdentityDiagnostic(process.env, { contextId: reference.contextId, turnId: reference.turnId });
  requireFact(hook.available && hook.reasonCode === "HOOK_DISPATCHED_IDENTITY_ACCEPTED", "actual_current_task_Hook_missing");
  // A historical v2 row has no turn/input/shell correlation. It is not enough:
  // frozen direct Hooks can write diagnostics without ever taking a lease.
  // Only this source's actual native dispatch entry can bind those facts. A
  // first/dormant A that never reaches it stays on A for native entry reload.
  const hasNativeEntry = (subject) => {
    const generation = subject === "task" ? source.digest : stages.find((stage) => stage.routeId === subject).source;
    return state.nativeEntries.some((entry) => {
      const record = JSON.parse(entry.record);
      return record.schema === "runtime-epoch-native-entry/1" && entry.subject === subject && entry.generation === generation
        && record.verifier === nativeEntry.verifier && record.shellDigest === nativeEntry.shell.digest
        && record.shellRootDigest === payloadHash(nativeEntry.shell.root) && binding.shellRoots.includes(record.shellRootDigest)
        && (subject !== "task" || record.turnDigest === payloadHash(reference.turnId))
        // Frozen dispatchers prune their completed invocation rows after 128
        // calls. The source-owned completion trigger preserves this exact
        // entry's terminal fact independently; ordinary history pruning must
        // not invalidate an idle child or a long root turn's entry proof.
        && state.nativeEntryCompletions.some((completion) => completion.invocation_id === entry.invocation_id
          && completion.generation === entry.generation);
    });
  };
  requireFact(hasNativeEntry("task"), "native_entry_attestation_missing:task");
  // This explicit coordinator reads the whole retained task outside a write
  // transaction. Its bounded scan must not consume the later commit window.
  // Ordinary Hook/closure/reclamation budgets remain unchanged.
  const deadline = Date.now() + 15_000;
  const root = rootQuiescence(store.db, context, reference, deadline);
  const sources = [[root.path, root.identity]], children = [];
  for (const child of state.delegation_children) {
    const locator = JSON.parse(openPrivateState(store.db, child.locator));
    const identity = rolloutIdentity(locator.transcriptPath);
    const commands = readChildCommands(store.db, child.route_id);
    const facts = applyOperationReviews(store.db, context, child, commands, readChildTurnEvidence(locator, { commands, deadline }));
    const operationSource = readStableRollout(locator.transcriptPath, (entry) => {
      if (entry.type === "response_item") requireFact(knownOperationCall(entry.payload), "unknown_child_operation_contract");
    }, { deadline });
    requireFact(operationSource.transcriptDigest === facts.transcriptDigest, "child_operation_source_changed");
    requireFact(facts.finished && !facts.pendingCalls.length && !facts.pendingOperations.length, "child_native_work_pending");
    requireFact(state.delegation_child_stops.some((stop) => stop.route_id === child.route_id && stop.turn_id === facts.lastFinal?.turnId
      && stop.result_digest === (facts.lastFinal.stopDigest || facts.lastFinal.digest)), "latest_child_Stop_missing");
    let entryBasis = "native_entry";
    if (!hasNativeEntry(child.route_id)) {
      // A settled child has no execution to hand over. Requiring a new turn
      // would reopen completed work just to manufacture installation evidence.
      // Re-read its full current responsibility and require the exact prior
      // verification token. This does not confirm a future child entry: its
      // first real followup still has to pass assertEpochAdmission.
      const maintenance = state.delegation_maintenance.find((row) => row.route_id === child.route_id);
      const closure = stageClosureStatus(store.db, context, child.route_id, { deadline, auditSettled: true });
      const verified = child.verified_revision === child.revision && child.verified_digest === closure?.token
        || maintenance?.state === "verified" && maintenance.verified_token === closure?.token;
      requireFact(child.state === "settled" && maintenance?.state !== "active"
        && state.outcomes.some((row) => row.route_id === child.route_id)
        && closure?.state === "ready" && verified, `native_entry_attestation_missing:${child.route_id}`);
      entryBasis = "verified_settled_history";
    }
    requireFact(identity === rolloutIdentity(locator.transcriptPath), "child_source_changed");
    sources.push([locator.transcriptPath, identity]);
    children.push({ routeId: child.route_id, revision: child.revision, sourceDigest: facts.transcriptDigest,
      operationDigest: facts.operationDigest, lastFinalDigest: payloadHash(facts.lastFinal), retainedCoverage: locator.commandCoverage || null, entryBasis });
  }
  requireFact(!store.db.prepare("SELECT 1 FROM meta WHERE key=?").get(`legacy_delegation_block:${context.projectId}:${context.contextKey}`), "legacy_unknown_responsibility");
  const record = { schema: "runtime-epoch-handover/1", source: source.digest, candidate, previous: state.epoch[0]?.receipt_id || null,
    baselineDigest: payloadHash(state), bindingDigest: binding.digest, root: { source: root.source, birthDigest: payloadHash(root.birth),
      retainedOperations: { count: root.retainedOperations.length, digest: payloadHash(root.retainedOperations),
        disposition: "preserved_without_business_settlement" } }, children, stages,
    verifier: runtimeSourceDigest(), nativeEntry: { shell: nativeEntry.shell.digest, verifier: nativeEntry.verifier },
    hookDigest: payloadHash(hook), turnDigest: payloadHash(reference.turnId),
    responsibility: "execution_continuation_only; original inputs, routes, tickets, outcomes and coverage retained",
    ...(recoveryAudit ? { historicalQualificationRecovery: { routeId: priorQualification.routeId,
      evidenceDigest: recoveryAudit.evidenceDigest, rawAuditDigest: recoveryAudit.rawAuditDigest,
      preservedState: priorQualification.state, candidateQualification: "required" } } : {}) };
  record.id = payloadHash(record);
  const token = Object.freeze({});
  HANDOVERS.set(token, { store, context, reference, source, target, stageSources, state, sources, hook, record, adoptionToken, recoveryAudit, qualificationContext,
    expiresAt: Date.now() + 5_000, root, cold, assertRetirement, nativeEntry });
  return token;
}

// This is reached from the newly audited dispatcher BEFORE changing generation,
// while the old business service/Hook is still selected. It cannot be synthesized
// by the CLI or by historical diagnostics. It proves a v2 path was entered; it
// NEVER proves retirement of a v1/native frozen entry; cold installation must
// separately retain its bytes and prove that its old launch paths are gone.
export function observeEpochNativeEntry(store, context, input, { invocation, shellRoot, stageId = null } = {}) {
  if (!shellRoot || !invocation?.id || !input.turn_id) return;
  const shell = inspectRuntimePackage(shellRoot);
  if (!readFileSync(join(shell.root, "scripts/lib/runtime-dispatch.mjs"))
    .equals(readFileSync(join(ROOT, "scripts/lib/runtime-dispatch.mjs")))) return;
  requireFact(store.db.prepare("SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'")
    .get(shell.root, shell.digest), "native_entry_shell_not_enrolled");
  const actual = store.db.prepare("SELECT * FROM runtime_invocations WHERE id=? AND state='active'").get(invocation.id);
  requireFact(actual?.project_id === context.projectId && actual.context_key === context.contextKey
    && actual.generation === invocation.generation && actual.kind === `hook:${input.hook_event_name}` && actual.pid === process.pid,
  "native_entry_live_invocation_missing");
  ensureHostEpochSchema(store.db);
  const prior = scoped(store.db, "runtime_epoch_native_entries", context).filter((entry) => entry.subject === (stageId || "task")
    && entry.generation === actual.generation);
  const completed = (id) => store.db.prepare("SELECT 1 FROM runtime_epoch_completed_invocations WHERE invocation_id=?").get(id);
  if (prior.some((entry) => completed(entry.invocation_id) && JSON.parse(entry.record).turnDigest === payloadHash(input.turn_id)
    && JSON.parse(entry.record).shellDigest === shell.digest)) return;
  for (const entry of prior) {
    if (!completed(entry.invocation_id) || store.db.prepare("SELECT 1 FROM runtime_epoch_entry_references WHERE invocation_id=?").get(entry.invocation_id)) continue;
    store.db.prepare("DELETE FROM runtime_epoch_native_entries WHERE invocation_id=?").run(entry.invocation_id);
    if (!store.db.prepare("SELECT 1 FROM runtime_epoch_execution WHERE invocation_id=?").get(entry.invocation_id))
      store.db.prepare("DELETE FROM runtime_epoch_completed_invocations WHERE invocation_id=?").run(entry.invocation_id);
  }
  store.db.prepare(`INSERT OR IGNORE INTO runtime_epoch_native_entries(invocation_id,project_id,context_key,subject,generation,record)
    VALUES(?,?,?,?,?,?)`).run(actual.id, context.projectId, context.contextKey, stageId || "task", actual.generation,
      canonicalJson({ schema: "runtime-epoch-native-entry/1", shellRootDigest: payloadHash(shell.root), shellDigest: shell.digest,
        verifier: runtimeSourceDigest(), turnDigest: payloadHash(input.turn_id), inputDigest: payloadHash(input), event: input.hook_event_name }));
}

export function commitHostEpochHandover(store, token) {
  const saved = HANDOVERS.get(token);
  requireFact(saved?.store === store, "source_owned_handover_proof_missing");
  if (!store.db.prepare("SELECT 1 FROM runtime_epoch_receipts WHERE id=?").get(saved.record.id))
    requireFact(Date.now() <= saved.expiresAt, "handover_preparation_expired");
  // Refresh the cold message proof outside the transaction, using its own
  // existing bounded reader. Recheck source identities after this fresh read;
  // elapsed verification time is not evidence that a native source changed.
  if (saved.cold) assertColdMessageCheckpoint(store.db, saved.context);
  const writeDeadline = Date.now() + 5_000;
  return store.transaction(() => {
    const { context, record, state } = saved;
    saved.nativeEntry.verify();
    if (saved.cold) for (const original of saved.stageSources.values()) saved.assertRetirement(original.digest);
    const previous = store.db.prepare("SELECT id FROM runtime_epoch_receipts WHERE id=?").get(record.id);
    if (previous) {
      requireFact(runtimeTask(store.db, context)?.generation === record.candidate, "receipt_superseded");
      return { id: record.id, state: "checking", idempotent: true };
    }
    requireFact(Date.now() <= writeDeadline, "epoch_commit_budget_exhausted");
    requireFact(saved.sources.every(([path, identity]) => rolloutIdentity(path) === identity), "native_source_changed");
    requireFact(!saved.recoveryAudit || historicalQualificationAuditCurrent(store, saved.recoveryAudit, saved.qualificationContext),
      "historical_qualification_recovery_changed");
    requireFact(payloadHash(snapshot(store.db, context)) === record.baselineDigest, "task_stage_invocation_or_input_revision_changed");
    requireFact(payloadHash(readHookIdentityDiagnostic(process.env, { contextId: saved.reference.contextId, turnId: saved.reference.turnId })) === payloadHash(saved.hook), "current_Hook_changed");
    for (const original of saved.stageSources.values()) verifyRuntimePackage(original);
    verifyRuntimePackage(saved.target);
    requireFact(record.verifier === runtimeSourceDigest(), "epoch_verifier_changed");
    assertLedgerQuiescence(state);
    if (saved.adoptionToken) {
      const adoption = commitHistoricalQualificationAdoption(store.db, saved.adoptionToken);
      requireFact(adoption.binding.digest === record.bindingDigest, "adoption_binding_differs");
    }
    const origin = (subject, generation, value) => store.db.prepare(`INSERT OR IGNORE INTO runtime_epoch_origins
      (project_id,context_key,subject,generation,record) VALUES(?,?,?,?,?)`).run(context.projectId, context.contextKey, subject, generation, sealPrivateState(store.db, canonicalJson(value)));
    origin("task", record.source, { schema: "runtime-epoch-origin/1", task: state.runtime_tasks[0], nativeBirth: saved.root.birth,
      qualifications: state.qualifications, retainedOperations: saved.root.retainedOperations,
      basis: "retained executing generation; no historical creator or business completion is inferred" });
    for (const stage of state.runtime_stages) origin(stage.route_id, stage.generation, { schema: "runtime-epoch-origin/1", stage,
      rows: Object.fromEntries(Object.entries(state).filter(([, rows]) => Array.isArray(rows)).map(([table, rows]) =>
        [table, rows.filter((row) => row.route_id === stage.route_id)])) });
    store.db.prepare(`INSERT INTO runtime_epoch_receipts(id,project_id,context_key,source,candidate,previous,baseline_digest,record)
      VALUES(?,?,?,?,?,?,?,?)`).run(record.id, context.projectId, context.contextKey, record.source, record.candidate, record.previous, record.baselineDigest, canonicalJson(record));
    for (const entry of state.nativeEntries) store.db.prepare("INSERT INTO runtime_epoch_entry_references VALUES(?,?)")
      .run(record.id, entry.invocation_id);
    requireFact(Date.now() <= writeDeadline, "epoch_commit_budget_exhausted");
    requireFact(saved.sources.every(([path, identity]) => rolloutIdentity(path) === identity), "native_source_changed");
    requireFact(!saved.recoveryAudit || historicalQualificationAuditCurrent(store, saved.recoveryAudit, saved.qualificationContext),
      "historical_qualification_recovery_changed");
    store.db.prepare("UPDATE runtime_stages SET generation=? WHERE project_id=? AND context_key=?")
      .run(record.candidate, context.projectId, context.contextKey);
    store.db.prepare("UPDATE runtime_tasks SET generation=?,candidate=NULL WHERE project_id=? AND context_key=?")
      .run(record.candidate, context.projectId, context.contextKey);
    store.db.prepare(`INSERT INTO runtime_epoch_tasks(project_id,context_key,receipt_id,generation,state) VALUES(?,?,?,?,'checking')
      ON CONFLICT(project_id,context_key) DO UPDATE SET receipt_id=excluded.receipt_id,generation=excluded.generation,state='checking'`)
      .run(context.projectId, context.contextKey, record.id, record.candidate);
    return { id: record.id, state: "checking", generation: record.candidate, stagesContinued: state.runtime_stages.length };
  });
}

export function epochAdmissionState(db, context, stageId = null) {
  if (!hasHostEpochSchema(db)) return { required: false, ready: true };
  const task = db.prepare("SELECT * FROM runtime_epoch_tasks WHERE project_id=? AND context_key=?").get(context.projectId, context.contextKey);
  if (!task) return { required: false, ready: true };
  const evidence = (subject, kind) => db.prepare(`SELECT DISTINCT e.generation FROM runtime_epoch_execution e JOIN runtime_epoch_completed_invocations i
    ON i.invocation_id=e.invocation_id AND i.generation=e.generation WHERE e.receipt_id=? AND e.subject=? AND e.kind=?`)
    .all(task.receipt_id, subject, kind).some((row) => runtimeEpochGenerationCompatible(db, context, row.generation));
  const rootReady = evidence("task", "hook") && evidence("task", "read");
  const childReady = !stageId || !db.prepare("SELECT 1 FROM delegation_children WHERE route_id=?").get(stageId)
    || evidence(stageId, "hook");
  const execution = runtimeTask(db, context);
  const stage = stageId && db.prepare("SELECT * FROM runtime_stages WHERE route_id=? AND project_id=? AND context_key=?")
    .get(stageId, context.projectId, context.contextKey);
  const generation = stage?.generation || execution?.candidate || execution?.generation || task.generation;
  return { required: true, ready: rootReady && childReady, rootReady, childReady, receiptId: task.receipt_id,
    generation, epochGeneration: task.generation,
    reasonCode: !rootReady ? "HOST_EPOCH_ENTRY_UNCONFIRMED" : !childReady ? "HOST_EPOCH_CHILD_ENTRY_UNCONFIRMED" : null };
}

// Call only from the selected B Hook/service, after trusted identity resolution.
// Caller flags cannot create a record: it must be a live registered invocation
// of THIS module's immutable package. Completed rows prove the body returned.
export function observeEpochExecution(store, { input = null, name = null, args = null } = {}) {
  if (!hasHostEpochSchema(store.db)) return { observed: false };
  const id = store.runtimeInvocation?.id || process.env.ADAPTIVE_ROUTER_INVOCATION_ID;
  const invocation = id && store.db.prepare("SELECT * FROM runtime_invocations WHERE id=? AND state='active'").get(id);
  if (!invocation) return { observed: false };
  const context = { projectId: invocation.project_id, contextKey: invocation.context_key };
  const epoch = store.db.prepare("SELECT * FROM runtime_epoch_tasks WHERE project_id=? AND context_key=?").get(context.projectId, context.contextKey);
  if (!epoch) return { observed: false };
  const selected = runtimeGeneration(store.db, invocation.generation);
  requireFact(runtimeEpochGenerationCompatible(store.db, context, selected.digest)
    && runtimeSourceDigest(selected.root) === runtimeSourceDigest(), "selected_B_execution_source_mismatch");
  let kind, subject = "task";
  if (input && invocation.kind === `hook:${input.hook_event_name}`) {
    requireFact(input.session_id && input.turn_id, "actual_Hook_turn_identity_missing");
    if (input.agent_id || input.agent_type) {
      requireFact(["PreToolUse", "PostToolUse", "SubagentStop", "Stop"].includes(input.hook_event_name), "child_followup_entry_not_observed");
      const child = store.db.prepare("SELECT * FROM delegation_children WHERE project_id=? AND context_key=? AND agent_hash=?")
        .get(context.projectId, context.contextKey, payloadHash(input.agent_id));
      requireFact(child, "child_identity_missing"); subject = child.route_id;
    } else {
      const actual = store.context({ cwd: input.cwd, contextId: input.session_id, create: false });
      requireFact(actual.projectId === context.projectId && actual.contextKey === context.contextKey, "Hook_context_mismatch");
    }
    kind = "hook";
  } else if (["get_route_status", "get_route_history"].includes(name) && invocation.kind === `mcp:${name}`) {
    requireFact(typeof args?.contextId === "string" && opaqueId(store.salt, "context", `${context.projectId}\0${args.contextId.normalize("NFC")}`)
      === context.contextKey, "read_context_mismatch"); kind = "read";
  } else return { observed: false };
  const assigned = runtimeTask(store.db, context);
  const selectedStage = subject !== "task" ? subject : input?.tool_input?.target
    ? targetedChild(store.db, context, input.tool_input.target)?.route_id : null;
  const stage = selectedStage && store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=? AND project_id=? AND context_key=?")
    .get(selectedStage, context.projectId, context.contextKey);
  requireFact(invocation.generation === (stage?.generation || assigned?.candidate || assigned?.generation),
    "current_epoch_assignment_differs");
  LIVE_OBSERVATIONS.set(id, { receiptId: epoch.receipt_id, subject, kind,
    event: input?.hook_event_name || null, toolName: input?.tool_name || null });
  if (LIVE_OBSERVATIONS.size > 128) LIVE_OBSERVATIONS.delete(LIVE_OBSERVATIONS.keys().next().value);
  const confirmed = store.db.prepare(`SELECT 1 FROM runtime_epoch_execution e JOIN runtime_epoch_completed_invocations c
    ON c.invocation_id=e.invocation_id WHERE e.receipt_id=? AND e.subject=? AND e.kind=? AND e.generation=?`)
    .get(epoch.receipt_id, subject, kind, invocation.generation);
  if (confirmed) return { observed: true, reused: true, subject, kind, ...epochAdmissionState(store.db, context, subject === "task" ? null : subject) };
  store.db.prepare(`INSERT OR IGNORE INTO runtime_epoch_execution(receipt_id,subject,kind,invocation_id,generation,record)
    VALUES(?,?,?,?,?,?)`).run(epoch.receipt_id, subject, kind, id, invocation.generation,
      canonicalJson({ schema: "runtime-epoch-execution/1", inputDigest: payloadHash(input || { name, args }), verifier: runtimeSourceDigest() }));
  return { observed: true, subject, kind, ...epochAdmissionState(store.db, context, subject === "task" ? null : subject) };
}

export function assertEpochAdmission(store, context, { kind, stageId = null } = {}) {
  let status = epochAdmissionState(store.db, context, stageId);
  if (!status.required) return status;
  // Native Hook delivery itself and readonly inspection establish entry. The
  // caller guards business mutations after observing them; no probe is spawned.
  if (["get_route_status", "get_route_history", "observe_hook"].includes(kind)) return status;
  const id = store.runtimeInvocation?.id || process.env.ADAPTIVE_ROUTER_INVOCATION_ID;
  const invocation = id && store.db.prepare(`SELECT * FROM runtime_invocations WHERE id=? AND state='active'
    AND project_id=? AND context_key=? AND generation=?`).get(id, context.projectId, context.contextKey, status.generation);
  const task = runtimeTask(store.db, context);
  requireFact(invocation && task && runtimeEpochGenerationCompatible(store.db, context, invocation.generation)
    && runtimeEpochGenerationCompatible(store.db, context, task.candidate || task.generation), "current_epoch_invocation_missing");
  const selected = runtimeGeneration(store.db, invocation.generation);
  requireFact(runtimeSourceDigest(selected.root) === runtimeSourceDigest(), "current_epoch_execution_source_differs");
  if (stageId) requireFact(store.db.prepare(`SELECT 1 FROM runtime_stages WHERE route_id=? AND project_id=? AND context_key=? AND generation=?`)
    .get(stageId, context.projectId, context.contextKey, invocation.generation), "current_stage_generation_differs");
  if (!status.rootReady) fail(status.reasonCode);
  // A completed historical confirmation never grants a different operation or
  // an arbitrary MCP name. The current dispatch must own this exact API entry.
  if (["route_stage", "manage_stage", "record_outcome"].includes(kind) && invocation.kind === `mcp:${kind}`)
    return { ...status, ready: true, childConfirmationPending: !status.childReady };
  const live = LIVE_OBSERVATIONS.get(id);
  const currentPre = invocation.kind === "hook:PreToolUse" && live?.receiptId === status.receiptId
    && live.kind === "hook" && live.event === "PreToolUse";
  // A real B child Pre admits its first operation atomically after the trusted
  // observer ran in this process. It need not wait for its own completion.
  if (currentPre && kind === "child_business" && stageId && live.subject === stageId)
    return { ...status, ready: true, childReady: true, currentNativeEntry: true };
  if (currentPre && kind === "spawn_agent" && live.subject === "task"
    && /^(?:Agent|(?:collaboration)?spawn_agent)$/u.test(live.toolName || "")) return status;
  // Root followup must be able to wake a retained child. A child sender still
  // needs its own actual Pre and cannot borrow a sibling's completed receipt.
  if (currentPre && /^(?:collaboration)?(?:send_message|followup_task|interrupt_agent)$/u.test(kind || "")
    && live.toolName === kind && stageId && (live.subject === "task" || live.subject === stageId))
    return { ...status, ready: true, childConfirmationPending: !status.childReady };
  fail(status.ready ? "current_epoch_entry_kind_or_subject_unproven" : status.reasonCode);
}
