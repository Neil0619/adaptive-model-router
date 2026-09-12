import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { callRouterTool } from "../scripts/lib/service.mjs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { routeStage } from "../scripts/lib/router.mjs";
import { recordOutcome } from "../scripts/lib/learning.mjs";
import { openPrivateState, sealPrivateState } from "../scripts/lib/private-state.mjs";
import { capacityAdmissionDecision, capacityStateKey } from "../scripts/lib/host-capacity-recovery.mjs";
import { DATABASE_VERSION } from "../scripts/lib/constants.mjs";
import { runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { payloadHash } from "../scripts/lib/io.mjs";
import { rememberMessageHost } from "../scripts/lib/stage-reconciliation.mjs";
import { inspectReclamationCandidate, reclaimGlobalReservations } from "../scripts/lib/global-reservation-reclamation.mjs";
import { reservationInventory, reservationSnapshot, saveReservationRelease } from "../scripts/lib/reservation-ledger.mjs";
import { CATALOG, routeInput, temporaryProject, withRouterEnvironment, completeNoChildRoute } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const disposition = (intent = "collect") => ({ intent, basis: "Original stage is closed; collect the retained requests without executing business work.", requirements: [], pendingOperations: [] });
const reviewed = (closure, intent = "collect") => ({ ...disposition(intent), resultReview: "Checked the returned requirements and operation receipts against each native input.",
  requirements: closure.inputReferences.slice(1).map(({ id }) => ({ messageId: id, source: `native input ${id}`,
    disposition: "transferred", receipt: "Retained in the root's current plan for execution", owner: "/root" })) });

function messageHostFixture(f, invocation, cliVersion = "0.153.4", replace = true, hostChanges = {}) {
  const key = `message_host:${payloadHash(["/root", invocation.tool_use_id])}`;
  if (replace) f.store.db.prepare("DELETE FROM delegation_stage_journal WHERE route_id=? AND kind IN (?,?)")
    .run(f.route.routeId, key, `${key}:conflict`);
  if (cliVersion === null) return;
  const child = f.store.db.prepare("SELECT * FROM delegation_children WHERE route_id=?").get(f.route.routeId);
  rememberMessageHost(f.store.db, child, invocation, "/root", { platform: "darwin", arch: "arm64", cliVersion,
    executableDigest: payloadHash(`fixture executable ${cliVersion}`), executablePathDigest: payloadHash("fixture executable path"), ...hostChanges });
}

test("native final message identity binds a different passthrough ID to its actual completed host turn", async () => {
  await withChild(async (f) => {
    f.send("native-turn-followup");
    f.records.push({ type: "event_msg", payload: { type: "task_started", turn_id: "host-turn" } });
    f.input(2, "host-turn");
    const native = { type: "event_msg", payload: { type: "item_completed", thread_id: f.child.agent_id, turn_id: "host-turn",
      item: { type: "AgentMessage", id: "unique-final", phase: "final_answer", content: [{ type: "Text", text: "REVIEWED" }] } } };
    const final = { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", id: "unique-final",
      content: [{ type: "output_text", text: "REVIEWED" }], internal_chat_message_metadata_passthrough: { turn_id: "inference-id" } } };
    const complete = { type: "event_msg", payload: { type: "task_complete", turn_id: "host-turn", last_agent_message: "REVIEWED" } };
    const prefix = structuredClone(f.records);
    const install = async (tail) => { f.records.splice(0, f.records.length, ...structuredClone(prefix), ...tail); await f.save(); };
    await install([native, final, complete]);
    hook(f.project, "subagent-stop", { ...f.child, turn_id: "host-turn", last_assistant_message: "REVIEWED" });
    assert.equal(f.store.status(f.context).stageClosure.state, "ready");
    for (const mutate of [
      (n) => { n.payload.thread_id = "another-child"; },
      (n) => { n.payload.turn_id = "old-turn"; },
      (n) => { n.payload.item.id = "other-final"; },
      (n) => { n.payload.item.content[0].text = "DIFFERENT"; },
      (n) => { n.payload.item.phase = "commentary"; },
      (_n, _f, c) => { c.payload.last_agent_message = "DIFFERENT"; },
    ]) {
      const tail = structuredClone([native, final, complete]); mutate(...tail); await install(tail);
      assert.equal(f.store.status(f.context).stageClosure.state, "pending", mutate.toString());
    }
    const foreign = structuredClone(native); foreign.payload.thread_id = "wrong-child";
    const sameId = structuredClone(final); sameId.payload.internal_chat_message_metadata_passthrough.turn_id = "host-turn";
    await install([foreign, sameId, complete]);
    assert.equal(f.store.status(f.context).stageClosure.state, "pending", "equal passthrough cannot bless a foreign native final");
    const contradiction = structuredClone(complete); contradiction.payload.last_agent_message = "DIFFERENT";
    await install([sameId, contradiction]);
    assert.equal(f.store.status(f.context).stageClosure.state, "pending", "legacy fallback still rejects contradicting completion");
    await install([native, final, complete, { type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } }]);
    assert.equal(f.store.status(f.context).stageClosure.state, "pending");
    const conflicting = structuredClone(native); conflicting.payload.turn_id = "another-turn";
    await install([native, conflicting, final, complete]);
    assert.equal(f.store.status(f.context).stageClosure.state, "pending");
    await install([final, native, complete]);
    const closure = f.store.status(f.context).stageClosure;
    assert.equal(closure.state, "ready");
    assert.equal(closure.finalTurnId, "host-turn");
    assert.equal(recordOutcome({ ...f.outcome(), closureToken: closure.token }, { store: f.store, cwd: f.project.root }).recorded, true);
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
  });
});

async function makeReclaimable(f) {
  const stamp = "2026-09-01T01:00:00.000Z";
  f.parentRecords.push({ timestamp: stamp, type: "event_msg", payload: { type: "task_started", turn_id: "root-turn" } },
    { timestamp: stamp, type: "event_msg", payload: { type: "task_complete", turn_id: "root-turn" } });
  f.records.slice(1).forEach((r) => { r.timestamp = stamp; });
  await f.save(); f.saveParent();
}

test("full global admission defers an idle stage across projects, retaining its gate and original result", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f);
    const before = reservationSnapshot(f.store.db, f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId));
    const otherRoot = join(f.project.root, "other-project"); await mkdir(otherRoot);
    for (let i = 0; i < 9; i++) assert.equal((await routeStage(routeInput({ contextId: `other-${i}` }),
      { store: f.store, cwd: otherRoot, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n })).action, "delegate");
    assert.equal(reservationInventory(f.store.db).pending.length, 10);
    assert.equal(f.store.status(f.context).globalReservations.released, 0, "read-only status never reclaims");
    const admitted = await routeStage(routeInput({ contextId: "eleventh" }),
      { store: f.store, cwd: otherRoot, catalog: CATALOG, diskProbe: () => 20n * 1024n ** 3n });
    assert.equal(admitted.action, "delegate");
    assert.equal(reservationInventory(f.store.db).pending.length, 10);
    assert.equal(reservationInventory(f.store.db).released.length, 1);
    assert.deepEqual(reservationSnapshot(f.store.db, f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId)), before);
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
    const saved = await f.manage("read_disposition");
    assert.equal(saved.release.kind, "verified_deferral");
    assert.equal(saved.release.retained.final.content[0].text, "INITIAL_RESULT", "keep the actual result, not just its path");
    assert.equal(saved.release.retained.inputs.length, 1);
    assert.ok(saved.release.retained.originalStage.includes(routeInput().goal));
    assert.equal(saved.release.snapshot.child.locator, before.child.locator);
    assert.equal(f.send("new-business").pre.hookSpecificOutput.permissionDecision, "deny");
    const denied = hook(f.project, "pre-tool-use", { ...f.child, tool_name: "exec_command", tool_use_id: "new-write", tool_input: { cmd: "touch should-not-run" } });
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    await f.manage("begin_maintenance", { disposition: disposition("deferred") });
    assert.equal((await f.manage("read_disposition")).release.retained.final.content[0].text, "INITIAL_RESULT");
    const interruption = f.send("interrupt-deferred", "interrupt_agent", false);
    assert.notEqual(interruption.pre?.hookSpecificOutput?.permissionDecision, "deny");
    hook(f.project, "post-tool-use", { ...interruption.invocation, tool_response: { previous_status: "completed" } });
    assert.equal(reservationInventory(f.store.db).pending.length, 10, "interrupt is not execution");
    assert.equal(f.send("collection-without-capacity").pre.hookSpecificOutput.permissionDecision, "deny");
    completeNoChildRoute(admitted, { store: f.store, cwd: otherRoot, contextId: "eleventh", status: "failed", failureType: "tooling" });
    f.send("collect-resumed"); f.input(2, "resumed"); await f.finish("resumed", "COLLECTED_ORIGINAL_REQUIREMENT");
    assert.equal(reservationInventory(f.store.db).released.some((row) => row.route_id === f.route.routeId), false, "new activity reacquires accounting");
    const closure = f.store.status(f.context).stageClosure;
    await f.manage("verify_maintenance", { closureToken: closure.token, disposition: reviewed(closure, "deferred") });
    assert.equal(recordOutcome({ ...f.outcome(), status: "failed", failureType: "environment", closureToken: closure.token },
      { store: f.store, cwd: f.project.root }).recorded, true);
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
    assert.equal(f.store.status(f.context).pendingStageWork.length, 1);
  });
});

test("reclamation rejects activity, unknown operations, pending messages and incomplete evidence", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f);
    const attempt = () => f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId);
    const initial = inspectReclamationCandidate(f.store.db, attempt());
    assert.equal(initial.eligible, true, JSON.stringify(initial));
    f.parentRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: "still-working" } }); f.saveParent();
    assert.equal(inspectReclamationCandidate(f.store.db, attempt()).reason, "root_active_or_unknown");
    f.parentRecords.pop(); f.saveParent();
    f.records.push({ type: "response_item", payload: { type: "function_call", call_id: "unfinished-command", name: "exec_command", arguments: "{}" } }); await f.save();
    assert.equal(inspectReclamationCandidate(f.store.db, attempt()).reason, "operations_pending");
    f.records.pop(); await f.save();
    f.send("pending-native-send", "followup_task", false);
    assert.equal(inspectReclamationCandidate(f.store.db, attempt()).eligible, undefined);
    const other = f.store.context({ cwd: f.project.root, contextId: "requester" });
    const result = f.store.transaction(() => reclaimGlobalReservations(f.store.db, other, { maximumPending: 1 }));
    assert.equal(result.released, 0);
    assert.equal(reservationInventory(f.store.db).pending.length, 1);
  });
});

function releaseCandidate(f) {
  const attempt = f.store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id=?").get(f.route.routeId);
  const view = inspectReclamationCandidate(f.store.db, attempt);
  assert.equal(view.eligible, true, JSON.stringify(view));
  const options = { kind: view.kind, basis: "Explicit fixture deferral preserving original responsibility", requesterContextId: "fixture-operator",
    sources: view.paths, expectedSources: view.fingerprints, retained: view.retained, lastActivity: view.lastActivity };
  return { attempt, view, options };
}
async function fillReservations(f, count) {
  const routes = [];
  for (let i = 0; i < count; i++) {
    const contextId = `filler-${i}`;
    const route = await routeStage(routeInput({ contextId }), { store: f.store, cwd: f.project.root, catalog: CATALOG,
      diskProbe: () => 20n * 1024n ** 3n });
    assert.equal(route.action, "delegate"); routes.push({ route, contextId });
  }
  return routes;
}

test("release rejects changed native evidence and is idempotent without changing original outcome", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f);
    const before = releaseCandidate(f);
    appendFileSync(f.child.transcript_path, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "new-work" } }) + "\n");
    assert.throws(() => f.store.transaction(() => saveReservationRelease(f.store.db, before.attempt, before.options)), /changed after verification/);
    assert.equal(reservationInventory(f.store.db).released.length, 0);
    await f.save();
    const fresh = releaseCandidate(f);
    assert.equal(f.store.transaction(() => saveReservationRelease(f.store.db, fresh.attempt, fresh.options)).idempotent, false);
    assert.equal(f.store.transaction(() => saveReservationRelease(f.store.db, fresh.attempt, fresh.options)).idempotent, true);
    const expired = reservationInventory(f.store.db, { deadline: 0 });
    assert.equal(expired.pending.length, 1);
    assert.equal(expired.verificationDeferred, 1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes WHERE route_id=?").get(f.route.routeId).n, 0);
    assert.deepEqual(reservationSnapshot(f.store.db, fresh.attempt), reservationSnapshot(f.store.db, before.attempt));
  });
});

