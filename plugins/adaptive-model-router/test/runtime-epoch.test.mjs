import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { archiveHistoricalRuntime } from "./support/historical-runtime.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { bindRuntimeStage, publishRuntime, runtimeTask, runtimeReferences, settleRuntimeMigration, beginRuntimeMigration, pendingRuntimeResponsibilities } from "../scripts/lib/runtime-isolation.mjs";
import { qualifyRuntimeCompatibility } from "../scripts/lib/runtime-compatibility.mjs";
import { inspectRuntimeBoundary, isRuntimeBoundaryProof } from "../scripts/lib/runtime-boundary.mjs";
import { beginHookDispatch, endRuntimeDispatch, beginMcpDispatch } from "../scripts/lib/runtime-dispatch.mjs";
import { lifecycleBinding, runtimeSourceDigest, readTaskQualification, qualificationReadiness } from "../scripts/lib/lifecycle-qualification.mjs";
import { recoverHistoricalQualification } from "../scripts/lib/historical-qualification-recovery.mjs";
import { resolveHookIdentity } from "../scripts/lib/hook-identity.mjs";
import { recordHookIdentityDiagnostic } from "../scripts/lib/hook-diagnostics.mjs";
import { qualifyHostEpochPublication, publishHostEpoch, prepareHostEpochHandover, commitHostEpochHandover,
  observeEpochExecution, assertEpochAdmission, epochAdmissionState } from "../scripts/lib/runtime-epoch.mjs";
import { sweepHostCompatibilityEpoch, activateHostCompatibilityEpoch, sourceTaskQualification } from "../scripts/lib/runtime-epoch-sweep.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { prepareColdHostEpochInstallation, inspectColdHostEpochRetirement, commitColdHostEpochRetirement,
  assertColdEpochRetirement, restoreColdHostEpochEntries, relocateColdHostEpochEntries, coldPendingMessageResponsibilities } from "../scripts/lib/runtime-cold-install.mjs";
import { rememberRootTranscript } from "../scripts/lib/stage-reconciliation.mjs";
import { openPrivateState } from "../scripts/lib/private-state.mjs";
import { readChildTurnEvidence } from "../scripts/lib/child-turn-evidence.mjs";
import { prepareMessageCheckpoint, prepareMessageContinuation, prepareMessageArrivalReview, messageContinuationProjection, commitMessageCheckpoint, readMessageCheckpoints } from "../scripts/lib/message-checkpoint.mjs";
import { stageClosureStatus, observeManagedMessage, observeManagedStop } from "../scripts/lib/stage-closure.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { CATALOG, routeInput } from "./fixtures.mjs";
import { historicalQualificationFixture } from "./support/historical-qualification.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "16c439dd0bf3657ba06707ff15c1465613d49554";
// Historical source contract: checkout must contain this exact commit object.
// CI uses fetch-depth: 0; a shallow local checkout can explicitly fetch it with
// git fetch origin 16c439dd0bf3657ba06707ff15c1465613d49554. Missing history fails.
const moduleAt = (base, name) => import(pathToFileURL(join(base, "scripts/lib", `${name}.mjs`)));
let work, a, b, publication, old, sourceAtStart;
before(async (t) => {
  sourceAtStart = runtimeSourceDigest(root);
  work = realpathSync(mkdtempSync(join(tmpdir(), "router-epoch-test-")));
  const archive = archiveHistoricalRuntime(resolve(root, "../.."), BASELINE);
  assert.equal(archive.status, 0, "Historical A must be available as exact git object 16c439dd (CI fetch-depth: 0); never substitute live cache");
  assert.equal(spawnSync("tar", ["-xf", "-", "-C", work], { input: archive.stdout }).status, 0);
  a = inspectRuntimePackage(join(work, "plugins/adaptive-model-router"));
  cpSync(root, join(work, "candidate"), { recursive: true });
  // This private candidate uses the fixture's data home, not the source
  // installation's absolute stable-shell binding. Hash it only after removal.
  rmSync(join(work, "candidate", "runtime-host.json"), { force: true });
  b = inspectRuntimePackage(join(work, "candidate"));
  old = Object.fromEntries(await Promise.all(["router", "delegation-gate", "stage-closure", "runtime-dispatch", "database"]
    .map(async (name) => [name, await moduleAt(a.root, name)])));
  publication = qualifyHostEpochPublication(a, b);
  t.diagnostic(JSON.stringify({ sourceAtStart, frozenA: a.digest, candidateB: b.digest }));
});
after((t) => {
  try {
    const sourceAtEnd = runtimeSourceDigest(root);
    t.diagnostic(JSON.stringify({ sourceAtStart, sourceAtEnd }));
    assert.equal(sourceAtEnd, sourceAtStart, "Source changed during fixture run; repeat with a stable snapshot before interpreting compatibility results");
    if (a) assert.equal(inspectRuntimePackage(a.root).digest, a.digest, "A bytes stay frozen");
  }
  finally { if (work) rmSync(work, { recursive: true, force: true }); }
});

