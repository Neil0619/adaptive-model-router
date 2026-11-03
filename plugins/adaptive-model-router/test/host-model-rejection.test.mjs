import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { consumeDelegationTicket, inspectRouterChildBudget } from "../scripts/lib/delegation-gate.mjs";
import { recoverDelegation, readNativeRecoveryReceipt } from "../scripts/lib/delegation-recovery.mjs";
import { qualificationReadiness, observeQualificationHook, readTaskQualification, lifecycleBinding } from "../scripts/lib/lifecycle-qualification.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { auditRecoveredModelQualification, modelQualificationAuditCurrent, recoveredModelQualificationBasis } from "../scripts/lib/host-model-rejection.mjs";
import { authorizeRequalification } from "../scripts/lib/qualification-retry.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
async function incident(run, qualification = true) {
  const project = await temporaryProject("router-model-rejection-");
  try { await withRouterEnvironment(project, async () => {
    const store = new RouterStore();
    try {
      const input = routeInput({ contextId: "model-parent" });
      const context = store.context({ cwd: project.root, contextId: input.contextId });
      const binding = lifecycleBinding([], root, root, { cliVersion: "future-host" }, project.root);
      const options = { store, cwd: project.root, catalog: CATALOG, diskProbe: () => 16n * 1024n ** 3n,
        ...(qualification ? { lifecycleHookProbe: async () => qualificationReadiness(store.db, context, binding) } : {}) };
      const route = await routeStage(input, options);
      assert.equal(route.action, "delegate");
      const args = { task_name: route.carrier.taskName, message: "native-encrypted-message", fork_turns: "none",
        model: route.target.model, reasoning_effort: route.target.effort };
      assert.equal(consumeDelegationTicket(store.db, context, { taskName: args.task_name, turnId: "turn", toolUseId: "call", toolInput: args }).allowed, true);
      if (qualification) observeQualificationHook(store.db, context, route.routeId, "pre", root);
      await callRouterTool("record_outcome", { routeId: route.routeId, contextId: input.contextId,
        status: "failed", gate: route.verificationGate, failureType: "tooling", retries: 0,
        retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
        escalations: 0, userCorrection: false }, { store, cwd: project.root });
      mkdirSync(join(project.root, "codex", "sessions"), { recursive: true });
      process.env.CODEX_HOME = realpathSync(join(project.root, "codex"));
      const parent = { id: input.contextId, cwd: project.root, parentThreadId: null, path: join(process.env.CODEX_HOME, "sessions", "parent.jsonl"),
        turns: [{ id: "turn", itemsView: "full", items: [] }] };
      const records = [
        { type: "session_meta", payload: { id: parent.id, cwd: project.root } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
        { type: "turn_context", payload: { turn_id: "turn" } },
        { type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "call", arguments: JSON.stringify(args) } },
        { type: "response_item", payload: { type: "function_call_output", call_id: "call",
          output: `Unknown model \`${args.model}\` for spawn_agent. Available models: other-model` } },
      ];
      const recoveryOptions = { store, cwd: project.root, readThread: async () => structuredClone(parent),
        readParentTranscript: () => Buffer.from(records.map(JSON.stringify).join("\n") + "\n") };
      writeFileSync(parent.path, recoveryOptions.readParentTranscript());
      await run({ store, context, route, records, args, parent, project, binding,
        input: { contextId: parent.id, routeId: route.routeId }, options: recoveryOptions });
    } finally { store.close(); }
  }); } finally { await project.cleanup(); }
}

for (const qualification of [true, false]) test(`unknown model safely releases ${qualification ? "qualification without Post" : "ordinary"} reservation`, async () => {
  await incident(async f => {
    const before = f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId);
    const outcomes = f.store.db.prepare("SELECT * FROM outcomes").all();
    const q = readTaskQualification(f.store.db, f.context);
    const budget = inspectRouterChildBudget(f.store.db, f.context);
    const inspected = await recoverDelegation(f.input, f.options);
    assert.equal(inspected.status, "recoverable");
    assert.equal(inspected.recoveryKind, "host_model_rejected");
    const result = await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options);
    assert.equal(result.gateReleased, true);
    assert.deepEqual(readNativeRecoveryReceipt(f.store.db, f.context, f.route.routeId), result.receipt);
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
    assert.equal(inspectRouterChildBudget(f.store.db, f.context).pending, budget.pending - 1);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes").all(), outcomes);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), q);
    const after = f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId);
    for (const field of ["post_observed", "stop_observed", "no_child", "agent_id", "outcome_recorded"]) assert.equal(after[field], before[field]);
    assert.equal((await recoverDelegation(f.input, f.options)).idempotent, true);
  }, qualification);
});

