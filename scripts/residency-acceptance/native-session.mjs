import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient, resolveCodexCommand } from "../../plugins/adaptive-model-router/scripts/lib/app-server.mjs";
import { RouterStore } from "../../plugins/adaptive-model-router/scripts/lib/database.mjs";
import { evaluateLifecycleHookInventory } from "../../plugins/adaptive-model-router/scripts/lib/hook-readiness.mjs";
import { runtimeSourceDigest, readTaskQualification } from "../../plugins/adaptive-model-router/scripts/lib/lifecycle-qualification.mjs";
import { readChildTurnEvidence } from "../../plugins/adaptive-model-router/scripts/lib/child-turn-evidence.mjs";
import { openPrivateState } from "../../plugins/adaptive-model-router/scripts/lib/private-state.mjs";
import { auditNativeLifecycleNoop } from "../../plugins/adaptive-model-router/scripts/lib/native-lifecycle-audit.mjs";
import { payloadHash } from "../../plugins/adaptive-model-router/scripts/lib/io.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const pluginSource = fileURLToPath(new URL("../../plugins/adaptive-model-router/", import.meta.url));

// A disposable native host owns this entire acceptance tree. No user task's
// model, controls, data, or production application is changed by the driver.
export class NativeResidencySession {
  constructor() {
    this.scratch = mkdtempSync(join(tmpdir(), "router-residency-semantic-"));
    this.home = join(this.scratch, "router-state");
    this.children = new Set();
    this.routeChildren = new Map();
    this.barriers = new Set();
    this.steps = [];
    this.modelTurns = 0;
    this.previousHome = process.env.ADAPTIVE_ROUTER_HOME;
    process.env.ADAPTIVE_ROUTER_HOME = this.home;
    this.client = new AppServerClient({ timeoutMs: 60000,
      async resolveImpl() { const command = await resolveCodexCommand(); return { ...command, path: realpathSync(command.path) }; },
      spawnImpl: (command, args, options) => {
        const child = spawn(command, ["--dangerously-bypass-approvals-and-sandbox", ...args], {
          ...options, cwd: this.scratch, detached: true,
        });
        this.pid = child.pid;
        return child;
      },
    });
  }

  async start({ preflightOnly = false, allowScratchWrites = false, allowRootVerification = false } = {}) {
    if (process.platform !== "darwin") throw new Error("native macOS is required");
    await this.client.start();
    const inventory = await this.client.listHooks(this.scratch);
    const hooks = inventory.data.find((group) => group.cwd === this.scratch)?.hooks
      .filter((hook) => hook.pluginId === "adaptive-model-router@adaptive-model-router") || [];
    this.pluginRoot = hooks[0]?.sourcePath && dirname(dirname(hooks[0].sourcePath));
    this.readiness = this.pluginRoot
      ? evaluateLifecycleHookInventory(inventory, { cwd: this.scratch, pluginRoot: this.pluginRoot })
      : { ready: false, reasonCode: "HOST_HOOK_SET_MISMATCH" };
    if (!this.readiness.ready) throw new Error(this.readiness.reasonCode);
    this.sourceDigest = runtimeSourceDigest();
    if (this.sourceDigest !== runtimeSourceDigest(this.pluginRoot)) throw new Error("installed candidate source differs from the workspace");
    for (const path of ["runtime.json", "scripts/mcp-server.mjs", "scripts/runtime-probe.mjs"]) {
      if (digest(readFileSync(join(this.pluginRoot, path))) !== digest(readFileSync(join(pluginSource, path)))) {
        throw new Error("installed entrypoint differs from the workspace");
      }
    }
    if (preflightOnly) return;
    this.client.subscribe((event) => {
      if (event.method === "item/completed" && event.params.threadId === this.rootId
        && event.params.item?.type === "subAgentActivity" && event.params.item.kind === "started") {
        this.children.add(event.params.item.agentThreadId);
      }
    });
    this.rootId = (await this.client.request("thread/start", {
      model: "gpt-6-astra", cwd: this.scratch, approvalPolicy: "never",
      sandbox: allowScratchWrites ? "workspace-write" : "read-only", ephemeral: false,
      config: {
        "features.multi_agent_v2": { enabled: true, max_concurrent_threads_per_session: 4 },
        "mcp_servers.router_semantic_acceptance": {
          command: process.execPath,
          args: [join(this.pluginRoot, "scripts/node-launcher.mjs"), join(this.pluginRoot, "scripts/mcp-server.mjs")],
          cwd: this.scratch, env: { ADAPTIVE_ROUTER_HOME: this.home },
          enabled_tools: ["route_stage", "record_outcome", "get_route_status", "manage_stage"],
          default_tools_approval_mode: "approve",
        },
      },
      developerInstructions: "You are a disposable native acceptance controller. The outer source driver owns all Router calls, result checks, dispositions and outcomes. Execute only each prompt's exact direct native collaboration call. "
        + (allowRootVerification ? "A prompt explicitly labeled ROOT_OPERATION_VERIFICATION additionally authorizes only its exact supplied functions.exec source with one native command to verify this disposable workspace. " : "")
        + "Do not otherwise call Router, shell, browser, file, configuration or unrelated tools. Never retry a launch, spawn an extra child, change a supplied parameter or put collaboration inside functions.exec. If requested to return immediately after a call, do not wait for the child: the outer driver owns its wait and any test barrier. A root Stop reminder does not authorize extra operations; the driver settles the exact pending route before the next test stage.",
    })).thread.id;
    this.store = new RouterStore();
    this.context = this.store.context({ cwd: this.scratch, contextId: this.rootId });
    this.store.configure(this.context, { autoActivate: true }, "global");
    await this.turn("Reply READY without tools.", "controller-ready");
    emit({ stage: "started", rootId: this.rootId, scratch: this.scratch, realModels: true, sourceDigest: this.sourceDigest });
  }

