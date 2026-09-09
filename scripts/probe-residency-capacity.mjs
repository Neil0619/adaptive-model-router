#!/usr/bin/env node
// Native pressure control: three unmanaged fixture children retain legitimate
// queued requirements. The refused and recovered business tickets use the real
// candidate Router and trusted Hooks. No fabricated legacy Router records.
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
import { CAPACITY_REJECTION, capacityWasRecovered } from "../plugins/adaptive-model-router/scripts/lib/host-capacity-recovery.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.argv.length, 2);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "router-residency-capacity-")));
process.env.ADAPTIVE_ROUTER_HOME = join(scratch, "router-state");
const marker = `CAPACITY_ROOT_${randomBytes(12).toString("hex")}`;
const relay = new ResidencyModelRelay(marker);
const store = new RouterStore();
const children = new Set(), stages = [];
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let rootId, turnId, pid, context, terminal = false, sourceDigest, pluginRoot, report;
const client = new AppServerClient({ timeoutMs: 60000,
  async resolveImpl() { const command = await resolveCodexCommand(); return { ...command, path: realpathSync(command.path) }; },
  spawnImpl(command, args, options) {
    const child = spawn(command, ["--dangerously-bypass-approvals-and-sandbox", ...args], { ...options, cwd: scratch, detached: true });
    pid = child.pid; return child;
  },
});
async function call(tool, args = {}) {
  const result = await client.request("mcpServer/tool/call", { threadId: rootId, server: "capacity_acceptance", tool,
    arguments: { contextId: rootId, ...args } });
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError) throw new Error(`${tool}: ${text}`);
  return result.structuredContent || JSON.parse(text);
}
async function completed(target, expected) {
  for (let i = 0; i < 100; i += 1) {
    const list = JSON.parse(await relay.native("list_agents", {}));
    assert.ok(list.agents.length <= 4);
    const status = list.agents.find((agent) => agent.agent_name === target)?.agent_status;
    if (status?.completed === expected) return list;
    assert.ok(!status?.errored, "native fixture child failed");
    await pause(50);
  }
  throw new Error("the original pending requirement was not returned by its child");
}
const route = (stageId, goal) => call("route_stage", { stageId, phase: "native-capacity-acceptance", goal,
  evidence: { requirementsSettled: true, strongVerification: true, workProduct: true },
  hostCapabilities: { delegation: { available: true, invocation: "direct",
    targets: [{ model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] } } });
const dispatch = (r) => relay.native("spawn_agent", { task_name: r.carrier.taskName, message: r.carrier.message,
  fork_turns: "none", model: r.target.model, reasoning_effort: r.target.effort });
const outcome = (r, closure, failed = false) => call("record_outcome", { routeId: r.routeId, status: failed ? "failed" : "passed",
  failureType: failed ? "tooling" : null, gate: r.verificationGate, retries: 0,
  retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false,
  ...(closure ? { closureToken: closure.token } : {}) });
async function settle(r, expected) {
  await completed(`/root/${r.carrier.taskName}`, expected);
  const state = await call("get_route_status");
  assert.equal(state.stageClosure?.state, "ready");
  await outcome(r, state.stageClosure);
  assert.equal((await call("get_route_status")).delegationGate.state, "available");
  stages.push({ routeId: r.routeId, target: r.target, resultDigest: state.stageClosure.resultDigest });
}

try {
  const baseUrl = await relay.start();
  await client.start();
  const inventory = await client.listHooks(scratch);
  const hooks = inventory.data.find((entry) => entry.cwd === scratch)?.hooks.filter((hook) => hook.pluginId === "adaptive-model-router@adaptive-model-router");
  pluginRoot = hooks?.[0]?.sourcePath && dirname(dirname(hooks[0].sourcePath));
  assert.ok(pluginRoot && evaluateLifecycleHookInventory(inventory, { cwd: scratch, pluginRoot }).ready, "current candidate Hooks must be trusted");
  sourceDigest = runtimeSourceDigest();
  assert.equal(sourceDigest, runtimeSourceDigest(pluginRoot));
  client.subscribe((event) => {
    if (event.method === "item/completed" && event.params.threadId === rootId && event.params.item?.type === "subAgentActivity" && event.params.item.kind === "started") children.add(event.params.item.agentThreadId);
    if (event.method === "turn/completed" && event.params.threadId === rootId) terminal = event.params.turn.status === "completed";
  });
  rootId = (await client.request("thread/start", { model: "gpt-6-astra", cwd: scratch, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
    config: { model_provider: "capacity_fixed", "model_providers.capacity_fixed": { name: "Capacity fixed response control", base_url: baseUrl, wire_api: "responses", requires_openai_auth: false },
      "features.responses_websockets": false, "features.responses_websockets_v2": false,
      "features.multi_agent_v2": { enabled: true, max_concurrent_threads_per_session: 4 },
      "mcp_servers.capacity_acceptance": { command: process.execPath,
        args: [join(pluginRoot, "scripts/node-launcher.mjs"), join(pluginRoot, "scripts/mcp-server.mjs")], cwd: scratch,
        env: { ADAPTIVE_ROUTER_HOME: process.env.ADAPTIVE_ROUTER_HOME }, enabled_tools: ["route_stage", "record_outcome", "get_route_status"], default_tools_approval_mode: "approve" } },
    developerInstructions: "Disposable capacity acceptance. Execute only exact native collaboration calls supplied by the outer driver. The three pressure fixtures are unmanaged native controls with legitimate pending requirements; all Router business stages use their exact carriers. No business tools, external writes, extra agents or retries. Keep the root turn open until the driver supplies its final marker.",
  })).thread.id;
  context = store.context({ cwd: scratch, contextId: rootId });
  store.configure(context, { autoActivate: true }, "global");
  turnId = (await client.request("turn/start", { threadId: rootId, effort: "high", input: [{ type: "text", text: marker }] })).turn.id;
  await relay.waitForRoot();
  emit({ stage: "started", rootId, scratch, sourceDigest, syntheticResponses: true, configuredTotalCapacity: 4 });
  const qualification = await route("capacity-native-qualification", "Return QUALIFIED without tools.");
  assert.ok(qualification.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION"));
  const qMarker = readTaskQualification(store.db, context).marker;
  relay.addChild(qMarker);
  assert.equal(JSON.parse(await dispatch(qualification)).task_name, `/root/${qualification.carrier.taskName}`);
  await settle(qualification, qMarker);

  const fixtures = [];
  for (let i = 0; i < 3; i += 1) {
    const original = `PRESSURE_ORIGINAL_${i}_${randomBytes(8).toString("hex")}`;
    const supplement = `PRESSURE_PENDING_${i}_${randomBytes(8).toString("hex")}`;
    const name = `capacity_fixture_${i}`;
    relay.addChild(original, [supplement]);
    const created = JSON.parse(await relay.native("spawn_agent", { task_name: name,
      message: `Return ${original} without tools. Preserve that original result and include each later supplemental marker in your next complete reply.`,
      fork_turns: "none", model: "gpt-6-astra", reasoning_effort: "high" }));
    assert.equal(created.task_name, `/root/${name}`);
    await completed(created.task_name, original);
    assert.equal(await relay.native("send_message", { target: created.task_name, message: supplement }), "");
    fixtures.push({ target: created.task_name, original, supplement });
  }
  const refused = await route("capacity-still-needed-review", "Return CAPACITY_RECOVERED_RESULT without tools.");
  assert.equal(refused.action, "delegate");
  assert.equal(await dispatch(refused), CAPACITY_REJECTION);
  await outcome(refused, null, true);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outcomes WHERE route_id=?").get(refused.routeId).n, 1);
  assert.equal((await call("get_route_status")).delegationGate.state, "available");
  emit({ stage: "verified", case: "actual-three-backlog-capacity-rejection", rejectedRouteId: refused.routeId });

  const first = fixtures[0];
  assert.equal(await relay.native("followup_task", { target: first.target,
    message: "Complete your still-pending requirement and return the original and supplemental markers together. This is the same requirement; do not start other work." }), "");
  await completed(first.target, `${first.original}|${first.supplement}`);
  const recovered = await route("capacity-still-needed-review", "Return CAPACITY_RECOVERED_RESULT without tools.");
  assert.equal(recovered.action, "delegate", recovered.reasonCodes.join(","));
  assert.notEqual(recovered.routeId, refused.routeId);
  relay.addChild("CAPACITY_RECOVERED_RESULT");
  assert.equal(JSON.parse(await dispatch(recovered)).task_name, `/root/${recovered.carrier.taskName}`);
  await settle(recovered, "CAPACITY_RECOVERED_RESULT");
  assert.equal(capacityWasRecovered(store.db, context), true);
  for (const fixture of fixtures.slice(1)) {
    assert.equal(await relay.native("followup_task", { target: fixture.target,
      message: "Complete the original pending supplement and return both original and supplemental markers. No new stage." }), "");
    await completed(fixture.target, `${fixture.original}|${fixture.supplement}`);
  }
  const status = await call("get_route_status");
  assert.equal(status.pendingOutcomes, 0);
  assert.equal(status.stageClosure, null);
  assert.deepEqual(status.pendingStageWork, []);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM capacity_refusals").get().n, 1);
  const done = client.createWaiter((event) => event.method === "turn/completed" && event.params.threadId === rootId, Date.now() + 30000);
  relay.finish(); await done.promise; assert.ok(terminal);
  report = { passed: true, rootId, turnId, sourceDigest, configuredTotalCapacity: 4, syntheticResponses: true,
    managedLegacyFixture: false, fixtureBoundary: "unmanaged native children; candidate Router refusal/recovery and trusted Hooks are real",
    threeBacklogsConfirmedByExactNativeRefusal: true, originalAndSupplementalResultsPreserved: true,
    sameRootAndStageNewTicketSucceeded: true, rejectedOutcomeCount: 1, refusedRouteId: refused.routeId,
    recoveredRouteId: recovered.routeId, nativeCalls: relay.nativeCalls, stages };
} catch (error) {
  process.exitCode = 1;
  report = { passed: false, rootId, sourceDigest, stages, failure: String(error.message).replace(/router_[a-f0-9]{32}/gu, "[carrier]").slice(0, 1600) };
} finally {
  if (rootId && turnId && !terminal) try { await client.request("turn/interrupt", { threadId: rootId, turnId }, Date.now() + 5000); } catch { /* Exact owned process cleanup follows. */ }
  if (terminal) for (const threadId of [...children, rootId]) try { await client.request("thread/archive", { threadId }, Date.now() + 5000); } catch { /* Archive is not capacity evidence. */ }
  store.close(); client.close(); await relay.close();
  let absent = !pid;
  if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* Check the exact group below. */ }
    for (let i = 0; i < 40; i += 1) { try { process.kill(-pid, 0); } catch (error) { if (error.code === "ESRCH") { absent = true; break; } } await pause(50); }
  }
  report.cleanup = { ownedProcessGroupAbsent: absent };
  if (!absent) { report.passed = false; report.failure ||= "owned process cleanup is unproven"; process.exitCode = 1; }
  const path = join(scratch, "capacity-report.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  emit({ stage: report.passed ? "verified" : "stopped", report: path, ...(report.failure ? { failure: report.failure } : {}) });
}
