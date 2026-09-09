#!/usr/bin/env node
// Actual native allocation with the candidate Router/MCP/trusted Hooks. Model
// responses are fixed. This does not count as real-model semantic acceptance.
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppServerClient, resolveCodexCommand } from "./lib/app-server.mjs";
import { RouterStore } from "./lib/database.mjs";
import { evaluateLifecycleHookInventory } from "./lib/hook-readiness.mjs";
import { runtimeSourceDigest, readTaskQualification } from "./lib/lifecycle-qualification.mjs";
import { readChildTurnEvidence } from "./lib/child-turn-evidence.mjs";
import { openPrivateState } from "./lib/private-state.mjs";
import { ResidencyModelRelay } from "./lib/residency-model-relay.mjs";

const roundsArg = process.argv.find((value) => value.startsWith("--rounds="));
const rounds = Number(roundsArg?.slice(9) || 100);
if (process.platform !== "darwin" || !Number.isInteger(rounds) || rounds < 1 || rounds > 100
  || process.argv.slice(2).some((value) => !/^--rounds=\d+$/u.test(value))) throw new Error("Usage on macOS: probe-residency-acceptance.mjs [--rounds=100]");
const scratch = mkdtempSync(join(tmpdir(), "router-residency-acceptance-"));
process.env.ADAPTIVE_ROUTER_HOME = join(scratch, "router-state");
const rootMarker = `RESIDENCY_ACCEPTANCE_ROOT_${randomBytes(12).toString("hex")}`;
const relay = new ResidencyModelRelay(rootMarker);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const store = new RouterStore();
let rootId, rootTurnId, nativePid, report, maxObservedResidents = 0, terminal = false;
const children = new Set();
const steps = [];
const client = new AppServerClient({ timeoutMs: 60000,
  async resolveImpl() { const executable = await resolveCodexCommand(); return { ...executable, path: realpathSync(executable.path) }; },
  spawnImpl(command, args, options) {
    const child = spawn(command, ["--dangerously-bypass-approvals-and-sandbox", ...args], { ...options, cwd: scratch, detached: true });
    nativePid = child.pid; return child;
  },
});
async function call(name, args) {
  const response = await client.request("mcpServer/tool/call", { threadId: rootId, server: "router_residency_acceptance", tool: name, arguments: args });
  const text = response.content?.find((part) => part.type === "text")?.text;
  if (response.isError) throw new Error(`${name} rejected: ${text || "native MCP error"}`);
  const value = response.structuredContent || JSON.parse(text);
  return value;
}
async function completed(target, expected) {
  for (let count = 0; count < 100; count += 1) {
    const result = JSON.parse(await relay.native("list_agents", {}));
    maxObservedResidents = Math.max(maxObservedResidents, result.agents.length);
    if (result.agents.length > 4) throw new Error("native residency exceeded root plus three children");
    const status = result.agents.find((agent) => agent.agent_name === target)?.agent_status;
    if ((Array.isArray(expected) ? expected : [expected]).includes(status?.completed)) return status.completed;
    if (status?.errored) throw new Error("native child failed");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("child never returned the currently required result");
}
try {
  const baseUrl = await relay.start();
  await client.start();
  const inventory = await client.listHooks(scratch);
  const hooks = inventory.data.find((entry) => entry.cwd === scratch)?.hooks.filter((hook) => hook.pluginId === "adaptive-model-router@adaptive-model-router");
  const pluginRoot = hooks?.[0]?.sourcePath && dirname(dirname(hooks[0].sourcePath));
  if (!pluginRoot || !evaluateLifecycleHookInventory(inventory, { cwd: scratch, pluginRoot }).ready) throw new Error("candidate Hooks are not installed and trusted; no model turn was started");
  const sourceDigest = runtimeSourceDigest();
  if (sourceDigest !== runtimeSourceDigest(pluginRoot)) throw new Error("installed source differs from this acceptance candidate");
  client.subscribe((event) => {
    if (event.method === "item/completed" && event.params.threadId === rootId && event.params.item?.type === "subAgentActivity" && event.params.item.kind === "started") children.add(event.params.item.agentThreadId);
    if (event.method === "turn/completed" && event.params.threadId === rootId) terminal = event.params.turn.status === "completed";
  });
  const thread = await client.request("thread/start", { model: "gpt-6-astra", cwd: scratch, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
    config: {
      model_provider: "router_residency_fixed", "model_providers.router_residency_fixed": { name: "Router fixed response acceptance", base_url: baseUrl, wire_api: "responses", requires_openai_auth: false },
      "features.responses_websockets": false, "features.responses_websockets_v2": false,
      "features.multi_agent_v2": { enabled: true, max_concurrent_threads_per_session: 4 },
      "mcp_servers.router_residency_acceptance": { command: process.execPath, args: [join(pluginRoot, "scripts/node-launcher.mjs"), join(pluginRoot, "scripts/mcp-server.mjs")],
        cwd: scratch, env: { ADAPTIVE_ROUTER_HOME: process.env.ADAPTIVE_ROUTER_HOME }, enabled_tools: ["route_stage", "record_outcome", "get_route_status"], default_tools_approval_mode: "approve" },
    },
    developerInstructions: "Disposable native protocol acceptance. The outer source orchestrator owns Router calls, exact-result checks and outcomes. Execute only supplied native collaboration operations; no business writes. Keep the root turn open until it supplies the final marker. Child tasks only return their assigned markers.",
  });
  rootId = thread.thread.id;
  const context = store.context({ cwd: scratch, contextId: rootId });
  store.configure(context, { autoActivate: true }, "global");
  rootTurnId = (await client.request("turn/start", { threadId: rootId, effort: "high", input: [{ type: "text", text: rootMarker }] })).turn.id;
  await relay.waitForRoot();
  emit({ stage: "started", scratch, rootId, rounds, syntheticResponses: true, routerAndTrustedHooks: true, sourceDigest });
  let ordinary = 0;
  for (let index = 0; ordinary < rounds; index += 1) {
    const marker = `RESIDENCY_STAGE_${index}_${randomBytes(8).toString("hex")}`;
    const supplemental = `SUPPLEMENT_${index}_${randomBytes(8).toString("hex")}`;
    const route = await call("route_stage", { contextId: rootId, stageId: `residency-stage-${index}`, phase: "protocol-acceptance",
      goal: `Return exactly ${marker} without tools. Process any same-stage supplementary markers in a final reply.`,
      evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
      override: { model: "gpt-6-astra", effort: "high" },
      hostCapabilities: { delegation: { available: true, invocation: "direct", targets: [{ model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] } },
    });
    if (route.action !== "delegate") throw new Error(`native route did not delegate: ${route.reasonCodes?.join(",")}`);
    const qualification = route.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION");
    const actualMarker = qualification ? readTaskQualification(store.db, context).marker : marker;
    const followup = !qualification && ordinary % 2 === 0;
    const finalWindowRace = !qualification && ordinary % 20 === 0;
    relay.addChild(actualMarker, followup ? [supplemental] : [], finalWindowRace);
    const output = await relay.native("spawn_agent", { task_name: route.carrier.taskName, message: route.carrier.message, fork_turns: "none", model: route.target.model, reasoning_effort: route.target.effort });
    const target = `/root/${route.carrier.taskName}`;
    if (JSON.parse(output).task_name !== target) throw new Error("native spawn did not return the exact child target");
    if (finalWindowRace) {
      await relay.waitForChildBarrier();
      if (await relay.native("send_message", { target, message: supplemental }) !== "") throw new Error("final-window message was not accepted");
      relay.releaseChildBarrier();
      await completed(target, [actualMarker, `${actualMarker}|${supplemental}`]);
    } else await completed(target, actualMarker);
    if (followup) {
      if (ordinary % 4 === 0 && !finalWindowRace) {
        if (await relay.native("send_message", { target, message: supplemental }) !== "") throw new Error("QueueOnly acceptance changed");
        const pending = await call("get_route_status", { contextId: rootId });
        if (pending.stageClosure?.reason !== "accepted_message_not_consumed") throw new Error("queued obligation was not retained");
      }
      if (await relay.native("followup_task", { target, message: `Handle ${supplemental} and return all current stage markers.` }) !== "") throw new Error("followup acceptance changed");
      await completed(target, `${actualMarker}|${supplemental}`);
    }
    const status = await call("get_route_status", { contextId: rootId });
    const closure = status.stageClosure;
    if (closure?.state !== "ready") throw new Error(`stage closure is not ready: ${closure?.reason}`);
    const row = store.db.prepare("SELECT locator FROM delegation_children WHERE route_id=?").get(route.routeId);
    const locator = JSON.parse(openPrivateState(store.db, row.locator));
    const facts = readChildTurnEvidence(locator);
    if (!facts.finished || facts.lastFinal.digest !== closure.resultDigest) throw new Error("latest native result mismatch");
    const nativeChild = (await client.request("thread/read", { threadId: locator.childId, includeTurns: false })).thread;
    if (nativeChild.parentThreadId !== rootId || nativeChild.model !== route.target.model
      || nativeChild.reasoningEffort !== route.target.effort) throw new Error("native child parent, model or effort differs from its route");
    await call("record_outcome", { contextId: rootId, routeId: route.routeId, status: "passed", gate: route.verificationGate, failureType: null,
      retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false, closureToken: closure.token });
    const after = await call("get_route_status", { contextId: rootId });
    if (after.delegationGate.state !== "available" || after.pendingOutcomes !== 0 || after.stageClosure) throw new Error("normal stage did not settle before the next admission");
    steps.push({ qualification, followup, finalWindowRace, routeId: route.routeId, target: route.target,
      observedTarget: { model: nativeChild.model, effort: nativeChild.reasoningEffort },
      revision: closure.revision, resultDigest: closure.resultDigest, bytes: closure.transcriptBytes });
    if (!qualification) ordinary += 1;
    if (ordinary % 10 === 0 || qualification) emit({ stage: "progress", completed: ordinary, qualification, nativeCalls: relay.nativeCalls });
    if (index > rounds + 3) throw new Error("repeated qualification prevented normal stages");
  }
  const finished = client.createWaiter((event) => event.method === "turn/completed" && event.params.threadId === rootId, Date.now() + 30000);
  relay.finish();
  await finished.promise;
  if (!terminal) throw new Error("root did not complete after settled obligations");
  const counts = { outcomes: store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n,
    retainedAttempts: store.db.prepare("SELECT count(*) AS n FROM delegation_attempts").get().n,
    managedChildren: store.db.prepare("SELECT count(*) AS n FROM delegation_children").get().n,
    capacityRefusals: store.db.prepare("SELECT count(*) AS n FROM capacity_refusals").get().n,
    totalBytes: store.db.prepare("SELECT total_transcript_bytes FROM delegation_usage").get()?.total_transcript_bytes };
  if (counts.outcomes !== steps.length || counts.managedChildren !== steps.length || relay.errors.length) throw new Error("final lifecycle accounting differs from executed stages");
  const binary = (await resolveCodexCommand()).path;
  report = { schemaVersion: 1, passed: true, rootId, rounds, syntheticResponses: true, realModelQualityAcceptance: false,
    routerAndTrustedHooks: true, configuredTotalCapacity: 4, sourceDigest, binaryDigest: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    counts, maxObservedResidents, nativeCalls: relay.nativeCalls, childReplies: relay.childReplies, steps };
} catch (error) {
  report = { schemaVersion: 1, passed: false, rootId, rounds, syntheticResponses: true, realModelQualityAcceptance: false,
    steps, message: String(error.message).replace(/router_[a-f0-9]{32}/gu, "[carrier]").slice(0, 2000) };
  emit({ stage: "failed", scratch, message: report.message });
  process.exitCode = 1;
} finally {
  if (rootId && rootTurnId && !terminal) try { await client.request("turn/interrupt", { threadId: rootId, turnId: rootTurnId }, Date.now() + 5000); } catch { /* Process cleanup remains scoped to this disposable host. */ }
  if (terminal) for (const threadId of [...children, rootId]) try { await client.request("thread/archive", { threadId }, Date.now() + 5000); } catch { /* Archive is not physical slot proof. */ }
  store.close(); client.close();
  await relay.close();
  let ownedProcessGroupAbsent = !nativePid;
  if (nativePid) {
    try { process.kill(-nativePid, "SIGTERM"); } catch { /* Inspect the exact owned group below. */ }
    for (let count = 0; count < 40; count += 1) {
      try { process.kill(-nativePid, 0); }
      catch (error) { if (error.code === "ESRCH") { ownedProcessGroupAbsent = true; break; } }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  report.cleanup = { ownedProcessGroupAbsent };
  if (!ownedProcessGroupAbsent) {
    report.passed = false;
    report.message ||= "owned native host cleanup was not proven";
    process.exitCode = 1;
  }
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2) + "\n");
  emit({ stage: report.passed ? "verified" : "stopped", report: join(scratch, "report.json"),
    ...(report.counts || {}), cleanup: report.cleanup });
}
