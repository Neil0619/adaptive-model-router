import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { consumeDelegationTicket, observeAgentResult } from "../scripts/lib/delegation-gate.mjs";
import { recoverDelegation, readNativeRecoveryReceipt } from "../scripts/lib/delegation-recovery.mjs";
import { observeQualificationHook, qualificationReadiness, readTaskQualification, runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function withFailedQualification(run) {
  const project = await temporaryProject("router-qualification-recovery-");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        const stageInput = routeInput({ contextId: "qualification-parent" });
        const context = store.context({ cwd: project.root, contextId: stageInput.contextId });
        const binding = { digest: "a".repeat(64), runtimeDigest: runtimeSourceDigest(),
          configurationDigest: "d".repeat(64),
          taskCwdDigest: payloadHash(realpathSync(project.root)),
          shellRoots: [payloadHash(realpathSync(SOURCE_ROOT))], cliVersion: "0.153.0" };
        const routeOptions = { store, cwd: project.root, catalog: CATALOG,
          diskProbe: () => 16n * 1024n ** 3n,
          lifecycleHookProbe: async () => qualificationReadiness(store.db, context, binding) };
        const route = await routeStage(stageInput, routeOptions);
        assert.deepEqual(route.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
        const toolInput = { task_name: route.carrier.taskName, message: route.carrier.message,
          model: route.target.model, reasoning_effort: route.target.effort, fork_turns: "none" };
        store.transaction(() => {
          assert.equal(consumeDelegationTicket(store.db, context, { taskName: route.carrier.taskName,
            turnId: "root-turn", toolUseId: "spawn-call", toolInput }).allowed, true);
          assert.equal(observeAgentResult(store.db, context, { turnId: "root-turn", toolUseId: "spawn-call",
            toolInput, toolResponse: { task_name: route.carrier.taskName } }).correlated, true);
          for (const event of ["pre", "post"]) observeQualificationHook(store.db, context, route.routeId, event, SOURCE_ROOT);
        });
        await callRouterTool("record_outcome", { routeId: route.routeId, contextId: stageInput.contextId,
          status: "failed", gate: "structured-check", failureType: "tooling", retries: 0,
          retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
          escalations: 0, userCorrection: false }, { store, cwd: project.root });
        const agentPath = `/root/${route.carrier.taskName}`;
        const parent = { id: stageInput.contextId, cwd: project.root, cliVersion: "0.153.0-alpha.5",
          turns: [{ id: "root-turn", status: "completed", itemsView: "full", items: [
            { type: "subAgentActivity", kind: "started", id: "spawn-call", agentThreadId: "child", agentPath },
            { type: "subAgentActivity", kind: "completed", id: "subagent-completed-child-turn", agentThreadId: "child", agentPath },
          ] }] };
        const child = { id: "child", parentThreadId: parent.id, forkedFromId: null, cwd: project.root,
          cliVersion: "0.153.0", model: route.target.model, reasoningEffort: route.target.effort,
          path: "/native/child.jsonl", source: { subAgent: { thread_spawn: {
            parent_thread_id: parent.id, depth: 1, agent_path: agentPath,
          } } }, turns: [{ id: "child-turn", status: "completed", error: null, itemsView: "full", items: [
            { type: "agentMessage", id: "final", phase: "final_answer", text: "Stopped without a trusted bounded context." },
          ] }] };
        const records = [
          { type: "session_meta", payload: { id: child.id, session_id: parent.id, parent_thread_id: parent.id,
            cwd: project.root, cli_version: child.cliVersion, agent_path: agentPath,
            source: { subagent: { thread_spawn: child.source.subAgent.thread_spawn } } } },
          { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
          { type: "turn_context", payload: { turn_id: "child-turn", model: child.model, effort: child.reasoningEffort } },
          { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer",
            content: [{ type: "output_text", text: child.turns[0].items[0].text }] } },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn" } },
        ];
        const options = { store, cwd: project.root,
          readThread: async (id) => structuredClone(id === parent.id ? parent : child),
          readTranscript: () => Buffer.from(records.map(JSON.stringify).join("\n") + "\n"),
          measureTranscript: () => ({ bytes: 4096, identityDigest: payloadHash("stable-file") }) };
        const input = { contextId: parent.id, routeId: route.routeId };
        const changeQualification = (change) => {
          const value = readTaskQualification(store.db, context);
          change(value);
          store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(value),
            `native_qualification:${context.projectId}:${context.contextKey}`);
        };
        await run({ project, store, stageInput, context, binding, routeOptions, route, parent, child,
          records, options, input, changeQualification });
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
}

test("failed qualification recovery preserves the failure and missing Hooks without authorizing another child", async () => {
  await withFailedQualification(async ({ store, context, route, input, options, stageInput, routeOptions }) => {
    const beforeQualification = readTaskQualification(store.db, context);
    const beforeOutcome = store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(route.routeId);
    const inspected = await recoverDelegation(input, options);
    assert.equal(inspected.status, "recoverable");
    assert.equal(inspected.recoveryKind, "failed_qualification");
    assert.equal(inspected.ordinaryDelegationEnabled, false);
    assert.equal(store.status(context).delegationGate.state, "occupied");
    const recovered = await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    assert.equal(recovered.status, "reconciled_failure");
    assert.equal(recovered.receipt.schemaVersion, "native-thread-delegation-recovery/3");
    assert.equal(recovered.receipt.rawAuditAdapter, "codex-0.153.0-no-work/1");
    const attempt = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(route.routeId);
    assert.equal(attempt.ticket_consumed, 1);
    assert.equal(attempt.post_observed, 1);
    assert.equal(attempt.outcome_recorded, 1);
    assert.equal(attempt.stop_observed, 0);
    assert.equal(attempt.no_child, 0);
    assert.equal(attempt.agent_id, null);
    assert.equal(attempt.transcript_bytes, null);
    assert.equal(attempt.ambiguous, 1);
    assert.ok(attempt.finalized_at);
    assert.equal(attempt.ticket_hash, null);
    assert.equal(attempt.context_package, null);
    assert.deepEqual(readTaskQualification(store.db, context), beforeQualification);
    assert.deepEqual(store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(route.routeId), beforeOutcome);
    assert.equal(store.status(context).delegationGate.state, "available");
    assert.equal(readNativeRecoveryReceipt(store.db, context, route.routeId).recoveryKind, "failed_qualification");
    const next = await routeStage(stageInput, routeOptions);
    assert.equal(next.action, "continue");
    assert.deepEqual(next.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION_FAILED"]);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
    assert.equal((await recoverDelegation({ ...input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options)).idempotent, true);
    assert.equal(store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes, 4096);
    assert.equal(store.db.prepare("SELECT eligible_learning FROM route_score_snapshots WHERE route_id=?").get(route.routeId).eligible_learning, 0);
    const serialized = JSON.stringify(recovered.receipt);
    for (const secret of [input.contextId, route.carrier.taskName, "/native/", "Stopped without"]) assert.equal(serialized.includes(secret), false);
  });
});

test("qualification recovery rejects ordinary attempts, changed failures, incomplete Hooks, and incompatible builds", async () => {
  const mutations = [
    (f) => f.changeQualification((q) => { q.state = "pending"; }),
    (f) => f.changeQualification((q) => { q.state = "passed"; }),
    (f) => f.changeQualification((q) => { q.ticketHash = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.binding.taskCwdDigest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.hooks.start = q.hooks.pre; }),
    (f) => f.changeQualification((q) => { delete q.hooks.post; }),
    (f) => f.changeQualification((q) => { q.hooks.pre.runtimeDigest = "b".repeat(64); }),
    (f) => f.changeQualification((q) => { q.proof = {}; }),
    (f) => { f.parent.turns[0].items[0].id = "different-call"; },
    (f) => { f.parent.turns[0].id = "different-turn"; },
    (f) => { f.child.cliVersion = f.records[0].payload.cli_version = "0.154.0"; },
    (f) => { f.records[0].payload.session_id = "wrong-parent"; },
    (f) => { f.records[0].payload.agent_path = "/root/unmarked"; },
    (f) => { f.records[0].payload.cwd = "/other-project"; },
    (f) => { f.records.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", name: "exec", namespace: "functions" } }); },
    (f) => { f.child.turns[0].items.unshift({ type: "subAgentActivity", kind: "interacted", id: "message", agentThreadId: f.parent.id, agentPath: "/root" }); },
    (f) => { f.parent.turns[0].items.push({ ...f.parent.turns[0].items[0], id: "second", agentThreadId: "another-child" }); },
    (f) => { f.child.turns.push({ ...f.child.turns[0], id: "resumed" }); },
    (f) => f.store.db.prepare("UPDATE routes SET reason_codes_json='[]' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE outcomes SET status='passed', failure_type=NULL WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE outcomes SET failure_type='environment' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET early_agent_id=? WHERE route_id=?").run("c".repeat(64), f.route.routeId),
    (f) => f.store.db.prepare("UPDATE delegation_attempts SET dispatch_input_digest='invalid' WHERE route_id=?").run(f.route.routeId),
  ];
  for (const mutate of mutations) await withFailedQualification(async (f) => {
    mutate(f);
    assert.equal((await recoverDelegation(f.input, f.options)).status, "unresolved");
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_recovery:%'").get().n, 0);
  });
});

test("qualification recovery binds the retained outcome and qualification through the final transaction", async () => {
  const changes = [
    (f) => f.changeQualification((q) => { q.completedAt = "2026-01-01T00:00:00.000Z"; }),
    (f) => f.store.db.prepare("UPDATE outcomes SET recorded_at='2026-01-01T00:00:00.000Z' WHERE route_id=?").run(f.route.routeId),
    (f) => f.store.db.prepare("UPDATE routes SET created_at='2026-01-01T00:00:00.000Z' WHERE route_id=?").run(f.route.routeId),
  ];
  for (const change of changes) await withFailedQualification(async (f) => {
    const first = await recoverDelegation(f.input, f.options);
    assert.equal(first.status, "recoverable");
    const read = f.options.readThread;
    let reads = 0;
    f.options.readThread = async (id) => {
      const value = await read(id);
      if (++reads === 4) change(f);
      return value;
    };
    const result = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: first.evidenceDigest }, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(result.reasonCode, "RECOVERY_STATE_CHANGED");
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
  });
});

test("qualification recovery receipts cannot claim ordinary admission or reuse the legacy audit adapter", async () => {
  await withFailedQualification(async (f) => {
    const first = await recoverDelegation(f.input, f.options);
    const result = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: first.evidenceDigest }, f.options);
    assert.equal(result.status, "reconciled_failure");
    const original = result.receipt;
    for (const change of [
      { ordinaryDelegationEnabled: true }, { qualificationState: "passed" },
      { originalDispatchConsumed: false }, { recoveryKind: "ordinary" },
      { rawAuditAdapter: "codex-0.153.0-alpha.5-no-work/1" },
      { cliVersion: "0.154.0" }, { retainedOutcomeDigest: null }, { dispatchInputDigest: null },
    ]) {
      f.store.db.prepare("UPDATE meta SET value=? WHERE key=?")
        .run(JSON.stringify({ ...original, ...change }), `native_recovery:${f.route.routeId}`);
      assert.equal(readNativeRecoveryReceipt(f.store.db, f.context, f.route.routeId), null);
    }
  });
});

test("operator requalification preserves the failed archive and consumes one exact authorization", async () => {
  const { authorizeRequalification } = await import("../scripts/lib/qualification-retry.mjs");
  await withFailedQualification(async (f) => {
    const inspected = await recoverDelegation(f.input, f.options);
    await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options);
    const original = readTaskQualification(f.store.db, f.context);
    const options = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }) };
    const preflight = await authorizeRequalification(f.input, options);
    assert.equal(preflight.status, "authorizable");
    assert.deepEqual(readTaskQualification(f.store.db, f.context), original);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).qualificationBinding, undefined);
    const approved = await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: preflight.evidenceDigest }, options);
    assert.equal(approved.status, "authorized");
    assert.equal(approved.ordinaryDelegationEnabled, false);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).ready, false);
    const routed = await routeStage(f.stageInput, f.routeOptions);
    assert.equal(routed.action, "delegate");
    assert.deepEqual(routed.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    assert.notEqual(routed.routeId, f.route.routeId);
    assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?")
      .get(`native_qualification_archive:${f.route.routeId}`).value), original);
    const next = readTaskQualification(f.store.db, f.context);
    assert.equal(next.state, "pending");
    assert.equal(next.requalification.priorRouteId, f.route.routeId);
    assert.equal((await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: preflight.evidenceDigest }, options)).status, "consumed");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 2);
    assert.equal(f.store.db.prepare("SELECT status FROM outcomes WHERE route_id=?").get(f.route.routeId).status, "failed");
  });
});