async function fixture(run) {
  const cwd = realpathSync(mkdtempSync(join(work, "case-"))), home = join(cwd, "state");
  const environment = { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home, CODEX_HOME: join(cwd, "codex"),
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "", CODEX_THREAD_ID: "" };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const store = new RouterStore();
  try {
    store.transaction(() => publishRuntime(store.db, a, home, { bootstrap: true, shellRoot: a.root }));
    publishHostEpoch(store, publication);
    // Explicit isolated native-entry reload fixture. The new source dispatcher
    // remains on A initially. This is not evidence a real frozen host reloaded.
    store.db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(b.root, b.digest);
    const contextId = "epoch-owner", turnId = "old-complete-turn";
    const transcriptPath = join(cwd, "root.jsonl");
    const records = [
      { type: "session_meta", timestamp: "2026-09-01T00:00:00Z", payload: { id: contextId, cwd, cli_version: "old-host" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ];
    const writeRoot = () => writeFileSync(transcriptPath, records.map(JSON.stringify).join("\n") + "\n"); writeRoot();
    const input = { hook_event_name: "Stop", session_id: contextId, turn_id: turnId, cwd, transcript_path: transcriptPath };
    const dispatch = beginHookDispatch(input, { shellRoot: b.root });
    endRuntimeDispatch(dispatch);
    const context = store.context({ cwd, contextId, create: false });
    const identity = resolveHookIdentity(input);
    recordHookIdentityDiagnostic(identity.audit, "identity_accepted", process.env, { contextId, turnId });
    const binding = lifecycleBinding([], b.root, b.root, { cliVersion: "new-host", platform: "darwin" }, cwd);
    const reference = { contextId, turnId, cwd, transcriptPath };
    const prepare = () => prepareHostEpochHandover(store, reference, { candidate: b.digest, shellRoot: b.root,
      inspect: async () => ({ ready: false, binding }) });
    await run({ store, context, cwd, home, reference, records, writeRoot, input, binding, prepare });
  } finally {
    store.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

const business = (db) => JSON.stringify(Object.fromEntries(["routes", "outcomes", "delegation_attempts", "delegation_children",
  "delegation_messages", "delegation_child_stops", "delegation_stage_journal", "delegation_maintenance"]
  .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));

async function retainedChild(f) {
  const modules = f.legacyModules || old;
  const dispatch = (f.runtimeShell ? beginMcpDispatch : old["runtime-dispatch"].beginMcpDispatch)("route_stage", { contextId: f.reference.contextId },
    { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: f.runtimeShell || a.root });
  f.store.runtimeInvocation = dispatch.invocation;
  let route;
  try { route = await modules.router.routeStage(routeInput({ contextId: f.reference.contextId }),
    { store: f.store, cwd: f.cwd, catalog: CATALOG, enforceLifecycleHooks: false, diskProbe: () => 20n * 1024n ** 3n }); }
  finally { endRuntimeDispatch(dispatch); f.store.runtimeInvocation = null; }
  assert.equal(route.action, "delegate");
  const childId = f.childId || "retained-child", taskName = route.carrier.taskName, agentPath = `/root/${taskName}`;
  const toolInput = { task_name: taskName, message: route.carrier.message, model: route.target.model,
    reasoning_effort: route.target.effort, fork_turns: "none" };
  const gate = modules["delegation-gate"], closure = modules["stage-closure"];
  const path = join(f.cwd, f.childId ? `${f.childId}.jsonl` : "child.jsonl"), turnId = "child-turn", text = "Original unverified final";
  const childRecords = [
    { type: "session_meta", payload: { id: childId, session_id: f.reference.contextId, parent_thread_id: f.reference.contextId,
      cwd: f.cwd, agent_path: agentPath, source: { subagent: { thread_spawn: { parent_thread_id: f.reference.contextId, depth: 1, agent_path: agentPath } } } } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "inter_agent_communication_metadata", payload: { trigger_turn: true } },
    { type: "response_item", payload: { type: "agent_message", id: "activation", author: "/root", recipient: agentPath,
      content: [{ type: "input_text", text: "Original request" }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: text } },
  ];
  writeFileSync(path, childRecords.map(JSON.stringify).join("\n") + "\n");
  f.store.transaction(() => {
    assert.equal(gate.consumeDelegationTicket(f.store.db, f.context, { taskName, turnId: f.reference.turnId, toolUseId: "spawn", toolInput }).allowed, true);
    assert.equal(gate.claimDelegationSubagent(f.store.db, f.context, { taskName, agentId: childId, model: route.target.model }).allowed, true);
    gate.observeAgentResult(f.store.db, f.context, { turnId: f.reference.turnId, toolUseId: "spawn", toolInput, toolResponse: { agent_id: childId } });
    closure.registerManagedChild(f.store.db, f.context, route.routeId, { taskName, childId, parentContextId: f.reference.contextId, agentPath, transcriptPath: path });
    if (f.pendingInput !== false) {
      const message = { tool_name: "send_message", turn_id: f.reference.turnId, tool_use_id: f.pendingCallId || "retained-input", tool_input: { target: childId, message: f.pendingInputMessage || "Keep this unconsumed request" } };
      closure.observeManagedMessage(f.store.db, f.context, message);
      closure.observeManagedMessage(f.store.db, f.context, { ...message, tool_response: "" }, { post: true });
    }
    gate.observeSubagentStop(f.store.db, f.context, taskName, childId, 4096, { turnId, lastAssistantMessage: text });
    closure.observeManagedStop(f.store.db, route.routeId, { turnId, lastAssistantMessage: text });
  });
  const stop = { hook_event_name: "SubagentStop", session_id: f.reference.contextId, agent_id: childId, turn_id: turnId,
    cwd: f.cwd, agent_transcript_path: path, transcript_path: path };
  if (f.childEntry !== false) {
    const childDispatch = beginHookDispatch(stop, { shellRoot: b.root }); endRuntimeDispatch(childDispatch);
  }
  return { route, childId, taskName, agentPath, path, childRecords, stop };
}

async function settledHistoricalChild(f) {
    const child = await retainedChild({ ...f, pendingInput: false, childEntry: false });
    const closure = stageClosureStatus(f.store.db, f.context, child.route.routeId);
    assert.equal(closure.state, "ready");
    await callRouterTool("record_outcome", { contextId: f.reference.contextId, routeId: child.route.routeId,
      status: "passed", gate: child.route.verificationGate, failureType: null, retries: 0,
      retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0,
      userCorrection: false, closureToken: closure.token }, { store: f.store, cwd: f.cwd });
    return child;
}

test("settled historical child does not require a new Hook turn before its idle root can adopt", async () => {
  await fixture(async (f) => {
    const child = await settledHistoricalChild(f);
    const before = business(f.store.db);
    assert.equal(f.store.db.prepare("SELECT state FROM delegation_children WHERE route_id=?").get(child.route.routeId).state, "settled");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_native_entries WHERE subject=?").get(child.route.routeId).n, 0);
    const result = commitHostEpochHandover(f.store, await f.prepare());
    assert.equal(runtimeTask(f.store.db, f.context).generation, b.digest);
    assert.equal(business(f.store.db), before);
    const record = JSON.parse(f.store.db.prepare("SELECT record FROM runtime_epoch_receipts WHERE id=?").get(result.id).record);
    assert.equal(record.children[0].entryBasis, "verified_settled_history");
    assert.equal(epochAdmissionState(f.store.db, f.context, child.route.routeId).childReady, false,
      "terminal history is not an invented current child Hook");
  });
});

test("settled history cannot hide stale review, running work, new input or changed sources", async () => {
  for (const mode of ["stale-review", "running", "new-input", "source-changed", "active-maintenance"]) await fixture(async (f) => {
    const child = await settledHistoricalChild(f);
    let token;
    if (mode === "source-changed") token = await f.prepare();
    if (mode === "stale-review") f.store.db.prepare("UPDATE delegation_children SET verified_digest=NULL WHERE route_id=?").run(child.route.routeId);
    if (mode === "running") child.childRecords.push(event("task_started", { turn_id: "new-active-turn" }));
    if (mode === "new-input") child.childRecords.push(event("task_started", { turn_id: "unreviewed-turn" }),
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: true } }, { type: "response_item", payload: { type: "agent_message",
      id: "unreviewed-input", author: "/root", recipient: child.agentPath, content: [{ type: "input_text", text: "Unfinished new requirement" }],
      internal_chat_message_metadata_passthrough: { turn_id: "unreviewed-turn" } } });
    if (mode === "source-changed") child.childRecords.push(event("diagnostic"));
    if (mode === "active-maintenance") await callRouterTool("manage_stage", { contextId: f.reference.contextId,
      routeId: child.route.routeId, action: "begin_maintenance", expectedRevision: 0,
      parentTranscriptPath: f.reference.transcriptPath,
      disposition: { intent: "collect", basis: "Current accepted collection still needs a reply", requirements: [], pendingOperations: [] } },
    { store: f.store, cwd: f.cwd });
    writeFileSync(child.path, child.childRecords.map(JSON.stringify).join("\n") + "\n");
    const before = business(f.store.db);
    if (token) assert.throws(() => commitHostEpochHandover(f.store, token), /changed/);
    else await assert.rejects(f.prepare(), /blocked/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    assert.equal(business(f.store.db), before);
  });
});

test("epoch discovery retains unscoped legacy qualification and never hides invalid scoped responsibility", async () => {
  await fixture(async (f) => {
    const key = `native_qualification:${f.context.projectId}:${f.context.contextKey}`;
    // Invalid retained state deliberately cannot be replaced with a fresh
    // qualification ticket. Discovery is not an assertion of a passed proof.
    f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify({ schema: 1, state: "failed" }));
    assert.deepEqual(sourceTaskQualification(f.store.db, f.context, a.digest), {
      qualification: { state: "invalid" }, sourceGeneration: null });
    f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(`${key}:runtime:${a.digest}`, "{}");
    assert.deepEqual(sourceTaskQualification(f.store.db, f.context, a.digest), {
      qualification: { state: "invalid" }, sourceGeneration: a.digest });
  });
});

test("historical failure handover requires a fresh source-owned repair audit and grants no candidate proof", async () => {
  for (const mode of ["success", "child-change", "child-change-during-commit"]) await fixture(async (f) => {
    const dispatch = beginMcpDispatch("route_stage", { contextId: f.reference.contextId },
      { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: b.root });
    f.store.runtimeInvocation = dispatch.invocation;
    await historicalQualificationFixture("completed", async (h) => {
      endRuntimeDispatch(dispatch); f.store.runtimeInvocation = null;
      const reference = { ...f.reference, turnId: "root-next", transcriptPath: h.parent.path };
      const input = { ...f.input, turn_id: reference.turnId, transcript_path: reference.transcriptPath };
      endRuntimeDispatch(beginHookDispatch(input, { shellRoot: b.root }));
      recordHookIdentityDiagnostic(resolveHookIdentity(input).audit, "identity_accepted", process.env,
        { contextId: reference.contextId, turnId: reference.turnId });
      const prepare = (recoveryAudit) => prepareHostEpochHandover(f.store, reference, { candidate: b.digest, shellRoot: b.root,
        recoveryAudit, inspect: async () => ({ ready: false, binding: f.binding }) });
      await assert.rejects(prepare(null), /historical_qualification_recovery_unproven/);
      const preview = await recoverHistoricalQualification(h.input, h.options);
      assert.equal(preview.status, "recoverable");
      assert.equal((await recoverHistoricalQualification({ ...h.input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, h.options)).status, "reconciled_failure");
      const audit = await recoverHistoricalQualification(h.input, { ...h.options, verifyRetainedNative: true });
      assert.equal(audit.status, "reconciled_failure");
      await assert.rejects(prepare(JSON.parse(JSON.stringify(audit))), /historical_qualification_recovery_unproven/);
      const before = business(f.store.db), original = readTaskQualification(f.store.db, h.context);
      const token = await prepare(audit);
      const changeChild = () => {
        h.childRecords.push(event("task_started", { turn_id: "late-work" }));
        writeFileSync(h.child.path, h.childRecords.map(JSON.stringify).join("\n") + "\n");
      };
      if (mode !== "success") {
        const originalPrepare = f.store.db.prepare;
        if (mode === "child-change") changeChild();
        else f.store.db.prepare = function (sql, ...args) {
          if (sql.startsWith("INSERT INTO runtime_epoch_receipts")) changeChild();
          return originalPrepare.call(this, sql, ...args);
        };
        try { assert.throws(() => commitHostEpochHandover(f.store, token), /historical_qualification_recovery_changed/); }
        finally { f.store.db.prepare = originalPrepare; }
        assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
      } else {
        const result = commitHostEpochHandover(f.store, token);
        assert.equal(runtimeTask(f.store.db, f.context).generation, b.digest);
        assert.deepEqual(readTaskQualification(f.store.db, h.context), original);
        assert.equal(readTaskQualification(f.store.db, { ...f.context, runtimeDigest: b.digest }), null);
        assert.equal(qualificationReadiness(f.store.db, { ...f.context, runtimeDigest: b.digest }, f.binding).ready, false);
        const receipt = JSON.parse(f.store.db.prepare("SELECT record FROM runtime_epoch_receipts WHERE id=?").get(result.id).record);
        assert.equal(receipt.historicalQualificationRecovery.candidateQualification, "required");
        assert.equal(receipt.historicalQualificationRecovery.preservedState, "failed");
      }
      assert.equal(business(f.store.db), before);
    }, { store: f.store, project: { root: f.cwd, home: f.home }, contextId: f.reference.contextId,
      parentPrefix: f.records, sourceGeneration: a.digest });
  });
});

test("source-owned epoch publication runs real immutable A/B readers and leaves task/default assignment unchanged", async () => {
  await fixture(async (f) => {
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    assert.equal(f.store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, a.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_publications").get().n, 1);
    assert.throws(() => publishHostEpoch(f.store, { passed: true }), /source_owned_publication_proof_missing/);
    assert.equal(publishHostEpoch(f.store, publication).taskBindingsChanged, 0);
  });
});

async function coldFixture(run, { legacy = false } = {}) {
  const cwd = realpathSync(mkdtempSync(join(work, "cold-case-"))), home = join(cwd, "state"), originalPath = join(cwd, "native-cache-A");
  cpSync(legacy ? process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE : a.root, originalPath, { recursive: true });
  const source = inspectRuntimePackage(originalPath, { legacy });
  const values = { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home, CODEX_HOME: join(cwd, "codex"),
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "", CODEX_THREAD_ID: "" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values);
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const store = new RouterStore();
  try {
    const contextId = "cold-native-owner", turnId = "cold-completed-turn";
    const context = store.context({ cwd, contextId });
    // A real preexisting scope before preparation, even if it has not routed.
    store.configure(context, { autoActivate: true }, "global");
    store.db.prepare("INSERT INTO host_model_state(project_id,context_key,current_model,task_mode,updated_at) VALUES(?,?,'gpt-6-astra','automatic',?)")
      .run(context.projectId, context.contextKey, new Date().toISOString());
    if (!legacy) {
      // Exact frozen registry can retain the original native entry path.
      store.transaction(() => publishRuntime(store.db, source, home, { bootstrap: true, shellRoot: source.root }));
      store.db.prepare("UPDATE runtime_generations SET record=? WHERE digest=?").run(JSON.stringify(source), source.digest);
      store.db.prepare("INSERT INTO runtime_tasks(project_id,context_key,generation) VALUES(?,?,?)").run(context.projectId, context.contextKey, source.digest);
    }
    const installation = prepareColdHostEpochInstallation(store, { source, candidate: b, shellRoot: b.root });
    assert.equal(runtimeTask(store.db, context).generation, source.digest);
    assert.throws(() => commitColdHostEpochRetirement(store, { passed: true, processes: [] }), /source_owned/);
    assert.throws(() => inspectColdHostEpochRetirement(store, installation.id, { inventory: () => [] }), /old_entry_still/);
    assert.throws(() => assertColdEpochRetirement(store.db, source.digest, b.digest), /retirement_missing/);
    // External registered shells survive native cache deletion. The source
    // coordinator archives their original bytes; v1 here is an offline cache
    // deletion fixture, not a logged-in host proof.
    if (legacy) rmSync(originalPath, { recursive: true });
    else {
      const moved = relocateColdHostEpochEntries(store, installation.id, { inventory: () => [] });
      assert.equal(moved.relocated.length, 1);
      assert.equal(inspectRuntimePackage(moved.relocated[0].archivePath).digest, source.digest);
      assert.equal(relocateColdHostEpochEntries(store, installation.id, { inventory: () => [] }).relocated.length, 0);
    }
    const proof = inspectColdHostEpochRetirement(store, installation.id, { inventory: () => [] });
    commitColdHostEpochRetirement(store, proof);
    assert.equal(commitColdHostEpochRetirement(store, proof).idempotent, true);
    assert.equal(runtimeTask(store.db, context).generation, source.digest, "retirement never implies task entry");
    const retained = JSON.parse(store.db.prepare("SELECT record FROM runtime_generations WHERE digest=?").get(source.digest).record);
    const transcriptPath = join(cwd, "root.jsonl"), records = [
      { type: "session_meta", timestamp: "2026-09-01T00:00:00Z", payload: { id: contextId, cwd } },
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }];
    const writeRoot = () => writeFileSync(transcriptPath, records.map(JSON.stringify).join("\n") + "\n"); writeRoot();
    const reference = { contextId, cwd, turnId, transcriptPath };
    rememberRootTranscript(store.db, context, transcriptPath);
    const input = { hook_event_name: "Stop", session_id: contextId, cwd, turn_id: turnId, transcript_path: transcriptPath };
    const binding = lifecycleBinding([], b.root, b.root, { platform: "darwin" }, cwd);
    const prepare = () => prepareHostEpochHandover(store, reference, { candidate: b.digest, shellRoot: b.root, inspect: async () => ({ binding }) });
    const identity = resolveHookIdentity(input); recordHookIdentityDiagnostic(identity.audit, "identity_accepted", process.env, { contextId, turnId });
    await assert.rejects(prepare(), /native_entry_attestation_missing/);
    endRuntimeDispatch(beginHookDispatch(input, { shellRoot: b.root }));
    const legacyModules = Object.fromEntries(await Promise.all(["router", "delegation-gate", "stage-closure"]
      .map(async (name) => [name, await moduleAt(retained.root, name)])));
    await run({ store, context, cwd, home, reference, input, binding, prepare, source, retained, originalPath, installation,
      records, writeRoot, legacyModules, runtimeShell: b.root });
    assert.equal(inspectRuntimePackage(retained.root, { legacy }).digest, source.digest);
  } finally {
    store.close(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test("cold frozen v2 resumes through the new entry on the first and subsequent user turns", async () => {
  await coldFixture(async (f) => {
    commitHostEpochHandover(f.store, await f.prepare());
    for (const turn of ["first-cold-user-turn", "later-cold-user-turn"]) {
      f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: turn } }); f.writeRoot();
      const hook = spawnSync(process.execPath, [join(b.root, "scripts/node-launcher.mjs"), join(b.root, "scripts/hook.mjs"), "prompt"], {
        cwd: f.cwd, encoding: "utf8", env: { ...process.env, PLUGIN_ROOT: b.root, ADAPTIVE_ROUTER_NODE: process.execPath },
        input: JSON.stringify({ ...f.input, hook_event_name: "UserPromptSubmit", turn_id: turn, prompt: "Continue", model: "gpt-6-astra" }) });
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(runtimeTask(f.store.db, f.context).generation, b.digest);
      assert.equal(runtimeTask(f.store.db, f.context).candidate, null);
      f.records.push({ type: "event_msg", payload: { type: "task_complete", turn_id: turn } }); f.writeRoot();
    }
  });
});

test("cold exact v1 adopts root and retained child only after B entry, preserving original result", {
  skip: !process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE && "Requires exact isolated installed-v1 fixture",
}, async () => {
  await coldFixture(async (f) => {
    const child = await retainedChild({ ...f, pendingInput: false }), before = business(f.store.db);
    const transfer = commitHostEpochHandover(f.store, await f.prepare());
    assert.equal(business(f.store.db), before);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(child.route.routeId).generation, b.digest);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_epoch_origins WHERE subject=?").get(child.route.routeId).generation, f.source.digest);
    assert.equal(epochAdmissionState(f.store.db, f.context, child.route.routeId).ready, false);
    for (const [dispatch, observation] of [
      [beginHookDispatch(f.input, { shellRoot: b.root }), { input: f.input }],
      [beginMcpDispatch("get_route_status", { contextId: f.reference.contextId }, { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: b.root }),
        { name: "get_route_status", args: { contextId: f.reference.contextId } }],
      [beginHookDispatch(child.stop, { shellRoot: b.root }), { input: child.stop }],
    ]) { f.store.runtimeInvocation = dispatch.invocation; observeEpochExecution(f.store, observation); endRuntimeDispatch(dispatch); }
    f.store.runtimeInvocation = null;
    assert.equal(epochAdmissionState(f.store.db, f.context, child.route.routeId).ready, true);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts WHERE id=?").get(transfer.id).n, 1);
    assert.equal(business(f.store.db), before, "entry confirmation cannot consume messages or settle a result");
    assert.throws(() => restoreColdHostEpochEntries(f.store, f.installation.id, { inventory: () => [] }), /rollback_first/);
  }, { legacy: true });
});

test("cold accepted queue remains pending without a durable native checkpoint and is never replayed or settled", {
  skip: !process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE && "Requires exact isolated installed-v1 fixture",
}, async () => {
  await coldFixture(async (f) => {
    await retainedChild(f); const before = business(f.store.db);
    await assert.rejects(f.prepare(), /cold_accepted_input_checkpoint_required/);
    assert.throws(() => inspectColdHostEpochRetirement(f.store, f.installation.id, { inventory: () => [] }), /cold_accepted_input_checkpoint_required/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, f.source.digest);
    assert.equal(f.store.db.prepare("SELECT status FROM delegation_messages").get().status, "accepted");
    assert.equal(business(f.store.db), before);
  }, { legacy: true });
});

test("cold handover rejects a restored old path and an interrupted history snapshot without moving a task", async () => {
  await coldFixture(async (f) => {
    const handover = await f.prepare();
    restoreColdHostEpochEntries(f.store, f.installation.id, { inventory: () => [] });
    assert.throws(() => commitHostEpochHandover(f.store, handover), /retirement_revoked_by_recovery/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, f.source.digest);
    relocateColdHostEpochEntries(f.store, f.installation.id, { inventory: () => [] });
    await assert.rejects(f.prepare(), /retirement_revoked_by_recovery/);
    commitColdHostEpochRetirement(f.store, inspectColdHostEpochRetirement(f.store, f.installation.id, { inventory: () => [] }));
    assert.equal(commitHostEpochHandover(f.store, await f.prepare()).state, "checking");
  });
});

async function ordinaryCheckpointFixture(run) {
  const cwd = realpathSync(mkdtempSync(join(work, "ordinary-restart-"))), home = join(cwd, "state");
  const values = { ADAPTIVE_ROUTER_HOME: home, PLUGIN_DATA: home, CODEX_HOME: join(cwd, "codex"),
    ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "", CODEX_THREAD_ID: "" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values);
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const store = new RouterStore();
  try {
    store.transaction(() => publishRuntime(store.db, b, home, { bootstrap: true, shellRoot: b.root }));
    const contextId = "ordinary-native-owner", turnId = "ordinary-completed-turn", context = store.context({ cwd, contextId });
    store.configure(context, { autoActivate: true }, "global");
    store.db.prepare("INSERT INTO host_model_state(project_id,context_key,current_model,task_mode,updated_at) VALUES(?,?,'gpt-6-astra','automatic',?)")
      .run(context.projectId, context.contextKey, new Date().toISOString());
    const transcriptPath = join(cwd, "root.jsonl"), records = [
      { type: "session_meta", payload: { id: contextId, cwd } },
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }];
    const writeRoot = () => writeFileSync(transcriptPath, records.map(JSON.stringify).join("\n") + "\n"); writeRoot();
    const reference = { contextId, cwd, turnId, transcriptPath };
    rememberRootTranscript(store.db, context, transcriptPath);
    const input = { hook_event_name: "Stop", session_id: contextId, cwd, turn_id: turnId, transcript_path: transcriptPath };
    endRuntimeDispatch(beginHookDispatch(input, { shellRoot: b.root }));
    const legacyModules = Object.fromEntries(await Promise.all(["router", "delegation-gate", "stage-closure"]
      .map(async (name) => [name, await moduleAt(b.root, name)])));
    assert.equal(store.db.prepare("SELECT count(*) n FROM runtime_epoch_tasks").get().n, 0);
    await run({ store, context, cwd, home, reference, input, records, writeRoot, legacyModules, runtimeShell: b.root });
    assert.equal(store.db.prepare("SELECT count(*) n FROM runtime_epoch_tasks").get().n, 0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 0);
  } finally {
    store.close(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

async function checkpointContinuationCase(f, { cold = false, suffix = "", beforeOutcome = null, siblingSender = false } = {}) {
    const initialOutcomes = f.store.db.prepare("SELECT count(*) n FROM outcomes").get().n;
    const originalCallId = `retained-input${suffix}`;
    const cipherA = "opaque-native-ciphertext-A", cipherB = "different-native-ciphertext-B";
    f.reference.turnId = `A-queue-turn${suffix}`; f.input.turn_id = f.reference.turnId;
    f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: f.reference.turnId } }); f.writeRoot();
    const child = await retainedChild({ ...f, pendingInputMessage: cipherA, pendingCallId: originalCallId, childId: `retained-child${suffix}` });
    const originalArgs = { target: child.childId, message: cipherA };
    const parentCall = (name, id, args, turnId) => ({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", name,
      arguments: JSON.stringify(args), call_id: id, internal_chat_message_metadata_passthrough: { turn_id: turnId } } });
    const result = (id) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: "" } });
    f.records.push(parentCall("send_message", originalCallId, originalArgs, f.reference.turnId), result(originalCallId),
      { type: "event_msg", payload: { type: "task_complete", turn_id: f.reference.turnId } }); f.writeRoot();
    let originalSource = f.reference.transcriptPath;
    const originalAuthor = siblingSender ? "/root/original-sender" : "/root";
    if (siblingSender) {
      originalSource = join(f.cwd, "original-sender.jsonl");
      writeFileSync(originalSource, [
        { type: "session_meta", payload: { id: "original-sender", cwd: f.cwd, parent_thread_id: f.reference.contextId,
          agent_path: originalAuthor, source: { subagent: { thread_spawn: { parent_thread_id: f.reference.contextId, agent_path: originalAuthor } } } } },
        parentCall("send_message", originalCallId, originalArgs, f.reference.turnId), result(originalCallId),
      ].map(JSON.stringify).join("\n") + "\n");
      f.store.db.prepare("UPDATE delegation_messages SET author=? WHERE call_id=?").run(payloadHash(originalAuthor), originalCallId);
    }
    endRuntimeDispatch(beginHookDispatch(f.input, { shellRoot: b.root }));
    recordHookIdentityDiagnostic(resolveHookIdentity(f.input).audit, "identity_accepted", process.env, { contextId: f.reference.contextId, turnId: f.reference.turnId });
    const original = JSON.stringify(f.store.db.prepare("SELECT * FROM delegation_messages WHERE call_id=?").get(originalCallId));
    const count = f.store.db.prepare("SELECT count(*) n FROM routes").get().n;
    if (cold) await assert.rejects(f.prepare(), /cold_accepted_input_checkpoint_required/);
    const referenceArgs = ["checkpoint-inputs", `--context=${f.reference.contextId}`, `--route=${child.route.routeId}`, `--cwd=${f.cwd}`,
      `--parent-source=${originalSource}`, `--revision=${f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(child.route.routeId).revision}`,
      `--home=${f.home}`, `--codex-home=${process.env.CODEX_HOME}`];
    const checkpointCall = spawnSync(process.execPath, [join(b.root, "scripts/runtime-epoch.mjs"), ...referenceArgs], { cwd: f.cwd, env: process.env, encoding: "utf8" });
    assert.equal(checkpointCall.status, 0, checkpointCall.stderr);
    const checkpointId = JSON.parse(checkpointCall.stdout).checkpoints[0]; assert.ok(checkpointId);
    const stored = f.store.db.prepare("SELECT record FROM runtime_message_checkpoints").get().record;
    assert.ok(stored.startsWith("enc-v1:")); assert.equal(stored.includes(cipherA), false);
    assert.equal(readMessageCheckpoints(f.store.db, f.context, child.route.routeId).checkpoints[0].retransmitOpaquePayload, false);
    assert.equal(stageClosureStatus(f.store.db, f.context, child.route.routeId).nextAction, "explicitly_followup_same_child_from_original_context");
    assert.deepEqual(coldPendingMessageResponsibilities(f.store.db, f.context), []);
    if (cold) commitHostEpochHandover(f.store, await f.prepare());
    for (const [dispatch, observation] of [
      [beginHookDispatch(f.input, { shellRoot: b.root }), { input: f.input }],
      [beginMcpDispatch("get_route_status", { contextId: f.reference.contextId }, { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: b.root }),
        { name: "get_route_status", args: { contextId: f.reference.contextId } }],
    ]) { f.store.runtimeInvocation = dispatch.invocation; observeEpochExecution(f.store, observation); endRuntimeDispatch(dispatch); }
    f.store.runtimeInvocation = null;
    // This is a new explicit semantic supplement, not retransmission of the
    // old opaque queue item or a synthetic native consumption record.
    const followup = { tool_name: "followup_task", turn_id: `B-parent-turn${suffix}`, tool_use_id: `B-supplement${suffix}`, tool_input: { target: child.childId, message: cipherB } };
    observeManagedMessage(f.store.db, f.context, followup);
    observeManagedMessage(f.store.db, f.context, { ...followup, tool_response: "" }, { post: true });
    f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: followup.turn_id } },
      parentCall("followup_task", followup.tool_use_id, followup.tool_input, followup.turn_id), result(followup.tool_use_id),
      { type: "event_msg", payload: { type: "task_complete", turn_id: followup.turn_id } }); f.writeRoot();
    const turn = `B-child-turn${suffix}`, inputId = `native-checkpoint-supplement${suffix}`, final = "Original missing requirement completed from the explicit new supplement";
    child.childRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: turn } },
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: true } },
      { type: "response_item", payload: { type: "agent_message", id: inputId, author: "/root", recipient: child.agentPath,
        content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" }, { type: "encrypted_content", encrypted_content: cipherB }],
        internal_chat_message_metadata_passthrough: { turn_id: turn } } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: final }],
        internal_chat_message_metadata_passthrough: { turn_id: turn } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: final } });
    writeFileSync(child.path, child.childRecords.map(JSON.stringify).join("\n") + "\n");
    observeManagedStop(f.store.db, child.route.routeId, { turnId: turn, lastAssistantMessage: final });
    assert.equal(stageClosureStatus(f.store.db, f.context, child.route.routeId).state, "pending");
    assert.equal(f.store.status(f.context).stageClosure.nextAction, "review_new_child_input_and_resolve_checkpoint");
    const args = { contextId: f.reference.contextId, routeId: child.route.routeId, action: "resolve_checkpoint", checkpointId, nativeInputId: inputId,
      parentTranscriptPath: f.reference.transcriptPath, expectedRevision: f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(child.route.routeId).revision,
      disposition: { intent: "collect", basis: "Native cold restart left the original queue input unconsumed; source retained in checkpoint.",
        resultReview: "Reviewed the latest same-child native final and its explicit replacement input against the original requirement.",
        requirements: [{ messageId: checkpointId, source: "Original accepted send at its immutable sender call", disposition: "fulfilled",
          receipt: "Verified latest same-child result from the independently accepted B followup", owner: "/root" }], pendingOperations: [] } };
    assert.throws(() => commitMessageCheckpoint(f.store, { passed: true }), /source_owned_checkpoint_token_missing/);
    assert.throws(() => prepareMessageContinuation(f.store, f.context, { ...args, nativeInputId: "wrong-input" }), /latest_native_followup_input_missing/);
    const token = prepareMessageContinuation(f.store, f.context, args);
    const changedRoot = [...f.records, { type: "event_msg", payload: { type: "task_started", turn_id: "concurrent-append" } }];
    writeFileSync(f.reference.transcriptPath, changedRoot.map(JSON.stringify).join("\n") + "\n");
    assert.throws(() => commitMessageCheckpoint(f.store, token), /source_or_stage_revision_changed/); f.writeRoot();
    const resolveDispatch = beginMcpDispatch("manage_stage", args, { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: b.root });
    f.store.runtimeInvocation = resolveDispatch.invocation;
    const resolved = await callRouterTool("manage_stage", args, { store: f.store, cwd: f.cwd });
    assert.equal((await callRouterTool("manage_stage", args, { store: f.store, cwd: f.cwd })).idempotent, true);
    endRuntimeDispatch(resolveDispatch); f.store.runtimeInvocation = null;
    assert.equal(resolved.originalMessageConsumed, false);
    assert.equal(stageClosureStatus(f.store.db, f.context, child.route.routeId).state, "ready");
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM delegation_messages WHERE call_id=?").get(originalCallId)), original);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM routes").get().n, count);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM outcomes").get().n, initialOutcomes);
    if (!cold) {
      const closure = stageClosureStatus(f.store.db, f.context, child.route.routeId);
      const outcome = { contextId: f.reference.contextId, routeId: child.route.routeId, status: "passed", gate: child.route.verificationGate,
        failureType: null, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
        escalations: 0, userCorrection: false, closureToken: closure.token };
      if (beforeOutcome) await beforeOutcome({ f, child, args, outcome });
      const recorded = await callRouterTool("record_outcome", outcome, { store: f.store, cwd: f.cwd });
      assert.equal(recorded.recorded || recorded.idempotent, true);
      assert.equal(f.store.db.prepare("SELECT state FROM delegation_children WHERE route_id=?").get(child.route.routeId).state, "settled");
      assert.equal(stageClosureStatus(f.store.db, f.context), null);
    }
    const priorOutcomes = JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all());
    const previousContinuation = f.store.db.prepare("SELECT record FROM runtime_message_continuations").get().record;
    const lateTurn = `late-original-turn${suffix}`, lateFinal = "Reviewed the arrived original and confirmed the requirement is already fulfilled";
    const late = { type: "response_item", payload: { type: "agent_message", id: `late-original${suffix}`, author: originalAuthor, recipient: child.agentPath,
      content: [{ type: "encrypted_content", encrypted_content: cipherA }], internal_chat_message_metadata_passthrough: { turn_id: lateTurn } } };
    child.childRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: lateTurn } },
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: false } }, late,
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: lateFinal }],
        internal_chat_message_metadata_passthrough: { turn_id: lateTurn } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: lateTurn, last_agent_message: lateFinal } });
    writeFileSync(child.path, child.childRecords.map(JSON.stringify).join("\n") + "\n");
    const arrivalArgs = { ...args, action: "resolve_checkpoint_arrival", nativeInputId: late.payload.id,
      disposition: { ...args.disposition, resultReview: "Reviewed actual late original input and latest final; its requirement was already fulfilled by the previous supplement.",
        requirements: [{ ...args.disposition.requirements[0], messageId: late.payload.id, disposition: "no_work",
          receipt: "Latest native final verifies deduplication against the preserved earlier completed requirement" }] } };
    assert.equal(stageClosureStatus(f.store.db, f.context, child.route.routeId).reason, "message_checkpoint_conflict");
    assert.equal(f.store.status(f.context).stageClosure.reason, "message_checkpoint_conflict", "even a settled child must surface the late original");
    assert.equal(readMessageCheckpoints(f.store.db, f.context, child.route.routeId).nativeInputId, late.payload.id);
    assert.ok(coldPendingMessageResponsibilities(f.store.db, f.context).every((row) => row.reason === "message_checkpoint_arrival_review_required"));
    assert.throws(() => prepareMessageArrivalReview(f.store, f.context, arrivalArgs), /latest_child_Stop_missing/);
    observeManagedStop(f.store.db, child.route.routeId, { turnId: lateTurn, lastAssistantMessage: lateFinal });
    assert.throws(() => prepareMessageArrivalReview(f.store, f.context, { ...arrivalArgs, nativeInputId: inputId }), /actual_original_input_arrival_missing/);
    assert.throws(() => prepareMessageArrivalReview(f.store, f.context, { ...arrivalArgs, disposition: args.disposition }), /explicit_requirement_result_review_required/);
    const lateToken = prepareMessageArrivalReview(f.store, f.context, arrivalArgs);
    writeFileSync(f.reference.transcriptPath, changedRoot.map(JSON.stringify).join("\n") + "\n");
    assert.throws(() => commitMessageCheckpoint(f.store, lateToken), /source_or_stage_revision_changed/); f.writeRoot();
    const arrivalDispatch = beginMcpDispatch("manage_stage", arrivalArgs, { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: b.root });
    f.store.runtimeInvocation = arrivalDispatch.invocation;
    const reviewed = await callRouterTool("manage_stage", arrivalArgs, { store: f.store, cwd: f.cwd });
    assert.equal(reviewed.state, "late_arrival_reviewed");
    assert.equal((await callRouterTool("manage_stage", arrivalArgs, { store: f.store, cwd: f.cwd })).idempotent, true);
    endRuntimeDispatch(arrivalDispatch); f.store.runtimeInvocation = null;
    const closed = stageClosureStatus(f.store.db, f.context, child.route.routeId);
    assert.equal(cold ? closed.state : closed, cold ? "ready" : null);
    assert.deepEqual(coldPendingMessageResponsibilities(f.store.db, f.context), []);
    assert.equal(readMessageCheckpoints(f.store.db, f.context, child.route.routeId).checkpoints[0].arrivalReviews[0].nativeInputId, late.payload.id);
    assert.equal(f.store.db.prepare("SELECT record FROM runtime_message_continuations").get().record, previousContinuation);
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM delegation_messages WHERE call_id=?").get(originalCallId)), original);
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all()), priorOutcomes);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM routes").get().n, count);
    return { child, args, checkpointId, originalSource };
}

