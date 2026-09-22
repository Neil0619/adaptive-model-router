import test from "node:test";
import assert from "node:assert/strict";
import { routeStage } from "../scripts/lib/router.mjs";
import { qualificationReadiness, readTaskQualification } from "../scripts/lib/lifecycle-qualification.mjs";
import { recoverHistoricalQualification } from "../scripts/lib/historical-qualification-recovery.mjs";
import { authorizeRequalification } from "../scripts/lib/qualification-retry.mjs";
import { historicalQualificationFixture as fixture } from "./support/historical-qualification.mjs";

const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
const call = (id, name, args) => ({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", call_id: id, name, arguments: JSON.stringify(args) } });
const output = (id, value) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: value } });

for (const kind of ["completed", "interrupted"]) test(`historical ${kind} qualification recovery preserves original evidence and grants no business success`, async () => {
  await fixture(kind, async (f) => {
    const before = { q: readTaskQualification(f.store.db, f.context), outcome: f.store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(f.route.routeId), attempt: f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId) };
    const preview = await recoverHistoricalQualification(f.input, f.options);
    assert.equal(preview.status, "recoverable");
    assert.equal(preview.ordinaryDelegationEnabled, false);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId), before.attempt);
    const applied = await recoverHistoricalQualification({ ...f.input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.options);
    assert.equal(applied.status, "reconciled_failure");
    assert.equal(applied.ordinaryDelegationEnabled, false);
    assert.deepEqual(readTaskQualification(f.store.db, f.context), before.q);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(f.route.routeId), before.outcome);
    const after = f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId);
    for (const key of ["agent_id", "no_child", "stop_observed", "outcome_recorded", "ticket_consumed", "post_observed", "transcript_bytes"]) assert.equal(after[key], before.attempt[key]);
    assert.ok(after.finalized_at);
    assert.equal((await recoverHistoricalQualification(f.input, f.options)).idempotent, true);
    assert.equal(JSON.stringify(applied).includes(f.route.carrier.taskName), false);
    assert.equal(JSON.stringify(applied).includes(f.project.root), false);
  });
});

test("historical recovery rejects hidden execution, incomplete turns, wrong identities and changed state", async () => {
  const mutations = [
    (f) => f.childRecords.splice(-1, 0, { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "hidden work" } }),
    (f) => f.childRecords.splice(-1, 0, event("item_completed", { thread_id: f.child.id, turn_id: "child-last", item: { type: "CommandExecution", id: "hidden" } })),
    (f) => { f.child.turns.at(-1).status = "inProgress"; },
    (f) => { f.child.parentThreadId = "other"; },
    (f) => { f.childRecords[0].payload.parent_thread_id = "other"; },
    (f) => { f.childRecords.find((r) => r.type === "turn_context").payload.model = "other"; },
    (f) => f.childRecords.push({ type: "response_item", payload: { type: "agent_message", author: "/root", recipient: f.child.source.subAgent.thread_spawn.agent_path, content: "still pending" } }),
    (f) => { f.parent.turns[1].items.push({ ...f.parent.turns[1].items[0], id: "another-message" }); },
    (f) => f.store.db.prepare("UPDATE outcomes SET status='passed',failure_type=NULL WHERE route_id=?").run(f.route.routeId),
  ];
  for (const mutate of mutations) await fixture("completed", async (f) => {
    mutate(f); f.write();
    assert.equal((await recoverHistoricalQualification(f.input, f.options)).status, "unresolved");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'historical_qualification_recovery:%'").get().n, 0);
  });
});

test("recovery rechecks native and ledger state after preview and before its only write", async () => {
  for (const kind of ["completed", "interrupted"]) await fixture(kind, async (f) => {
    const preview = await recoverHistoricalQualification(f.input, f.options);
    const before = f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId);
    const read = f.options.readThread; let reads = 0;
    f.options.readThread = async (id) => {
      const value = await read(id);
      if (++reads === 4) f.store.db.prepare("UPDATE delegation_attempts SET updated_at='changed-after-preview' WHERE route_id=?").run(f.route.routeId);
      return value;
    };
    const result = await recoverHistoricalQualification({ ...f.input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.options);
    assert.equal(result.status, "unresolved");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'historical_qualification_recovery:%'").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT finalized_at FROM delegation_attempts WHERE route_id=?").get(f.route.routeId).finalized_at, before.finalized_at);
  });
});