test("requalification rejects absent recovery, stale authorization, source drift and replay", async () => {
  const { authorizeRequalification } = await import("../scripts/lib/qualification-retry.mjs");
  await withFailedQualification(async (f) => {
    const options = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }) };
    assert.equal((await authorizeRequalification(f.input, options)).status, "unresolved");
    const recovery = await recoverDelegation(f.input, f.options);
    await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: recovery.evidenceDigest }, f.options);
    const inspected = await authorizeRequalification(f.input, options);
    assert.equal((await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: "0".repeat(64) }, options)).status, "unresolved");
    assert.equal((await authorizeRequalification({ ...f.input, ordinaryDelegationEnabled: true }, options)).status, "unresolved");
    await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    assert.equal((await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: "0".repeat(64) }, options)).status, "unresolved");
    for (const field of ["runtimeDigest", "configurationDigest", "taskCwdDigest"]) {
      assert.equal(qualificationReadiness(f.store.db, f.context, { ...f.binding, [field]: "0".repeat(64) }).qualificationBinding, undefined);
    }
    const key = `native_requalification:${f.route.routeId}`;
    const authorization = JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(key).value);
    f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify({ ...authorization, expiresAt: "2000-01-01T00:00:00Z" }), key);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).qualificationBinding, undefined);
    assert.equal((await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options)).status, "unresolved");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
  });
});