test("sibling message recovery ignores unrelated missing history but retains the exact original source requirement", async () =>
  ordinaryCheckpointFixture(async (f) => {
    // Admit and settle the unrelated historical stage through the real ledger
    // entrypoints before its transcript becomes unavailable.
    const history = await retainedChild({ ...f, pendingInput: false, childId: "unrelated-history" });
    const closure = stageClosureStatus(f.store.db, f.context, history.route.routeId);
    await callRouterTool("record_outcome", { contextId: f.reference.contextId, routeId: history.route.routeId,
      status: "passed", gate: history.route.verificationGate, failureType: null, retries: 0,
      retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
      escalations: 0, userCorrection: false, closureToken: closure.token }, { store: f.store, cwd: f.cwd });
    rmSync(history.path);
    const { child, originalSource } = await checkpointContinuationCase(f, { siblingSender: true });
    const outcomes = JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all());
    rmSync(originalSource);
    const status = stageClosureStatus(f.store.db, f.context, child.route.routeId);
    assert.equal(status.reason, "message_checkpoint_conflict");
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all()), outcomes);
  }));

async function auditCheckpointReads(store, run, { afterRead = null } = {}) {
  const originalRead = fs.readSync, observations = [];
  fs.readSync = function (...args) {
    const checkpoint = new Error().stack.includes("message-checkpoint.mjs");
    if (checkpoint) observations.push({ locked: store.db.isTransaction });
    const value = originalRead(...args);
    if (checkpoint) afterRead?.(observations.length);
    return value;
  };
  syncBuiltinESMExports();
  try {
    const value = await run(observations);
    assert.ok(observations.length > 0, "the real entry must perform checkpoint source preflight");
    assert.equal(observations.some((row) => row.locked), false, "checkpoint full source reads never hold the SQLite write lock");
    return { value, reads: observations.length };
  } finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
}
async function changeAfterCheckpointPreflight(store, run, mutate, restore = () => {}) {
  const originalTransaction = store.transaction;
  let changed = false;
  try {
    return await auditCheckpointReads(store, async (observations) => {
      store.transaction = function (...args) {
        if (!changed && observations.length) { changed = true; mutate(); }
        return originalTransaction.apply(this, args);
      };
      const value = await run(); assert.equal(changed, true, "mutation occurs after real entry preflight before BEGIN"); return value;
    });
  } finally { store.transaction = originalTransaction; restore(); }
}

test("native outcome and Stop entries preflight checkpoint sources outside writes and reject append, replacement, revision and expiry races", async () =>
  ordinaryCheckpointFixture(async (f) => {
    await checkpointContinuationCase(f, { beforeOutcome: async ({ child, outcome }) => {
      const submit = () => callRouterTool("record_outcome", outcome, { store: f.store, cwd: f.cwd });
      const outcomes = JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all());
      for (const race of ["append", "replacement", "revision", "expiry", "new-message"]) {
        const revision = f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(child.route.routeId).revision;
        const originalNow = Date.now;
        const moved = join(f.cwd, "parent-source-before-replacement.jsonl");
        await changeAfterCheckpointPreflight(f.store, () => assert.rejects(submit(), /Stage closure is pending/), () => {
          if (race === "append") fs.appendFileSync(f.reference.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "diagnostic" } }) + "\n");
          if (race === "replacement") { fs.renameSync(f.reference.transcriptPath, moved); fs.copyFileSync(moved, f.reference.transcriptPath); }
          if (race === "revision") f.store.db.prepare("UPDATE delegation_children SET revision=revision+1 WHERE route_id=?").run(child.route.routeId);
          if (race === "expiry") Date.now = () => originalNow() + 6000;
          if (race === "new-message") observeManagedMessage(f.store.db, f.context, { tool_name: "send_message", turn_id: "race-parent-turn", tool_use_id: "race-message",
            tool_input: { target: child.childId, message: "newly pending responsibility" } });
        }, () => {
          Date.now = originalNow;
          if (race === "replacement") { fs.rmSync(f.reference.transcriptPath); fs.renameSync(moved, f.reference.transcriptPath); }
          if (race === "append") f.writeRoot();
          // Restore only injected fixture state. Production receives the
          // unchanged pending responsibility and must obtain a fresh review.
          if (race === "new-message") f.store.db.prepare("DELETE FROM delegation_messages WHERE call_id='race-message'").run();
          f.store.db.prepare("UPDATE delegation_children SET revision=? WHERE route_id=?").run(revision, child.route.routeId);
        });
        assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all()), outcomes);
      }
      const stopped = await auditCheckpointReads(f.store, () => f.store.handleStop(f.context));
      assert.equal(stopped.value.action, "block");
      await changeAfterCheckpointPreflight(f.store, () => {
        const value = f.store.handleStop(f.context); assert.equal(value.action, "block"); assert.match(value.reason, /message_checkpoint_conflict/);
      }, () => fs.appendFileSync(f.reference.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "diagnostic" } }) + "\n"), f.writeRoot);
      // Readonly warming on another connection is not a capability for this
      // connection. A transactional cache miss stays pending without any scan.
      const other = new RouterStore();
      try {
        stageClosureStatus(f.store.db, f.context, child.route.routeId);
        const closed = other.transaction(() => stageClosureStatus(other.db, f.context, child.route.routeId));
        assert.equal(closed.reason, "message_checkpoint_conflict");
        assert.equal(closed.checkpointReason, "checkpoint_projection_preflight_required");
      } finally { other.close(); }
      const result = await auditCheckpointReads(f.store, submit);
      assert.equal(result.value.recorded, true);
    } });
  }));