for (const kind of ["completed", "interrupted"]) test(`recovered ${kind} history permits only one freshly audited qualification retry`, async () => {
  await fixture(kind, async (f) => {
    const options = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }),
      noopAuditOptions: { readThread: f.options.readThread } };
    assert.equal((await authorizeRequalification(f.input, options)).status, "unresolved");
    const preview = await recoverHistoricalQualification(f.input, f.options);
    assert.equal((await recoverHistoricalQualification({ ...f.input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.options)).status, "reconciled_failure");
    const original = readTaskQualification(f.store.db, f.context);
    const outcome = f.store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(f.route.routeId);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).ready, false);
    assert.equal(qualificationReadiness(f.store.db, f.context, f.binding).qualificationBinding, undefined);
    const retry = await authorizeRequalification(f.input, options);
    assert.equal(retry.status, "authorizable");
    assert.equal((await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: "0".repeat(64) }, options)).status, "unresolved");
    const granted = await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: retry.evidenceDigest }, options);
    assert.equal(granted.status, "authorized");
    assert.equal(granted.ordinaryDelegationEnabled, false);
    const routed = await routeStage(f.stageInput, f.routeOptions);
    assert.equal(routed.action, "delegate");
    assert.deepEqual(routed.reasonCodes, ["HOST_LIFECYCLE_QUALIFICATION"]);
    assert.notEqual(routed.routeId, f.route.routeId);
    assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?")
      .get(`native_qualification_archive:${f.route.routeId}`).value), original);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(f.route.routeId), outcome);
    assert.equal(readTaskQualification(f.store.db, f.context).state, "pending");
    assert.equal((await authorizeRequalification(f.input, options)).status, "consumed");
    assert.equal((await routeStage({ ...f.stageInput, stageId: "cannot-overlap-retry" }, f.routeOptions)).action, "busy");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n, 2);
  });
});

test("a recovery receipt cannot authorize changed native history or a changed retained result", async () => {
  for (const mutation of ["native", "ledger"]) await fixture("completed", async (f) => {
    const preview = await recoverHistoricalQualification(f.input, f.options);
    await recoverHistoricalQualification({ ...f.input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.options);
    if (mutation === "native") { f.childRecords.splice(-1, 0, event("unrecognized_native_event")); f.write(); }
    else f.store.db.prepare("UPDATE outcomes SET recorded_at='changed' WHERE route_id=?").run(f.route.routeId);
    const options = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }),
      noopAuditOptions: { readThread: f.options.readThread } };
    assert.equal((await authorizeRequalification(f.input, options)).status, "unresolved");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_requalification:%'").get().n, 0);
  });
});

test("recovery requires exact marker-only raw and projected child records and all native parent deliveries", async () => {
  const attacks = [
    (f) => f.child.turns[1].items.unshift({ type: "agentMessage", id: "business", phase: "commentary", text: "Business work" }),
    (f) => {
      f.child.turns[1].items.unshift({ type: "agentMessage", id: "business", phase: "commentary", text: "Business work" });
      f.childRecords.splice(-2, 0, { type: "response_item", payload: { type: "message", role: "assistant", id: "business", phase: "commentary", content: [{ type: "output_text", text: "Business work" }] } });
    },
    (f) => f.childRecords.splice(4, 0, { type: "response_item", payload: { type: "reasoning", id: "hidden-reasoning", summary: [] } }),
    (f) => { f.childRecords.at(-1).payload.last_agent_message = "Contradictory final"; },
    (f) => {
      const at = f.childRecords.findLastIndex((r) => r.payload?.type === "agent_message");
      const [delivery] = f.childRecords.splice(at, 1); f.childRecords.splice(-1, 0, delivery);
    },
    (f) => {
      f.child.turns[1].items.unshift({ type: "reasoning", id: "late-reasoning", summary: [], content: [] });
      f.childRecords.splice(-1, 0, { type: "response_item", payload: { type: "reasoning", id: "late-reasoning", summary: [] } });
    },
    ...["followup_task", "interrupt_agent"].map((name) => (f) => {
      const extra = call("late-call", name, { target: f.route.carrier.taskName, ...(name === "followup_task" ? { message: "Late work" } : {}) });
      delete extra.payload.namespace;
      f.rootRecords.push(extra, output("late-call", ""));
    }),
  ];
  for (const attack of attacks) await fixture("completed", async (f) => {
    attack(f); f.write();
    assert.equal((await recoverHistoricalQualification(f.input, f.options)).status, "unresolved");
  });
});