  async turn(prompt, label) {
    const started = await this.client.request("turn/start", {
      threadId: this.rootId, effort: "high", input: [{ type: "text", text: prompt }],
    });
    const turnId = started.turn.id;
    this.modelTurns += 1;
    // Observation timeouts never become completion or another launch. Inspect
    // this exact turn and keep waiting for it, with a bounded probe deadline.
    for (let window = 0; window < 4; window += 1) {
      const waiter = this.client.createWaiter((event) => event.method === "turn/completed"
        && event.params.threadId === this.rootId && event.params.turn.id === turnId, Date.now() + 45000);
      try {
        const event = await waiter.promise;
        if (event.params.turn.status !== "completed") throw new Error(`controller turn ended ${event.params.turn.status}`);
        return;
      } catch (error) {
        if (!/notification exceeded/u.test(error.message)) throw error;
        const current = (await this.read(this.rootId)).turns.find((turn) => turn.id === turnId);
        if (current?.status === "completed") return;
        if (!current || current.status !== "inProgress") throw new Error("controller turn is no longer running and did not complete");
        emit({ stage: "observed-running", label, turnId });
      }
    }
    throw new Error("controller exceeded the bounded acceptance deadline while still running");
  }

  async read(threadId) { return (await this.client.request("thread/read", { threadId, includeTurns: true })).thread; }

  async call(name, args) {
    const response = await this.client.request("mcpServer/tool/call", {
      threadId: this.rootId, server: "router_semantic_acceptance", tool: name, arguments: { contextId: this.rootId, ...args },
    });
    const text = response.content?.find((part) => part.type === "text")?.text;
    if (response.isError) throw new Error(`${name}: ${text || "native MCP error"}`);
    const value = response.structuredContent || JSON.parse(text);
    return value;
  }

  async native(name, args) {
    await this.turn(`Call direct native collaboration.${name} exactly once with this JSON:\n${JSON.stringify(args)}\nReturn CONTROL_ACCEPTED immediately after its result. Do not wait for a child, call Router or perform any other operation. If it fails, report the failure without retrying.`, name);
  }