test("service maintenance verification preflights checkpoint sources and preserves an earlier outcome across a source race", async () =>
  ordinaryCheckpointFixture(async (f) => {
    const { child } = await checkpointContinuationCase(f);
    const outcomes = JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all());
    const base = { contextId: f.reference.contextId, routeId: child.route.routeId, parentTranscriptPath: f.reference.transcriptPath,
      expectedRevision: f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(child.route.routeId).revision };
    await callRouterTool("manage_stage", { ...base, action: "begin_maintenance", disposition: { intent: "collect", basis: "Collect the retained original and supplemental responsibilities",
      requirements: [], pendingOperations: [] } }, { store: f.store, cwd: f.cwd });
    const message = { tool_name: "followup_task", turn_id: "maintenance-parent-turn", tool_use_id: "maintenance-followup", tool_input: {
      target: child.childId, message: "opaque-maintenance-collection" } };
    f.store.transaction(() => {
      observeManagedMessage(f.store.db, f.context, message);
      observeManagedMessage(f.store.db, f.context, { ...message, tool_response: "" }, { post: true });
    });
    f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: message.turn_id } },
      { type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "followup_task", call_id: message.tool_use_id,
        arguments: JSON.stringify(message.tool_input), internal_chat_message_metadata_passthrough: { turn_id: message.turn_id } } },
      { type: "response_item", payload: { type: "function_call_output", call_id: message.tool_use_id, output: "" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: message.turn_id } }); f.writeRoot();
    const turnId = "maintenance-child-turn", final = "Collected the full original and supplemental disposition history without new business";
    child.childRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: true } },
      { type: "response_item", payload: { type: "agent_message", id: "maintenance-native-input", author: "/root", recipient: child.agentPath,
        content: [{ type: "encrypted_content", encrypted_content: message.tool_input.message }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: final }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: final } });
    writeFileSync(child.path, child.childRecords.map(JSON.stringify).join("\n") + "\n");
    observeManagedStop(f.store.db, child.route.routeId, { turnId, lastAssistantMessage: final });
    const closure = f.store.status(f.context).stageClosure; assert.equal(closure.state, "ready");
    const args = { ...base, expectedRevision: closure.revision, action: "verify_maintenance", closureToken: closure.token,
      disposition: { intent: "collect", basis: "Native maintenance returned all responsibility evidence", resultReview: "Reviewed each actual input and the latest same-child result",
        requirements: closure.inputReferences.slice(1).map((input) => ({ messageId: input.id, source: "Exact native input retained in the original child", disposition: "no_work",
          receipt: "This bounded collection and prior immutable reviews confirm no outstanding business", owner: "/root" })), pendingOperations: [] } };
    const submit = () => callRouterTool("manage_stage", args, { store: f.store, cwd: f.cwd });
    await changeAfterCheckpointPreflight(f.store, () => assert.rejects(submit(), /not ready/),
      () => fs.appendFileSync(f.reference.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "diagnostic" } }) + "\n"), f.writeRoot);
    assert.equal(f.store.db.prepare("SELECT state FROM delegation_maintenance WHERE route_id=?").get(child.route.routeId).state, "active");
    const verified = await auditCheckpointReads(f.store, submit); assert.equal(verified.value.state, "verified");
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes").all()), outcomes);
  }));

test("all settled checkpoint children share one bounded preflight budget and cannot reuse another task's cache", async () =>
  ordinaryCheckpointFixture(async (f) => {
    await checkpointContinuationCase(f, { suffix: "-first" });
    await checkpointContinuationCase(f, { suffix: "-second" });
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM delegation_children WHERE state='settled'").get().n, 2);
    const healthy = await auditCheckpointReads(f.store, () => f.store.handleStop(f.context)); assert.equal(healthy.value.action, "allow");
    const originalNow = Date.now, initial = originalNow(); let clock = initial;
    try {
      Date.now = () => clock;
      const budgeted = await auditCheckpointReads(f.store, () => f.store.handleStop(f.context), { afterRead: () => { clock += 1000; } });
      assert.equal(budgeted.value.action, "block");
      assert.match(budgeted.value.reason, /message_checkpoint_conflict/);
      assert.ok(budgeted.reads <= 6, `all children share the 5s deadline, observed ${budgeted.reads} full reads`);
      assert.ok(healthy.reads > budgeted.reads, "the second child cannot start a fresh 5s budget");
    } finally { Date.now = originalNow; }
    // A real entry obtains a new bounded proof after expiry; pending is not a
    // permanent lock, and every existing outcome stays immutable.
    const recovered = await auditCheckpointReads(f.store, () => f.store.handleStop(f.context)); assert.equal(recovered.value.action, "allow");
    const other = f.store.context({ cwd: f.cwd, contextId: "foreign-preflight-task" });
    const child = f.store.db.prepare("SELECT * FROM delegation_children LIMIT 1").get();
    const foreign = f.store.transaction(() => messageContinuationProjection(f.store.db, other, child));
    assert.equal(foreign.conflict, "checkpoint_projection_preflight_required");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM outcomes").get().n, 2);
  }));

test("exact v1 cold checkpoint continues an unconsumed opaque requirement and reviews its later actual arrival without rewriting accepted calls", {
  skip: !process.env.ADAPTIVE_ROUTER_LEGACY_FIXTURE && "Requires exact isolated installed-v1 fixture",
}, async () => coldFixture((f) => checkpointContinuationCase(f, { cold: true }), { legacy: true }));

test("ordinary App restart task resolves checkpoint and late arrival without any runtime epoch or new qualification", async () =>
  ordinaryCheckpointFixture((f) => checkpointContinuationCase(f)));


test("cold message responsibilities bind exact opaque calls one-to-one and never substitute another same-mode consumed input", async () =>
  ordinaryCheckpointFixture(async (f) => {
    const child = await retainedChild({ ...f, pendingInputMessage: "missing-original-cipher" });
    const parentCall = (id, input) => [
      { type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "send_message", arguments: JSON.stringify(input),
        call_id: id, internal_chat_message_metadata_passthrough: { turn_id: f.reference.turnId } } },
      { type: "response_item", payload: { type: "function_call_output", call_id: id, output: "" } }];
    f.records.push(...parentCall("retained-input", { target: child.childId, message: "missing-original-cipher" }));
    const other = { tool_name: "send_message", turn_id: f.reference.turnId, tool_use_id: "other-send", tool_input: { target: child.childId, message: "actual-consumed-cipher" } };
    observeManagedMessage(f.store.db, f.context, other); observeManagedMessage(f.store.db, f.context, { ...other, tool_response: "" }, { post: true });
    f.records.push(...parentCall(other.tool_use_id, other.tool_input)); f.writeRoot();
    const turn = "consumed-other-turn", final = "Completed only the separately delivered input";
    child.childRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: turn } },
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: false } },
      { type: "response_item", payload: { type: "agent_message", id: "actual-other-input", author: "/root", recipient: child.agentPath,
        content: [{ type: "encrypted_content", encrypted_content: other.tool_input.message }], internal_chat_message_metadata_passthrough: { turn_id: turn } } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: final }],
        internal_chat_message_metadata_passthrough: { turn_id: turn } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: final } });
    writeFileSync(child.path, child.childRecords.map(JSON.stringify).join("\n") + "\n");
    observeManagedStop(f.store.db, child.route.routeId, { turnId: turn, lastAssistantMessage: final });
    const pending = coldPendingMessageResponsibilities(f.store.db, f.context);
    assert.deepEqual(pending.map((row) => row.callId), ["retained-input"]);
    const args = { contextId: f.reference.contextId, routeId: child.route.routeId, action: "checkpoint_requirements",
      parentTranscriptPath: f.reference.transcriptPath, expectedRevision: f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(child.route.routeId).revision };
    const captured = await callRouterTool("manage_stage", args, { store: f.store, cwd: f.cwd });
    assert.equal(captured.checkpointed, 1);
    assert.equal(readMessageCheckpoints(f.store.db, f.context, child.route.routeId).checkpoints[0].callId, "retained-input");
    assert.deepEqual(coldPendingMessageResponsibilities(f.store.db, f.context), [], "exact checkpoint is sufficient despite missing queue offset");
    // Equal opaque values in separate accepted calls are not enough to prove
    // which one produced a single native input. Keep both responsibilities.
    const duplicate = { ...other, tool_use_id: "duplicate-send" };
    observeManagedMessage(f.store.db, f.context, duplicate); observeManagedMessage(f.store.db, f.context, { ...duplicate, tool_response: "" }, { post: true });
    f.records.push(...parentCall(duplicate.tool_use_id, duplicate.tool_input)); f.writeRoot();
    assert.deepEqual(coldPendingMessageResponsibilities(f.store.db, f.context).map((row) => [row.callId, row.reason]),
      [["other-send", "native_input_call_binding_ambiguous"], ["duplicate-send", "native_input_call_binding_ambiguous"]]);
    assert.throws(() => prepareMessageCheckpoint(f.store, f.context, { ...args,
      expectedRevision: f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(child.route.routeId).revision }), /native_input_call_binding_ambiguous/);
  }));

async function consumedMessageCase(f, { count = 25, childCount = 1, unknownOperation = false } = {}) {
  const children = [];
  for (let index = 0; index < childCount; index++) {
    f.reference.turnId = `spawn-consumed-${index}`; f.input.turn_id = f.reference.turnId;
    const child = await retainedChild({ ...f, pendingInput: false, childId: `consumed-child-${index}` });
    const turn = `consumed-turn-${index}`;
    child.childRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
    for (let i = 0; i < count; i++) {
      const message = { tool_name: "send_message", turn_id: f.reference.turnId, tool_use_id: `consumed-${index}-${i}`,
        tool_input: { target: child.childId, message: `exact-native-cipher-${index}-${i}` } };
      observeManagedMessage(f.store.db, f.context, message);
      observeManagedMessage(f.store.db, f.context, { ...message, tool_response: "" }, { post: true });
      f.records.push({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "send_message",
        arguments: JSON.stringify(message.tool_input), call_id: message.tool_use_id,
        internal_chat_message_metadata_passthrough: { turn_id: message.turn_id } } },
      { type: "response_item", payload: { type: "function_call_output", call_id: message.tool_use_id, output: "" } });
      child.childRecords.push({ type: "inter_agent_communication_metadata", payload: { trigger_turn: false } },
        { type: "response_item", payload: { type: "agent_message", id: `input-${index}-${i}`, author: "/root", recipient: child.agentPath,
          content: [{ type: "encrypted_content", encrypted_content: message.tool_input.message }],
          internal_chat_message_metadata_passthrough: { turn_id: turn } } });
    }
    if (unknownOperation) child.childRecords.push(
      { type: "response_item", payload: { type: "function_call", name: "exec", namespace: "functions", call_id: "uncovered-code-mode",
        arguments: JSON.stringify({ code: "historical opaque call" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "uncovered-code-mode", output: "finished" } },
      { type: "response_item", payload: { type: "function_call", name: "mcp__historical__operation", call_id: "unreviewed-contract", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "unreviewed-contract", output: "historical result" } });
    const final = "Every exact native input reached this child";
    child.childRecords.push({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: final }], internal_chat_message_metadata_passthrough: { turn_id: turn } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: final } });
    writeFileSync(child.path, child.childRecords.map(JSON.stringify).join("\n") + "\n");
    observeManagedStop(f.store.db, child.route.routeId, { turnId: turn, lastAssistantMessage: final });
    if (childCount > 1) {
      f.writeRoot();
      const closure = stageClosureStatus(f.store.db, f.context, child.route.routeId);
      await callRouterTool("record_outcome", { contextId: f.reference.contextId, routeId: child.route.routeId,
        status: "passed", gate: child.route.verificationGate, failureType: null, retries: 0,
        retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
        escalations: 0, userCorrection: false, closureToken: closure.token }, { store: f.store, cwd: f.cwd });
    }
    children.push(child);
  }
  f.writeRoot(); return children;
}

test("native input consumption is independent of unknown old operations while new checkpoints still require quiescence", async () =>
  ordinaryCheckpointFixture(async (f) => {
    const [child] = await consumedMessageCase(f, { unknownOperation: true });
    const row = f.store.db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(child.route.routeId);
    const locator = JSON.parse(openPrivateState(f.store.db, row.locator));
    const before = readChildTurnEvidence(locator);
    assert.equal(before.finished, false); assert.ok(before.pendingOperations.length);
    const original = business(f.store.db);
    assert.deepEqual(coldPendingMessageResponsibilities(f.store.db, f.context), []);
    assert.equal(business(f.store.db), original);
    assert.deepEqual(readChildTurnEvidence(locator).pendingOperations, before.pendingOperations);
    assert.throws(() => prepareMessageCheckpoint(f.store, f.context, { routeId: child.route.routeId,
      expectedRevision: row.revision, parentTranscriptPath: f.reference.transcriptPath }), /unknown_child_operation_contract|child_operations_or_turn_pending/);
  }));

test("one cold batch indexes a shared sender once for all exact accepted messages and invalidates source changes", async () =>
  ordinaryCheckpointFixture(async (f) => {
    const children = await consumedMessageCase(f, { childCount: 2 });
    const originalOpen = fs.openSync;
    let senderReads = 0;
    try {
      fs.openSync = function (path, ...args) {
        if (path === f.reference.transcriptPath) { senderReads++; assert.equal(f.store.db.isTransaction, false); }
        return originalOpen(path, ...args);
      }; syncBuiltinESMExports();
      assert.deepEqual(coldPendingMessageResponsibilities(f.store.db), []);
      assert.equal(senderReads, 1, "25 accepted rows per child reuse one full stable sender scan");
      fs.openSync = function (path, ...args) {
        if (path === children[1].path) fs.appendFileSync(f.reference.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "diagnostic" } }) + "\n");
        return originalOpen(path, ...args);
      }; syncBuiltinESMExports();
      assert.ok(coldPendingMessageResponsibilities(f.store.db).length, "A source changed within the batch cannot retain a cached success");
    } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  }));

test("cold sender scan has a finite offline budget without relaxing the normal shared five seconds", async () =>
  ordinaryCheckpointFixture(async (f) => {
    await consumedMessageCase(f, { count: 2 });
    const originalOpen = fs.openSync, originalNow = Date.now, initial = originalNow(), before = business(f.store.db);
    let clock = initial, delay = 6000;
    try {
      Date.now = () => clock;
      fs.openSync = function (path, ...args) {
        if (path === f.reference.transcriptPath) clock += delay;
        return originalOpen(path, ...args);
      }; syncBuiltinESMExports();
      assert.equal(coldPendingMessageResponsibilities(f.store.db, f.context).length, 2, "ordinary task keeps the five-second budget");
      clock = initial;
      assert.deepEqual(coldPendingMessageResponsibilities(f.store.db), [], "cold sender and its cached exact matches fit the offline budget");
      clock = initial; delay = 30_001;
      assert.equal(coldPendingMessageResponsibilities(f.store.db).length, 2, "expired cold reads preserve every responsibility");
      assert.equal(business(f.store.db), before, "reading never changes accepted inputs or outcomes");
    } finally { Date.now = originalNow; fs.openSync = originalOpen; syncBuiltinESMExports(); }
  }));