test("retained evidence preserves all final results across followups and metadata changes do not resume execution", async () => {
  await withChild(async (f) => {
    f.send("supplemental"); f.input(2, "supplemental"); await f.finish("supplemental", "SUPPLEMENTAL_RESULT_B");
    await makeReclaimable(f);
    const { attempt, options } = releaseCandidate(f);
    f.store.transaction(() => saveReservationRelease(f.store.db, attempt, options));
    // Rewriting identical bytes changes file metadata, but neither input nor result.
    await f.save();
    assert.equal(reservationInventory(f.store.db).released.length, 1);
    const saved = await f.manage("read_disposition");
    assert.deepEqual(saved.release.retained.finals.map((p) => p.content[0].text), ["INITIAL_RESULT", "SUPPLEMENTAL_RESULT_B"]);
    await fillReservations(f, 10);
    appendFileSync(f.child.transcript_path, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "untracked-execution" } }) + "\n");
    assert.equal(reservationInventory(f.store.db).released.length, 0, "real new evidence charges conservatively");
    await f.manage("begin_maintenance", { disposition: disposition("deferred") });
    assert.equal(f.send("stale-resume").pre.hookSpecificOutput.permissionDecision, "deny", "stale release is not an admission receipt");
  });
});

test("repeated maintenance preserves original age, requirements and capacity after attempt history trimming", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f);
    const first = releaseCandidate(f);
    f.store.transaction(() => saveReservationRelease(f.store.db, first.attempt, first.options));
    async function collect(number, stamp) {
      f.root.turn_id = `maintenance-root-${number}`;
      f.parentRecords.push({ timestamp: stamp, type: "event_msg", payload: { type: "task_started", turn_id: f.root.turn_id } },
        { timestamp: stamp, type: "turn_context", payload: { turn_id: f.root.turn_id } }); f.saveParent();
      await f.manage("begin_maintenance", { disposition: { ...disposition("deferred"), basis: `Preserve original work, bounded collection ${number}` } });
      const start = f.records.length;
      f.send(`maintenance-${number}`);
      f.records.push({ timestamp: stamp, type: "event_msg", payload: { type: "task_started", turn_id: `maintenance-child-${number}` } });
      f.input(number + 1, `maintenance-child-${number}`);
      await f.finish(`maintenance-child-${number}`, `COLLECTION_${number}`);
      f.records.slice(start).forEach((row) => { row.timestamp = stamp; }); await f.save();
      f.parentRecords.push({ timestamp: stamp, type: "event_msg", payload: { type: "task_complete", turn_id: f.root.turn_id } }); f.saveParent();
      return f.store.status(f.context).stageClosure;
    }
    const one = await collect(1, "2026-09-05T01:00:00Z");
    await f.manage("verify_maintenance", { closureToken: one.token, disposition: reviewed(one, "deferred") });
    recordOutcome({ ...f.outcome(), status: "failed", failureType: "environment", closureToken: one.token }, { store: f.store, cwd: f.project.root });
    const original = (await f.manage("read_disposition")).release.retained.originalStage;
    assert.ok(original.includes(routeInput().goal));
    const two = await collect(2, "2026-09-11T01:00:00Z");
    const repeated = releaseCandidate(f);
    assert.equal(repeated.view.lastActivity, first.view.lastActivity, "neither maintenance cycle refreshes business age");
    f.store.transaction(() => saveReservationRelease(f.store.db, repeated.attempt, repeated.options));
    assert.equal((await f.manage("read_disposition")).release.retained.originalStage, original);
    f.store.db.prepare("DELETE FROM delegation_attempts WHERE route_id=?").run(f.route.routeId);
    assert.equal(reservationInventory(f.store.db).released.length, 1, "attempt pruning preserves maintenance-only accounting");
    f.store.db.prepare("UPDATE delegation_children SET state='unknown' WHERE route_id=?").run(f.route.routeId);
    assert.equal(reservationInventory(f.store.db).pending.length, 1, "uncertain held maintenance never loses its reservation");
    f.store.db.prepare("UPDATE delegation_children SET state='settled' WHERE route_id=?").run(f.route.routeId);
    await fillReservations(f, 10);
    assert.equal(f.send("pruned-maintenance-full").pre.hookSpecificOutput.permissionDecision, "deny");
    await f.manage("verify_maintenance", { closureToken: two.token, disposition: reviewed(two, "deferred") });
    assert.equal(reservationInventory(f.store.db).pending.length, 10);
  });
});

test("archive and restore preserve released accounting, and original inputs/results survive source loss", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f);
    const previousCodex = process.env.CODEX_HOME;
    const codexRoot = join(f.project.root, "codex-home");
    process.env.CODEX_HOME = codexRoot;
    try {
      const basename = "rollout-2026-09-01T01-00-00-closure-child.jsonl";
      const live = join(codexRoot, "sessions/2026/09/01", basename), archive = join(codexRoot, "archived_sessions", basename);
      await mkdir(dirname(live), { recursive: true }); await mkdir(dirname(archive), { recursive: true });
      await rename(f.child.transcript_path, live);
      const row = f.store.db.prepare("SELECT locator FROM delegation_children WHERE route_id=?").get(f.route.routeId);
      const locator = JSON.parse(openPrivateState(f.store.db, row.locator)); locator.transcriptPath = live;
      f.store.db.prepare("UPDATE delegation_children SET locator=? WHERE route_id=?").run(sealPrivateState(f.store.db, JSON.stringify(locator)), f.route.routeId);
      const { attempt, options } = releaseCandidate(f);
      f.store.transaction(() => saveReservationRelease(f.store.db, attempt, options));
      await rename(live, archive);
      assert.equal(reservationInventory(f.store.db).released.length, 1);
      assert.equal(inspectReclamationCandidate(f.store.db, attempt).eligible, true);
      await rename(archive, live);
      assert.equal(reservationInventory(f.store.db).released.length, 1);
      await rename(live, join(codexRoot, "unavailable.jsonl"));
      const retained = (await f.manage("read_disposition")).release.retained;
      assert.equal(retained.final.content[0].text, "INITIAL_RESULT");
      assert.equal(retained.inputs[0].content[0].text, "requirement 1");
      assert.equal(reservationInventory(f.store.db).released.length, 0, "unknown source state remains conservative");
    } finally {
      if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
    }
  });
});

test("explicit release CLI validates reviewed state and repeated apply is idempotent", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f);
    const request = { contextId: "fixture-operator", routeIds: [f.route.routeId], basis: "User explicitly named this historical fixture" };
    const call = (input) => spawnSync(process.execPath, [join(pluginRoot, "scripts/release-reservations.mjs")],
      { input: JSON.stringify(input), encoding: "utf8", env: process.env, cwd: f.project.root });
    const review = call(request); assert.equal(review.status, 0, review.stderr);
    const reviewed = JSON.parse(review.stdout);
    const apply = { ...request, apply: true, expectedDigests: { [f.route.routeId]: reviewed.routes[0].evidenceDigest } };
    assert.notEqual(call({ ...apply, expectedDigests: {} }).status, 0);
    const first = call(apply); assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).after, 0);
    const repeat = call(apply); assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).releases[0].idempotent, true);
  });
});

test("finalized historical maintenance obtains a fresh slot and releases it after verified collection", async () => {
  await withChild(async (f) => {
    const closure = f.store.status(f.context).stageClosure;
    recordOutcome({ ...f.outcome(), closureToken: closure.token }, { store: f.store, cwd: f.project.root });
    const originalOutcome = f.store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(f.route.routeId);
    const fillers = await fillReservations(f, 10);
    await f.manage("begin_maintenance", { disposition: disposition() });
    assert.equal(f.send("historical-full").pre.hookSpecificOutput.permissionDecision, "deny");
    completeNoChildRoute(fillers[0].route, { store: f.store, cwd: f.project.root, contextId: fillers[0].contextId, status: "failed", failureType: "tooling" });
    assert.notEqual(f.send("historical-collection").pre?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(reservationInventory(f.store.db).pending.length, 10);
    f.input(2, "historical-maintenance"); await f.finish("historical-maintenance", "RETAINED_OLD_RESULT");
    const done = f.store.status(f.context).stageClosure;
    await f.manage("verify_maintenance", { closureToken: done.token, disposition: reviewed(done) });
    assert.equal(reservationInventory(f.store.db).pending.length, 9);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(f.route.routeId), originalOutcome);
  });
});

test("full admission selects oldest real activity, terminal first, and stops at the exact deficit", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f);
    await setupChild(f.project, f.store, async (g) => {
      await makeReclaimable(g);
      g.records.slice(1).forEach((r) => { r.timestamp = "2026-09-05T01:00:00Z"; }); await g.save();
      f.parentRecords.push({ timestamp: "2026-09-11T01:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "status-only" } },
        { timestamp: "2026-09-11T01:00:00Z", type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "adaptive_model_router", tool: "get_route_status" } } },
        { timestamp: "2026-09-11T01:00:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "status-only" } }); f.saveParent();
      const requester = f.store.context({ cwd: f.project.root, contextId: "new-owner" });
      const result = f.store.transaction(() => reclaimGlobalReservations(f.store.db, requester, { maximumPending: 2 }));
      assert.equal(result.released, 1);
      assert.deepEqual(reservationInventory(f.store.db).released.map((a) => a.route_id), [f.route.routeId]);
      // A terminal responsibility has priority over an older unfinished stage.
      f.store.db.prepare("DELETE FROM meta WHERE key=?").run(`global_reservation_release:${f.route.routeId}`);
      const closed = g.store.status(g.context).stageClosure;
      recordOutcome({ ...g.outcome(), closureToken: closed.token }, { store: g.store, cwd: g.project.root });
      // Model a legacy terminal outcome whose accounting finalization was missed.
      f.store.db.prepare("UPDATE delegation_attempts SET finalized_at=NULL WHERE route_id=?").run(g.route.routeId);
      f.store.db.prepare("UPDATE delegation_children SET state='open' WHERE route_id=?").run(g.route.routeId);
      const second = f.store.transaction(() => reclaimGlobalReservations(f.store.db, requester, { maximumPending: 2 }));
      assert.equal(second.released, 1);
      assert.deepEqual(reservationInventory(f.store.db).released.map((a) => a.route_id), [g.route.routeId]);
    }, "second-root");
  });
});

test("concurrent real admissions reclaim one available candidate without overissuing", async () => {
  await withChild(async (f) => {
    await makeReclaimable(f); await fillReservations(f, 9);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(pluginRoot, "test/concurrency-worker.mjs"), "route-only", f.project.root, `concurrent-${i}`],
        { env: { ...process.env, ADAPTIVE_ROUTER_HOME: f.project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
      child.once("error", reject); child.once("close", (code) => {
        if (code) reject(new Error(errors)); else { try { resolve(JSON.parse(output)); } catch (e) { reject(e); } }
      });
    })));
    assert.equal(results.filter((r) => r.action === "delegate").length, 1);
    assert.equal(reservationInventory(f.store.db).pending.length, 10);
    assert.equal(reservationInventory(f.store.db).released.length, 1);
  });
});