test("retained native refusal permits audited handover and one explicit no-tool retry, never fabricated success", async () => {
  await incident(async f => {
    const inspection = await recoverDelegation(f.input, f.options);
    await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspection.evidenceDigest }, f.options);
    const q = readTaskQualification(f.store.db, f.context);
    assert.ok(recoveredModelQualificationBasis(f.store.db, f.context, q));
    const audit = await auditRecoveredModelQualification(f.input, { ...f.options, context: f.context });
    assert.equal(audit.status, "reconciled_failure");
    assert.equal(modelQualificationAuditCurrent(f.store, audit, f.context), true);
    assert.equal(modelQualificationAuditCurrent(f.store, { ...audit }, f.context), false);
    const settings = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }),
      noopAuditOptions: { readThread: f.options.readThread } };
    const approval = await authorizeRequalification(f.input, settings);
    assert.equal(approval.status, "authorizable");
    assert.equal((await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: approval.evidenceDigest }, settings)).status, "authorized");
    assert.deepEqual(readTaskQualification(f.store.db, f.context), q);
    const changed = { ...q, completedAt: "changed" };
    f.store.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(changed), `native_qualification:${f.context.projectId}:${f.context.contextKey}`);
    assert.equal(modelQualificationAuditCurrent(f.store, audit, f.context), false);
  });
});

test("model recovery rejects ambiguous errors, tampering, replay and real child activity", async () => {
  const changes = [
    f => { f.records[4].payload.output = "connection lost"; },
    f => { f.records[4].payload.output += "\n"; },
    f => { f.records[4].payload.output = `Unknown model \`different\` for spawn_agent.\nAvailable models: other-model`; },
    f => { f.records[4].payload.output = `Unknown model \`${f.args.model}\` for spawn_agent.\nAvailable models: ${f.args.model}`; },
    f => { f.records[4].payload.call_id = "different"; },
    f => { f.records[3].payload.arguments = JSON.stringify({ ...f.args, message: "modified" }); },
    f => { f.records.push(structuredClone(f.records[3])); },
    f => { f.parent.turns[0].items.push({ type: "subAgentActivity", kind: "started", id: "call", agentPath: `/root/${f.args.task_name}` }); },
    f => { f.store.db.prepare("UPDATE delegation_attempts SET early_agent_id='child' WHERE route_id=?").run(f.route.routeId); },
    f => { f.store.db.prepare("UPDATE outcomes SET failure_type='reasoning' WHERE route_id=?").run(f.route.routeId); },
  ];
  for (const change of changes) await incident(async f => {
    change(f);
    assert.equal((await recoverDelegation(f.input, f.options)).status, "unresolved");
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
  });
});

test("inspection binds the original qualification and outcome through application", async () => {
  await incident(async f => {
    const inspected = await recoverDelegation(f.input, f.options);
    assert.equal(inspected.status, "recoverable");
    f.store.db.prepare("UPDATE outcomes SET recorded_at='changed' WHERE route_id=?").run(f.route.routeId);
    assert.equal((await recoverDelegation({ ...f.input, apply: true, expectedEvidenceDigest: inspected.evidenceDigest }, f.options)).gateReleased, false);
  });
});

test("operator recovery locates only the exact route's runtime-scoped qualification", async () => {
  await incident(async f => {
    const key = `native_qualification:${f.context.projectId}:${f.context.contextKey}`;
    const q = readTaskQualification(f.store.db, f.context);
    f.store.db.prepare("INSERT INTO runtime_generations VALUES(?,?,'published')").run(q.binding.runtimeDigest, '{}');
    f.store.db.prepare("INSERT INTO runtime_stages VALUES(?,?,?,?)").run(f.route.routeId, f.context.projectId, f.context.contextKey, q.binding.runtimeDigest);
    f.store.db.prepare("UPDATE meta SET key=? WHERE key=?").run(`${key}:runtime:${q.binding.runtimeDigest}`, key);
    assert.equal((await recoverDelegation(f.input, f.options)).status, "recoverable");
    f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify(q));
    assert.equal((await recoverDelegation(f.input, f.options)).status, "unresolved");
  });
});