test("native SubAgentActivity binds a message inference ID to its exact host turn without rewriting the original row", async () =>
  ordinaryCheckpointFixture(async (f) => {
    const [child] = await consumedMessageCase(f, { count: 1 });
    const originalRows = business(f.store.db), callIndex = f.records.findIndex((row) => row.payload?.call_id === "consumed-0-0");
    const call = f.records[callIndex].payload, output = f.records[callIndex + 1].payload;
    f.records.splice(callIndex, 0, { type: "event_msg", payload: { type: "task_started", turn_id: f.reference.turnId } });
    call.internal_chat_message_metadata_passthrough.turn_id = "inference-response-id";
    output.internal_chat_message_metadata_passthrough = { turn_id: f.reference.turnId };
    const native = { type: "event_msg", payload: { type: "item_completed", thread_id: f.reference.contextId, turn_id: f.reference.turnId,
      started_at_ms: 1000, completed_at_ms: 1001, item: { type: "SubAgentActivity", id: call.call_id, kind: "interacted",
        agent_thread_id: child.childId, agent_path: child.agentPath } } };
    f.records.splice(callIndex + 2, 0, native); f.writeRoot();
    assert.deepEqual(coldPendingMessageResponsibilities(f.store.db, f.context), []);
    assert.equal(business(f.store.db), originalRows);
    const valid = structuredClone(f.records);
    for (const mutate of [
      (records) => { records.splice(callIndex + 2, 1); },
      (records) => { records[callIndex + 2].payload.item.id = "another-call"; },
      (records) => { records[callIndex + 2].payload.thread_id = "foreign-sender"; },
      (records) => { records[callIndex + 2].payload.turn_id = "another-turn"; },
      (records) => { records[callIndex + 2].payload.item.agent_thread_id = "another-child"; },
      (records) => { records[callIndex + 2].payload.item.agent_path = "/root/another-child"; },
      (records) => { records[callIndex + 2].payload.item.kind = "spawned"; },
      (records) => { records.splice(callIndex + 2, 0, structuredClone(native)); },
      (records) => { records[callIndex + 3].payload.internal_chat_message_metadata_passthrough.turn_id = "unrelated-result-turn"; },
      (records) => { records[callIndex + 1].payload.arguments = JSON.stringify({ target: child.childId, message: "changed" }); },
    ]) {
      const changed = structuredClone(valid); mutate(changed);
      writeFileSync(f.reference.transcriptPath, changed.map(JSON.stringify).join("\n") + "\n");
      assert.equal(coldPendingMessageResponsibilities(f.store.db, f.context).length, 1, "Unbound or conflicting native turn evidence stays pending");
      assert.equal(business(f.store.db), originalRows);
    }
  }));

test("completed root and retained child entry proofs survive normal frozen dispatcher history pruning", async () => {
  await fixture(async (f) => {
    const child = await retainedChild(f);
    const entries = f.store.db.prepare("SELECT * FROM runtime_epoch_native_entries ORDER BY subject").all();
    assert.equal(entries.length, 2);
    await f.prepare();
    for (let i = 0; i < 130; i++) {
      const read = old["runtime-dispatch"].beginMcpDispatch("get_route_status", { contextId: f.reference.contextId },
        { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: a.root });
      old["runtime-dispatch"].endRuntimeDispatch(read);
    }
    for (const entry of entries) {
      assert.equal(f.store.db.prepare("SELECT 1 FROM runtime_invocations WHERE id=?").get(entry.invocation_id), undefined);
      assert.ok(f.store.db.prepare("SELECT 1 FROM runtime_epoch_completed_invocations WHERE invocation_id=?").get(entry.invocation_id));
      assert.throws(() => f.store.db.prepare("DELETE FROM runtime_epoch_completed_invocations WHERE invocation_id=?")
        .run(entry.invocation_id), /completion is referenced/);
    }
    for (const input of [f.input, child.stop]) {
      const hook = beginHookDispatch(input, { shellRoot: b.root }); endRuntimeDispatch(hook);
    }
    assert.deepEqual(f.store.db.prepare("SELECT * FROM runtime_epoch_native_entries ORDER BY subject").all(), entries);
    const before = business(f.store.db);
    const result = commitHostEpochHandover(f.store, await f.prepare());
    assert.equal(result.state, "checking");
    assert.equal(business(f.store.db), before);
    assert.equal(runtimeTask(f.store.db, f.context).generation, b.digest);
  });
});

test("next actual user turn retains its explicit epoch despite the unchanged ordinary default", async () => {
  await fixture(async (f) => {
    commitHostEpochHandover(f.store, await f.prepare());
    assert.equal(f.store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, a.digest);
    f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: "next-real-turn" } }); f.writeRoot();
    const input = { ...f.input, hook_event_name: "UserPromptSubmit", turn_id: "next-real-turn", prompt: "Continue work" };
    const hook = beginHookDispatch(input, { shellRoot: b.root });
    try { assert.equal(hook.invocation.generation, b.digest); }
    finally { endRuntimeDispatch(hook); }
    const task = runtimeTask(f.store.db, f.context);
    assert.equal(task.turn_id, "next-real-turn");
    assert.equal(task.generation, b.digest); assert.equal(task.candidate, null);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_migrations").get().n, 0);
  });
});

for (const expireBoundary of [false, true]) test(expireBoundary
  ? "ordinary publication defers an expired boundary and migrates at the next verified turn"
  : "ordinary B to C publication preserves A default and admits only the existing candidate qualification path", async () => {
  await fixture(async (f) => {
    commitHostEpochHandover(f.store, await f.prepare());
    for (const [dispatch, observation] of [
      [beginHookDispatch(f.input, { shellRoot: b.root }), { input: f.input }],
      [beginMcpDispatch("get_route_status", { contextId: f.reference.contextId },
        { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: b.root }),
      { name: "get_route_status", args: { contextId: f.reference.contextId } }],
    ]) {
      f.store.runtimeInvocation = dispatch.invocation; observeEpochExecution(f.store, observation);
      endRuntimeDispatch(dispatch); f.store.runtimeInvocation = null;
    }
    assert.equal(epochAdmissionState(f.store.db, f.context).rootReady, true);
    const cRoot = join(f.cwd, "ordinary-C"); cpSync(b.root, cRoot, { recursive: true });
    writeFileSync(join(cRoot, "release-note.txt"), "Ordinary release with unchanged execution contract.\n");
    const c = inspectRuntimePackage(cRoot), proof = qualifyRuntimeCompatibility(b, c);
    const before = business(f.store.db);
    const publication = f.store.transaction(() => publishRuntime(f.store.db, c, f.home, { compatibilityProof: proof }));
    assert.equal(publication.scope, "compatible_epoch_tasks"); assert.equal(publication.sharedDefaultChanged, false);
    assert.equal(f.store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest, a.digest);
    assert.ok(runtimeReferences(f.store.db, c.digest).includes("epoch_ordinary_default"));
    const other = { ...f.input, session_id: "unadopted-A", transcript_path: null };
    const oldTask = old["runtime-dispatch"].beginHookDispatch(other, { shellRoot: a.root });
    assert.equal(oldTask.invocation.generation, a.digest); old["runtime-dispatch"].endRuntimeDispatch(oldTask);
    f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: "ordinary-C-turn" } }); f.writeRoot();
    let input = { ...f.input, hook_event_name: "UserPromptSubmit", turn_id: "ordinary-C-turn", prompt: "Continue work" };
    const dispatchAtBoundary = (expire = false) => {
      // Functional admission must not depend on local disk speed. Exercise
      // real expiry separately at the stable-shell read, after native scanning.
      const originalNow = Date.now, originalRead = fs.readFileSync;
      let clock = originalNow(), expired = false;
      try {
        Date.now = () => clock;
        if (expire) {
          fs.readFileSync = function(path, ...args) {
            if (!expired && String(path) === join(b.root, ".codex-plugin/plugin.json")) {
              clock += 251; expired = true;
            }
            return originalRead.call(fs, path, ...args);
          };
          syncBuiltinESMExports();
        }
        const dispatched = beginHookDispatch(input, { shellRoot: b.root });
        assert.equal(expired, expire);
        return dispatched;
      } finally { Date.now = originalNow; fs.readFileSync = originalRead; syncBuiltinESMExports(); }
    };
    let hook = dispatchAtBoundary(expireBoundary);
    if (expireBoundary) {
      try {
        assert.equal(hook.invocation.generation, b.digest);
        assert.equal(runtimeTask(f.store.db, f.context).candidate, null);
        assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_migrations").get().n, 0);
      } finally { endRuntimeDispatch(hook); }
      f.records.push({ type: "event_msg", payload: { type: "task_complete", turn_id: input.turn_id } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "ordinary-C-next-turn" } }); f.writeRoot();
      input = { ...input, turn_id: "ordinary-C-next-turn" };
      hook = dispatchAtBoundary();
    }
    f.store.runtimeInvocation = hook.invocation;
    try {
      assert.equal(hook.invocation.generation, c.digest);
      const actual = await moduleAt(hook.selected.root, "runtime-epoch");
      assert.equal(actual.observeEpochExecution(f.store, { input }).observed, true);
    } finally { endRuntimeDispatch(hook); f.store.runtimeInvocation = null; }
    assert.equal(runtimeTask(f.store.db, f.context).candidate, c.digest);
    const dispatch = beginMcpDispatch("route_stage", { contextId: f.reference.contextId },
      { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: b.root });
    f.store.runtimeInvocation = dispatch.invocation;
    try {
      const actual = await moduleAt(dispatch.selected.root, "runtime-epoch");
      assert.equal(actual.assertEpochAdmission(f.store, f.context, { kind: "route_stage" }).ready, true);
      assert.throws(() => bindRuntimeStage(f.store.db, f.context, "ordinary-business", dispatch.invocation, false), /qualification is unfinished/);
      assert.equal(f.store.db.prepare("SELECT 1 FROM runtime_stages WHERE route_id='ordinary-business'").get(), undefined);
    } finally { endRuntimeDispatch(dispatch); f.store.runtimeInvocation = null; }
    assert.equal(business(f.store.db), before);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 1);
    const reader = new old.database.RouterStore({ path: f.store.path });
    try { assert.equal(reader.db.prepare("SELECT generation FROM runtime_epoch_ordinary_defaults").get().generation, c.digest); }
    finally { reader.close(); }
  });
});

test("mixed historical stages preserve each verified origin through epoch handover and old writer reopen", async () => {
  for (const withChild of [false, true]) await fixture(async (f) => {
    const child = withChild ? await retainedChild(f) : null;
    const earlierRoot = join(f.cwd, "earlier-compatible-release");
    cpSync(a.root, earlierRoot, { recursive: true });
    writeFileSync(join(earlierRoot, "release-note.txt"), "Earlier ordinary release with identical writer and shell.\n");
    const earlier = inspectRuntimePackage(earlierRoot);
    assert.equal(earlier.writerDigest, a.writerDigest); assert.equal(earlier.shellDigest, a.shellDigest);
    f.store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(earlier.digest, JSON.stringify(earlier));
    const stageId = child?.route.routeId || "historical-pruned-route";
    if (child) {
      f.store.db.prepare("UPDATE runtime_stages SET generation=? WHERE route_id=?").run(earlier.digest, stageId);
      // A fresh entry must select this stage's actual old generation, not the
      // task's later generation. Previously recorded A evidence cannot do so.
      await assert.rejects(f.prepare(), /native_entry_attestation_missing/);
      const hook = beginHookDispatch(child.stop, { shellRoot: b.root }); endRuntimeDispatch(hook);
    } else f.store.db.prepare("INSERT INTO runtime_stages VALUES(?,?,?,?)")
      .run(stageId, f.context.projectId, f.context.contextKey, earlier.digest);
    const before = business(f.store.db);
    const result = commitHostEpochHandover(f.store, await f.prepare());
    const receipt = JSON.parse(f.store.db.prepare("SELECT record FROM runtime_epoch_receipts WHERE id=?").get(result.id).record);
    assert.deepEqual(receipt.stages.map(({ routeId, source, candidate, equivalenceSource }) => ({ routeId, source, candidate, equivalenceSource })),
      [{ routeId: stageId, source: earlier.digest, candidate: b.digest, equivalenceSource: a.digest }]);
    const origin = f.store.db.prepare("SELECT * FROM runtime_epoch_origins WHERE subject=?").get(stageId);
    assert.equal(origin.generation, earlier.digest);
    assert.equal(JSON.parse(openPrivateState(f.store.db, origin.record)).stage.generation, earlier.digest);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(stageId).generation, b.digest);
    assert.equal(business(f.store.db), before);
    const reopened = new old.database.RouterStore({ path: f.store.path });
    try {
      assert.deepEqual(reopened.db.prepare("SELECT * FROM runtime_epoch_origins WHERE subject=?").get(stageId), origin);
      assert.equal(business(reopened.db), before);
    } finally { reopened.close(); }
  });
});

test("a different historical stage writer needs its own publication and rechecks retained bytes at commit", async () => {
  for (const mode of ["different-writer", "source-mutated"]) await fixture(async (f) => {
    const earlierRoot = join(f.cwd, "earlier-source"); cpSync(a.root, earlierRoot, { recursive: true });
    const path = join(earlierRoot, mode === "different-writer" ? "scripts/lib/router.mjs" : "release-note.txt");
    writeFileSync(path, (mode === "different-writer" ? readFileSync(path, "utf8") : "") + "\n// Earlier package.\n");
    const earlier = inspectRuntimePackage(earlierRoot);
    f.store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(earlier.digest, JSON.stringify(earlier));
    f.store.db.prepare("INSERT INTO runtime_stages VALUES('earlier-stage',?,?,?)")
      .run(f.context.projectId, f.context.contextKey, earlier.digest);
    if (mode === "different-writer") await assert.rejects(f.prepare(), /stage_epoch_publication_missing:earlier-stage/);
    else {
      const proof = await f.prepare(); writeFileSync(path, "Changed after inspection.\n");
      assert.throws(() => commitHostEpochHandover(f.store, proof), /content integrity changed/);
    }
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 0);
  });
});

test("activation runs bounded discovery but never reports native installation or dormant-v1 adoption as completed", async () => {
  await fixture(async (f) => {
    f.store.db.prepare("DELETE FROM runtime_epoch_native_entries").run();
    const client = { start: async () => {}, close() {}, request: async (method) => method === "thread/list"
      ? { data: [{ id: f.reference.contextId }] }
      : { thread: { id: f.reference.contextId, cwd: f.cwd, path: f.reference.transcriptPath, turns: [{ id: f.reference.turnId }] } } };
    const before = business(f.store.db);
    const result = await activateHostCompatibilityEpoch({ store: f.store, source: a, candidate: b, shellRoot: b.root, client });
    assert.equal(result.sweep.tasks.length, 1); assert.equal(result.complete, false);
    assert.equal(result.installationComplete, false); assert.equal(result.nativeRegistration, "not_performed");
    assert.match(result.remainingHostBoundary, /retained_v1_execution_unsupported/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest); assert.equal(business(f.store.db), before);
  });
});

test("epoch continues stopped child and accepted unconsumed input with immutable origin and no new route, ticket or outcome", async () => {
  await fixture(async (f) => {
    const child = await retainedChild(f);
    const before = business(f.store.db), token = await f.prepare();
    const result = commitHostEpochHandover(f.store, token);
    assert.equal(result.state, "checking"); assert.equal(result.stagesContinued, 1);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(child.route.routeId).generation, b.digest);
    assert.equal(business(f.store.db), before);
    assert.equal(commitHostEpochHandover(f.store, token).idempotent, true);
    const origins = f.store.db.prepare("SELECT * FROM runtime_epoch_origins").all();
    assert.equal(origins.length, 2); assert.ok(origins.every((row) => row.generation === a.digest));
    for (const Store of [old.database.RouterStore, RouterStore, old.database.RouterStore]) {
      const other = new Store({ path: f.store.path });
      try { assert.equal(business(other.db), before); assert.deepEqual(other.db.prepare("SELECT * FROM runtime_epoch_origins").all(), origins); }
      finally { other.close(); }
    }
    const entered = old["runtime-dispatch"].beginMcpDispatch("manage_stage", { contextId: f.reference.contextId, routeId: child.route.routeId },
      { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: a.root });
    try { assert.equal(entered.invocation.generation, b.digest); }
    finally { endRuntimeDispatch(entered); }
  });
});