async function exceptionalOperations(f, count = 1) {
  f.send("exception-work"); f.input(2, "exception-turn");
  f.records.push({ type: "turn_context", payload: { turn_id: "exception-turn" } });
  for (let i = 0; i < count; i++) f.records.push(
    { type: "response_item", payload: { type: "function_call", namespace: "functions", name: "exec_command",
      call_id: `legacy-${i}`, arguments: JSON.stringify({ cmd: `owned-operation-${i}` }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: `legacy-${i}`,
      output: `Chunk ID: start-${i}\nProcess running with session ID ${700 + i}\nOutput:\nPARTIAL` } });
  await f.finish("exception-turn", "RETURNED_WITH_UNRESOLVED_OPERATIONS");
  f.parentRecords.push(
    { type: "response_item", payload: { type: "function_call", namespace: "functions", name: "exec_command",
      call_id: "verify-owned-operation", arguments: JSON.stringify({ cmd: "verify-owned-operation-and-artifact" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "verify-owned-operation",
      output: "Chunk ID: checked\nProcess exited with code 0\nOutput:\nverified exact owned operation stopped and partial result retained" } });
  f.saveParent();
  return f.manage("read_operations");
}

const operationReview = (view, index = 0) => ({ snapshotDigest: view.snapshotDigest, items: [{
  operationId: view.operations[index].operationId, conclusion: "stopped",
  original: view.operations[index].origin, evidence: [view.rootEvidence.at(-1)],
  basis: "Matched the owned handle and original call; the root checked its actual process and artifact.",
  resultReview: "Execution stopped. The partial artifact was verified and the remaining business work stays with the root.",
}] });

test("native memory citation separation matches Stop while preserving the complete final result", async () => {
  await withChild(async (f) => {
    f.send("citation-review"); f.input(2, "citation-turn");
    const body = "Reviewed the change. Remaining work is retained.\n\n";
    const citation = { entries: [{ path: "MEMORY.md", lineStart: 434, lineEnd: 434,
      note: "historical residency scope and retained responsibility boundary" }],
    rolloutIds: ["01a079b0-eba4-7792-bc1c-288c3f0af2f9"] };
    const trailer = (c) => `<oai-mem-citation>\n<citation_entries>\n${c.entries.map((e) => `${e.path}:${e.lineStart}-${e.lineEnd}|note=[${e.note}]`).join("\n")}\n</citation_entries>\n<rollout_ids>\n${c.rolloutIds.map((id) => `${id}\n`).join("")}</rollout_ids>\n</oai-mem-citation>`;
    const native = { type: "event_msg", payload: { type: "item_completed", thread_id: f.child.agent_id,
      turn_id: "citation-turn", item: { type: "AgentMessage", id: "citation-final", phase: "final_answer",
        content: [{ type: "Text", text: body }], memory_citation: citation } } };
    const raw = { type: "response_item", payload: { type: "message", id: "citation-final", role: "assistant",
      phase: "final_answer", content: [{ type: "output_text", text: body + trailer(citation) }],
      internal_chat_message_metadata_passthrough: { turn_id: "citation-turn" } } };
    const complete = { type: "event_msg", payload: { type: "task_complete", turn_id: "citation-turn", last_agent_message: body } };
    const prefix = structuredClone(f.records);
    const install = async (tail) => { f.records.splice(0, f.records.length, ...structuredClone(prefix), ...tail); await f.save(); };
    await install([native, raw, complete]);
    hook(f.project, "subagent-stop", { ...f.child, turn_id: "citation-turn", last_assistant_message: body });
    const closure = f.store.status(f.context).stageClosure;
    assert.equal(closure.state, "ready");
    assert.equal(closure.resultDigest, payloadHash(raw.payload.content[0].text), "the full response, including citations, remains the result");

    const invalid = [
      (n) => { n.payload.thread_id = "other-child"; },
      (n) => { n.payload.turn_id = "other-turn"; },
      (n) => { n.payload.item.id = "other-message"; },
      (n) => { n.payload.item.phase = "commentary"; },
      (n) => { n.payload.item.content[0].type = "Unrecognized"; },
      (n) => { delete n.payload.item.memory_citation; },
      (n) => { n.payload.item.memory_citation.entries[0].path = "other.md"; },
      (n) => { n.payload.item.memory_citation.entries[0].lineStart = 433; },
      (n) => { n.payload.item.memory_citation.entries[0].lineEnd = 435; },
      (n) => { n.payload.item.memory_citation.entries[0].note = "another note"; },
      (n) => { n.payload.item.memory_citation.rolloutIds = []; },
      (n) => { n.payload.item.memory_citation.entries.push(n.payload.item.memory_citation.entries[0]); },
      (n) => { n.payload.item.content[0].text = body.trimEnd(); },
      (n, r) => { n.payload.item.id = ""; r.payload.id = ""; },
      (_n, r) => { r.payload.content[0].type = "Unrecognized"; },
      (_n, r) => { r.payload.content.push({ type: "Unrecognized", business: "unreviewed payload" }); },
      (_n, r) => { r.payload.content[0].text = "Changed business result.\n\n" + trailer(citation); },
      (_n, r) => { r.payload.content[0].text += "\nAdditional unfinished business."; },
      (_n, r) => { r.payload.content[0].text += trailer(citation); },
      (_n, r) => { r.payload.content[0].text = r.payload.content[0].text.replace("</oai-mem-citation>", ""); },
      (_n, r) => { r.payload.content[0].text = r.payload.content[0].text.replace("<citation_entries>", "<citation_entries><oai-mem-citation>"); },
      (_n, _r, c) => { c.payload.last_agent_message = body.trimEnd(); },
      (_n, _r, c) => { delete c.payload.last_agent_message; },
      (_n, _r, c) => { c.payload.turn_id = "other-turn"; },
    ];
    for (const mutate of invalid) {
      const tail = structuredClone([native, raw, complete]); mutate(...tail); await install(tail);
      assert.equal(f.store.status(f.context).stageClosure.state, "pending", mutate.toString());
    }
    const conflicting = structuredClone(native); conflicting.payload.item.content[0].text = "Conflicting result";
    await install([native, conflicting, raw, complete]);
    assert.equal(f.store.status(f.context).stageClosure.state, "pending");
    await install([raw, complete, native]);
    assert.equal(f.store.status(f.context).stageClosure.state, "pending", "completion cannot precede its native final");
    await install([raw, native, complete]);
    assert.equal(f.store.status(f.context).stageClosure.state, "ready", "native and raw final ordering can vary before completion");
    const changed = structuredClone(citation); changed.entries[0].note = "updated evidence boundary";
    const tail = structuredClone([native, raw, complete]);
    tail[0].payload.item.memory_citation = changed; tail[1].payload.content[0].text = body + trailer(changed);
    await install(tail);
    const next = f.store.status(f.context).stageClosure;
    assert.equal(next.state, "ready");
    assert.notEqual(next.resultDigest, closure.resultDigest);
    assert.notEqual(next.token, closure.token, "changed citation evidence invalidates the old result token");
    assert.throws(() => recordOutcome({ ...f.outcome(), closureToken: closure.token }, { store: f.store, cwd: f.project.root }), /token|current|changed/);
    assert.equal(recordOutcome({ ...f.outcome(), closureToken: next.token }, { store: f.store, cwd: f.project.root }).recorded, true);
  });
});

test("an old opaque call with neither command ledger nor native start remains reviewable after the outer final", async () => {
  await withChild(async (f) => {
    const row = f.store.db.prepare("SELECT locator FROM delegation_children WHERE route_id=?").get(f.route.routeId);
    const locator = JSON.parse(openPrivateState(f.store.db, row.locator));
    delete locator.commandCoverage;
    f.store.db.prepare("UPDATE delegation_children SET locator=? WHERE route_id=?")
      .run(sealPrivateState(f.store.db, JSON.stringify(locator)), f.route.routeId);
    // This is the legacy native shape: no item_started and no Hook command row.
    // The second printed block makes a single-tool forwarding proof impossible.
    await exceptionalOperations(f, 0);
    f.records.push({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "legacy-outer",
      input: 'const r = await tools.exec_command({cmd:"owned-operation"}); text(r); text("extra");' } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "legacy-outer", output: [
      { type: "input_text", text: "Script completed\nOutput:\n" },
      { type: "input_text", text: '{"session_id":42,"wall_time_seconds":1,"output":"PARTIAL"}' },
      { type: "input_text", text: "extra" },
    ] } });
    await f.finish("exception-turn", "OUTER_RETURNED_WHILE_INNER_UNKNOWN");
    const view = await f.manage("read_operations");
    assert.equal(view.operations.length, 1);
    assert.equal(view.operations[0].state, "execution_coverage_unknown");
    assert.equal(view.operations[0].origin.callId, "legacy-outer");
    assert.throws(() => recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root }), /pending/);
    await f.manage("reconcile_operations", { operationReview: operationReview(view) });
    assert.equal(f.store.status(f.context).stageClosure.state, "ready");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

test("read_operations cannot adopt a legacy child on success or a revision error", async () => {
  await withChild(async (f) => {
    recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root });
    f.store.db.prepare("DELETE FROM delegation_children WHERE route_id=?").run(f.route.routeId);
    for (const expectedRevision of [99, 0]) {
      const before = f.store.db.prepare("SELECT total_changes() AS n").get().n;
      await assert.rejects(f.manage("read_operations", { expectedRevision,
        childId: f.child.agent_id, childTranscriptPath: f.child.transcript_path }), /registered|reconcile_messages/);
      assert.equal(f.store.db.prepare("SELECT total_changes() AS n").get().n, before);
      assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_children").get().n, 0);
    }
    await f.manage("reconcile_messages", { childId: f.child.agent_id, childTranscriptPath: f.child.transcript_path });
    const before = f.store.db.prepare("SELECT total_changes() AS n").get().n;
    await f.manage("read_operations");
    assert.equal(f.store.db.prepare("SELECT total_changes() AS n").get().n, before);
  });
});

test("a later maintenance verification cannot overwrite an earlier transferred responsibility", async () => {
  await withChild(async (f) => {
    recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root });
    const outcome = f.store.db.prepare("SELECT * FROM outcomes").all();
    await f.manage("begin_maintenance", { disposition: disposition() });
    f.send("first-collection"); f.input(2, "first-collection"); await f.finish("first-collection", "TRANSFERRED_WORK");
    const first = f.store.status(f.context).stageClosure;
    const original = reviewed(first);
    await f.manage("verify_maintenance", { closureToken: first.token, disposition: original });
    await f.manage("begin_maintenance", { disposition: { ...disposition(), basis: "Collect a later guard check while preserving prior work." } });
    f.send("second-collection"); f.input(3, "second-collection"); await f.finish("second-collection", "GUARD_CHECK_COLLECTED");
    const second = f.store.status(f.context).stageClosure;
    const report = reviewed(second);
    report.requirements[0] = { ...report.requirements[0], disposition: "no_work", receipt: "Claim the old work disappeared" };
    await assert.rejects(f.manage("verify_maintenance", { closureToken: second.token, disposition: report }), /preserve|retained|resolve_requirements/);
    assert.deepEqual((await f.manage("read_disposition")).disposition.requirements, original.requirements);
    report.requirements[0] = original.requirements[0];
    report.requirements[1] = { ...report.requirements[1], disposition: "fulfilled", receipt: "Verified new guard result" };
    await f.manage("verify_maintenance", { closureToken: second.token, disposition: report });
    assert.equal(f.store.status(f.context).pendingStageWork[0].pending.length, 1);
    await f.manage("resolve_requirements", { disposition: { ...original, basis: "Root completed the retained work and verified its result.",
      requirements: original.requirements.map((r) => ({ ...r, disposition: "fulfilled", receipt: "Concrete root verification receipt" })) } });
    assert.deepEqual(f.store.status(f.context).pendingStageWork, []);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes").all(), outcome);
  });
});