test("storage rejection preserves one-use requalification until a later admitted route", async () => {
  const { authorizeRequalification } = await import("../scripts/lib/qualification-retry.mjs");
  await withFailedQualification(async (f) => {
    const recovery = await recoverDelegation(f.input, f.options);
    await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: recovery.evidenceDigest }, f.options);
    const options = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }) };
    const inspected = await authorizeRequalification(f.input, options);
    await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    const authorizationKey = `native_requalification:${f.route.routeId}`;
    const authorizationBefore = f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(authorizationKey).value;
    const qualificationBefore = readTaskQualification(f.store.db, f.context);
    const blocked = await routeStage(f.stageInput, { ...f.routeOptions, routerChildByteLimit: 0 });
    assert.equal(blocked.action, "continue");
    assert.deepEqual(blocked.reasonCodes, ["ROUTER_CHILD_STORAGE_LIMIT"]);
    assert.equal(blocked.carrier, undefined);
    assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(authorizationKey).value, authorizationBefore);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), qualificationBefore);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes WHERE route_id=?").get(blocked.routeId).n, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_qualification_archive:%'").get().n, 0);
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
    const admitted = await routeStage(f.stageInput, f.routeOptions);
    assert.equal(admitted.action, "delegate");
    assert.deepEqual(admitted.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    const authorizationAfter = JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(authorizationKey).value);
    assert.equal(authorizationAfter.state, "consumed");
    assert.equal(authorizationAfter.routeId, admitted.routeId);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 2);
  });
});

test("requalification rechecks recovery and authorization at its final admission transaction", async () => {
  const { authorizeRequalification } = await import("../scripts/lib/qualification-retry.mjs");
  const { newTaskQualification, reserveTaskQualification } = await import("../scripts/lib/lifecycle-qualification.mjs");
  await withFailedQualification(async (f) => {
    const recovery = await recoverDelegation(f.input, f.options);
    await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: recovery.evidenceDigest }, f.options);
    const options = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }) };
    const inspected = await authorizeRequalification(f.input, options);
    await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, options);
    const readiness = qualificationReadiness(f.store.db, f.context, f.binding);
    const next = newTaskQualification(f.binding, "new-qualification", readiness.requalification);
    assert.ok(next.requalification);
    f.store.db.prepare("UPDATE outcomes SET recorded_at='2000-01-01T00:00:00Z' WHERE route_id=?").run(f.route.routeId);
    assert.equal(f.store.transaction(() => reserveTaskQualification(f.store.db, f.context, next, "0".repeat(64))), false);
    assert.equal(readTaskQualification(f.store.db, f.context).routeId, f.route.routeId);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_qualification_archive:%'").get().n, 0);
  });
});
