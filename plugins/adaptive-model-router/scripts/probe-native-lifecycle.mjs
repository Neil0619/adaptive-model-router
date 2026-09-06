#!/usr/bin/env node
import { runtimeSourceDigest } from "./lib/lifecycle-qualification.mjs";
// Diagnostic qualification only: fixed no-tool payloads, a disposable native
// host, and a fresh Router store. This never writes production readiness proof.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { AppServerClient, resolveCodexCommand } from "./lib/app-server.mjs";
import { normalizeCatalog } from "./lib/catalog.mjs";
import { resolveModelTarget } from "./lib/model-policy.mjs";
import { RouterStore } from "./lib/database.mjs";
import { evaluateLifecycleHookInventory } from "./lib/hook-readiness.mjs";
import { routeStage } from "./lib/router.mjs";
import { auditNativeLifecycleNoop } from "./lib/native-lifecycle-audit.mjs";

const mode = process.argv[2] || "deny";
if (!["darwin", "win32"].includes(process.platform) || !["deny", "roundtrip"].includes(mode) || process.argv.length > 3) {
  process.stderr.write("Usage on native macOS or Windows: probe-native-lifecycle.mjs [deny|roundtrip]\n");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "router-native-lifecycle-"));
process.env.ADAPTIVE_ROUTER_HOME = join(scratch, "router-state");
const marker = `NATIVE_ROUTER_NOOP_${randomBytes(12).toString("hex")}`;
const testTaskName = `router_${randomBytes(16).toString("hex")}`;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const redact = (value) => String(value)
  .replace(/router_[a-f0-9]{32}/gu, "[carrier]")
  .replace(/NATIVE_ROUTER_NOOP_[a-f0-9]+/gu, "[marker]");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let rootTarget;
let probeTarget;
let rootId;
let childId;
let store;
let route;
let routerServer;
let terminal = false;
const events = [];
const client = new AppServerClient({
  timeoutMs: 240_000,
  async resolveImpl() {
    const command = await resolveCodexCommand();
    if (command.kind !== "direct") throw new Error("native probe requires a directly executable Codex host");
    // Desktop companions are resolved beside argv[0]. A symlink in ~/.local/bin
    // may leave codex-code-mode-host unavailable even though codex itself runs.
    return { ...command, path: realpathSync(command.path) };
  },
  spawnImpl(command, args, options) {
    return spawn(command, ["--dangerously-bypass-approvals-and-sandbox", ...args], { ...options, cwd: scratch });
  },
});
const deadline = Date.now() + 240_000;

async function turn(prompt) {
  const previous = new Set(client.notificationBuffer
    .filter((message) => message.method === "turn/completed")
    .map((message) => message.params.turn.id));
  const waiter = client.createWaiter((message) => message.method === "turn/completed"
    && message.params?.threadId === rootId && !previous.has(message.params.turn.id), deadline);
  waiter.promise.catch(() => {});
  terminal = false;
  const started = await client.request("turn/start", {
    threadId: rootId, effort: rootTarget.effort, input: [{ type: "text", text: prompt }],
  }, deadline);
  const completed = await waiter.promise;
  terminal = true;
  emit({ stage: "turn-complete", turnId: started.turn.id, status: completed.params.turn.status });
  if (completed.params.turn.status !== "completed") throw new Error("native probe turn did not complete");
}