test("runtime rollback preserves deferred work, late native operations and the historical outcome", async (t) => {
  await withChild(async (f) => {
    recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root });
    await f.manage("begin_maintenance", { disposition: disposition("deferred") });
    f.send("retained-before-rollback"); f.input(2, "deferred-before-rollback");
    await f.finish("deferred-before-rollback", "SOURCE_AND_PARTIAL_RESULT_RETAINED");
    const first = f.store.status(f.context).stageClosure;
    const work = reviewed(first, "deferred");
    await f.manage("verify_maintenance", { closureToken: first.token, disposition: work });
    await f.manage("begin_maintenance", { disposition: { ...disposition(), basis: "Collect late evidence without discarding deferred responsibility." } });
    // A legacy outcome does not erase later-discovered execution from its
    // original turn. This native-event fixture is not a new guarded command.
    f.records.push({ type: "event_msg", payload: { type: "item_started", thread_id: f.child.agent_id,
      turn_id: "child-turn-1", item: { type: "CommandExecution", source: "unified_exec_startup",
        id: "late-original-operation", status: "in_progress", process_id: "77" } } });
    await f.save();
    const beforeClosure = f.store.status(f.context).stageClosure;
    assert.equal(beforeClosure.reason, "child_operations_pending");
    const beforeOps = await f.manage("read_operations");
    const beforeWork = await f.manage("read_disposition");
    const beforeOutcomes = f.store.db.prepare("SELECT * FROM outcomes").all();
    const beforePending = f.store.status(f.context).pendingStageWork;
    assert.equal(beforeWork.disposition.requirements.length, 1, "active collection retains the earlier transferred requirement");
    const versions = join(f.project.root, "runtime-fixture", "plugins", "cache", "market", "adaptive-model-router");
    const pluginData = join(f.project.root, "runtime-fixture", "plugins", "data", "market-adaptive-model-router");
    await mkdir(pluginData, { recursive: true });
    const roots = [join(versions, "0.4.0"), join(versions, "0.4.1")];
    // An explicit acceptance run may supply the actual previous installed
    // implementation. The ordinary regression is self-contained and uses two
    // compatible copies of the current core; report those scopes separately.
    const previousSource = process.env.ADAPTIVE_ROUTER_ROLLBACK_PREVIOUS_ROOT || pluginRoot;
    const previousManifest = JSON.parse(await readFile(join(previousSource, "runtime.json"), "utf8"));
    t.diagnostic(JSON.stringify({ previousSourceVersion: previousManifest.runtimeVersion,
      previousSourceDigest: runtimeSourceDigest(previousSource), currentSourceDigest: runtimeSourceDigest(pluginRoot),
      historicalImplementation: previousSource !== pluginRoot }));
    for (const [index, root] of roots.entries()) {
      await cp(index ? pluginRoot : previousSource, root, { recursive: true });
      const version = index ? "0.4.1" : "0.4.0";
      for (const [path, field] of [["runtime.json", "runtimeVersion"], [".codex-plugin/plugin.json", "version"]]) {
        const value = JSON.parse(await readFile(join(root, path), "utf8")); value[field] = version;
        await writeFile(join(root, path), JSON.stringify(value) + "\n");
      }
      const constants = join(root, "scripts/lib/constants.mjs");
      await writeFile(constants, (await readFile(constants, "utf8")).replace(/export const ROUTER_VERSION = "[^"]+";/u,
        `export const ROUTER_VERSION = "${version}";`));
    }
    const env = { ...process.env, PLUGIN_ROOT: roots[0], PLUGIN_DATA: pluginData,
      ADAPTIVE_ROUTER_HOME: f.project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_RUNTIME_TRACE: "1" };
    const run = () => spawnSync(process.execPath, [join(roots[0], "scripts/node-launcher.mjs"), join(roots[0], "scripts/hook.mjs"), "prompt"], {
      cwd: f.project.root, env, encoding: "utf8", timeout: 15000,
      input: JSON.stringify({ ...f.root, model: "gpt-6-astra", prompt: "router: status" }),
    });
    const pointer = () => JSON.parse(readFileSync(join(f.project.home, "runtime/active.json"), "utf8"));
    const activated = run(); assert.equal(activated.status, 0, activated.stderr);
    assert.equal(pointer().activeVersion, "0.4.1");
    await writeFile(join(roots[1], "scripts/hook.mjs"), "#!/usr/bin/env node\nprocess.exit(7);\n");
    const failed = run(); assert.equal(failed.status, 7, failed.stderr);
    assert.equal(pointer().activeVersion, "0.4.0");
    assert.ok(pointer().failedDirectories.includes("0.4.1"));
    const recovered = run(); assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stderr, /runtime=0\.4\.0/u);
    const consumer = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const input = JSON.parse(readFileSync(0, "utf8"));
      const { RouterStore } = await import(pathToFileURL(input.runtime + "/scripts/lib/database.mjs"));
      const { callRouterTool } = await import(pathToFileURL(input.runtime + "/scripts/lib/service.mjs"));
      const store = new RouterStore();
      try {
        const context = store.context({ cwd: input.cwd, contextId: input.contextId });
        const manage = (action, extra = {}) => callRouterTool("manage_stage", {
          contextId: input.contextId, routeId: input.routeId, expectedRevision: input.revision, action, ...extra,
        }, { store, cwd: input.cwd, stageOptions: { readParent: async () => ({ id: input.contextId, cwd: input.cwd }) } });
        let verifyError = null;
        try { await manage("verify_maintenance", { closureToken: input.token, disposition: input.work }); }
        catch (error) { verifyError = error.message; }
        const status = store.status(context);
        process.stdout.write(JSON.stringify({ outcomes: store.db.prepare("SELECT * FROM outcomes").all(),
          disposition: await manage("read_disposition"), operations: await manage("read_operations"),
          pending: status.pendingStageWork, closure: status.stageClosure, verifyError }));
      } finally { store.close(); }
    `], { cwd: f.project.root, env, encoding: "utf8", timeout: 15000,
      input: JSON.stringify({ runtime: roots[0], cwd: f.project.root, contextId: f.root.session_id,
        routeId: f.route.routeId, revision: beforeWork.revision, token: first.token, work }) });
    assert.equal(consumer.status, 0, consumer.stderr);
    const consumed = JSON.parse(consumer.stdout);
    assert.deepEqual(consumed.outcomes, JSON.parse(JSON.stringify(beforeOutcomes)));
    assert.deepEqual(consumed.disposition, beforeWork);
    assert.deepEqual(consumed.pending, beforePending);
    assert.deepEqual(consumed.closure, beforeClosure);
    assert.equal(consumed.operations.snapshotDigest, beforeOps.snapshotDigest);
    assert.deepEqual(consumed.operations.operations, beforeOps.operations);
    assert.match(consumed.verifyError, /pending|ready|closure/i);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes").all(), beforeOutcomes);
    assert.deepEqual(await f.manage("read_disposition"), beforeWork);
    assert.deepEqual(f.store.status(f.context).pendingStageWork, beforePending);
    assert.deepEqual(f.store.status(f.context).stageClosure, beforeClosure);
    const afterOps = await f.manage("read_operations");
    assert.equal(afterOps.snapshotDigest, beforeOps.snapshotDigest);
    assert.deepEqual(afterOps.operations, beforeOps.operations);
    await assert.rejects(f.manage("verify_maintenance", { closureToken: first.token, disposition: work }), /pending|ready|closure/i);
  });
});

test("a native Pre rejection remains with its sender and cannot poison later collection", async () => {
  await withChild(async (f) => {
    recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root });
    const outcome = f.store.db.prepare("SELECT * FROM outcomes").all();
    const invocation = { ...f.root, tool_name: "collaborationsend_message", tool_use_id: "rejected-message",
      tool_input: { target: `/root/${f.route.carrier.taskName}`, message: "encrypted rejected requirement" } };
    const denied = hook(f.project, "pre-tool-use", invocation);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    messageHostFixture(f, invocation);
    f.parentRecords[0].payload.cli_version = "0.153.4";
    f.parentRecords.push({ type: "response_item", payload: { type: "function_call", namespace: "collaboration",
      name: "send_message", call_id: invocation.tool_use_id, arguments: JSON.stringify(invocation.tool_input) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: invocation.tool_use_id,
      output: `Tool call blocked by PreToolUse hook: ${denied.hookSpecificOutput.permissionDecisionReason}. Tool: collaborationsend_message` } });
    f.saveParent();
    const reconciled = await f.manage("reconcile_messages");
    assert.deepEqual(reconciled.pendingCalls, []);
    assert.equal(reconciled.rejectedCalls[0].owner, "/root");
    assert.equal(f.store.db.prepare("SELECT status FROM delegation_messages WHERE call_id=?").get(invocation.tool_use_id).status, "rejected");
    await f.manage("begin_maintenance", { disposition: disposition() });
    assert.equal(f.send("after-rejection").pre.hookSpecificOutput, undefined);
    f.input(2, "after-rejection"); await f.finish("after-rejection", "COLLECTION_AFTER_UNDELIVERED_MESSAGE");
    const closure = f.store.status(f.context).stageClosure;
    assert.equal(closure.state, "ready");
    await f.manage("verify_maintenance", { closureToken: closure.token, disposition: reviewed(closure) });
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes").all(), outcome);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM delegation_stage_journal WHERE kind LIKE 'message_rejection:%'").get().n, 1);
  });
});

test("v9 migration preserves existing message rows and unique revisions while adding rejection", async () => {
  await withChild(async (f) => {
    f.send("pending-message", "followup_task", false);
    const before = f.store.db.prepare("SELECT * FROM delegation_messages").all();
    const sql = f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='delegation_messages'").get().sql;
    f.store.db.exec("ALTER TABLE delegation_messages RENAME TO message_fixture_copy");
    f.store.db.exec(sql.replace(",'rejected'", ""));
    f.store.db.exec("INSERT INTO delegation_messages SELECT * FROM message_fixture_copy; DROP TABLE message_fixture_copy; PRAGMA user_version=9");
    f.store.migrate();
    assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, DATABASE_VERSION);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM delegation_messages").all(), before);
    assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
    f.store.migrate();
    assert.deepEqual(f.store.db.prepare("SELECT * FROM delegation_messages").all(), before);
    assert.throws(() => f.store.db.exec("INSERT INTO delegation_messages SELECT * FROM delegation_messages"), /UNIQUE/);
  });
});

test("missing native provider rejects only the undelivered followup and permits real collection", async () => {
  await withChild(async (f) => {
    const { invocation } = f.send("provider-rejected", "followup_task", false);
    messageHostFixture(f, invocation);
    f.parentRecords[0].payload.cli_version = "0.153.4";
    f.parentRecords.at(-1).payload.output = "collab tool failed: Model provider `codex_local_access` not found";
    f.saveParent();
    const result = await f.manage("reconcile_messages");
    assert.deepEqual(result.pendingCalls, []);
    assert.equal(result.rejectedCalls[0].source, "native_provider_resolution_rejection");
    assert.equal(result.rejectedCalls[0].nextAction, "keep_undelivered_requirement_with_sender");
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    await f.manage("begin_maintenance", { disposition: disposition("superseded") });
    assert.equal(f.send("restored-provider").pre.hookSpecificOutput, undefined);
    f.input(2, "recovery-collection"); await f.finish("recovery-collection", "COLLECTED_AFTER_PROVIDER_RECOVERY");
    const closure = f.store.status(f.context).stageClosure;
    assert.equal(closure.state, "ready");
    await f.manage("verify_maintenance", { closureToken: closure.token, disposition: reviewed(closure, "superseded") });
    assert.equal(recordOutcome({ ...f.outcome(), status: "failed", failureType: "tooling", closureToken: closure.token },
      { store: f.store, cwd: f.project.root }).recorded, true);
    assert.equal(f.store.status(f.context).delegationGate.state, "available");
  }, { cli_version: "0.153.4", model_provider: "codex_local_access" });
});

for (const variation of ["wrong-provider", "missing-provider-metadata", "unknown-host", "unknown-child-host", "extra-text", "wrong-tool", "unexpected-child-input", "missing-call-host", "stale-call-host", "conflicting-call-host", "changed-call-input"]) test(`provider rejection keeps ${variation} pending`, async () => {
  await withChild(async (f) => {
    const { invocation } = f.send("provider-uncertain", variation === "wrong-tool" ? "send_message" : "followup_task", false);
    // Both immutable session headers stay at 0.153.4 after host upgrade.
    f.parentRecords[0].payload.cli_version = "0.153.4";
    messageHostFixture(f, variation === "stale-call-host" ? { ...invocation, turn_id: "old-native-turn" }
      : variation === "changed-call-input" ? { ...invocation, tool_input: { ...invocation.tool_input, message: "other input" } } : invocation,
    variation === "missing-call-host" ? null : variation === "unknown-host" ? "0.999.0" : "0.153.4");
    if (variation === "conflicting-call-host") messageHostFixture(f, invocation, "0.999.0", false);
    f.parentRecords.at(-1).payload.output = `collab tool failed: Model provider \`${variation === "wrong-provider" ? "other" : "codex_local_access"}\` not found${variation === "extra-text" ? " but delivered" : ""}`;
    f.saveParent();
    if (variation === "unexpected-child-input") { f.input(2, "unexpected"); await f.finish("unexpected", "UNEXPECTED_INPUT"); }
    const result = await f.manage("reconcile_messages");
    assert.equal(f.store.status(f.context).stageClosure.state, "pending");
    if (variation !== "unexpected-child-input") assert.deepEqual(result.pendingCalls, ["provider-uncertain"]);
    assert.throws(() => recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root }), /pending/);
  }, { cli_version: variation === "unknown-child-host" ? "unknown" : "0.153.4",
    ...(variation === "missing-provider-metadata" ? {} : { model_provider: "codex_local_access" }) });
});

for (const variation of ["generic-error", "wrong-tool", "unknown-host"]) test(`${variation} cannot settle an undelivered message`, async () => {
  await withChild(async (f) => {
    const { invocation } = f.send("uncertain-send", "followup_task", false);
    messageHostFixture(f, invocation, variation === "unknown-host" ? "0.999.0" : "0.153.4");
    f.parentRecords[0].payload.cli_version = "0.153.4";
    f.parentRecords.at(-1).payload.output = variation === "generic-error" ? "connection lost"
      : `Tool call blocked by PreToolUse hook: refused. Tool: collaboration${variation === "wrong-tool" ? "send_message" : "followup_task"}`;
    f.saveParent();
    const result = await f.manage("reconcile_messages");
    assert.deepEqual(result.pendingCalls, ["uncertain-send"]);
    assert.deepEqual(result.rejectedCalls, []);
    assert.equal(f.store.status(f.context).stageClosure.reason, "message_result_pending");
  });
});

test("retained rejection receipts survive an upgrade without retroactively attesting a call host", async () => {
  await withChild(async (f) => {
    const { invocation } = f.send("legacy-provider-rejection", "followup_task", false);
    messageHostFixture(f, invocation);
    f.parentRecords[0].payload.cli_version = "0.153.4";
    f.parentRecords.at(-1).payload.output = "collab tool failed: Model provider `codex_local_access` not found";
    f.saveParent();
    const first = await f.manage("reconcile_messages");
    messageHostFixture(f, invocation, null);
    const key = `message_rejection:${payloadHash(["/root", invocation.tool_use_id])}`;
    const receipt = JSON.parse(openPrivateState(f.store.db, f.store.db.prepare("SELECT record FROM delegation_stage_journal WHERE kind=?").get(key).record));
    delete receipt.hostEvidenceDigest; // Exact legacy receipt contract, predating call-time attestation.
    delete receipt.schema;
    f.store.db.prepare("UPDATE delegation_stage_journal SET record=? WHERE kind=?")
      .run(sealPrivateState(f.store.db, JSON.stringify(receipt)), key);
    const next = await f.manage("reconcile_messages");
    assert.deepEqual(next.pendingCalls, []);
    assert.equal(next.rejectedCalls[0].resultDigest, first.rejectedCalls[0].resultDigest);
    assert.equal(next.rejectedCalls[0].hostEvidenceDigest, undefined);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    assert.equal(f.store.status(f.context).delegationGate.state, "occupied");
    f.parentRecords.at(-1).payload.output += " changed"; f.saveParent();
    await assert.rejects(f.manage("reconcile_messages"), /terminal result changed/);
  }, { cli_version: "0.153.4", model_provider: "codex_local_access" });
});