test("epoch refuses pending calls, unconsumed Pre, running native child, unknown delivery and stale revisions without changing A", async () => {
  for (const mode of ["invocation", "Pre", "child-running", "unknown-message", "revision", "source-append", "shell-retired", "self-exec", "unknown-external"]) await fixture(async (f) => {
    const child = await retainedChild(f);
    let token;
    if (["revision", "source-append", "shell-retired"].includes(mode)) token = await f.prepare();
    if (mode === "invocation") f.store.db.prepare("INSERT INTO runtime_invocations VALUES('unknown',?,?,?,?,1,'unknown','2026-01-01')")
      .run(f.context.projectId, f.context.contextKey, a.digest, "mcp:get_route_status");
    if (mode === "Pre") f.store.db.prepare("INSERT INTO runtime_call_receipts VALUES('pre',?,?,?,?, 'pending')")
      .run(f.context.projectId, f.context.contextKey, "e".repeat(64), a.digest);
    if (mode === "unknown-message") f.store.db.prepare("UPDATE delegation_messages SET status='unknown'").run();
    if (mode === "revision") f.store.db.prepare("UPDATE delegation_children SET revision=revision+1").run();
    if (mode === "shell-retired") f.store.db.prepare("UPDATE runtime_host_entries SET state='released' WHERE path=?").run(b.root);
    if (mode === "source-append") { f.records.push({ type: "event_msg", payload: { type: "token_count" } }); f.writeRoot(); }
    if (mode === "child-running") writeFileSync(child.path, readFileSync(child.path, "utf8") + '{"type":"event_msg","payload":{"type":"task_started","turn_id":"running"}}\n');
    if (mode === "self-exec") {
      f.records.splice(-1, 1, { type: "response_item", payload: { type: "function_call", name: "exec_command", namespace: "functions",
        call_id: "target-running-verifier", arguments: '{"cmd":"node runtime-epoch.mjs sweep"}' } }); f.writeRoot();
    }
    if (mode === "unknown-external") {
      f.records.splice(-1, 0,
        { type: "response_item", payload: { type: "function_call", name: "new_background_operation", namespace: "external", call_id: "opaque", arguments: "{}" } },
        { type: "response_item", payload: { type: "function_call_output", call_id: "opaque", output: '{"status":"accepted","job":"still-running"}' } });
      f.writeRoot();
    }
    if (token) assert.throws(() => commitHostEpochHandover(f.store, token), /changed/);
    else await assert.rejects(f.prepare(), /blocked/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 0);
  });
});

test("root epoch preserves opaque business effects and unsolicited native replies without reopening settled history", async () => fixture(async (f) => {
  f.reference.turnId = "later-completed-turn"; f.input.turn_id = f.reference.turnId;
  f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: f.reference.turnId } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "old-script", input: "await tools.some_business_operation({})" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "old-script", output: [{ type: "input_text", text: "Script completed" }] } },
    { type: "response_item", payload: { type: "function_call_output", id: "native-arrival", name: "send_message_to_thread", namespace: "codex_app", output: "An asynchronously delivered reply" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: f.reference.turnId } });
  f.writeRoot(); endRuntimeDispatch(beginHookDispatch(f.input, { shellRoot: b.root }));
  recordHookIdentityDiagnostic(resolveHookIdentity(f.input).audit, "identity_accepted", process.env,
    { contextId: f.reference.contextId, turnId: f.reference.turnId });
  const before = business(f.store.db);
  commitHostEpochHandover(f.store, await f.prepare());
  assert.equal(business(f.store.db), before);
  const receipt = JSON.parse(f.store.db.prepare("SELECT record FROM runtime_epoch_receipts").get().record);
  assert.equal(receipt.root.retainedOperations.count, 1);
  const origin = JSON.parse(openPrivateState(f.store.db, f.store.db.prepare("SELECT record FROM runtime_epoch_origins WHERE subject='task'").get().record));
  assert.equal(origin.retainedOperations[0].businessState, "unverified_preserved");
}));

test("bounded whole-task evidence reading has its own budget before the short commit window", async () => fixture(async (f) => {
  const originalNow = Date.now, originalRead = fs.readSync;
  const sourceStat = fs.statSync(f.reference.transcriptPath);
  let offset = 0, advanced = false;
  try {
    Date.now = () => originalNow() + offset;
    fs.readSync = (...args) => {
      const count = originalRead(...args);
      const stat = fs.fstatSync(args[0]);
      if (!advanced && count > 0 && stat.dev === sourceStat.dev && stat.ino === sourceStat.ino) { advanced = true; offset += 6000; }
      return count;
    };
    syncBuiltinESMExports();
    const token = await f.prepare();
    assert.equal(advanced, true, "The simulated cost must occur during a real native source read");
    commitHostEpochHandover(f.store, token);
    assert.equal(runtimeTask(f.store.db, f.context).generation, b.digest);
  } finally { fs.readSync = originalRead; Date.now = originalNow; syncBuiltinESMExports(); }
}));

test("an unused handover token expires independently and a delayed write transaction cannot overrun its budget", async () => {
  for (const mode of ["unused-token", "write-delay"]) await fixture(async (f) => {
    const originalNow = Date.now, transaction = f.store.transaction.bind(f.store); let offset = 0;
    try {
      Date.now = () => originalNow() + offset;
      const token = await f.prepare();
      if (mode === "unused-token") offset += 6000;
      else f.store.transaction = (fn) => { offset += 6000; return transaction(fn); };
      assert.throws(() => commitHostEpochHandover(f.store, token), mode === "unused-token" ? /handover_preparation_expired/ : /epoch_commit_budget_exhausted/);
      assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 0);
    } finally { Date.now = originalNow; f.store.transaction = transaction; }
  });
});

test("entry confirmation needs actual B Hook and completed readonly body; root followup and first child Pre have no confirmation deadlock", async () => {
  await fixture(async (f) => {
    const child = await retainedChild(f); commitHostEpochHandover(f.store, await f.prepare());
    assert.throws(() => assertEpochAdmission(f.store, f.context, { kind: "route_stage" }), /current_epoch_invocation_missing/);
    assert.equal(observeEpochExecution(f.store, { name: "get_route_status", args: { contextId: f.reference.contextId } }).observed, false);
    const hook = beginHookDispatch(f.input, { shellRoot: b.root });
    f.store.runtimeInvocation = hook.invocation;
    observeEpochExecution(f.store, { input: f.input });
    assert.equal(epochAdmissionState(f.store.db, f.context).ready, false);
    assert.equal(epochAdmissionState(f.store.db, f.context).reasonCode, "HOST_EPOCH_ENTRY_UNCONFIRMED");
    endRuntimeDispatch(hook); f.store.runtimeInvocation = null;
    const read = beginMcpDispatch("get_route_status", { contextId: f.reference.contextId }, { cwd: f.cwd,
      env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: a.root });
    f.store.runtimeInvocation = read.invocation;
    observeEpochExecution(f.store, { name: "get_route_status", args: { contextId: f.reference.contextId } });
    assert.throws(() => assertEpochAdmission(f.store, f.context, { kind: "route_stage" }), /ENTRY_UNCONFIRMED/);
    endRuntimeDispatch(read); f.store.runtimeInvocation = null;
    assert.equal(epochAdmissionState(f.store.db, f.context).ready, true);
    assert.equal(epochAdmissionState(f.store.db, f.context).reasonCode, null);
    const pendingChild = epochAdmissionState(f.store.db, f.context, child.route.routeId);
    assert.equal(pendingChild.ready, false);
    assert.equal(pendingChild.rootReady, true);
    assert.equal(pendingChild.childReady, false);
    assert.equal(pendingChild.reasonCode, "HOST_EPOCH_CHILD_ENTRY_UNCONFIRMED");
    const followup = beginMcpDispatch("manage_stage", { contextId: f.reference.contextId, routeId: child.route.routeId },
      { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: a.root });
    f.store.runtimeInvocation = followup.invocation;
    assert.equal(assertEpochAdmission(f.store, f.context, { kind: "manage_stage", stageId: child.route.routeId }).ready, true);
    endRuntimeDispatch(followup); f.store.runtimeInvocation = null;
    const preInput = { ...child.stop, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "new-command", tool_input: { command: "true" } };
    const pre = beginHookDispatch(preInput, { shellRoot: b.root }); f.store.runtimeInvocation = pre.invocation;
    assert.throws(() => assertEpochAdmission(f.store, f.context, { kind: "child_business", stageId: child.route.routeId }), /CHILD_ENTRY_UNCONFIRMED/);
    observeEpochExecution(f.store, { input: preInput });
    assert.equal(assertEpochAdmission(f.store, f.context, { kind: "child_business", stageId: child.route.routeId }).currentNativeEntry, true);
    endRuntimeDispatch(pre); f.store.runtimeInvocation = null;
    const confirmedChild = epochAdmissionState(f.store.db, f.context, child.route.routeId);
    assert.equal(confirmedChild.ready, true);
    assert.equal(confirmedChild.rootReady, true);
    assert.equal(confirmedChild.childReady, true);
    assert.equal(confirmedChild.reasonCode, null);
  });
});

test("frozen direct A Hook diagnostic and registry are insufficient: no switch before actual preassignment v2 entry", async () => {
  await fixture(async (f) => {
    // An unrelated old record cannot be upgraded into a new source attestation.
    f.store.db.prepare("DELETE FROM runtime_epoch_native_entries").run();
    await assert.rejects(f.prepare(), /native_entry_attestation_missing/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    const client = { start: async () => {}, close() {}, request: async (method) => method === "thread/list"
      ? { data: [{ id: f.reference.contextId }] }
      : { thread: { id: f.reference.contextId, cwd: f.cwd, path: f.reference.transcriptPath, turns: [{ id: f.reference.turnId }] } } };
    const sweep = await sweepHostCompatibilityEpoch({ store: f.store, candidate: b.digest, shellRoot: b.root, client });
    assert.match(sweep.tasks[0].reason, /native_entry_attestation_missing/);
    assert.equal(sweep.complete, false); assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
  });
});

test("real frozen A launcher/Hook and MCP execute B bodies and persist confirmation without helper injection", async () => {
  await fixture(async (f) => {
    commitHostEpochHandover(f.store, await f.prepare());
    const env = { ...process.env, PLUGIN_ROOT: a.root, ADAPTIVE_ROUTER_SHELL_ROOT: a.root,
      ADAPTIVE_ROUTER_NODE: process.execPath, CODEX_THREAD_ID: f.reference.contextId };
    const hook = spawnSync(process.execPath, [join(a.root, "scripts/node-launcher.mjs"), join(a.root, "scripts/hook.mjs"), "session-start"],
      { cwd: f.cwd, env, encoding: "utf8", timeout: 15_000,
        input: JSON.stringify({ ...f.input, hook_event_name: "SessionStart", source: "compact", model: "gpt-6-astra" }) });
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(epochAdmissionState(f.store.db, f.context).rootReady, false);
    const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_route_status", arguments: { contextId: f.reference.contextId } } };
    const rpc = spawnSync(process.execPath, [join(a.root, "scripts/node-launcher.mjs"), join(a.root, "scripts/mcp-server.mjs")],
      { cwd: f.cwd, env, encoding: "utf8", timeout: 15_000, input: JSON.stringify(message) + "\n" });
    assert.equal(rpc.status, 0, rpc.stderr);
    const response = JSON.parse(rpc.stdout.trim());
    assert.equal(response.result?.isError, false, rpc.stdout);
    assert.equal(epochAdmissionState(f.store.db, f.context).rootReady, true);
    const executions = f.store.db.prepare("SELECT * FROM runtime_epoch_execution ORDER BY kind").all();
    assert.deepEqual(executions.map((row) => row.kind), ["hook", "read"]);
    assert.ok(executions.every((row) => row.generation === b.digest));
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM outcomes").get().n, 0);
    assert.equal(inspectRuntimePackage(a.root).digest, a.digest);
    // The same confirmed history cannot admit a source CLI without an active B
    // invocation, or let an A invocation borrow the current generation.
    assert.throws(() => assertEpochAdmission(f.store, f.context, { kind: "route_stage" }), /current_epoch_invocation_missing/);
    f.store.db.prepare("INSERT INTO runtime_invocations VALUES('old-a-lease',?,?,?,?,1,'active','2026-01-01')")
      .run(f.context.projectId, f.context.contextKey, a.digest, "mcp:route_stage");
    f.store.runtimeInvocation = { id: "old-a-lease" };
    assert.throws(() => assertEpochAdmission(f.store, f.context, { kind: "route_stage" }), /current_epoch_invocation_missing/);
    f.store.runtimeInvocation = null;
    for (const name of ["get_route_status", "unknown_business", "manage_stage"]) {
      const current = beginMcpDispatch(name, { contextId: f.reference.contextId },
        { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: a.root });
      f.store.runtimeInvocation = current.invocation;
      assert.throws(() => assertEpochAdmission(f.store, f.context, { kind: "route_stage" }), /entry_kind_or_subject_unproven/);
      endRuntimeDispatch(current); f.store.runtimeInvocation = null;
    }
    const current = beginMcpDispatch("route_stage", { contextId: f.reference.contextId },
      { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: a.root });
    f.store.runtimeInvocation = current.invocation;
    assert.equal(assertEpochAdmission(f.store, f.context, { kind: "route_stage" }).ready, true);
    assert.throws(() => assertEpochAdmission(f.store, f.context, { kind: "caller_claims_ready" }), /entry_kind_or_subject_unproven/);
    endRuntimeDispatch(current); f.store.runtimeInvocation = null;
  });
});

test("epoch origin material is encrypted and public receipts and sweep output do not expose native task paths or content", async () => {
  await fixture(async (f) => {
    const child = await retainedChild(f); const result = commitHostEpochHandover(f.store, await f.prepare());
    const raw = JSON.stringify(Object.fromEntries(["runtime_epoch_origins", "runtime_epoch_receipts", "runtime_epoch_native_entries", "runtime_epoch_execution"]
      .map((table) => [table, f.store.db.prepare(`SELECT * FROM ${table}`).all()])));
    for (const secret of [f.cwd, f.reference.contextId, child.childId, "Original unverified final", "Keep this unconsumed request"])
      assert.equal(raw.includes(secret), false, secret);
    assert.equal(JSON.stringify(result).includes(f.cwd), false);
    const { openPrivateState } = await import("../scripts/lib/private-state.mjs");
    const origin = JSON.parse(openPrivateState(f.store.db, f.store.db.prepare("SELECT record FROM runtime_epoch_origins WHERE subject='task'").get().record));
    assert.equal(origin.nativeBirth.id, f.reference.contextId); assert.equal(origin.nativeBirth.cwd, f.cwd);
  });
});

test("failed commit rolls back origin, receipt and effective bindings together and retry preserves one receipt", async () => {
  await fixture(async (f) => {
    await retainedChild(f); const before = business(f.store.db), token = await f.prepare();
    f.store.db.exec("CREATE TRIGGER fixture_interrupted_epoch BEFORE UPDATE ON runtime_stages BEGIN SELECT RAISE(ABORT,'injected_commit_interruption'); END");
    assert.throws(() => commitHostEpochHandover(f.store, token), /injected_commit_interruption/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_origins").get().n, 0);
    assert.equal(business(f.store.db), before);
    f.store.db.exec("DROP TRIGGER fixture_interrupted_epoch");
    commitHostEpochHandover(f.store, token);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 1);
    assert.equal(business(f.store.db), before);
  });
});

test("repeated normal Hook/status observations remain bounded while referenced and unknown invocations remain retained", async () => {
  await fixture(async (f) => {
    commitHostEpochHandover(f.store, await f.prepare());
    for (let index = 0; index < 48; index++) {
      const input = { ...f.input, turn_id: `normal-${index}` };
      const hook = beginHookDispatch(input, { shellRoot: b.root }); f.store.runtimeInvocation = hook.invocation;
      observeEpochExecution(f.store, { input }); endRuntimeDispatch(hook); f.store.runtimeInvocation = null;
      const read = beginMcpDispatch("get_route_status", { contextId: f.reference.contextId },
        { cwd: f.cwd, env: { CODEX_THREAD_ID: f.reference.contextId }, shellRoot: a.root });
      f.store.runtimeInvocation = read.invocation;
      observeEpochExecution(f.store, { name: "get_route_status", args: { contextId: f.reference.contextId } });
      endRuntimeDispatch(read); f.store.runtimeInvocation = null;
    }
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_execution").get().n, 2);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_native_entries").get().n, 2);
    const unknown = beginHookDispatch({ ...f.input, turn_id: "unknown-turn" }, { shellRoot: b.root });
    endRuntimeDispatch(unknown, false);
    const latest = beginHookDispatch({ ...f.input, turn_id: "latest-turn" }, { shellRoot: b.root }); endRuntimeDispatch(latest);
    assert.ok(f.store.db.prepare("SELECT 1 FROM runtime_epoch_native_entries WHERE invocation_id=?").get(unknown.invocation.id));
    assert.throws(() => f.store.db.prepare("DELETE FROM runtime_epoch_native_entries WHERE invocation_id=?").run(unknown.invocation.id), /unresolved/);
    const referenced = f.store.db.prepare("SELECT invocation_id FROM runtime_epoch_entry_references").get().invocation_id;
    assert.throws(() => f.store.db.prepare("DELETE FROM runtime_epoch_native_entries WHERE invocation_id=?").run(referenced), /referenced/);
    assert.equal(epochAdmissionState(f.store.db, f.context).rootReady, true);
  });
});