for (const kind of ["completed", "interrupted"]) test(`retry authorization rechecks ${kind} native sources at its final write boundary`, async () => {
  await fixture(kind, async (f) => {
    const recovery = await recoverHistoricalQualification(f.input, f.options);
    await recoverHistoricalQualification({ ...f.input, apply: true, expectedEvidenceDigest: recovery.evidenceDigest }, f.options);
    const options = { store: f.store, cwd: f.project.root, inspectBinding: async () => ({ binding: f.binding }),
      noopAuditOptions: { readThread: f.options.readThread } };
    const preview = await authorizeRequalification(f.input, options);
    assert.equal(preview.status, "authorizable");
    let inspected = 0;
    options.inspectBinding = async () => {
      if (++inspected === 2) { f.childRecords.push({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "Late work" } }); f.write(); }
      return { binding: f.binding };
    };
    assert.equal((await authorizeRequalification({ ...f.input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, options)).status, "unresolved");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'native_requalification:%'").get().n, 0);
  });
});

test("interrupted history with affirmative model token usage is not an unobserved no-work execution", async () => {
  await fixture("interrupted", async (f) => {
    f.childRecords.splice(-1, 0, { type: "token_usage_record", payload: { thread_id: f.child.id,
      turn_id: "child-first", session_id: f.parent.id, response_id: "executed", usage: { output_tokens: 17 } } });
    f.write();
    assert.equal((await recoverHistoricalQualification(f.input, f.options)).status, "unresolved");
  });
});

test("completed recovery charges native transcript growth once while preserving its original attempt", async () => {
  await fixture("completed", async (f) => {
    const summary = "x".repeat(20_000);
    f.child.turns[1].items.unshift({ type: "reasoning", id: "reasoning-long", summary: [summary], content: [] });
    f.childRecords.splice(-2, 0,
      event("item_completed", { thread_id: f.child.id, turn_id: "child-last", item: { type: "Reasoning", id: "reasoning-long", summary_text: [summary], raw_content: [] } }),
      { type: "response_item", payload: { type: "reasoning", id: "reasoning-long", summary: [{ type: "summary_text", text: summary }] } });
    f.childRecords.find((r) => r.payload?.role === "assistant").payload.content[0].type = "text";
    f.childRecords.splice(-2, 0, event("item_completed", { thread_id: f.child.id, turn_id: "child-last",
      item: { type: "AgentMessage", id: "final", phase: "final_answer", content: [{ type: "Text", text: f.q.marker }] } }));
    f.write();
    const usage = () => f.store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage WHERE project_id=? AND context_key=?")
      .get(f.context.projectId, f.context.contextKey).total_transcript_bytes;
    const before = usage(), preview = await recoverHistoricalQualification(f.input, f.options);
    assert.equal(preview.status, "recoverable");
    assert.equal((await recoverHistoricalQualification({ ...f.input, apply: true, expectedEvidenceDigest: preview.evidenceDigest }, f.options)).status, "reconciled_failure");
    const receipt = JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key=?").get(`historical_qualification_recovery:${f.route.routeId}`).value);
    assert.equal(usage(), receipt.nativeEvidence.childSource.transcriptBytes);
    assert.ok(usage() > before);
    assert.equal(f.store.db.prepare("SELECT transcript_bytes FROM delegation_attempts WHERE route_id=?").get(f.route.routeId).transcript_bytes, 4096);
    await recoverHistoricalQualification(f.input, f.options);
    assert.equal(usage(), receipt.nativeEvidence.childSource.transcriptBytes);
  });
});