for (const change of ["missing", "conflict", "same-version-executable"]) test(`a new rejection cannot borrow legacy retention after its host evidence becomes ${change}`, async () => {
  await withChild(async (f) => {
    const { invocation } = f.send("verified-then-changed", "followup_task", false);
    messageHostFixture(f, invocation);
    f.parentRecords[0].payload.cli_version = "0.153.4";
    f.parentRecords.at(-1).payload.output = "collab tool failed: Model provider `codex_local_access` not found";
    f.saveParent();
    const first = await f.manage("reconcile_messages");
    assert.equal(first.rejectedCalls[0].schema, 2);
    assert.match(first.rejectedCalls[0].hostEvidenceDigest, /^[a-f0-9]{64}$/u);
    const before = f.store.db.prepare("SELECT * FROM outcomes").all();
    if (change === "same-version-executable") messageHostFixture(f, invocation, "0.153.4", true,
      { executableDigest: payloadHash("changed binary with the same version") });
    else messageHostFixture(f, invocation, change === "missing" ? null : "0.999.0", change === "missing");
    assert.equal(f.store.status(f.context).stageClosure.reason, "message_result_pending", "status alone must retain the gate");
    await assert.rejects(f.manage("reconcile_messages"), /terminal result changed/);
    assert.throws(() => recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root }), /pending/);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM outcomes").all(), before);
  }, { cli_version: "0.153.4", model_provider: "codex_local_access" });
});

for (const recovered of [false, true]) test(`active historical maintenance blocks admission ${recovered ? "after recovery" : "without a capacity refusal"}`, async () => {
  await withChild(async (f) => {
    recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root });
    if (recovered) {
      f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(capacityStateKey(f.context), f.route.routeId);
      f.store.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(`capacity_recovered:${f.context.projectId}:${f.context.contextKey}`,
        JSON.stringify({ rejectionRouteId: f.route.routeId, proofDigest: "a".repeat(64) }));
    }
    await f.manage("begin_maintenance", { disposition: disposition() });
    assert.deepEqual(capacityAdmissionDecision(f.store.db, f.context, "new-stage"), { allowed: false, reasonCode: "CHILD_MAINTENANCE_PENDING" });
    assert.deepEqual(f.store.commitRoute(f.context, { action: "delegate", stageKey: "new-stage" }),
      { committed: false, retry: false, fallback: "CHILD_MAINTENANCE_PENDING" }, "commit must recheck even after prior scoring");
    const next = await routeStage(routeInput({ contextId: "closure-root", stageId: "after-maintenance" }),
      { store: f.store, cwd: f.project.root, catalog: CATALOG, diskProbe: () => 16n * 1024n ** 3n });
    assert.equal(next.action, "continue"); assert.deepEqual(next.reasonCodes, ["CHILD_MAINTENANCE_PENDING"]);
    f.send("finish-maintenance"); f.input(2, "finish-maintenance"); await f.finish("finish-maintenance", "DONE");
    const closure = f.store.status(f.context).stageClosure;
    await f.manage("verify_maintenance", { closureToken: closure.token, disposition: reviewed(closure) });
    assert.deepEqual(capacityAdmissionDecision(f.store.db, f.context, "new-stage"), { allowed: true });
  });
});

test("exception reconciliation is reachable while pending and cannot settle other operations or replace result verification", async () => {
  await withChild(async (f) => {
    const view = await exceptionalOperations(f, 2);
    assert.equal(view.operations.length, 2);
    const review = operationReview(view);
    const applied = await f.manage("reconcile_operations", { operationReview: review });
    assert.equal(applied.resolved, 1);
    assert.equal((await f.manage("reconcile_operations", { operationReview: review, expectedRevision: view.revision })).idempotent, true);
    assert.equal(f.store.status(f.context).stageClosure.pendingOperations.length, 1);
    assert.throws(() => recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root }), /pending/);
    const next = await f.manage("read_operations");
    await f.manage("reconcile_operations", { operationReview: operationReview(next) });
    const closure = f.store.status(f.context).stageClosure;
    assert.equal(closure.state, "ready");
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
    assert.throws(() => recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root }), /closureToken/);
    recordOutcome({ ...f.outcome(), closureToken: closure.token }, { store: f.store, cwd: f.project.root });
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
  });
});

test("operation reviews retain unknown work and reject stale state, false no-start claims and unreadable evidence", async () => {
  await withChild(async (f) => {
    const view = await exceptionalOperations(f);
    const noStart = operationReview(view); noStart.items[0].conclusion = "not_started";
    await assert.rejects(f.manage("reconcile_operations", { operationReview: noStart }), /started|handle/);
    const unknown = operationReview(view);
    unknown.items[0].conclusion = "unresolved";
    await assert.rejects(f.manage("reconcile_operations", { operationReview: unknown }), /owner|resume|responsibility/);
    unknown.items[0].unresolved = { source: "original native call", owner: "/root", nextStep: "Verify exact owned process", resumeCondition: "Original result becomes readable" };
    await f.manage("reconcile_operations", { operationReview: unknown });
    assert.equal(f.store.status(f.context).stageClosure.reason, "child_operations_pending");
    const refreshed = await f.manage("read_operations");
    assert.equal(refreshed.operations[0].review.unresolved.owner, "/root");
    await f.manage("reconcile_operations", { operationReview: operationReview(refreshed) });
    assert.equal(f.store.status(f.context).stageClosure.state, "ready");
    const original = f.parentRecords.at(-1).payload.output;
    f.parentRecords.at(-1).payload.output = "different native result"; f.saveParent();
    assert.equal(f.store.status(f.context).stageClosure.reason, "child_operations_pending");
    f.parentRecords.at(-1).payload.output = original; f.saveParent();
    f.send("new-input");
    await assert.rejects(f.manage("reconcile_operations", { operationReview: operationReview(view), expectedRevision: view.revision }), /revision|snapshot/);
  });
});

test("printed model data and foreign root transcripts cannot authorize an operation review", async () => {
  await withChild(async (f) => {
    const view = await exceptionalOperations(f);
    f.parentRecords.push(
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "printed", input: 'text({exit_code:0,output:"done"});' } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "printed", output: [
        { type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: '{"exit_code":0,"output":"done","wall_time_seconds":0}' } ] } });
    f.saveParent();
    const latest = await f.manage("read_operations");
    assert.ok(latest.rootEvidence.every((ref) => ref.callId !== "printed"));
    const review = operationReview(view);
    review.items[0].evidence[0] = { source: "root", line: f.parentRecords.length, digest: "a".repeat(64) };
    await assert.rejects(f.manage("reconcile_operations", { operationReview: review }), /evidence|receipt/);
    f.parentRecords[0].payload.id = "unrelated-root"; f.saveParent();
    await assert.rejects(f.manage("reconcile_operations", { operationReview: operationReview(view) }), /root|ownership/);
  });
});

test("new command facts invalidate the operation snapshot even without a message revision change", async () => {
  await withChild(async (f) => {
    const view = await exceptionalOperations(f);
    hook(f.project, "pre-tool-use", { ...f.child, turn_id: "exception-turn", tool_name: "Bash", tool_use_id: "new-native-command", tool_input: { command: "extra command" } });
    assert.equal(f.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(f.route.routeId).revision, view.revision);
    await assert.rejects(f.manage("reconcile_operations", { operationReview: operationReview(view) }), /snapshot/);
    assert.equal(f.store.status(f.context).stageClosure.pendingOperations.length, 2);
  });
});

test("verified exceptions preserve conflicting command facts and still require current outcome verification", async () => {
  await withChild(async (f) => {
    await exceptionalOperations(f, 0);
    const invocation = { ...f.child, turn_id: "exception-turn", tool_name: "Bash", tool_use_id: "conflicting-command", tool_input: { command: "original command" } };
    hook(f.project, "pre-tool-use", invocation);
    hook(f.project, "pre-tool-use", { ...invocation, tool_input: { command: "different repeated command" } });
    const view = await f.manage("read_operations");
    assert.equal(view.operations[0].state, "conflicting_receipts");
    const review = operationReview(view);
    review.items[0].conclusion = "not_started";
    review.items[0].basis = "The root examined the original creation failure and the conflicting duplicate; neither produced an execution.";
    await f.manage("reconcile_operations", { operationReview: review });
    const closure = f.store.status(f.context).stageClosure;
    assert.equal(closure.state, "ready");
    const command = () => f.store.db.prepare("SELECT conflicted,verified FROM delegation_child_commands WHERE call_id='conflicting-command'").get();
    assert.equal(command().conflicted, 1);
    assert.equal(command().verified, 0);
    recordOutcome({ ...f.outcome(), closureToken: closure.token }, { store: f.store, cwd: f.project.root });
    assert.equal(command().conflicted, 1, "reconciliation never erases the conflict history");
    assert.equal(command().verified, 1);
  });
});

test("a second bounded maintenance cycle preserves previous dispositions and requires a fresh final", async () => {
  await withChild(async (f) => {
    recordOutcome(f.outcome(), { store: f.store, cwd: f.project.root });
    const beforeOutcome = f.store.db.prepare("SELECT payload_hash FROM outcomes").get().payload_hash;
    await f.manage("begin_maintenance", { disposition: disposition() });
    f.send("collect-one"); f.input(2, "collect-one"); await f.finish("collect-one", "FIRST_COLLECTION");
    const first = f.store.status(f.context).stageClosure;
    const firstReport = reviewed(first);
    await f.manage("verify_maintenance", { closureToken: first.token, disposition: firstReport });
    const bytes = f.store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes;
    const nextIntent = { ...disposition(), basis: "User accepted a second bounded collection to verify the repaired guard." };
    const next = await f.manage("begin_maintenance", { disposition: nextIntent });
    assert.equal(next.state, "active");
    assert.equal((await f.manage("read_disposition")).disposition.requirements[0].messageId, firstReport.requirements[0].messageId);
    assert.equal(f.store.status(f.context).stageClosure.nextAction, "followup_bounded_collection");
    await assert.rejects(f.manage("verify_maintenance", { closureToken: first.token, disposition: firstReport }), /ready|token/);
    f.send("collect-two"); f.input(3, "collect-two"); await f.finish("collect-two", "SECOND_COLLECTION");
    const second = f.store.status(f.context).stageClosure;
    await f.manage("verify_maintenance", { closureToken: second.token, disposition: reviewed(second) });
    assert.equal(f.store.db.prepare("SELECT payload_hash FROM outcomes").get().payload_hash, beforeOutcome);
    const afterBytes = f.store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes;
    assert.ok(afterBytes >= bytes);
    await f.manage("verify_maintenance", { closureToken: second.token, disposition: reviewed(second) });
    assert.equal(f.store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes, afterBytes);
    assert.equal((await f.manage("read_disposition")).disposition.requirements.length, 2);
  });
});

test("ordinary code-mode output cannot hide an unfinished command from the outcome gate", async () => {
  await withChild(async ({ project, store, context, child, records, send, input, finish, outcome }) => {
    send("opaque-work"); input(2, "opaque-turn");
    const invocation = { ...child, turn_id: "opaque-turn", tool_name: "Bash", tool_use_id: "exec-native-opaque",
      tool_input: { command: "node controlled.mjs" } };
    hook(project, "pre-tool-use", invocation);
    records.push({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "outer-opaque",
      input: 'const r = await tools.exec_command({cmd:"node controlled.mjs"}); text(r); text("extra output");' } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "outer-opaque", output: [
      { type: "input_text", text: "Script completed\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ session_id: 42, wall_time_seconds: 1, output: "PARTIAL" }) },
      { type: "input_text", text: "extra output" },
    ] } });
    await finish("opaque-turn", "RETURNED_WITH_PENDING_COMMAND");
    const closure = store.status(context).stageClosure;
    assert.equal(closure.reason, "child_operations_pending");
    assert.ok(closure.pendingOperations.some((op) => op.callId === invocation.tool_use_id));
    assert.throws(() => recordOutcome(outcome(), { store, cwd: project.root }), /closure is pending/i);
    // Simulate an old additive-compatible writer which only knows the previous
    // verified_revision/digest fields. The database must protect new work too.
    store.db.prepare("UPDATE delegation_children SET verified_revision=revision,verified_digest='old-runtime-proof' WHERE route_id=?").run(outcome().routeId);
    const oldInsert = () => store.db.prepare(`INSERT INTO outcomes(route_id,project_id,context_key,category,status,gate,
      failure_type,retries,retry_reasoning,retry_environment,retry_information,retry_tooling,escalations,user_correction,payload_hash,recorded_at)
      SELECT route_id,project_id,context_key,category,'passed','none',NULL,0,0,0,0,0,0,0,'old-claim','2026-09-09T00:00:00Z'
      FROM routes WHERE route_id=?`).run(outcome().routeId);
    assert.throws(oldInsert, /command outcome requires current operation verification/);

    // Native write_stdin can send the original command's Post from a later turn.
    hook(project, "post-tool-use", { ...invocation, turn_id: "later-poll-turn", tool_response: "actual terminal output" });
    assert.equal(store.status(context).stageClosure.state, "ready");
    assert.throws(oldInsert, /command outcome requires current operation verification/);
    const ready = store.status(context).stageClosure;
    assert.equal(recordOutcome({ ...outcome(), closureToken: ready.token }, { store, cwd: project.root }).recorded, true);
  });
});