test("restart sweep discovers first and dormant tasks without borrowing a binding or creating another business route", async () => {
  await fixture(async (f) => {
    const client = { start: async () => {}, close() {}, request: async (method, args) => method === "thread/list"
      ? { data: [{ id: f.reference.contextId }, { id: "unobserved-dormant-native-task" }] }
      : { thread: { id: args.threadId, cwd: f.cwd, path: f.reference.transcriptPath, turns: [{ id: f.reference.turnId }] } } };
    const before = business(f.store.db);
    const first = await sweepHostCompatibilityEpoch({ store: f.store, candidate: b.digest, shellRoot: b.root,
      client, inspect: async () => ({ binding: f.binding }) });
    assert.equal(first.tasks[0].state, "checking");
    assert.equal(first.tasks[0].generation, b.digest);
    assert.equal(first.tasks[1].reason, "task_not_observed_by_v2_dispatch_yet");
    assert.equal(first.complete, false);
    assert.equal(JSON.stringify(first).includes("unobserved-dormant-native-task"), false);
    const restarted = new RouterStore({ path: f.store.path });
    try {
      const again = await sweepHostCompatibilityEpoch({ store: restarted, candidate: b.digest, shellRoot: b.root, client });
      assert.equal(again.tasks[0].state, "checking");
      assert.equal(restarted.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 1);
      assert.equal(business(restarted.db), before);
    } finally { restarted.close(); }
  });
});

test("rollback to a frozen writer without epoch confirmation remains explicitly blocked and retains the B assignment", async () => {
  await fixture(async (f) => {
    commitHostEpochHandover(f.store, await f.prepare());
    const before = business(f.store.db);
    await assert.rejects(prepareHostEpochHandover(f.store, f.reference, { candidate: a.digest, shellRoot: b.root,
      inspect: async () => ({ binding: f.binding }) }), /rollback_or_target_epoch_entry_unproven/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, b.digest);
    assert.equal(business(f.store.db), before);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 1);
  });
});

test("two source-qualified epoch-capable runtimes roll forward and back at new quiescent boundaries with one immutable continuation chain", async () => {
  await fixture(async (f) => {
    const child = await retainedChild(f), before = business(f.store.db);
    const first = commitHostEpochHandover(f.store, await f.prepare());
    const location = join(f.cwd, "epoch-capable-c"); cpSync(b.root, location, { recursive: true });
    writeFileSync(join(location, "epoch-release-note.txt"), "A distinct immutable release of the same reviewed epoch protocol.\n");
    const c = inspectRuntimePackage(location);
    publishHostEpoch(f.store, qualifyHostEpochPublication(b, c));
    const observeCurrentEntries = () => {
      const rootEntry = beginHookDispatch(f.input, { shellRoot: b.root }); endRuntimeDispatch(rootEntry);
      const childEntry = beginHookDispatch(child.stop, { shellRoot: b.root }); endRuntimeDispatch(childEntry);
    };
    observeCurrentEntries();
    const secondToken = await prepareHostEpochHandover(f.store, f.reference, { candidate: c.digest,
      shellRoot: b.root, inspect: async () => ({ binding: f.binding }) });
    const second = commitHostEpochHandover(f.store, secondToken);
    assert.equal(runtimeTask(f.store.db, f.context).generation, c.digest);
    observeCurrentEntries();
    const rollbackToken = await prepareHostEpochHandover(f.store, f.reference, { candidate: b.digest,
      shellRoot: b.root, inspect: async () => ({ binding: f.binding }) });
    const rollback = commitHostEpochHandover(f.store, rollbackToken);
    assert.equal(runtimeTask(f.store.db, f.context).generation, b.digest);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(child.route.routeId).generation, b.digest);
    assert.equal(business(f.store.db), before);
    const receipts = f.store.db.prepare("SELECT id,source,candidate,previous FROM runtime_epoch_receipts ORDER BY rowid").all();
    assert.deepEqual(receipts.map((row) => [row.id, row.source, row.candidate, row.previous]), [
      [first.id, a.digest, b.digest, null], [second.id, b.digest, c.digest, first.id], [rollback.id, c.digest, b.digest, second.id],
    ]);
    assert.ok(f.store.db.prepare("SELECT generation FROM runtime_epoch_origins").all().every((row) => row.generation === a.digest));
    assert.equal(commitHostEpochHandover(f.store, rollbackToken).idempotent, true);
    const restarted = new RouterStore({ path: f.store.path });
    try { assert.deepEqual(restarted.db.prepare("SELECT id,source,candidate,previous FROM runtime_epoch_receipts ORDER BY rowid").all(), receipts); }
    finally { restarted.close(); }
  });
});

test("a rejected candidate preserves A; a frozen task missing entry proof can be swept successfully after actual new-dispatcher entry", async () => {
  await fixture(async (f) => {
    const invalidRoot = join(f.cwd, "invalid-candidate"); cpSync(b.root, invalidRoot, { recursive: true });
    const file = join(invalidRoot, "scripts/lib/runtime-epoch.mjs");
    writeFileSync(file, readFileSync(file, "utf8") + "\n// unreviewed candidate-owned claim\n");
    const invalid = inspectRuntimePackage(invalidRoot);
    assert.throws(() => qualifyHostEpochPublication(a, invalid), /candidate_verifier_source_differs/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 0);
    f.store.db.prepare("DELETE FROM runtime_epoch_native_entries").run();
    const client = { start: async () => {}, close() {}, request: async (method) => method === "thread/list"
      ? { data: [{ id: f.reference.contextId }] }
      : { thread: { id: f.reference.contextId, cwd: f.cwd, path: f.reference.transcriptPath, turns: [{ id: f.reference.turnId }] } } };
    const settings = { store: f.store, candidate: b.digest, shellRoot: b.root, client, inspect: async () => ({ binding: f.binding }) };
    const blocked = await sweepHostCompatibilityEpoch(settings);
    assert.match(blocked.tasks[0].reason, /native_entry_attestation_missing/);
    assert.equal(runtimeTask(f.store.db, f.context).generation, a.digest);
    const entered = beginHookDispatch(f.input, { shellRoot: b.root }); endRuntimeDispatch(entered);
    const resumed = await sweepHostCompatibilityEpoch(settings);
    assert.equal(resumed.tasks[0].state, "checking");
    assert.equal(resumed.tasks[0].generation, b.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM runtime_epoch_receipts").get().n, 1);
  });
});

// Independent regression cases use the real qualification state machine and
// raw child audits. Hook input and host read results are isolated fixtures;
// these cases do not claim native host reload or Hook trust acceptance.
const mod = moduleAt; const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
async function qualifyFixture(f, id, { fail = false, omitStop = false, bindingVariant = "" } = {}) {
  let dispatch = beginMcpDispatch("route_stage", { contextId: id }, { cwd: f.project.root, env: { CODEX_THREAD_ID: id }, shellRoot: f.a.root });
  const [service, qualification, gate, router] = await Promise.all(["service", "lifecycle-qualification", "delegation-gate", "router"].map((name) => mod(dispatch.selected.root, name)));
  const store = service.createServiceStore({ runtimeInvocation: dispatch.invocation });
  try {
    const context = store.context({ cwd: f.project.root, contextId: id });
    const binding = { runtimeDigest: qualification.runtimeSourceDigest(), configurationDigest: payloadHash("fixture host/hook chain" + bindingVariant),
      taskCwdDigest: payloadHash(realpathSync(f.project.root)), shellRoots: [payloadHash(realpathSync(f.a.root))], cliVersion: "0.153.0" };
    binding.digest = payloadHash(binding);
    const readiness = () => qualification.qualificationReadiness(store.db, context, binding);
    if (readiness().ready) return { context, binding, qualified: qualification.verifiedRuntimeQualification(store.db, context) };
    const route = await router.routeStage(routeInput({ contextId: id }), { store, cwd: f.project.root, catalog: CATALOG,
      diskProbe: () => 20n * 1024n ** 3n, lifecycleHookProbe: async () => readiness() });
    assert.deepEqual(route.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    const childId = `child-${route.routeId}`, turnId = `root-${route.routeId}`, toolUseId = `call-${route.routeId}`, childTurn = "child-turn";
    const taskName = route.carrier.taskName, agentPath = `/root/${taskName}`, marker = qualification.readTaskQualification(store.db, context).marker;
    const toolInput = { task_name: taskName, message: route.carrier.message, model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
    store.transaction(() => {
      gate.consumeDelegationTicket(store.db, context, { taskName, turnId, toolUseId, toolInput });
      gate.claimDelegationSubagent(store.db, context, { taskName, agentId: childId, model: route.target.model });
      gate.observeAgentResult(store.db, context, { turnId, toolUseId, toolInput, toolResponse: { agent_id: childId } });
      if (!omitStop) gate.observeSubagentStop(store.db, context, taskName, childId, 4096);
      for (const event of ["pre", "start", "post", ...(omitStop ? [] : ["stop"])]) qualification.observeQualificationHook(store.db, context, route.routeId, event, f.a.root);
    });
    const parent = { id, cwd: f.project.root, turns: [{ id: turnId, itemsView: "full", items: [
      { type: "subAgentActivity", kind: "started", id: toolUseId, agentThreadId: childId, agentPath },
      { type: "subAgentActivity", kind: "completed", id: `subagent-completed-${childTurn}`, agentThreadId: childId, agentPath }] }] };
    const child = { id: childId, parentThreadId: id, forkedFromId: null, cwd: f.project.root, cliVersion: binding.cliVersion,
      model: route.target.model, reasoningEffort: route.target.effort, path: "/fixture-native/child.jsonl",
      source: { subAgent: { thread_spawn: { parent_thread_id: id, depth: 1, agent_path: agentPath } } },
      turns: [{ id: childTurn, status: "completed", error: null, itemsView: "full", items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: marker }] }] };
    const records = [{ type: "session_meta", payload: { id: childId, parent_thread_id: id, cli_version: binding.cliVersion } },
      event("task_started", { turn_id: childTurn }), { type: "turn_context", payload: { turn_id: childTurn, model: route.target.model, effort: route.target.effort } },
      { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: marker }] } }, event("task_complete", { turn_id: childTurn })];
    endRuntimeDispatch(dispatch); store.runtimeInvocation = null;
    dispatch = beginMcpDispatch("record_outcome", { contextId: id, routeId: route.routeId },
      { cwd: f.project.root, env: { CODEX_THREAD_ID: id }, shellRoot: f.a.root });
    store.runtimeInvocation = dispatch.invocation;
    const outcome = { contextId: id, routeId: route.routeId, status: "passed", gate: route.verificationGate, failureType: null, retries: 0,
      retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false };
    const options = { store, cwd: f.project.root, qualificationOptions: { inspectBinding: async () => ({ binding }),
      readNative: async () => ({ parent, child }), auditOptions: { readTranscript: () => Buffer.from(records.map(JSON.stringify).join("\n") + "\n") } } };
    if (fail || omitStop) {
      records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", namespace: "functions", name: "exec" } });
      await assert.rejects(service.callRouterTool("record_outcome", outcome, options), /verification failed/);
      await service.callRouterTool("record_outcome", { ...outcome, status: "failed", failureType: "tooling" }, options);
    } else await service.callRouterTool("record_outcome", outcome, options);
    return { context, binding, qualified: qualification.verifiedRuntimeQualification(store.db, context),
      state: qualification.readTaskQualification(store.db, context), route, childId, taskName };
  } finally { store.close(); endRuntimeDispatch(dispatch); }
}