  async route(stageId, goal) {
    const route = await this.call("route_stage", {
      stageId, phase: "real-model-residency-acceptance", goal,
      evidence: { workProduct: true, requirementsSettled: true, strongVerification: true },
      hostCapabilities: { delegation: { available: true, invocation: "direct",
        targets: [{ model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] } },
    });
    if (route.action !== "delegate") throw new Error(`required route returned ${route.action}: ${route.reasonCodes.join(",")}`);
    return route;
  }

  async spawn(route) {
    await this.native("spawn_agent", { task_name: route.carrier.taskName, message: route.carrier.message,
      fork_turns: "none", model: route.target.model, reasoning_effort: route.target.effort });
    const parent = await this.read(this.rootId);
    const starts = parent.turns.flatMap((turn) => turn.items).filter((item) => item.type === "subAgentActivity"
      && item.kind === "started" && item.agentPath === `/root/${route.carrier.taskName}`);
    if (starts.length !== 1) throw new Error("native spawn did not create exactly one matching child");
    this.children.add(starts[0].agentThreadId);
    this.routeChildren.set(route.routeId, starts[0].agentThreadId);
    return starts[0].agentThreadId;
  }

  locator(route, { required = true } = {}) {
    const row = this.store.db.prepare("SELECT locator FROM delegation_children WHERE route_id=?").get(route.routeId);
    if (!row) {
      if (required) throw new Error("trusted child locator is missing");
      return null;
    }
    return JSON.parse(openPrivateState(this.store.db, row.locator));
  }

  async waitChild(route, { pendingOperation = false } = {}) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const locator = this.locator(route, { required: false });
      if (!locator) {
        // Native spawn announces its child before that child's startup Hook
        // necessarily finishes. Wait on that exact already-created child;
        // neither missing startup evidence nor a timeout authorizes a respawn.
        const childId = this.routeChildren.get(route.routeId);
        if (!childId) throw new Error("this route has no verified native child dispatch");
        const thread = await this.read(childId);
        const turn = thread.turns.at(-1);
        if (turn && turn.status !== "inProgress") throw new Error(`child ended ${turn.status} without a trusted startup locator`);
        await pause(1000);
        continue;
      }
      let facts;
      try { facts = readChildTurnEvidence(locator); }
      catch (error) {
        if (!/changed during|incomplete records/u.test(error.message)) throw error;
      }
      if (pendingOperation && facts?.pendingOperations.length) return facts;
      const closure = await this.call("get_route_status", {});
      if (!pendingOperation && closure.stageClosure?.routeId === route.routeId && closure.stageClosure.state === "ready") {
        const thread = await this.read(this.locator(route).childId);
        const messages = thread.turns.flatMap((turn) => turn.items)
          .filter((item) => item.type === "agentMessage" && item.phase === "final_answer");
        const text = messages.at(-1)?.text;
        if (typeof text !== "string") throw new Error("latest native final reply is missing");
        if (thread.model !== route.target.model || thread.reasoningEffort !== route.target.effort
          || payloadHash(text) !== closure.stageClosure.resultDigest) throw new Error("native model, effort or final result differs from the verified stage");
        return { text, closure: closure.stageClosure, thread, facts };
      }
      await pause(1000);
    }
    const thread = await this.read(this.routeChildren.get(route.routeId) || this.locator(route).childId);
    throw new Error(`child observation deadline; latest native turn remains ${thread.turns.at(-1)?.status || "unknown"}`);
  }

  async outcome(route, closure, { status = "passed", failureType = null } = {}) {
    return this.call("record_outcome", { routeId: route.routeId, status, gate: route.verificationGate,
      failureType, retries: 0, retryBreakdown: { reasoning: 0, environment: 0, information: 0, tooling: 0 },
      escalations: 0, userCorrection: false, closureToken: closure?.token });
  }

  async qualify() {
    const route = await this.route("semantic-native-qualification", "Return QUALIFIED without tools.");
    if (!route.reasonCodes.includes("HOST_LIFECYCLE_QUALIFICATION")) throw new Error("fresh native lifecycle qualification was not requested");
    await this.spawn(route);
    const result = await this.waitChild(route);
    const audit = auditNativeLifecycleNoop({ child: result.thread, parentId: this.rootId, taskName: route.carrier.taskName,
      target: route.target, marker: readTaskQualification(this.store.db, this.context).marker });
    if (!audit.passed) throw new Error("qualification no-tool source audit failed");
    await this.outcome(route, result.closure);
    this.steps.push({ case: "qualification", routeId: route.routeId, target: route.target, audit });
  }

  async manage(route, action, extra = {}) {
    const row = this.store.db.prepare("SELECT revision FROM delegation_children WHERE route_id=?").get(route.routeId);
    return this.call("manage_stage", { routeId: route.routeId, expectedRevision: row?.revision ?? 0, action, ...extra });
  }

  async close() {
    this.processGroupAbsent = !this.pid;
    for (const path of this.barriers) writeFileSync(path, "release\n");
    for (const threadId of [...this.children, this.rootId].filter(Boolean)) {
      try {
        const thread = await this.read(threadId);
        for (const turn of thread.turns.filter((entry) => entry.status === "inProgress")) {
          await this.client.request("turn/interrupt", { threadId, turnId: turn.id }, Date.now() + 5000);
        }
        const final = await this.read(threadId);
        if (final.turns.every((turn) => turn.status !== "inProgress")) {
          await this.client.request("thread/archive", { threadId }, Date.now() + 5000);
        }
      } catch { /* Process cleanup remains scoped to this owned disposable host. */ }
    }
    this.store?.close();
    this.client.close();
    if (this.pid) {
      try { process.kill(-this.pid, "SIGTERM"); } catch { /* Group already exited. */ }
      for (let count = 0; count < 40; count += 1) {
        try { process.kill(-this.pid, 0); } catch { this.processGroupAbsent = true; break; }
        await pause(50);
      }
    }
    if (this.previousHome === undefined) delete process.env.ADAPTIVE_ROUTER_HOME;
    else process.env.ADAPTIVE_ROUTER_HOME = this.previousHome;
  }
}
