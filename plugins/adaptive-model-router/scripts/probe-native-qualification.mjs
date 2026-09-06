#!/usr/bin/env node
// Disposable logged-in acceptance of the production MCP admission path. Unlike
// the diagnostic probe, this never calls routeStage directly or supplies proof.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppServerClient, resolveCodexCommand } from "./lib/app-server.mjs";
import { normalizeCatalog } from "./lib/catalog.mjs";
import { resolveModelTarget } from "./lib/model-policy.mjs";
import { RouterStore } from "./lib/database.mjs";
import { evaluateLifecycleHookInventory } from "./lib/hook-readiness.mjs";
import { auditNativeLifecycleNoop } from "./lib/native-lifecycle-audit.mjs";
import { runtimeSourceDigest, readTaskQualification } from "./lib/lifecycle-qualification.mjs";

if (!["darwin", "win32"].includes(process.platform) || process.argv.length !== 2) {
  process.stderr.write("Usage on native macOS or Windows: probe-native-qualification.mjs\n");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "router-native-qualification-"));
process.env.ADAPTIVE_ROUTER_HOME = join(scratch, "state");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const children = new Set();
let rootTarget;
let probeTarget;
let rootId;
let terminal = false;
let store;
const client = new AppServerClient({ timeoutMs: 240_000,
  async resolveImpl() {
    const command = await resolveCodexCommand();
    if (command.kind !== "direct") throw new Error("native probe requires a directly executable Codex host");
    return { ...command, path: realpathSync(command.path) };
  },
  spawnImpl(command, args, options) {
    return spawn(command, ["--dangerously-bypass-approvals-and-sandbox", ...args], { ...options, cwd: scratch });
  },
});

async function turn(prompt) {
  terminal = false;
  const before = new Set(client.notificationBuffer.filter((entry) => entry.method === "turn/completed").map((entry) => entry.params.turn.id));
  const deadline = Date.now() + 180_000;
  const waiter = client.createWaiter((entry) => entry.method === "turn/completed"
    && entry.params.threadId === rootId && !before.has(entry.params.turn.id), deadline);
  waiter.promise.catch(() => {});
  await client.request("turn/start", { threadId: rootId, effort: rootTarget.effort, input: [{ type: "text", text: prompt }] }, deadline);
  const result = await waiter.promise;
  terminal = true;
  if (result.params.turn.status !== "completed") throw new Error("native acceptance turn failed");
}

async function call(name, args) {
  const result = await client.request("mcpServer/tool/call", {
    threadId: rootId, server: "router_acceptance", tool: name, arguments: args,
  }, Date.now() + 60_000);
  const value = result.structuredContent || JSON.parse(result.content.find((part) => part.type === "text").text);
  if (result.isError) throw new Error(`production ${name} rejected: ${value.error?.message || value.error || "unavailable"}`);
  return value;
}