test("an intercepted patch can close from its native file result without inventing a Bash Post", async () => {
  await withChild(async ({ project, store, context, child, records, send, input, finish, outcome, save }) => {
    send("patch-work"); input(2, "patch-turn");
    hook(project, "pre-tool-use", { ...child, turn_id: "patch-turn", tool_name: "Bash", tool_use_id: "exec-patch",
      tool_input: { command: "apply_patch fixture" } });
    await finish("patch-turn", "PATCH_RESULT_VERIFIED_BY_ROOT");
    assert.equal(store.status(context).stageClosure.reason, "child_operations_pending");
    assert.throws(() => recordOutcome(outcome(), { store, cwd: project.root }), /closure is pending/i);
    records.push({ type: "event_msg", payload: { type: "item_completed", thread_id: child.agent_id,
      turn_id: "patch-turn", item: { type: "FileChange", id: "exec-patch", status: "completed",
        changes: { "result.txt": { type: "add", content: "verified result" } }, stdout: "patch applied", stderr: "" } } });
    await save();
    const closure = store.status(context).stageClosure;
    assert.equal(closure.state, "ready");
    assert.equal(store.db.prepare("SELECT post_seen FROM delegation_child_commands WHERE call_id='exec-patch'").get().post_seen, 0);
    assert.equal(recordOutcome({ ...outcome(), closureToken: closure.token }, { store, cwd: project.root }).recorded, true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
  });
});

test("parallel native commands finish independently and natural exit needs no extra poll", async () => {
  await withChild(async ({ project, store, context, child, records, send, input, finish, save }) => {
    send("parallel-work"); input(2, "parallel-turn");
    const invocation = (id) => ({ ...child, turn_id: "parallel-turn", tool_name: "Bash", tool_use_id: id,
      tool_input: { command: `node ${id}.mjs` } });
    for (const id of ["exec-one", "exec-two"]) hook(project, "pre-tool-use", invocation(id));
    await finish("parallel-turn", "RETURNED_WITH_TWO_COMMANDS");
    assert.equal(store.status(context).stageClosure.pendingOperations.length, 2);
    hook(project, "post-tool-use", { ...invocation("exec-one"), tool_response: "first exited" });
    assert.deepEqual(store.status(context).stageClosure.pendingOperations.map((op) => op.callId), ["exec-two"]);
    records.push({ type: "event_msg", payload: { type: "item_completed", thread_id: child.agent_id,
      turn_id: "parallel-turn", item: { type: "CommandExecution", id: "exec-two", process_id: "77",
        command: ["node", "exec-two.mjs"], source: "unified_exec_startup", status: "completed", exit_code: 0 } } });
    await save();
    assert.equal(store.status(context).stageClosure.state, "ready");
  });
});
function hook(project, mode, input) {
  const result = spawnSync(process.execPath, [join(pluginRoot, "scripts/hook.mjs"), mode], {
    input: JSON.stringify(input), encoding: "utf8",
    env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function setupChild(project, store, run, contextId = "closure-root", nativeMetadata = {}) {
        const parentPath = join(project.root, `${contextId}-parent.jsonl`);
        const parentRecords = [{ type: "session_meta", payload: { id: contextId, cwd: project.root } },
          { type: "turn_context", payload: { turn_id: "root-turn" } }];
        const saveParent = () => writeFileSync(parentPath, parentRecords.map(JSON.stringify).join("\n") + "\n");
        saveParent();
        const root = { transcript_path: parentPath, cwd: project.root, session_id: contextId, turn_id: "root-turn", model: "gpt-6-astra" };
        const route = await routeStage(routeInput({ contextId }), { store, cwd: project.root, catalog: CATALOG,
          diskProbe: () => 16n * 1024n ** 3n });
        assert.equal(route.action, "delegate");
        const context = store.context({ cwd: project.root, contextId });
        const name = route.carrier.taskName;
        const childId = `${contextId}-child`;
        const path = join(project.root, `${contextId}-child.jsonl`);
        const toolInput = { task_name: name, message: "gAAAA-activation", model: route.target.model,
          reasoning_effort: route.target.effort, fork_turns: "none" };
        hook(project, "pre-tool-use", { ...root, tool_name: "collaborationspawn_agent", tool_use_id: "spawn-call", tool_input: toolInput });
        const records = [{ type: "session_meta", payload: { ...nativeMetadata, session_id: contextId, id: childId,
          parent_thread_id: contextId, cwd: project.root, agent_path: `/root/${name}`,
          source: { subagent: { thread_spawn: { parent_thread_id: contextId, depth: 1, agent_path: `/root/${name}` } } } } }];
        const save = () => writeFile(path, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
        await save();
        const child = { ...root, agent_id: childId, agent_type: "worker", transcript_path: path,
          agent_transcript_path: path, turn_id: "child-turn-1", model: route.target.model };
        hook(project, "subagent-start", child);
        hook(project, "post-tool-use", { ...root, tool_name: "collaborationspawn_agent", tool_use_id: "spawn-call",
          tool_input: toolInput, tool_response: JSON.stringify({ task_name: `/root/${name}` }) });
        function input(number, turnId, trigger = true) {
          records.push({ type: "inter_agent_communication_metadata", payload: { trigger_turn: trigger } },
            { type: "response_item", payload: { type: "agent_message", id: `amsg_${number}`, author: "/root",
              recipient: `/root/${name}`, content: [{ type: "input_text", text: `requirement ${number}` }],
              internal_chat_message_metadata_passthrough: { turn_id: turnId } } });
        }
        async function finish(turnId, result) {
          records.push({ type: "response_item", payload: { type: "message", id: `final_${turnId}`, role: "assistant",
            phase: "final_answer", content: [{ type: "output_text", text: result }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
          { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } });
          await save();
          hook(project, "subagent-stop", { ...child, turn_id: turnId, last_assistant_message: result });
        }
        input(1, "child-turn-1");
        await finish("child-turn-1", "INITIAL_RESULT");
        const outcome = () => ({ contextId, routeId: route.routeId, status: "passed", gate: route.verificationGate,
          failureType: null, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
          escalations: route.escalation.count, userCorrection: false });
        const send = (callId, tool = "followup_task", post = true) => {
          const invocation = { ...root, tool_name: `collaboration${tool}`, tool_use_id: callId,
            tool_input: { target: `/root/${name}`, message: `gAAAA-${callId}` } };
          const pre = hook(project, "pre-tool-use", invocation);
          if (post && pre?.hookSpecificOutput?.permissionDecision !== "deny") {
            hook(project, "post-tool-use", { ...invocation, tool_response: "" });
          }
          if (pre?.hookSpecificOutput?.permissionDecision !== "deny") {
            parentRecords.push({ type: "response_item", payload: { type: "function_call", namespace: "collaboration",
              name: tool, call_id: callId, arguments: JSON.stringify(invocation.tool_input) } },
              { type: "response_item", payload: { type: "function_call_output", call_id: callId, output: "" } });
            saveParent();
          }
          return { invocation, pre };
        };
        const manage = (action, extra = {}) => callRouterTool("manage_stage", { contextId, routeId: route.routeId, action,
          expectedRevision: store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(route.routeId)?.revision || 0,
          ...extra }, { store, cwd: project.root,
          stageOptions: { readParent: async () => ({ id: contextId, cwd: project.root }) } });
        await run({ project, store, context, route, child, input, finish, save, records, outcome, send, root, parentPath, parentRecords, saveParent, manage });
}

async function withChild(run, nativeMetadata = {}) {
  const project = await temporaryProject("router stage closure ");
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      try {
        await setupChild(project, store, run, "closure-root", nativeMetadata);
      } finally { store.close(); }
    });
  } finally { await project.cleanup(); }
}

test("a same-stage followup invalidates the first Stop before its native result arrives", async () => {
  await withChild(async ({ store, route, outcome, send, project }) => {
    send("followup-1", "followup_task", false);
    const row = store.db.prepare("SELECT stop_observed FROM delegation_attempts WHERE route_id=?").get(route.routeId);
    assert.equal(row.stop_observed, 0, "the first Stop must not close a later followup");
    assert.throws(() => recordOutcome(outcome(), { store, cwd: project.root }), /pending|settle|closure/i);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes WHERE route_id=?").get(route.routeId).n, 0);
  });
});

test("accepted QueueOnly work cannot settle until the wakeup and current final are observed", async () => {
  await withChild(async ({ store, context, route, child, input, finish, outcome, send, project }) => {
    send("queue-1", "send_message");
    assert.equal(store.status(context).stageClosure.reason, "accepted_message_not_consumed");
    send("wake-1");
    input(2, "child-turn-2", false);
    await finish("child-turn-2", "ONLY_QUEUE_HANDLED");
    assert.throws(() => recordOutcome(outcome(), { store, cwd: project.root }), /pending/i);
    input(3, "child-turn-3");
    await finish("child-turn-3", "ALL_REQUIREMENTS_HANDLED");
    // A duplicate old Stop cannot overwrite the newest native result.
    hook(project, "subagent-stop", { ...child, turn_id: "child-turn-1", last_assistant_message: "INITIAL_RESULT" });
    const closure = store.status(context).stageClosure;
    assert.equal(closure.state, "ready");
    assert.equal(closure.finalTurnId, "child-turn-3");
    assert.equal(closure.revision, 2);
    assert.throws(() => recordOutcome(outcome(), { store, cwd: project.root }), /closureToken/);
    const accepted = recordOutcome({ ...outcome(), closureToken: closure.token }, { store, cwd: project.root });
    assert.equal(accepted.recorded, true);
    assert.equal(store.status(context).delegationGate.state, "available");
    assert.equal(store.status(context).stageClosure, null);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes WHERE route_id=?").get(route.routeId).n, 1);
    assert.equal(send("late-business").pre.hookSpecificOutput.permissionDecision, "deny");
  });
});

test("same native turn may consume a followup without another SubagentStart", async () => {
  await withChild(async ({ store, context, input, finish, outcome, send, project }) => {
    send("same-turn-followup");
    input(2, "child-turn-1");
    await finish("child-turn-1", "UPDATED_SAME_TURN_RESULT");
    const closure = store.status(context).stageClosure;
    assert.equal(closure.state, "ready");
    assert.equal(closure.finalTurnId, "child-turn-1");
    assert.equal(recordOutcome({ ...outcome(), closureToken: closure.token }, { store, cwd: project.root }).recorded, true);
  });
});

test("a new requirement invalidates an otherwise ready root verification token", async () => {
  await withChild(async ({ store, context, input, finish, outcome, send, project }) => {
    send("followup-1"); input(2, "child-turn-2"); await finish("child-turn-2", "SECOND_RESULT");
    const staleToken = store.status(context).stageClosure.token;
    send("followup-2"); input(3, "child-turn-3"); await finish("child-turn-3", "THIRD_RESULT");
    assert.throws(() => recordOutcome({ ...outcome(), closureToken: staleToken }, { store, cwd: project.root }), /closureToken/);
    assert.equal(store.status(context).pendingOutcomes, 1);
    const current = store.status(context).stageClosure;
    assert.equal(recordOutcome({ ...outcome(), closureToken: current.token }, { store, cwd: project.root }).recorded, true);
  });
});

test("untracked native messages remain a concrete reconciliation item", async () => {
  await withChild(async ({ store, context, input, finish, outcome, send, project }) => {
    send("followup-1"); input(2, "child-turn-2"); input(3, "child-turn-2", false);
    await finish("child-turn-2", "EXTRA_INPUT_RESULT");
    assert.equal(store.status(context).stageClosure.reason, "message_history_requires_reconciliation");
    assert.throws(() => recordOutcome(outcome(), { store, cwd: project.root }), /pending/);
    const stop = store.handleStop(context);
    assert.equal(stop.action, "block");
    assert.equal(store.handleStop(context, { stopHookActive: true }).gateRetained, true);
  });
});

test("a missing Post cannot be hidden by a later native final", async () => {
  await withChild(async ({ store, context, input, finish, send }) => {
    send("lost-post", "followup_task", false); input(2, "child-turn-2");
    await finish("child-turn-2", "FOLLOWUP_RESULT");
    assert.equal(store.status(context).stageClosure.reason, "message_result_pending");
    assert.equal(send("unrelated-retry").pre.hookSpecificOutput.permissionDecision, "deny");
  });
});

test("read-only status has no writes and harmless accounting records do not invalidate verification", async () => {
  await withChild(async ({ store, context, input, finish, records, save, send }) => {
    send("followup-1"); input(2, "child-turn-2"); await finish("child-turn-2", "RESULT");
    const before = store.db.prepare("SELECT * FROM delegation_children").all();
    const closure = store.status(context).stageClosure;
    records.push({ type: "event_msg", payload: { type: "token_count", info: null } });
    await save();
    assert.equal(store.status(context).stageClosure.token, closure.token);
    assert.deepEqual(store.db.prepare("SELECT * FROM delegation_children").all(), before);
  });
});

test("native completion and an actual latest Stop are both required", async () => {
  await withChild(async ({ store, context, child, input, finish, records, save, send, project }) => {
    send("followup-1"); input(2, "child-turn-2");
    await finish("child-turn-2", "RESULT");
    records.pop(); // The latest final and Stop alone do not attest task completion.
    await save();
    assert.equal(store.status(context).stageClosure.reason, "latest_child_turn_not_complete");
    records.push({ type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn-2" } });
    await save();
    store.db.prepare("DELETE FROM delegation_child_stops WHERE turn_id='child-turn-2'").run();
    assert.equal(store.status(context).stageClosure.reason, "latest_stop_not_observed");
    hook(project, "subagent-stop", { ...child, turn_id: "child-turn-2", last_assistant_message: "WRONG_RESULT" });
    assert.equal(store.status(context).stageClosure.reason, "latest_stop_not_observed");
    hook(project, "subagent-stop", { ...child, turn_id: "child-turn-2", last_assistant_message: "RESULT" });
    assert.equal(store.status(context).stageClosure.state, "ready");
  });
});

test("duplicate Hook observations do not allocate another requirement", async () => {
  await withChild(async ({ store, context, send, project }) => {
    const { invocation } = send("one-call", "followup_task", false);
    hook(project, "pre-tool-use", invocation);
    hook(project, "post-tool-use", { ...invocation, tool_response: "" });
    hook(project, "post-tool-use", { ...invocation, tool_response: "" });
    assert.equal(store.status(context).stageClosure.revision, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_messages").get().n, 1);
    assert.equal(hook(project, "pre-tool-use", invocation).hookSpecificOutput.permissionDecision, "deny");
    const unrelated = hook(project, "pre-tool-use", { ...invocation, tool_use_id: "other-call",
      tool_input: { target: "ordinary_child", message: "unrelated" } });
    assert.equal(unrelated?.hookSpecificOutput?.permissionDecision, undefined);
  });
});

test("a reserved child cannot receive work without a trusted ownership record", async () => {
  const project = await temporaryProject("router unregistered message ");
  try {
    const result = hook(project, "pre-tool-use", { cwd: project.root, session_id: "root", turn_id: "turn",
      tool_name: "collaborationfollowup_task", tool_use_id: "call", tool_input: {
        target: `/root/router_${"a".repeat(32)}`, message: "gAAAA-work",
      } });
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  } finally { await project.cleanup(); }
});

test("child locators and native message content are not stored as plaintext", async () => {
  await withChild(async ({ store, context, send, project, route }) => {
    send("private-message");
    const persisted = JSON.stringify({ children: store.db.prepare("SELECT * FROM delegation_children").all(),
      messages: store.db.prepare("SELECT * FROM delegation_messages").all() });
    assert.equal(persisted.includes(project.root), false);
    assert.equal(persisted.includes(route.carrier.taskName), false);
    assert.equal(persisted.includes("gAAAA-private-message"), false);
    assert.equal(store.status(context).stageClosure.revision, 1);
  });
});

test("the exact native call reconciles a lost Post without resending its message", async () => {
  await withChild(async ({ store, context, send, input, finish, manage, outcome, project }) => {
    send("missing-post", "followup_task", false);
    input(2, "child-turn-2");
    await finish("child-turn-2", "SUPPLEMENT_FULFILLED");
    assert.equal(store.status(context).stageClosure.reason, "message_result_pending");
    const result = await manage("reconcile_messages");
    assert.equal(result.reconciledCalls, 1);
    assert.deepEqual(result.pendingCalls, []);
    const closure = store.status(context).stageClosure;
    assert.equal(closure.state, "ready");
    recordOutcome({ ...outcome(), closureToken: closure.token }, { store, cwd: project.root });
  });
});

test("reconciliation cannot substitute a changed native input or another root", async () => {
  await withChild(async ({ send, manage, parentRecords, saveParent, store, context }) => {
    send("missing-post", "followup_task", false);
    const before = store.db.prepare("SELECT * FROM delegation_messages").all();
    parentRecords.at(-2).payload.arguments = JSON.stringify({ target: "different", message: "changed" });
    saveParent();
    await assert.rejects(manage("reconcile_messages"), /missing|changed/i);
    assert.deepEqual(store.db.prepare("SELECT * FROM delegation_messages").all(), before);
    parentRecords[0].payload.id = "other-root"; saveParent();
    await assert.rejects(manage("reconcile_messages"), /ownership/i);
    assert.equal(store.status(context).stageClosure.reason, "message_result_pending");
  });
});

test("a finalized child performs bounded collection with real tool denial and no second outcome", async () => {
  await withChild(async ({ store, context, route, child, input, finish, outcome, send, project, manage }) => {
    recordOutcome(outcome(), { store, cwd: project.root });
    const oldOutcome = store.db.prepare("SELECT * FROM outcomes").all();
    const beforeBytes = store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes;
    const start = await manage("begin_maintenance", { disposition: disposition() });
    assert.equal(start.nextAction, "followup_bounded_collection");
    assert.equal(store.handleStop(context).action, "block", "maintenance is checked even without an active delegation ticket");
    for (const tool of ["exec_command", "apply_patch", "functions.exec", "collaborationspawn_agent", "collaborationsend_message"]) {
      const output = hook(project, "pre-tool-use", { ...child, tool_name: tool, tool_use_id: `blocked-${tool}`, tool_input: {} });
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny", tool);
    }
    assert.equal(send("courtesy", "send_message").pre.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(send("collect").pre.hookSpecificOutput, undefined);
    input(2, "maintenance-turn"); await finish("maintenance-turn", "RETAINED_REQUIREMENTS_AND_OPERATION_REFERENCES");
    const closure = store.status(context).stageClosure;
    assert.equal(closure.state, "ready");
    await assert.rejects(manage("verify_maintenance", { closureToken: closure.token,
      disposition: { ...disposition(), resultReview: "Too vague; omitted the received input" } }), /Every collected/);
    const report = reviewed(closure);
    const verified = await manage("verify_maintenance", { closureToken: closure.token, disposition: report });
    assert.equal(verified.state, "verified");
    assert.deepEqual(store.db.prepare("SELECT * FROM outcomes").all(), oldOutcome);
    assert.equal(store.status(context).stageClosure, null);
    const afterBytes = store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes;
    assert.ok(afterBytes >= beforeBytes);
    assert.equal((await manage("verify_maintenance", { closureToken: closure.token, disposition: report })).idempotent, true);
    assert.equal(store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes, afterBytes);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_stage_journal WHERE route_id=? AND kind IN ('intent','verification')").get(route.routeId).n, 2);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_stage_journal WHERE route_id=? AND kind LIKE 'message_host:%'").get(route.routeId).n, 2);
    assert.equal(send("new-business").pre.hookSpecificOutput.permissionDecision, "deny");
  });
});

test("legacy child identity and retained messages are adopted without reopening its outcome", async () => {
  await withChild(async ({ store, context, route, child, input, finish, outcome, project, manage, parentRecords, saveParent }) => {
    recordOutcome(outcome(), { store, cwd: project.root });
    store.db.prepare("DELETE FROM delegation_children WHERE route_id=?").run(route.routeId); // v6 snapshot
    parentRecords.push({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "send_message", call_id: "legacy-queue",
      arguments: JSON.stringify({ target: `/root/${route.carrier.taskName}`, message: "host-owned-ciphertext" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "legacy-queue", output: "" } });
    saveParent();
    const start = await manage("begin_maintenance", { childId: child.agent_id, childTranscriptPath: child.transcript_path, disposition: disposition() });
    assert.equal(start.revision, 1);
    assert.equal(store.status(context).stageClosure.reason, "maintenance_followup_required");
    const invocation = { session_id: "closure-root", cwd: project.root, turn_id: "root-turn", tool_name: "collaborationfollowup_task", tool_use_id: "maintenance-wake",
      tool_input: { target: start.target, message: "encrypted-collection" } };
    hook(project, "pre-tool-use", invocation); hook(project, "post-tool-use", { ...invocation, tool_response: "" });
    input(2, "legacy-collection", false); input(3, "legacy-collection", true);
    await finish("legacy-collection", "COLLECTED_ORIGINAL_REQUEST_WITHOUT_EXECUTION");
    const closure = store.status(context).stageClosure;
    assert.equal(closure.state, "ready");
    await manage("verify_maintenance", { closureToken: closure.token, disposition: reviewed(closure) });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
  });
});

test("legacy reconciliation uses the native task directory when MCP runs from its plugin cache", async () => {
  await withChild(async ({ store, context, route, child, outcome, project, parentPath }) => {
    store.observeHostModel(context, "gpt-6-astra", { detectChanges: false });
    recordOutcome(outcome(), { store, cwd: project.root });
    store.db.prepare("DELETE FROM delegation_children WHERE route_id=?").run(route.routeId);
    const args = { contextId: "closure-root", routeId: route.routeId, action: "reconcile_messages", expectedRevision: 0,
      childId: child.agent_id, childTranscriptPath: child.transcript_path, parentTranscriptPath: parentPath };
    const before = store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(route.routeId);
    let reads = 0;
    const stageOptions = { readParent: async (id) => { reads += 1; assert.equal(id, args.contextId); return { id, cwd: project.root }; } };
    const reconciled = await callRouterTool("manage_stage", args, { store, cwd: pluginRoot, stageOptions });
    assert.equal(reads, 1);
    assert.equal(reconciled.reconciledCalls, 0);
    assert.equal(store.db.prepare("SELECT state FROM delegation_children WHERE route_id=?").get(route.routeId).state, "settled");
    assert.deepEqual(store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").get(route.routeId), before);
  });
});

test("legacy reconciliation rejects a native root from another task or project before adopting a child", async () => {
  await withChild(async ({ store, context, route, child, outcome, project, parentPath }) => {
    store.observeHostModel(context, "gpt-6-astra", { detectChanges: false });
    recordOutcome(outcome(), { store, cwd: project.root });
    store.db.prepare("DELETE FROM delegation_children WHERE route_id=?").run(route.routeId);
    const args = { contextId: "closure-root", routeId: route.routeId, action: "reconcile_messages", expectedRevision: 0,
      childId: child.agent_id, childTranscriptPath: child.transcript_path, parentTranscriptPath: parentPath };
    for (const parent of [{ id: "another-root", cwd: project.root }, { id: args.contextId, cwd: pluginRoot }]) {
      await assert.rejects(callRouterTool("manage_stage", args, { store, cwd: pluginRoot,
        stageOptions: { readParent: async () => parent } }), /incomplete|inconsistent/);
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM delegation_children WHERE route_id=?").get(route.routeId).n, 0);
    }
  });
});

for (const intent of ["cancelled", "superseded", "deferred"]) test(`${intent} work retains its disposition and cannot be reported as passed`, async () => {
  await withChild(async ({ store, context, child, send, input, finish, outcome, project, manage }) => {
    await manage("begin_maintenance", { disposition: disposition(intent) });
    const denial = hook(project, "pre-tool-use", { ...child, tool_name: "exec_command", tool_use_id: "obsolete-write", tool_input: { cmd: "would write" } });
    assert.equal(denial.hookSpecificOutput.permissionDecision, "deny");
    send("cancel-collection"); input(2, "cancel-collection"); await finish("cancel-collection", "PARTIAL_WORK_AND_PENDING_REQUESTS_PRESERVED");
    const closure = store.status(context).stageClosure;
    await assert.rejects(manage("verify_maintenance", { closureToken: closure.token,
      disposition: { ...reviewed(closure, intent), pendingOperations: ["old external write is still running"] } }), /resolve pending/);
    await manage("verify_maintenance", { closureToken: closure.token, disposition: reviewed(closure, intent) });
    assert.throws(() => recordOutcome({ ...outcome(), closureToken: closure.token }, { store, cwd: project.root }), /must not be reported as passed/);
    recordOutcome({ ...outcome(), closureToken: closure.token, status: "failed", failureType: "information" }, { store, cwd: project.root });
    assert.equal(store.status(context).stageClosure, null);
    assert.equal(store.status(context).delegationGate.state, "available");
  });
});

test("an unanswered native tool cannot be hidden by a final reply and task_complete", async () => {
  await withChild(async ({ records, save, store, context, finish }) => {
    records.push({ type: "response_item", payload: { type: "function_call", call_id: "unfinished-tool", name: "exec_command", arguments: "{}" } });
    await finish("child-turn-1", "FINAL_WITH_UNRESOLVED_TOOL");
    assert.equal(store.status(context).stageClosure.reason, "latest_child_turn_not_complete");
    records.push({ type: "response_item", payload: { type: "function_call_output", call_id: "unfinished-tool", output: "actual terminal result" } });
    await save();
    assert.equal(store.status(context).stageClosure.state, "ready");
  });
});

test("interrupt acceptance is recorded independently from actual execution completion", async () => {
  await withChild(async ({ store, context, route, root, manage, project, records, save, input, finish, send }) => {
    const invocation = { ...root, tool_name: "collaborationinterrupt_agent", tool_use_id: "stop-request", tool_input: { target: `/root/${route.carrier.taskName}` } };
    assert.equal(hook(project, "pre-tool-use", invocation).hookSpecificOutput.permissionDecision, "deny", "intent must change before old business tools can continue");
    await manage("begin_maintenance", { disposition: disposition("cancelled") });
    records.push({ type: "event_msg", payload: { type: "task_started", turn_id: "still-running" } }); await save();
    assert.equal(hook(project, "pre-tool-use", invocation).hookSpecificOutput, undefined);
    hook(project, "post-tool-use", { ...invocation, tool_response: JSON.stringify({ previous_status: "running" }) });
    assert.equal(store.status(context).stageClosure.reason, "latest_child_turn_not_complete");
    send("collect-after-interrupt"); input(2, "still-running"); await finish("still-running", "EXTERNAL_OPERATIONS_MUST_BE_VERIFIED_BY_ROOT");
    assert.equal(store.status(context).stageClosure.state, "ready");
    assert.equal(store.db.prepare("SELECT status FROM delegation_messages WHERE kind='interrupt_agent'").get().status, "accepted");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 0);
  });
});

test("a yielded native process remains pending until its exact poll returns a terminal envelope", async () => {
  await withChild(async ({ records, finish, store, context, save }) => {
    records.push({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "process-start", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "process-start",
        output: "Chunk ID: live\nWall time: 1 seconds\nProcess running with session ID 42\nOutput:\nProcess exited with code 0" } });
    await finish("child-turn-1", "CANNOT_HIDE_RUNNING_PROCESS");
    assert.equal(store.status(context).stageClosure.reason, "child_operations_pending");
    records.push({ type: "response_item", payload: { type: "function_call", name: "write_stdin", call_id: "wrong-process", arguments: '{"session_id":43}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "wrong-process", output: "Chunk ID: done\nProcess exited with code 0\nOutput:\n" } });
    await save();
    assert.equal(store.status(context).stageClosure.pendingOperations[0].id, "42");
    records.push({ type: "response_item", payload: { type: "function_call", name: "write_stdin", call_id: "right-process", arguments: '{"session_id":42}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "right-process", output: "Chunk ID: done\nProcess exited with code 0\nOutput:\n" } });
    await finish("child-turn-1", "VERIFIED_PROCESS_ENDED");
    assert.equal(store.status(context).stageClosure.state, "ready");
  });
});

test("a sibling sender's lost Post is reconciled from that exact same-tree native call", async () => {
  await withChild(async ({ project, child, root, records, input, finish, store, context, manage }) => {
    const senderPath = join(project.root, "sender.jsonl");
    const sender = "/root/sender";
    const meta = { ...records[0].payload, id: "sender-child", agent_path: sender,
      source: { subagent: { thread_spawn: { parent_thread_id: "closure-root", depth: 1, agent_path: sender } } } };
    const args = { target: records[0].payload.agent_path, message: "host-owned-ciphertext" };
    const senderRecords = [{ type: "session_meta", payload: meta }, { type: "turn_context", payload: { turn_id: "sender-turn" } }];
    const saveSender = () => writeFileSync(senderPath, senderRecords.map(JSON.stringify).join("\n") + "\n");
    saveSender();
    const pre = hook(project, "pre-tool-use", { ...root, ...child, agent_id: "sender-child", turn_id: "sender-turn",
      transcript_path: senderPath, agent_transcript_path: senderPath,
      tool_name: "collaborationsend_message", tool_use_id: "sibling-send", tool_input: args });
    assert.notEqual(pre?.hookSpecificOutput?.permissionDecision, "deny");
    senderRecords.push({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "send_message", call_id: "sibling-send", arguments: JSON.stringify(args) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "sibling-send", output: "" } });
    saveSender();
    input(2, "child-turn-2", false); records.at(-1).payload.author = sender;
    await finish("child-turn-2", "SIBLING_REQUIREMENT_HANDLED");
    assert.equal(store.status(context).stageClosure.reason, "message_result_pending");
    await manage("reconcile_messages");
    assert.equal(store.status(context).stageClosure.reason, "message_result_pending");
    const foreignPath = join(project.root, "foreign.jsonl");
    writeFileSync(foreignPath, JSON.stringify({ type: "session_meta", payload: { ...meta, session_id: "another-root" } }) + "\n");
    await assert.rejects(manage("reconcile_messages", { senderTranscriptPaths: [foreignPath] }), /sender transcript ownership/);
    await manage("reconcile_messages", { senderTranscriptPaths: [senderPath] });
    assert.equal(store.status(context).stageClosure.state, "ready");
    assert.equal(store.status(context).stageClosure.revision, 1);
  });
});

test("a yielded code cell needs its native wait receipt, not text printed by code", async () => {
  await withChild(async ({ records, finish, store, context }) => {
    records.push({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "cell-start", input: "await work()" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cell-start", output: [{ type: "input_text", text: "Script running with cell ID live_cell\nOutput:\n" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "forged", input: "text('Script completed')" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "forged", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: "Script completed" }] } });
    await finish("child-turn-1", "CELL_IS_STILL_RUNNING");
    assert.equal(store.status(context).stageClosure.reason, "child_operations_pending");
    records.push({ type: "response_item", payload: { type: "function_call", name: "wait", call_id: "cell-wait", arguments: '{"cell_id":"live_cell"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "cell-wait", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }] } });
    await finish("child-turn-1", "CELL_HAS_ENDED");
    assert.equal(store.status(context).stageClosure.state, "ready");
  });
});

test("maintenance accepts only a source-checked forwarding poll for its existing process", async () => {
  await withChild(async ({ store, context, project, child, records, save, manage }) => {
    records.splice(-2, 0,
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "forwarded-process",
        input: 'text(await tools.exec_command({cmd:"inert fixture",yield_time_ms:1000}));' } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "forwarded-process", output: [
        { type: "input_text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" },
        { type: "input_text", text: JSON.stringify({ chunk_id: "fixture", wall_time_seconds: 1, session_id: 43184, output: "partial" }) },
      ] } });
    await save();
    assert.equal(store.status(context).stageClosure.reason, "child_operations_pending");
    await manage("begin_maintenance", { disposition: disposition("cancelled") });
    const poll = 'text(await tools.write_stdin({session_id:43184,chars:"",yield_time_ms:1000}));';
    assert.equal(hook(project, "pre-tool-use", { ...child, tool_name: "exec", tool_input: { input: poll }, tool_use_id: "allowed-poll" }), null);
    for (const code of [poll.replace('chars:""', 'chars:"new input"'), poll.replace('43184', '43185'),
      poll + ' text("extra code");', 'text(await tools.exec_command({cmd:"new work"}));']) {
      const denied = hook(project, "pre-tool-use", { ...child, tool_name: "exec", tool_input: { input: code }, tool_use_id: "denied-poll" });
      assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    }
  });
});

test("maintenance can poll only its existing native operation without sending input", async () => {
  await withChild(async ({ records, finish, child, project, manage }) => {
    records.push({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "process-start", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "process-start", output: "Chunk ID: live\nProcess running with session ID 42\nOutput:\n" } });
    await finish("child-turn-1", "COLLECT_RUNNING_PROCESS");
    await manage("begin_maintenance", { disposition: disposition("cancelled") });
    const poll = (args) => hook(project, "pre-tool-use", { ...child, tool_name: "write_stdin", tool_use_id: "poll", tool_input: args });
    assert.notEqual(poll({ session_id: 42, chars: "" })?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(poll({ session_id: 43 })?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(poll({ session_id: 42, chars: "continue\n" })?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(hook(project, "pre-tool-use", { ...child, tool_name: "exec", tool_use_id: "code", tool_input: { code: "poll()" } })?.hookSpecificOutput?.permissionDecision, "deny");
  });
});

test("history trimming preserves maintenance identity and accounts only newly added transcript bytes", async () => {
  await withChild(async ({ store, context, route, outcome, project, manage, send, input, finish }) => {
    recordOutcome(outcome(), { store, cwd: project.root });
    const oldBytes = store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes;
    store.db.prepare("DELETE FROM delegation_attempts WHERE route_id=?").run(route.routeId);
    await manage("begin_maintenance", { disposition: disposition() });
    send("after-trim"); input(2, "after-trim"); await finish("after-trim", "PRESERVED_AFTER_HISTORY_TRIM " + "x".repeat(10000));
    const closure = store.status(context).stageClosure;
    await manage("verify_maintenance", { closureToken: closure.token, disposition: reviewed(closure) });
    const total = store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get().total_transcript_bytes;
    assert.equal(total, Math.max(oldBytes, closure.transcriptBytes));
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
  });
});

test("transferred requirements survive root reentry until their actual resolution is recorded", async () => {
  await withChild(async ({ store, context, root, outcome, project, manage, send, input, finish }) => {
    recordOutcome(outcome(), { store, cwd: project.root });
    await manage("begin_maintenance", { disposition: disposition() });
    send("retained-work"); input(2, "retained-work"); await finish("retained-work", "PENDING_REQUIREMENT_FOR_THE_ROOT");
    const closure = store.status(context).stageClosure;
    const report = reviewed(closure);
    await manage("verify_maintenance", { closureToken: closure.token, disposition: report });
    const pending = store.status(context).pendingStageWork;
    assert.equal(pending.length, 1);
    assert.equal(store.handleStop(context).action, "block");
    assert.equal(store.handleStop(context, { stopHookActive: true }).action, "allow", "no infinite Stop loop");
    store.configure(context, { autoActivate: true }, "global");
    const resumed = hook(project, "prompt", { ...root, turn_id: "next-real-turn", prompt: "Continue the authorized work" });
    assert.match(resumed.hookSpecificOutput.additionalContext, /pendingStageWork|responsibilities/);
    const read = await manage("read_disposition");
    assert.deepEqual(read.disposition, report);
    await manage("resolve_requirements", { disposition: { ...report,
      basis: "The transferred work has now been completed in the current root stage.",
      requirements: report.requirements.map((r) => ({ ...r, disposition: "fulfilled", receipt: "Verified the actual result and its test receipt" })) } });
    assert.deepEqual(store.status(context).pendingStageWork, []);
    assert.equal(store.handleStop(context).action, "allow");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
  });
});

test("a frozen native inventory can verify a followup through the existing stdio bridge", async () => {
  await withChild(async ({ store, context, root, project, send, input, finish, outcome }) => {
    hook(project, "prompt", { ...root, prompt: "Continue the current task" });
    send("frozen-tool-followup"); input(2, "frozen-followup"); await finish("frozen-followup", "FOLLOWUP_RESULT_VERIFIED_BY_ROOT");
    const closure = store.status(context).stageClosure;
    const result = spawnSync(process.execPath, [join(pluginRoot, "scripts/stdio-tool.mjs")], {
      cwd: project.root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
      input: JSON.stringify({ name: "record_outcome", arguments: { ...outcome(), closureToken: closure.token } }) + "\n",
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).structuredContent.recorded, true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
    const read = spawnSync(process.execPath, [join(pluginRoot, "scripts/stdio-tool.mjs")], {
      cwd: project.root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: project.home, ADAPTIVE_ROUTER_LOCAL_ONLY: "1" },
      input: JSON.stringify({ name: "manage_stage", arguments: { contextId: root.session_id, routeId: outcome().routeId,
        expectedRevision: closure.revision, action: "reconcile_messages" } }) + "\n",
    });
    assert.equal(read.status, 0, read.stderr + read.stdout);
    assert.equal(JSON.parse(read.stdout).structuredContent.reconciledCalls, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n, 1);
  });
});