try {
  await client.start(deadline);
  const catalog = normalizeCatalog(await client.listModels());
  rootTarget = resolveModelTarget({ catalog, purpose: "smoke" }).target;
  probeTarget = resolveModelTarget({ catalog, purpose: "qualification" }).target;
  if (!rootTarget || !probeTarget) throw new Error("allowed native smoke model is unavailable");
  const inventory = await client.listHooks(scratch, deadline);
  const hooks = inventory.data?.find((group) => group.cwd === scratch)?.hooks
    ?.filter((hook) => hook.pluginId === "adaptive-model-router@adaptive-model-router") || [];
  const pluginRoot = hooks[0]?.sourcePath ? dirname(dirname(hooks[0].sourcePath)) : null;
  if (!pluginRoot || !evaluateLifecycleHookInventory(inventory, { cwd: scratch, pluginRoot }).ready) {
    throw new Error("exact trusted installed hook inventory is unavailable");
  }
  emit({ stage: "inventory", hookSetDigest: hash(JSON.stringify(hooks.map((hook) => [hook.eventName, hook.currentHash]))) });
  client.subscribe((message) => {
    const params = message.params || {};
    if (message.method === "hook/completed" && params.run?.source === "plugin") {
      const run = params.run;
      const event = { event: run.eventName, status: run.status, root: params.threadId === rootId,
        sourceDigest: hash(run.sourcePath),
        entries: run.entries.map((entry) => ({ kind: entry.kind, digest: hash(entry.text),
          ...(entry.kind === "error" ? { error: redact(entry.text).slice(0, 800) } : {}),
        })),
      };
      events.push(event);
      emit({ stage: "hook", ...event });
    }
    if (message.method === "item/completed" && params.threadId === rootId
      && params.item?.type === "subAgentActivity" && params.item.kind === "started") {
      childId = params.item.agentThreadId;
    }
  });
  if (runtimeSourceDigest(pluginRoot) !== runtimeSourceDigest()) throw new Error("installed runtime differs from the GPT-6 candidate; no inference started");
  const started = await client.request("thread/start", {
    model: rootTarget.model, cwd: scratch, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
    config: {
      "mcp_servers.router_smoke": {
        command: process.execPath,
        args: [join(pluginRoot, "scripts", "node-launcher.mjs"), join(pluginRoot, "scripts", "mcp-server.mjs")],
        cwd: scratch,
        env: { ADAPTIVE_ROUTER_HOME: process.env.ADAPTIVE_ROUTER_HOME },
        enabled_tools: ["get_route_status", "record_outcome"],
        default_tools_approval_mode: "approve",
      },
    },
    developerInstructions: "This is an isolated native Router lifecycle smoke. Use only the explicitly requested direct native Agent/wait tools and the one permitted Router outcome call. Never use shell, filesystem, browser or unrelated tools. Do not modify config, retry a launch, create extra children, or call route_stage. All child work is a fixed no-tool marker response.",
  }, deadline);
  rootId = started.thread.id;
  emit({ stage: "started", mode, threadId: rootId });
  if (mode === "deny") {
    await turn([
      "Call the direct native spawn_agent tool exactly once with this JSON argument object:",
      JSON.stringify({ task_name: testTaskName, fork_turns: "none", model: probeTarget.model, reasoning_effort: probeTarget.effort,
        message: "Negative guard probe only. Do not use any tools, write files, call Router or spawn a child. Return GUARD_PROBE_NOOP immediately." }),
      "This correctly shaped reserved Router ticket is deliberately unissued and must be denied. Never retry or replace the direct call with functions.exec, shell or MCP. If an inert child is unexpectedly created, wait for only that exact child to finish. Then report only whether the guard denied the call. Do not print the task name.",
    ].join("\n"));
  } else {
    await turn("Reply READY without calling tools.");
    store = new RouterStore();
    const servers = await client.request("mcpServerStatus/list", { threadId: rootId, limit: 100 }, deadline);
    const routerServers = servers.data.filter((server) => server.name === "router_smoke");
    if (routerServers.length !== 1) throw new Error("isolated native Router MCP registration is not unique");
    routerServer = routerServers[0].name;
    const inspected = await client.request("mcpServer/tool/call", {
      threadId: rootId, server: routerServers[0].name, tool: "get_route_status", arguments: { contextId: rootId },
    }, deadline);
    const status = inspected.structuredContent || JSON.parse(inspected.content.find((item) => item.type === "text").text);
    const localRoot = store.rootTask(store.context({ cwd: scratch, contextId: rootId }));
    emit({ stage: "mcp-state-binding", nativeRoot: status.rootTask, hookRoot: localRoot });
    if (inspected.isError || status.rootTask?.model !== rootTarget.model
      || localRoot.model !== status.rootTask.model) throw new Error("native MCP and Hook stores are not bound to the same isolated context");
    route = await routeStage({
      contextId: rootId, phase: "isolated-native-qualification",
      goal: `Return exactly ${marker}. Do not call tools, read or write files, browse, change Router controls or spawn another child.`,
      evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
      override: probeTarget,
      hostCapabilities: { delegation: { available: true, invocation: "direct", targets: [{ model: probeTarget.model, efforts: [probeTarget.effort] }] } },
    }, { store, cwd: scratch, catalog: await client.listModels(deadline) });
    if (route.action !== "delegate") throw new Error(`isolated qualification route was not delegated: ${route.action}/${route.reasonCodes.join(",")}`);
    emit({ stage: "isolated-route", routeId: route.routeId, target: route.target });
    await turn([
      "Execute this already-issued isolated qualification route exactly once. Do not call route_stage.",
      "Call direct native spawn_agent with exactly this JSON:",
      JSON.stringify({ task_name: route.carrier.taskName, message: route.carrier.message, fork_turns: "none",
        model: route.target.model, reasoning_effort: route.target.effort }),
      "Wait for that exact child. It should return a NATIVE_ROUTER_NOOP_ marker using only trusted injected context and no tools.",
      "Do not call record_outcome: the outer source-owned probe will audit the complete child transcript first and record exactly one outcome only if that audit passes.",
      "If the native tool or trusted guard rejects, or the child reports validation failure, never retry. Finish with the failure. Never put the direct spawn inside functions.exec. Do not disclose the task name or initial message. Report only whether the child returned its marker.",
    ].join("\n"));
  }
  const root = (await client.request("thread/read", { threadId: rootId, includeTurns: true }, deadline)).thread;
  const activities = root.turns.flatMap((value) => value.items)
    .filter((item) => item.type === "subAgentActivity");
  childId = activities.find((item) => item.kind === "started")?.agentThreadId || childId;
  const child = childId ? (await client.request("thread/read", { threadId: childId, includeTurns: true }, deadline)).thread : null;
  const childItems = child?.turns.flatMap((value) => value.items) || [];
  const final = childItems.filter((item) => item.type === "agentMessage" && item.phase === "final_answer").at(-1);
  const failedHooks = events.filter((event) => event.status === "failed");
  const pre = events.filter((event) => event.root && event.event === "preToolUse");
  let passed = mode === "deny" && pre.length === 1 && pre[0].status === "blocked" && !childId && failedHooks.length === 0;
  let attempt = null;
  let noOpEvidence = null;
  if (route) {
    noOpEvidence = auditNativeLifecycleNoop({ child, parentId: rootId,
      taskName: route.carrier.taskName, target: route.target, marker });
    let row = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(route.routeId);
    const readyToRecord = row.ticket_consumed === 1 && row.post_observed === 1 && row.stop_observed === 1
      && row.outcome_recorded === 0 && row.ambiguous === 0 && !row.finalized_at
      && row.agent_id === hash(childId) && noOpEvidence.passed && failedHooks.length === 0
      && store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n === 0;
    if (readyToRecord) {
      const recorded = await client.request("mcpServer/tool/call", {
        threadId: rootId, server: routerServer, tool: "record_outcome", arguments: {
          contextId: rootId, routeId: route.routeId, status: "passed", gate: route.verificationGate,
          failureType: null, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
          escalations: 0, userCorrection: false,
        },
      }, deadline);
      if (recorded.isError) throw new Error("verified isolated outcome was not accepted");
      row = store.db.prepare("SELECT * FROM delegation_attempts WHERE route_id = ?").get(route.routeId);
    }
    attempt = { ticketConsumed: row.ticket_consumed, postObserved: row.post_observed, stopObserved: row.stop_observed,
      outcomeRecorded: row.outcome_recorded, ambiguous: row.ambiguous, finalized: Boolean(row.finalized_at), transcriptBytes: row.transcript_bytes };
    passed = row.ticket_consumed === 1 && row.post_observed === 1 && row.stop_observed === 1
      && row.outcome_recorded === 1 && row.ambiguous === 0 && Boolean(row.finalized_at)
      && row.agent_id === hash(childId) && noOpEvidence.passed && failedHooks.length === 0
      && store.db.prepare("SELECT count(*) AS n FROM outcomes").get().n === 1;
  }
  emit({ stage: "summary", mode, passed, rootModel: root.model, rootEffort: root.reasoningEffort,
    attempt, noOpEvidence, child: { exists: Boolean(child), model: child?.model, effort: child?.reasoningEffort,
      turnCount: child?.turns.length, itemTypes: childItems.map((item) => item.type), markerMatches: final?.text.trim() === marker },
    hookSequence: events.map(({ root: isRoot, event, status }) => ({ root: isRoot, event, status })),
  });
  if (!passed) process.exitCode = 1;
} catch (error) {
  emit({ stage: "error", message: redact(error.message) });
  process.exitCode = 1;
} finally {
  if (terminal) for (const threadId of [childId, rootId].filter(Boolean)) {
    try {
      await client.request("thread/archive", { threadId }, Date.now() + 10_000);
      emit({ stage: "archived-probe-thread", threadId });
    } catch {
      emit({ stage: "archive-unavailable", threadId });
    }
  }
  store?.close();
  client.close();
  if (terminal || !rootId) await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  else emit({ stage: "cleanup-deferred", scratch });
}