try {
  await client.start();
  const catalog = normalizeCatalog(await client.listModels());
  rootTarget = resolveModelTarget({ catalog, purpose: "smoke" }).target;
  probeTarget = resolveModelTarget({ catalog, purpose: "qualification" }).target;
  if (!rootTarget || !probeTarget) throw new Error("allowed native smoke model is unavailable");
  const inventory = await client.listHooks(scratch);
  const entries = inventory.data.find((group) => group.cwd === scratch)?.hooks
    .filter((hook) => hook.pluginId === "adaptive-model-router@adaptive-model-router");
  const pluginRoot = entries?.[0]?.sourcePath && dirname(dirname(entries[0].sourcePath));
  if (!pluginRoot || !evaluateLifecycleHookInventory(inventory, { cwd: scratch, pluginRoot }).ready) {
    throw new Error("trusted installed Hook set is unavailable");
  }
  if (runtimeSourceDigest(pluginRoot) !== runtimeSourceDigest()) throw new Error("installed runtime differs from the GPT-6 candidate; no inference started");
  client.subscribe((entry) => {
    if (entry.method === "item/completed" && entry.params.threadId === rootId
      && entry.params.item?.type === "subAgentActivity" && entry.params.item.kind === "started") {
      children.add(entry.params.item.agentThreadId);
    }
  });
  rootId = (await client.request("thread/start", {
    model: rootTarget.model, cwd: scratch, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
    config: { "mcp_servers.router_acceptance": {
      command: process.execPath, args: [join(pluginRoot, "scripts/node-launcher.mjs"), join(pluginRoot, "scripts/mcp-server.mjs")],
      cwd: scratch, env: { ADAPTIVE_ROUTER_HOME: process.env.ADAPTIVE_ROUTER_HOME },
      enabled_tools: ["get_route_status", "route_stage", "record_outcome"], default_tools_approval_mode: "approve",
    } },
    developerInstructions: "This is a disposable Router acceptance target. Use only requested direct native Agent and wait tools. Never use shell, filesystem, browser or unrelated tools. Do not call Router tools yourself, retry a launch or spawn extra children. The outer source-owned orchestrator handles routes, verification and outcomes. Every child returns only a fixed marker without tools.",
  })).thread.id;
  emit({ stage: "started", threadId: rootId });
  await turn("Reply READY without calling tools.");
  store = new RouterStore();
  const context = store.context({ cwd: scratch, contextId: rootId });
  const status = await call("get_route_status", { contextId: rootId });
  if (status.rootTask?.model !== store.rootTask(context).model || status.rootTask.model !== rootTarget.model) {
    throw new Error("MCP and Hook context binding failed");
  }
  const marker = `NATIVE_ROUTER_NOOP_${randomBytes(12).toString("hex")}`;
  // The transport is production MCP, but the work itself is an inert no-op.
  // Putting "production" in the task evidence correctly invokes the risk floor.
  const request = { contextId: rootId, phase: "native-acceptance-noop",
    goal: `Return exactly ${marker}. Do not call tools, read or write files, browse, change Router controls or spawn another child.`,
    evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
    override: probeTarget,
    hostCapabilities: { delegation: { available: true, invocation: "direct", targets: [{ model: probeTarget.model, efforts: [probeTarget.effort] }] } },
  };
  for (let index = 0; index < 2; index++) {
    const route = await call("route_stage", request);
    const qualification = route.reasonCodes?.includes("HOST_LIFECYCLE_QUALIFICATION");
    if (route.action !== "delegate" || qualification !== (index === 0)) {
      throw new Error(`expected ${index === 0 ? "qualification" : "ordinary delegation"}: ${route.action}/${route.reasonCodes?.join(",")}`);
    }
    emit({ stage: qualification ? "qualification" : "ordinary-delegation", routeId: route.routeId, target: route.target });
    await turn("Call direct native spawn_agent exactly once with this JSON:\n" + JSON.stringify({
      task_name: route.carrier.taskName, message: route.carrier.message, fork_turns: "none",
      model: route.target.model, reasoning_effort: route.target.effort,
    }) + "\nWait for only this child to finish. Never retry, call Router, or put spawn inside functions.exec. Return a short completion message without disclosing the carrier.");
    const parent = (await client.request("thread/read", { threadId: rootId, includeTurns: true })).thread;
    const starts = parent.turns.flatMap((value) => value.items).filter((item) => item.type === "subAgentActivity"
      && item.kind === "started" && item.agentPath === `/root/${route.carrier.taskName}`);
    if (starts.length !== 1) throw new Error("native acceptance did not create exactly one matching child");
    const childId = starts[0].agentThreadId;
    children.add(childId);
    const child = (await client.request("thread/read", { threadId: childId, includeTurns: true })).thread;
    const audit = auditNativeLifecycleNoop({ child, parentId: rootId, taskName: route.carrier.taskName, target: route.target,
      marker: qualification ? readTaskQualification(store.db, context).marker : marker });
    if (!audit.passed) throw new Error("native acceptance no-tool source audit failed");
    await call("record_outcome", { contextId: rootId, routeId: route.routeId, status: "passed", gate: route.verificationGate,
      failureType: null, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 }, escalations: 0, userCorrection: false });
    const state = await call("get_route_status", { contextId: rootId });
    if (state.delegationGate.state !== "available" || state.pendingOutcomes !== 0) throw new Error("native acceptance gate did not release");
    emit({ stage: "verified", qualification, routeId: route.routeId, audit, gate: state.delegationGate.state });
  }
  const count = store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n;
  const qualified = readTaskQualification(store.db, context).state === "passed";
  if (children.size !== 2 || count !== 2 || !qualified) throw new Error("native acceptance final count mismatch");
  emit({ stage: "summary", passed: true, children: children.size, outcomes: count, qualification: "passed", rootModel: rootTarget.model, rootEffort: rootTarget.effort });
} catch (error) {
  emit({ stage: "error", message: String(error.message).replace(/router_[a-f0-9]{32}/gu, "[carrier]") });
  process.exitCode = 1;
} finally {
  if (terminal) for (const threadId of [...children, rootId].filter(Boolean)) {
    try { await client.request("thread/archive", { threadId }, Date.now() + 10_000); emit({ stage: "archived", threadId }); }
    catch { emit({ stage: "archive-unavailable", threadId }); }
  }
  store?.close();
  client.close();
  if (terminal || !rootId) await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  else emit({ stage: "cleanup-deferred", scratch });
}