const qfixture = (f) => ({ project: { root: f.cwd, home: f.home }, a: b });
async function enterEpoch(f) {
  commitHostEpochHandover(f.store, await f.prepare());
  for (const [name, args] of [["hook", f.input], ["get_route_status", { contextId: f.reference.contextId }]]) {
    const d = name === "hook" ? beginHookDispatch(args, { shellRoot: b.root }) : beginMcpDispatch(name,args,
      {cwd:f.cwd,env:{CODEX_THREAD_ID:f.reference.contextId},shellRoot:b.root});
    f.store.runtimeInvocation=d.invocation;
    observeEpochExecution(f.store, name === "hook" ? {input:args} : {name,args});
    endRuntimeDispatch(d);f.store.runtimeInvocation=null;
  }
  assert.equal(epochAdmissionState(f.store.db,f.context).rootReady,true);
  return JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_receipts").all());
}
function compatible(f,label) {
  const path=join(f.cwd,label); cpSync(b.root,path,{recursive:true});
  writeFileSync(join(path,"release-note.txt"),label+"\n");
  const c=inspectRuntimePackage(path);
  assert.equal(c.writerDigest,b.writerDigest);assert.equal(c.shellDigest,b.shellDigest);
  return c;
}
function publish(f,c,from=b) {
  const proof=qualifyRuntimeCompatibility(from,c);
  return f.store.transaction(()=>publishRuntime(f.store.db,c,f.home,{compatibilityProof:proof}));
}
async function nextTurn(f,id) {
  const previous=runtimeTask(f.store.db,f.context).turn_id;
  if (!f.records.some(r=>r.payload?.type==="task_complete"&&r.payload?.turn_id===previous)) f.records.push(event("task_complete",{turn_id:previous}));
  f.records.push(event("task_started",{turn_id:id}));f.writeRoot();
  const input={...f.input,hook_event_name:"UserPromptSubmit",turn_id:id,prompt:"Continue"};
  const d=beginHookDispatch(input,{shellRoot:b.root});f.store.runtimeInvocation=d.invocation;
  try { const actual=await moduleAt(d.selected.root,"runtime-epoch");actual.observeEpochExecution(f.store,{input}); }
  finally {endRuntimeDispatch(d);f.store.runtimeInvocation=null;}
  return d.invocation.generation;
}
async function businessRoute(f,qualified) {
  const args=routeInput({contextId:f.reference.contextId});
  const d=beginMcpDispatch("route_stage",args,{cwd:f.cwd,env:{CODEX_THREAD_ID:f.reference.contextId},shellRoot:b.root});
  const service=await moduleAt(d.selected.root,"service"), q=await moduleAt(d.selected.root,"lifecycle-qualification");
  const store=service.createServiceStore({runtimeInvocation:d.invocation});
  try {return await service.callRouterTool("route_stage",args,{store,cwd:f.cwd,routeOptions:{catalog:CATALOG,
    diskProbe:()=>20n*1024n**3n,lifecycleHookProbe:async()=>q.qualificationReadiness(store.db,store.context({cwd:f.cwd,contextId:args.contextId}),qualified.binding)}});}
  finally {store.close();endRuntimeDispatch(d);}
}
test("real qualified B proof inherits to C, blocks pre-settlement business, then C continues and retains B receipt",async(t)=>{
  await fixture(async f=>{
    const receipt=await enterEpoch(f);
    const original=await qualifyFixture(qfixture(f),f.reference.contextId);
    assert.equal(original.qualified.state,"passed");
    const originalRaw=JSON.stringify(original.qualified);
    const c=compatible(f,"C-success");publish(f,c);
    assert.equal(await nextTurn(f,"candidate-C-turn"),c.digest);
    const beforeCandidateBusiness=business(f.store.db); const paused=await businessRoute(f,original); assert.deepEqual(paused.reasonCodes,["RUNTIME_CANDIDATE_QUALIFICATION_PENDING"]);
    assert.notEqual(paused.action,"delegate"); assert.equal(business(f.store.db),beforeCandidateBusiness);
    const candidate=await qualifyFixture(qfixture(f),f.reference.contextId);
    assert.equal(candidate.qualified.state,"passed");assert.equal(candidate.qualified.inheritedFromRuntime,b.digest);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM outcomes").get().n,1);
    const result=f.store.transaction(()=>settleRuntimeMigration(f.store.db,f.context,{candidateQualification:candidate.qualified,candidateReady:true}));
    assert.equal(result.state,"migrated");assert.equal(result.generation,c.digest);
    assert.equal(await nextTurn(f,"after-C-turn"),c.digest);
    assert.equal(runtimeTask(f.store.db,f.context).candidate,null);
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_receipts").all()),receipt);
    const oldq=await moduleAt(b.root,"lifecycle-qualification");
    assert.equal(JSON.stringify(oldq.readTaskQualification(f.store.db,original.context)),originalRaw);
    const admittedBusiness=await businessRoute(f,candidate);assert.equal(admittedBusiness.action,"delegate");
    assert.ok(!admittedBusiness.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"));
    t.diagnostic(JSON.stringify({proof:"real route, hook events, raw child audit, record_outcome",epochReceiptUnchanged:true,currentC:c.digest}));
  });
});
test("real failed C qualification restores B and preserves the old proof and epoch receipt",async(t)=>{
  await fixture(async f=>{
    const receipt=await enterEpoch(f);
    const original=await qualifyFixture(qfixture(f),f.reference.contextId);
    const originalRaw=JSON.stringify(original.qualified);
    const c=compatible(f,"C-failed");publish(f,c);assert.equal(await nextTurn(f,"failure-C-turn"),c.digest);
    const failed=await qualifyFixture(qfixture(f),f.reference.contextId,{fail:true,bindingVariant:"changed-host-config"});
    assert.equal(failed.state.state,"failed");assert.equal(failed.qualified.state,"failed");
    const settle=()=>f.store.transaction(()=>settleRuntimeMigration(f.store.db,f.context,{candidateQualification:failed.qualified,oldQualificationValid:true}));
    assert.equal(settle().state,"restored");assert.equal(runtimeTask(f.store.db,f.context).generation,b.digest);
    assert.equal(await nextTurn(f,"after-failed-C-turn"),c.digest);
    assert.equal(settle().state,"restored");assert.equal(runtimeTask(f.store.db,f.context).generation,b.digest);
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_receipts").all()),receipt);
    const oldq=await moduleAt(b.root,"lifecycle-qualification");
    assert.equal(JSON.stringify(oldq.readTaskQualification(f.store.db,original.context)),originalRaw);
    const admittedBusiness=await businessRoute(f,original);assert.equal(admittedBusiness.action,"delegate");
    assert.ok(!admittedBusiness.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"));
    t.diagnostic(JSON.stringify({failedBy:"raw child contains forbidden tool",restoredB:true,noA:true,oldProofUnchanged:true}));
  });
});
test("ordinary publication rejects forged and wrong-pair proof and invalidates a stale native boundary",async()=>{
  await fixture(async f=>{
    await enterEpoch(f);
    const c=compatible(f,"C-cas"),d=compatible(f,"D-cas");
    const pc=qualifyRuntimeCompatibility(b,c),pd=qualifyRuntimeCompatibility(b,d);
    const before=business(f.store.db);
    for(const proof of [{source:b.digest,candidate:c.digest,suite:pc.suite},pd])
      assert.throws(()=>f.store.transaction(()=>publishRuntime(f.store.db,c,f.home,{compatibilityProof:proof})),/shared-writer qualification/);
    f.store.transaction(()=>publishRuntime(f.store.db,c,f.home,{compatibilityProof:pc}));
    const input={...f.input,hook_event_name:"UserPromptSubmit",turn_id:"new-cas-turn"};
    const boundary=inspectRuntimeBoundary(input,f.reference.turnId,{db:f.store.db,context:f.context,deadline:Date.now()+60000});
    assert.ok(boundary);assert.equal(isRuntimeBoundaryProof(boundary,f.store.db,f.context),true);
    f.store.transaction(()=>publishRuntime(f.store.db,d,f.home,{compatibilityProof:pd}));
    assert.equal(isRuntimeBoundaryProof(boundary,f.store.db,f.context),false);
    assert.equal(f.store.transaction(()=>beginRuntimeMigration(f.store.db,f.context,boundary)),false);
    assert.equal(runtimeTask(f.store.db,f.context).candidate,null);
    assert.equal(business(f.store.db),before);
  });
});

async function selectedCall(f,name,args) {
  const d=beginMcpDispatch(name,args,{cwd:f.cwd,env:{CODEX_THREAD_ID:f.reference.contextId},shellRoot:b.root});
  const service=await moduleAt(d.selected.root,"service");
  const store=service.createServiceStore({runtimeInvocation:d.invocation});
  try {return {generation:d.invocation.generation,result:await service.callRouterTool(name,args,{store,cwd:f.cwd})};}
  finally {store.close();endRuntimeDispatch(d);}
}
async function settledBusinessChild(f,qualified) {
  const route=await businessRoute(f,qualified);assert.equal(route.action,"delegate");
  assert.ok(!route.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"));
  const gate=await moduleAt(b.root,"delegation-gate"),closure=await moduleAt(b.root,"stage-closure");
  const taskName=route.carrier.taskName,childId="retained-real-fixture-child",agentPath=`/root/${taskName}`;
  const turnId="settled-child-turn",text="Completed isolated original stage",path=join(f.cwd,"settled-child.jsonl");
  const records=[{type:"session_meta",payload:{id:childId,session_id:f.reference.contextId,parent_thread_id:f.reference.contextId,cwd:f.cwd,
    agent_path:agentPath,source:{subagent:{thread_spawn:{parent_thread_id:f.reference.contextId,depth:1,agent_path:agentPath}}}}},
    event("task_started",{turn_id:turnId}),{type:"inter_agent_communication_metadata",payload:{trigger_turn:true}},
    {type:"response_item",payload:{type:"agent_message",id:"activation",author:"/root",recipient:agentPath,content:[{type:"input_text",text:"Original work"}],
      internal_chat_message_metadata_passthrough:{turn_id:turnId}}},
    {type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",id:"original-final",content:[{type:"output_text",text}],
      internal_chat_message_metadata_passthrough:{turn_id:turnId}}},event("task_complete",{turn_id:turnId,last_agent_message:text})];
  const save=()=>writeFileSync(path,records.map(JSON.stringify).join("\n")+"\n");save();
  const toolInput={task_name:taskName,message:route.carrier.message,model:route.target.model,reasoning_effort:route.target.effort,fork_turns:"none"};
  f.store.transaction(()=>{
    assert.equal(gate.consumeDelegationTicket(f.store.db,f.context,{taskName,turnId:f.reference.turnId,toolUseId:"original-spawn",toolInput}).allowed,true);
    assert.equal(gate.claimDelegationSubagent(f.store.db,f.context,{taskName,agentId:childId,model:route.target.model}).allowed,true);
    gate.observeAgentResult(f.store.db,f.context,{turnId:f.reference.turnId,toolUseId:"original-spawn",toolInput,toolResponse:{agent_id:childId}});
    closure.registerManagedChild(f.store.db,f.context,route.routeId,{taskName,childId,parentContextId:f.reference.contextId,agentPath,transcriptPath:path});
    gate.observeSubagentStop(f.store.db,f.context,taskName,childId,readFileSync(path).length,{turnId,lastAssistantMessage:text});
    closure.observeManagedStop(f.store.db,route.routeId,{turnId,lastAssistantMessage:text});
  });
  const view=f.store.status(f.context).stageClosure;assert.equal(view.state,"ready",JSON.stringify(view));
  const outcome={contextId:f.reference.contextId,routeId:route.routeId,status:"passed",gate:route.verificationGate,failureType:null,retries:0,
    retryBreakdown:{reasoning:0,environment:0,information:0,tooling:0},escalations:0,userCorrection:false,closureToken:view.token};
  assert.equal((await selectedCall(f,"record_outcome",outcome)).result.recorded,true);
  assert.equal(f.store.db.prepare("SELECT state FROM delegation_children WHERE route_id=?").get(route.routeId).state,"settled");
  assert.deepEqual(pendingRuntimeResponsibilities(f.store.db,f.context),[]);
  return {route,childId,taskName,agentPath,path,records,save,turnId};
}
function actualHook(f,mode,input) {
  const result=spawnSync(process.execPath,[join(b.root,"scripts/node-launcher.mjs"),join(b.root,"scripts/hook.mjs"),mode],{
    cwd:f.cwd,env:{...process.env,ADAPTIVE_ROUTER_RUNTIME_TRACE:"1",CODEX_THREAD_ID:f.reference.contextId},input:JSON.stringify(input),encoding:"utf8",timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const invocation=f.store.db.prepare("SELECT * FROM runtime_invocations ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(invocation.generation,b.digest,"retained stage Hook must run B while root task is C");
  return result.stdout.trim()?JSON.parse(result.stdout):null;
}
test("settled B child stays B under task C and completes actual Hook followup maintenance without a second outcome",async(t)=>{
  await fixture(async f=>{
    const receipt=await enterEpoch(f);
    const original=await qualifyFixture(qfixture(f),f.reference.contextId);
    const child=await settledBusinessChild(f,original);
    const c=compatible(f,"C-retained-child");publish(f,c);assert.equal(await nextTurn(f,"C-business-turn"),c.digest);
    const candidate=await qualifyFixture(qfixture(f),f.reference.contextId);
    assert.equal(f.store.transaction(()=>settleRuntimeMigration(f.store.db,f.context,{candidateQualification:candidate.qualified,candidateReady:true})).state,"migrated");
    assert.equal(runtimeTask(f.store.db,f.context).generation,c.digest);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_stages WHERE route_id=?").get(child.route.routeId).generation,b.digest);
    const outcomes=JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes ORDER BY rowid").all());
    const disposition={intent:"collect",basis:"Collect original retained requirements without business work",requirements:[],pendingOperations:[]};
    const manage=async(action,extra={})=>{
      const args={contextId:f.reference.contextId,routeId:child.route.routeId,action,parentTranscriptPath:f.reference.transcriptPath,expectedRevision:f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(child.route.routeId).revision,...extra};
      const called=await selectedCall(f,"manage_stage",args);assert.equal(called.generation,b.digest);return called.result;
    };
    assert.equal((await manage("begin_maintenance",{disposition})).nextAction,"followup_bounded_collection");
    const input={...f.input,hook_event_name:"PreToolUse",turn_id:"C-business-turn",tool_name:"collaborationfollowup_task",tool_use_id:"maintenance-wake",
      tool_input:{target:child.agentPath,message:"Collect original retained requirements without doing work"}};
    assert.notEqual(actualHook(f,"pre-tool-use",input)?.hookSpecificOutput?.permissionDecision,"deny");
    actualHook(f,"post-tool-use",{...input,hook_event_name:"PostToolUse",tool_response:""});
    f.records.push({type:"response_item",payload:{type:"function_call",namespace:"collaboration",name:"followup_task",call_id:input.tool_use_id,arguments:JSON.stringify(input.tool_input)}},
      {type:"response_item",payload:{type:"function_call_output",call_id:input.tool_use_id,output:""}});f.writeRoot();
    const childInput={session_id:f.reference.contextId,agent_id:child.childId,agent_type:"worker",cwd:f.cwd,transcript_path:child.path,agent_transcript_path:child.path,
      turn_id:"maintenance-child-turn",hook_event_name:"PreToolUse",tool_name:"exec_command",tool_use_id:"forbidden-maintenance-work",tool_input:{cmd:"true"}};
    assert.equal(actualHook(f,"pre-tool-use",childInput).hookSpecificOutput.permissionDecision,"deny");
    child.records.push(event("task_started",{turn_id:"maintenance-child-turn"}),
      {type:"inter_agent_communication_metadata",payload:{trigger_turn:true}},
      {type:"response_item",payload:{type:"agent_message",id:"maintenance-input",author:"/root",recipient:child.agentPath,content:[{type:"input_text",text:input.tool_input.message}],
        internal_chat_message_metadata_passthrough:{turn_id:"maintenance-child-turn"}}},
      {type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",id:"maintenance-final",content:[{type:"output_text",text:"COLLECTED"}],
        internal_chat_message_metadata_passthrough:{turn_id:"maintenance-child-turn"}}},event("task_complete",{turn_id:"maintenance-child-turn",last_agent_message:"COLLECTED"}));
    child.save();
    actualHook(f,"subagent-stop",{...childInput,hook_event_name:"SubagentStop",last_assistant_message:"COLLECTED"});
    const view=f.store.status(f.context).stageClosure;assert.equal(view.state,"ready",JSON.stringify(view));
    const reviewed={...disposition,resultReview:"Matched each returned requirement and native operation reference",requirements:view.inputReferences.slice(1).map(({id})=>({messageId:id,source:`native input ${id}`,disposition:"transferred",receipt:"Retained with root",owner:"/root"}))};
    assert.equal((await manage("verify_maintenance",{closureToken:view.token,disposition:reviewed})).state,"verified");
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM outcomes ORDER BY rowid").all()),outcomes);
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_receipts").all()),receipt);
    assert.equal(runtimeTask(f.store.db,f.context).generation,c.digest);
    t.diagnostic(JSON.stringify({taskC:c.digest,retainedStageB:b.digest,actualLauncherHooks:true,maintenanceVerified:true,originalOutcomesUnchanged:true,nativeHost:false}));
  });
});

test("historical writer equivalence uses actual immutable proof pairs and rejects an unbridged writer",async(t)=>{
  await fixture(async f=>{
    await enterEpoch(f);
    const a2path=join(f.cwd,"A2-equivalent");cpSync(a.root,a2path,{recursive:true});writeFileSync(join(a2path,"release-note.txt"),"Equivalent historical A2\n");
    const a2=inspectRuntimePackage(a2path);assert.equal(a2.writerDigest,a.writerDigest);assert.equal(a2.shellDigest,a.shellDigest);
    const pa2=qualifyRuntimeCompatibility(a,a2);
    f.store.transaction(()=>publishRuntime(f.store.db,a2,f.home,{compatibilityProof:pa2}));
    assert.equal(f.store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest,a2.digest);
    assert.throws(()=>f.store.transaction(()=>publishRuntime(f.store.db,a2,f.home,{compatibilityProof:{source:b.digest,candidate:a2.digest,suite:"claim"}})),/shared-writer qualification/);
    const c=compatible(f,"C-historical-equivalence");const pc=qualifyRuntimeCompatibility(b,c);
    assert.equal(f.store.transaction(()=>publishRuntime(f.store.db,c,f.home,{compatibilityProof:pc})).scope,"compatible_epoch_tasks");
    assert.equal(f.store.db.prepare("SELECT current_digest FROM runtime_defaults").get().current_digest,a2.digest);
    const history=JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_ordinary_publications ORDER BY rowid").all());
    // Deliberately model a registered historical writer lacking an epoch bridge;
    // this isolated DB fixture is not a claim public admission accepts it.
    const roguePath=join(f.cwd,"unbridged-history");cpSync(b.root,roguePath,{recursive:true});
    const path=join(roguePath,"scripts/lib/database.mjs");writeFileSync(path,readFileSync(path,"utf8")+"\n// unbridged historical writer\n");
    const rogue=inspectRuntimePackage(roguePath);assert.notEqual(rogue.writerDigest,b.writerDigest);
    f.store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(rogue.digest,JSON.stringify(rogue));
    const d=compatible(f,"D-unbridged-refused"),pd=qualifyRuntimeCompatibility(b,d);
    assert.throws(()=>f.store.transaction(()=>publishRuntime(f.store.db,d,f.home,{compatibilityProof:pd})),/Unproven shared-writer or shell compatibility/);
    assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM runtime_epoch_ordinary_publications ORDER BY rowid").all()),history);
    assert.equal(f.store.db.prepare("SELECT generation FROM runtime_epoch_ordinary_defaults").get().generation,c.digest);
    t.diagnostic(JSON.stringify({actualAtoA2Proof:true,actualBtoCProof:true,sharedDefaultA2Preserved:true,unbridgedHistoryRefused:true}));
  });
});
