#!/usr/bin/env node
// Two actual native roots in one AppServer and one Router database. Fixed
// responses isolate native residency/ownership; they do not assess model quality.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppServerClient, resolveCodexCommand } from "../plugins/adaptive-model-router/scripts/lib/app-server.mjs";
import { RouterStore } from "../plugins/adaptive-model-router/scripts/lib/database.mjs";
import { evaluateLifecycleHookInventory } from "../plugins/adaptive-model-router/scripts/lib/hook-readiness.mjs";
import { runtimeSourceDigest, readTaskQualification } from "../plugins/adaptive-model-router/scripts/lib/lifecycle-qualification.mjs";
import { ResidencyModelRelay } from "../plugins/adaptive-model-router/scripts/lib/residency-model-relay.mjs";
import { CAPACITY_REJECTION } from "../plugins/adaptive-model-router/scripts/lib/host-capacity-recovery.mjs";
import { openPrivateState } from "../plugins/adaptive-model-router/scripts/lib/private-state.mjs";
import { payloadHash } from "../plugins/adaptive-model-router/scripts/lib/io.mjs";

assert.equal(process.platform, "darwin"); assert.equal(process.argv.length, 2);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "router-shared-root-acceptance-")));
process.env.ADAPTIVE_ROUTER_HOME = join(scratch, "router-state");
const store = new RouterStore(), roots = [], children = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let pid, pluginRoot, sourceDigest, report;
const client = new AppServerClient({ timeoutMs: 60000,
  async resolveImpl() { const c = await resolveCodexCommand(); return { ...c, path: realpathSync(c.path) }; },
  spawnImpl(command, args, options) {
    const child = spawn(command, ["--dangerously-bypass-approvals-and-sandbox", ...args], { ...options, cwd: scratch, detached: true });
    pid = child.pid; return child;
  },
});
const target = (route) => `/root/${route.carrier.taskName}`;
class Root {
  constructor(label) { this.label = label; this.marker = `ROOT_${label}_${randomBytes(12).toString("hex")}`; this.relay = new ResidencyModelRelay(this.marker); }
  async start() {
    const baseUrl = await this.relay.start();
    this.id = (await client.request("thread/start", { model: "gpt-6-astra", cwd: scratch, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
      config: { model_provider: `shared_${this.label}`, [`model_providers.shared_${this.label}`]: { name: "Native isolation response control", base_url: baseUrl, wire_api: "responses", requires_openai_auth: false },
        "features.responses_websockets": false, "features.responses_websockets_v2": false,
        "features.multi_agent_v2": { enabled: true, max_concurrent_threads_per_session: 4 },
        "mcp_servers.residency_isolation": { command: process.execPath, args: [join(pluginRoot, "scripts/node-launcher.mjs"), join(pluginRoot, "scripts/mcp-server.mjs")], cwd: scratch,
          env: { ADAPTIVE_ROUTER_HOME: process.env.ADAPTIVE_ROUTER_HOME }, enabled_tools: ["route_stage", "record_outcome", "get_route_status", "manage_stage"], default_tools_approval_mode: "approve" } },
      developerInstructions: "Disposable native isolation acceptance. Execute only exact supplied collaboration calls. Unmanaged pressure children carry synthetic requirements. Router stages use exact carrier parameters. No business tools, writes, extra children, retries or model changes. The external driver owns checks, maintenance and outcomes; keep this root turn open until its final marker.",
    })).thread.id;
    this.context = store.context({ cwd: scratch, contextId: this.id }); store.configure(this.context, { autoActivate: true }, "global");
    this.turnId = (await client.request("turn/start", { threadId: this.id, effort: "high", input: [{ type: "text", text: this.marker }] })).turn.id;
    await this.relay.waitForRoot();
  }
  async call(tool, args = {}) {
    const r = await client.request("mcpServer/tool/call", { threadId: this.id, server: "residency_isolation", tool, arguments: { contextId: this.id, ...args } });
    const text = r.content?.find((c) => c.type === "text")?.text; if (r.isError) throw Error(`${tool}: ${text}`); return r.structuredContent || JSON.parse(text);
  }
  route(stageId, goal) { return this.call("route_stage", { stageId, phase: "shared-native-roots", goal,
    evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
    hostCapabilities: { delegation: { available: true, invocation: "direct", targets: [{ model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] } } }); }
  dispatch(r) { assert.equal(r.action, "delegate"); return this.relay.native("spawn_agent", { task_name: r.carrier.taskName, message: r.carrier.message, fork_turns: "none", model: r.target.model, reasoning_effort: r.target.effort }); }
  async list() { const r = JSON.parse(await this.relay.native("list_agents", {})); assert.ok(r.agents.length <= 4); return r; }
  async completed(name, expected) {
    for (let n = 0; n < 100; n++) { const r = await this.list(); const s = r.agents.find((a) => a.agent_name === name)?.agent_status;
      if (s?.completed === expected) return r; assert.ok(!s?.errored); await pause(50); }
    throw Error("exact native child result was not returned");
  }
  async outcome(r, closure, failed = false) { return this.call("record_outcome", { routeId: r.routeId, status: failed ? "failed" : "passed", failureType: failed ? "tooling" : null,
    gate: r.verificationGate, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false, ...(closure ? { closureToken: closure.token } : {}) }); }
  async settle(r, expected) { await this.completed(target(r), expected); const s = await this.call("get_route_status"); assert.equal(s.stageClosure?.state, "ready"); await this.outcome(r, s.stageClosure); return s.stageClosure; }
  async manage(r, action, extra = {}) { const revision = store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(r.routeId).revision;
    return this.call("manage_stage", { routeId: r.routeId, expectedRevision: revision, action, ...extra }); }
  locator(r) { return JSON.parse(openPrivateState(store.db, store.db.prepare("SELECT locator FROM delegation_children WHERE route_id=?").get(r.routeId).locator)); }
  usage() { return store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage WHERE project_id=? AND context_key=?").get(this.context.projectId, this.context.contextKey)?.total_transcript_bytes || 0; }
  accounting(r) { return { usage: this.usage(),
    child: store.db.prepare("SELECT accounted_bytes FROM delegation_children WHERE route_id=?").get(r.routeId).accounted_bytes,
    maintenance: store.db.prepare("SELECT accounted_bytes FROM delegation_maintenance WHERE route_id=?").get(r.routeId).accounted_bytes }; }
  async finish() { const wait = client.createWaiter((e) => e.method === "turn/completed" && e.params.threadId === this.id, Date.now() + 30000); this.relay.finish(); const e = await wait.promise; assert.equal(e.params.turn.status, "completed"); this.terminal = true; }
}
try {
  await client.start(); const inventory = await client.listHooks(scratch);
  const hooks = inventory.data.find((entry) => entry.cwd === scratch)?.hooks.filter((h) => h.pluginId === "adaptive-model-router@adaptive-model-router");
  pluginRoot = hooks?.[0]?.sourcePath && dirname(dirname(hooks[0].sourcePath));
  assert.ok(pluginRoot && evaluateLifecycleHookInventory(inventory, { cwd: scratch, pluginRoot }).ready);
  sourceDigest = runtimeSourceDigest(); assert.equal(sourceDigest, runtimeSourceDigest(pluginRoot));
  client.subscribe((e) => { if (e.method === "item/completed" && roots.some((r) => r.id === e.params.threadId) && e.params.item?.type === "subAgentActivity" && e.params.item.kind === "started") children.add(e.params.item.agentThreadId); });
  for (const label of ["A", "B"]) { const r = new Root(label); roots.push(r); await r.start(); }
  for (const r of roots) {
    const q = await r.route("qualify", "Return the no-tool qualification marker."); assert.ok(q.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"));
    const marker = readTaskQualification(store.db, r.context).marker; r.relay.addChild(marker); await r.dispatch(q); await r.settle(q, marker);
    r.original = `ORIGINAL_${r.label}_${randomBytes(6).toString("hex")}`; r.supplements = [`COLLECT_${r.label}_1`, `COLLECT_${r.label}_2`];
    r.old = await r.route("original-completed-result", `Return ${r.original}. Preserve it and any later exact collection markers; no tools.`);
    r.relay.addChild(r.original, r.supplements); await r.dispatch(r.old); await r.settle(r.old, r.original);
    r.oldChildId = r.locator(r.old).childId;
    r.oldOutcome = payloadHash(store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").all(r.old.routeId));
    r.pressure = [];
    for (let i = 0; i < 3; i++) {
      const original = `PRESSURE_${r.label}_${i}`, supplement = `PENDING_${r.label}_${i}`, name = `pressure_${r.label.toLowerCase()}_${i}`;
      r.relay.addChild(original, [supplement]);
      assert.equal(JSON.parse(await r.relay.native("spawn_agent", { task_name: name, message: `Return ${original}; retain later supplement markers without tools.`, fork_turns: "none", model: "gpt-6-astra", reasoning_effort: "high" })).task_name, `/root/${name}`);
      await r.completed(`/root/${name}`, original); await r.relay.native("send_message", { target: `/root/${name}`, message: supplement });
      r.pressure.push({ target: `/root/${name}`, original, supplement });
    }
    r.fullList = await r.list(); assert.ok(!r.fullList.agents.some((a) => a.agent_name === target(r.old)), "the old child must actually leave the native resident list");
    assert.ok(r.pressure.every((p) => r.fullList.agents.some((a) => a.agent_name === p.target && a.agent_status.completed === p.original)));
    r.refused = await r.route("still-needed-result", `Return RECOVERED_${r.label} without tools.`);
    assert.equal(await r.dispatch(r.refused), CAPACITY_REJECTION); await r.outcome(r.refused, null, true);
  }
  emit({ stage: "two-full-roots", roots: roots.map((r) => r.id), sameAppServerPid: pid, sharedRouterDatabase: true, sourceDigest });
  const [a, b] = roots;
  const bUsageBeforeRecovery = b.usage(), accounting = [];
  assert.ok(a.usage() > 0 && bUsageBeforeRecovery > 0);
  const aggregateUsage = () => store.db.prepare("SELECT SUM(total_transcript_bytes) AS n FROM delegation_usage").get().n;
  assert.equal(aggregateUsage(), a.usage() + b.usage(), "shared database retains both root budgets");
  const completePressure = async (r, p) => { await r.relay.native("followup_task", { target: p.target, message: "Complete the still-pending supplement and return original plus supplement. No new work." }); await r.completed(p.target, `${p.original}|${p.supplement}`); p.done = true; };
  await completePressure(a, a.pressure[0]);
  let priorRequirements = [];
  for (const supplement of a.supplements) {
    await a.manage(a.old, "begin_maintenance", { disposition: { intent: "collect", basis: `Collect original result and exact authorized ${supplement} after native cache eviction.`, requirements: priorRequirements, pendingOperations: [] } });
    // Fixed-response byte pressure crosses filesystem allocation boundaries;
    // it is not a semantic model-quality fixture.
    await a.relay.native("followup_task", { target: target(a.old), message: `Only collect your original result and ${supplement}; preserve earlier collected markers, no business tools. Byte-accounting fixture padding: ${".".repeat(65536)}` });
    await a.completed(target(a.old), [a.original, ...a.supplements.slice(0, a.supplements.indexOf(supplement) + 1)].join("|"));
    const s = await a.call("get_route_status"); assert.equal(s.stageClosure?.state, "ready"); assert.equal(a.locator(a.old).childId, a.oldChildId);
    const requirements = s.stageClosure.inputReferences.slice(1).map((input) => priorRequirements.find((p) => p.messageId === input.id) || { messageId: input.id, source: `native collection ${input.id}`, disposition: "fulfilled", owner: "/root", receipt: "Exact original result and each collection marker verified in this same reloaded native child." });
    const before = a.accounting(a.old), beforeAggregate = aggregateUsage();
    const verification = { closureToken: s.stageClosure.token, disposition: { intent: "collect", basis: "Completed authorized synthetic collection only.", requirements, pendingOperations: [], resultReview: "Native resident absence before followup, same persistent child identity after reload, all input markers and actual latest Stop verified; old business result remains unchanged." } };
    await a.manage(a.old, "verify_maintenance", verification);
    const after = a.accounting(a.old), delta = Math.max(0, s.stageClosure.transcriptBytes - Math.max(before.child, before.maintenance));
    assert.equal(after.usage - before.usage, delta);
    assert.equal(after.child, s.stageClosure.transcriptBytes); assert.equal(after.maintenance, s.stageClosure.transcriptBytes);
    assert.equal(aggregateUsage() - beforeAggregate, delta); assert.equal(b.usage(), bUsageBeforeRecovery);
    await a.call("get_route_status"); await a.manage(a.old, "read_disposition");
    assert.equal((await a.manage(a.old, "verify_maintenance", verification)).idempotent, true);
    assert.deepEqual(a.accounting(a.old), after, "repeated reads and identical verification cannot count bytes twice");
    accounting.push({ closureBytes: s.stageClosure.transcriptBytes, before, after, delta, repeatedVerificationUnchanged: true });
    priorRequirements = requirements;
    assert.equal(payloadHash(store.db.prepare("SELECT * FROM outcomes WHERE route_id=?").all(a.old.routeId)), a.oldOutcome);
  }
  assert.ok(accounting.reduce((sum, row) => sum + row.delta, 0) > 0, "real reloaded followups must exercise positive measured byte growth");
  const bUnchanged = await b.list(); assert.deepEqual(bUnchanged, b.fullList, "A recovery must not consume, evict or alter B's resident requirements");
  for (const r of roots) {
    if (!r.pressure[0].done) await completePressure(r, r.pressure[0]);
    r.recovered = await r.route("still-needed-result", `Return RECOVERED_${r.label} without tools.`);
    assert.notEqual(r.recovered.routeId, r.refused.routeId); r.relay.addChild(`RECOVERED_${r.label}`); await r.dispatch(r.recovered); await r.settle(r.recovered, `RECOVERED_${r.label}`);
    for (const p of r.pressure.filter((p) => !p.done)) await completePressure(r, p);
    const s = await r.call("get_route_status"); assert.equal(s.pendingOutcomes, 0); assert.equal(s.stageClosure, null); assert.deepEqual(s.pendingStageWork, []);
    await r.finish();
  }
  report = { passed: true, sourceDigest, syntheticResponses: true, sameAppServerPid: pid, sharedRouterDatabase: true, configuredTotalCapacityPerRoot: 4,
    roots: roots.map((r) => ({ rootId: r.id, originalChildId: r.oldChildId, refusedRouteId: r.refused.routeId, recoveredRouteId: r.recovered.routeId, nativeCalls: r.relay.nativeCalls, fullResidentInventory: r.fullList })),
    lru: { originalRouteId: a.old.routeId, originalChildId: a.oldChildId, absentBeforeReload: true, sameChildAfterReload: true, verifiedFollowups: 2, originalOutcomeUnchanged: true, accounting },
    isolation: { sixResidentChildrenAcrossTwoRoots: true, bothExactCapacityRefusals: true, otherRootInventoryUnchangedDuringRecovery: true, sharedBudgetAndPerRootDeltasMatched: true, independentNewTicketRecovery: true, allSupplementalResultsPreserved: true } };
} catch (error) { process.exitCode = 1; report = { passed: false, sourceDigest, roots: roots.map((r) => r.id), failure: String(error.stack || error).slice(0, 2500) }; }
finally {
  for (const r of roots) if (r.id && !r.terminal) try { await client.request("turn/interrupt", { threadId: r.id, turnId: r.turnId }, Date.now() + 5000); } catch { /* exact owned host cleanup follows */ }
  for (const id of [...children, ...roots.filter((r) => r.terminal).map((r) => r.id)]) try { await client.request("thread/archive", { threadId: id }, Date.now() + 5000); } catch { /* archive is not residency proof */ }
  store.close(); client.close(); for (const r of roots) await r.relay.close();
  let absent = !pid; if (pid) { try { process.kill(-pid, "SIGTERM"); } catch { /* verify below */ } for (let n = 0; n < 40; n++) { try { process.kill(-pid, 0); } catch (e) { if (e.code === "ESRCH") { absent = true; break; } } await pause(50); } }
  report.cleanup = { ownedProcessGroupAbsent: absent }; if (!absent) { report.passed = false; process.exitCode = 1; }
  const path = join(scratch, "shared-roots-report.json"); writeFileSync(path, JSON.stringify(report, null, 2) + "\n"); emit({ stage: report.passed ? "verified" : "failed", report: path, ...(report.failure ? { failure: report.failure } : {}) });
}
