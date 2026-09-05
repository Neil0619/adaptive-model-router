#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { parseControlPrompt, parseReadOnlyInspectionPrompt } from "./lib/control.mjs";
import { writeJsonLine } from "./lib/io.mjs";
import { formatRouteHistory, formatRouteStatus } from "./lib/presentation.mjs";
import { assertRuntime } from "./lib/runtime.mjs";
import { emitDiagnostic } from "./lib/diagnostics.mjs";
import { isBoundedSubagent, resolveHookIdentity } from "./lib/hook-identity.mjs";
import { recordHookIdentityDiagnostic } from "./lib/hook-diagnostics.mjs";
import { resolveLifecyclePluginRoot } from "./lib/hook-readiness.mjs";
import { observeQualificationHook } from "./lib/lifecycle-qualification.mjs";
import { databasePath } from "./lib/context.mjs";
import {
  claimDelegationSubagent,
  consumeDelegationTicket,
  inspectManagedSubagent,
  observeAgentResult,
  observeSubagentStop,
  parseCarrierTaskName,
  parseLegacyCarrierMessage,
} from "./lib/delegation-gate.mjs";
import { readThreadSpawnIdentity } from "./lib/subagent-session.mjs";
import { createLifecycleDiagnostic } from "./lib/lifecycle-diagnostics.mjs";

let RouterStore;
let lifecycleDiagnostic = () => {};

function readInput() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
      if (value.length > 1_000_000) reject(new Error("hook input is too large"));
    });
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(value || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on("error", reject);
  });
}

function additionalContext(message, hookEventName = "UserPromptSubmit") {
  writeJsonLine(process.stdout, {
    hookSpecificOutput: { hookEventName, additionalContext: message },
  });
}

function preToolDecision(permissionDecision, fields = {}) {
  writeJsonLine(process.stdout, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      ...fields,
    },
  });
}

function denyRouterAgent(reason) {
  preToolDecision("deny", { permissionDecisionReason: reason });
}

function controlResultContext(message) {
  additionalContext([
    "This exact router control has already been applied atomically by the trusted UserPromptSubmit hook.",
    "Do not call any Adaptive Model Router MCP tool for this control turn, and do not invent or substitute a contextId.",
    "Report only the hook result below.",
    "",
    message,
  ].join("\n"));
}

function visibleReport(message, locale) {
  const instruction = locale === "zh"
    ? "请在本次回复中向用户清晰展示以下 Adaptive Model Router 报告；不要声称根任务模型发生了切换。"
    : "Clearly show the following Adaptive Model Router report in this response; do not claim that the root-task model changed.";
  controlResultContext(`${instruction}\n\n${message}`);
}

function rootLabel(rootTask) {
  return rootTask.modelVisibility === "hook_observed" ? rootTask.model : "host-managed";
}

function contextIdInstruction(contextId) {
  return `Use ${JSON.stringify(contextId)} as the contextId argument for every Adaptive Model Router MCP call in the current task and never substitute cwd/project paths.`;
}

function boundedSubagentContext(contextPackage = null, { finalized = false } = {}) {
  const lines = [
    "Adaptive Model Router: this agent is already a bounded subagent selected by its parent root task.",
    "Execute only the bounded work assigned by the parent and return the result to that parent.",
    "Never call route_stage, shadow_route_stage, resolve_host_model_intent, configure_router, learning-policy tools, or spawn another routed subagent.",
    "Do not interpret this subagent model as the root-task model and do not change router controls or root-model intent state.",
    "The parent root task owns route reporting, verification, record_outcome, and the routed-stage Stop lifecycle.",
    "The encrypted initial task message is only an activation request; this trusted context is the sole work authorization.",
  ];
  if (finalized) {
    lines.push("This routed stage is already finalized. Do not perform more work; return that fact to the parent.");
  } else if (contextPackage) {
    lines.push("", contextPackage);
  } else {
    lines.push("The bounded context package is unavailable. Stop without doing work or spawning another subagent.");
  }
  return lines.join("\n");
}

function rejectedSubagentContext() {
  return [
    "Adaptive Model Router could not validate this Router-marked child against its parent gate.",
    "Stop without doing work, changing Router controls, or spawning another subagent.",
    "Report the validation failure to the parent root task.",
  ].join("\n");
}

function recordIdentity(identity, contextInjection) {
  try {
    recordHookIdentityDiagnostic(identity.audit, contextInjection);
  } catch (error) {
    emitDiagnostic({ component: "hook", stage: "identity_diagnostic", error });
  }
}

function requireIdentity(input, event) {
  const identity = resolveHookIdentity(input, { event });
  if (identity.contextId) return identity;
  recordIdentity(identity, "blocked_missing_session_id");
  process.stderr.write("Adaptive Model Router hook skipped: trusted session identity unavailable.\n");
  emitDiagnostic({
    component: "hook",
    stage: "identity",
    error: new Error("stable session identity unavailable"),
    category: "missing_session_identity",
  });
  return identity;
}

function managedSubagentState(input, {
  pathField = "transcript_path",
  claim = false,
} = {}) {
  const spawn = readThreadSpawnIdentity(input, { pathField,
    onDiagnostic: (facts) => lifecycleDiagnostic("identity", facts) });
  if (!spawn) return { marked: false, managed: false };
  const carrier = parseCarrierTaskName(spawn.taskName);
  lifecycleDiagnostic("carrier", { marked: carrier.marked, valid: carrier.valid });
  if (!carrier.marked) return { marked: false, managed: false };
  if (!carrier.valid || !existsSync(databasePath())) {
    return { marked: true, managed: false };
  }
  let store;
  try {
    store = new RouterStore();
    const context = store.context({
      cwd: input.cwd || process.cwd(),
      contextId: spawn.parentContextId,
      authoritative: true,
      create: false,
    });
    const state = claim
      ? store.transaction(() => {
          const result = claimDelegationSubagent(store.db, context, {
            taskName: spawn.taskName,
            agentId: spawn.childId,
            model: input.model,
          });
          if (result.allowed) observeQualificationHook(store.db, context, result.routeId, "start", resolveLifecyclePluginRoot());
          return result;
        })
      : inspectManagedSubagent(store.db, context, {
          taskName: spawn.taskName,
          agentId: spawn.childId,
        });
    lifecycleDiagnostic("result", { claimed: claim ? state.allowed === true : state.managed === true });
    return { marked: true, managed: claim ? state.allowed === true : state.managed === true, state };
  } catch {
    lifecycleDiagnostic("result", { reason: "state_unavailable" });
    return { marked: true, managed: false };
  } finally {
    store?.close();
  }
}

function injectManagedSubagentContext(input, hookEventName, options = {}) {
  const result = managedSubagentState(input, options);
  lifecycleDiagnostic("result", { contextInjected: result.marked === true && result.managed === true });
  if (!result.marked) return false;
  if (!result.managed || result.state?.trusted === false) {
    additionalContext(rejectedSubagentContext(), hookEventName);
    return true;
  }
  additionalContext(boundedSubagentContext(result.state.contextPackage, {
    finalized: result.state.finalized === true,
  }), hookEventName);
  return true;
}

function automaticRoutingContext(rootTask, contextId) {
  return [
    "Adaptive Model Router global automatic activation is enabled for this local Codex task.",
    "For every meaningful substantive stage boundary, use the adaptive-model-router skill and call route_stage without requiring the user to mention the skill.",
    "Do not route greetings, simple questions, or messages with no work product merely to create a subagent.",
    "Read-only router inspection is not a substantive stage. For get_route_status, get_route_history, list_policy_proposals, get_learning_status, get_model_policy, preview_model_policy, diagnose_router, or shadow_route_stage requests, call only the requested inspection tool and never call route_stage merely to precede it.",
    "An action=delegate result is an explicit request from the applicable adaptive-model-router skill and satisfies conditional multi-agent policies that allow skill-requested delegation.",
    "With declared host delegation still available, action=delegate is required, not a suggestion: immediately create exactly one bounded subagent; do not continue root-only, ask the user, or claim a blanket no-subagent constraint.",
    "Only an actual host-tool rejection may prevent that launch; follow the skill's failed/tooling flow when it occurs.",
    "Declare hostCapabilities.delegation.invocation=direct only when spawn_agent is callable as a direct native tool. A spawn entry visible only inside functions.exec or another code-mode namespace is code_mode_nested, not a compatible delegation capability, and must remain root-only.",
    "Do not use list_agents, an empty agent list, or the absence of an existing child to decide whether spawn_agent is callable. Once this task has successfully created a Router child, do not downgrade direct delegation unless a later direct spawn_agent call returns an actual host rejection.",
    "For delegate, call the direct native spawn_agent tool outside functions.exec, pass carrier.taskName as the exact task_name, carrier.message as the exact message, and fork_turns=none; trusted hooks validate the non-encrypted task name without rewriting host-encrypted input and inject the bounded context only into that child.",
    "Never call record_outcome for a delegate route before its matching spawn_agent dispatch handshake; an unlaunched route has no verification outcome.",
    "If the guarded Stop re-entry arrives while that ticket is still unconsumed, the Router marks the launch lifecycle ambiguous and retains the gate; without an authoritative no-child result it never archives the attempt or permits a replacement child.",
    "For busy, do not create or retry an Agent and do not record an outcome for the busy decision; continue root-only, explain the pending delegation, and retain blockingRouteId internally.",
    `The active root-task model observed by the hook is ${rootLabel(rootTask)}; its reasoning effort remains visible only in the Codex composer.`,
    "The router must never change the root-task model or label a bounded subagent target as the root model.",
    contextIdInstruction(contextId),
    "After each route, show a compact notice with the unchanged root model and a readable stage label; for delegate, show target.model / target.effort / service_tier. Keep root reasoning effort host-managed.",
    "Omit routeId and blockingRouteId from routine conversation notices. Keep the exact IDs internally for lifecycle calls, history, and diagnostics; show them only for an explicit inspection, troubleshooting request, or a necessary user action that names an exact route.",
    "Use service_tier=unknown (host has not provided the child's tier) unless already available, direct host evidence identifies that exact child's tier. Never infer it from the parent task's Fast setting, model/effort, a supported service-tiers list, or an assumed default; unknown does not mean Fast is off.",
    "If only the requested tier is observed, label it requested, not actually served. This is display-only: do not change Fast, invent a spawn parameter, or launch a probe just to populate the notice.",
    "For delegate only, verify the work and record exactly one outcome; continue, ask_user, and busy routes have no outcome.",
  ].join("\n");
}

function inspectionContext(rootTask, contextId, tools) {
  return [
    "Read-only router inspection is active for this turn.",
    `Call only the requested inspection tool${tools.length === 1 ? "" : "s"}: ${tools.join(", ")}.`,
    "Do not call route_stage before or after the inspection. A live route is blocked for this inspection turn.",
    "Do not create a subagent or record an outcome for a shadow preference.",
    `The active root-task model observed by the hook is ${rootLabel(rootTask)}; it remains unchanged.`,
    contextIdInstruction(contextId),
  ].join("\n");
}

function pendingIntentContext(state, contextId) {
  const change = state.pendingChange;
  return [
    "Adaptive Model Router detected an unresolved active root-model change.",
    `changeId=${change.changeId}; from=${change.fromModel}; to=${change.toModel}.`,
    "Continue handling the current request in the root task with the active Codex model and never create a subagent while this change is unresolved.",
    "At a meaningful substantive stage boundary, route_stage may be called only to record its required HOST_MODEL_INTENT_PENDING continue decision; respect that result.",
    contextIdInstruction(contextId),
    "Briefly remind the user that the current and subsequent turns remain root-only, then ask them to choose either '本任务手动' / manual_root or '保持自动' / keep_automatic.",
    "Only after an explicit user answer, call resolve_host_model_intent with this changeId and the matching enum. Do not infer a decision from silence or unrelated text.",
  ].join("\n");
}

function manualRootContext(rootTask, contextId) {
  return [
    "Adaptive Model Router is in manual_root mode for this task.",
    `Continue only in the root task using ${rootLabel(rootTask)} and never create a routed subagent.`,
    "If route_stage is explicitly requested, respect its MANUAL_ROOT_SELECTED continue decision.",
    contextIdInstruction(contextId),
    "This mode lasts only for the current task. The user can send '路由器：本任务自动' to resume automatic routing.",
  ].join("\n");
}

function disabledRoutingContext(rootTask, contextId) {
  return [
    "Adaptive Model Router automatic routing is disabled for this session.",
    `Continue in the root task using ${rootLabel(rootTask)} and do not create an automatically routed subagent.`,
    "Do not call route_stage for ordinary tasks while this override is active. If the user explicitly invokes the router, respect its ROUTER_DISABLED continue decision.",
    contextIdInstruction(contextId),
    "Quoted commands and ordinary discussion do not change router controls. The user can send '路由器：本任务自动' to clear this session override.",
  ].join("\n");
}

function pendingChoiceReport(state, locale) {
  if (state.taskMode !== "pending_confirmation" || !state.pendingChange) return "";
  const change = state.pendingChange;
  return locale === "zh"
    ? `根模型变化待确认：${change.fromModel} → ${change.toModel} · ${change.changeId}。请选择“路由器：本任务手动”或“路由器：本任务自动”。`
    : `Root-model change pending: ${change.fromModel} → ${change.toModel} · ${change.changeId}. Choose "router: manual" or "router: auto session".`;
}

async function promptHook(input) {
  if (isBoundedSubagent(input)) {
    injectManagedSubagentContext(input, "UserPromptSubmit");
    return;
  }
  const prompt = String(input.prompt || "");
  const control = parseControlPrompt(prompt);
  const locale = prompt.startsWith("路由器：") ? "zh" : "en";
  const identity = requireIdentity(input, "UserPromptSubmit");
  if (!identity.contextId) return;
  const contextId = identity.contextId;
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId, authoritative: true });
    recordIdentity(identity, "identity_accepted");
    const inspection = control ? null : parseReadOnlyInspectionPrompt(prompt);
    if (inspection) store.setInspectionGuard(context);
    else store.clearInspectionGuard(context);
    if (!control) {
      const settings = store.getSettings(context);
      if (settings.autoActivate !== true || settings.enabled !== true) {
        const state = store.hostModelState(context);
        if (state.taskMode === "pending_confirmation") store.cancelPendingHostModelIntent(context);
        store.observeHostModel(context, input.model, { detectChanges: false });
        if (inspection) {
          additionalContext(inspectionContext(store.rootTask(context), contextId, inspection.tools));
        }
        return;
      }
      const resolved = store.resolveOverride(context, null, settings);
      const disabled = resolved.override?.mode === "disabled";
      store.observeHostModel(context, input.model, { detectChanges: !disabled });
      const state = store.hostModelState(context);
      const rootTask = store.rootTask(context);
      if (inspection) {
        additionalContext(inspectionContext(rootTask, contextId, inspection.tools));
        return;
      }
      if (state.taskMode === "pending_confirmation") {
        additionalContext(pendingIntentContext(state, contextId));
        return;
      }
      if (state.taskMode === "manual_root") {
        additionalContext(manualRootContext(rootTask, contextId));
        return;
      }
      if (disabled) {
        additionalContext(disabledRoutingContext(rootTask, contextId));
        return;
      }
      additionalContext(automaticRoutingContext(rootTask, contextId));
      return;
    }
    if (control.command === "status") {
      const settings = store.getSettings(context);
      const disabled = store.resolveOverride(context, null, settings).override?.mode === "disabled";
      const active = settings.autoActivate === true && settings.enabled === true;
      store.observeHostModel(context, input.model, { detectChanges: active && !disabled });
      const status = store.status(context);
      visibleReport(formatRouteStatus(status, { locale }), locale);
      return;
    }
    if (control.command === "history") {
      const settings = store.getSettings(context);
      const disabled = store.resolveOverride(context, null, settings).override?.mode === "disabled";
      const active = settings.autoActivate === true && settings.enabled === true;
      store.observeHostModel(context, input.model, { detectChanges: active && !disabled });
      const state = store.hostModelState(context);
      const history = formatRouteHistory(store.routeHistory(context, { limit: control.limit }), { locale });
      const pending = pendingChoiceReport(state, locale);
      visibleReport(pending ? `${history}\n${pending}` : history, locale);
      return;
    }
    if (control.command === "global_enable") {
      store.configure(context, { autoActivate: true }, "global");
      store.observeHostModel(context, input.model, { detectChanges: false });
      controlResultContext("Adaptive Router global automatic activation is enabled. Ordinary substantive tasks will route automatically after this control turn.");
      return;
    }
    if (control.command === "global_disable") {
      store.configure(context, { autoActivate: false }, "global");
      if (store.hostModelState(context).taskMode === "pending_confirmation") {
        store.cancelPendingHostModelIntent(context);
      }
      store.observeHostModel(context, input.model, { detectChanges: false });
      controlResultContext("Adaptive Router global automatic activation is disabled. Explicit skill use remains available.");
      return;
    }
    if (control.command === "manual") {
      store.observeHostModel(context, input.model, { detectChanges: false });
      store.setTaskMode(context, "manual_root");
      controlResultContext("Adaptive routing is in manual-root mode for this task; do not create a routed subagent.");
      return;
    }
    if (control.command === "enable") {
      store.configure(context, { enabled: true }, "project");
      store.clearOverrides(context, "session");
      store.setTaskMode(context, "automatic");
      store.observeHostModel(context, input.model, { detectChanges: false });
      controlResultContext("Adaptive routing is enabled for this project.");
      return;
    }
    if (control.command === "disable") {
      store.setOverride(context, { scope: "session", mode: "disabled" });
      store.observeHostModel(context, input.model, { detectChanges: false });
      controlResultContext("Adaptive routing is disabled for this session.");
      return;
    }
    if (control.command === "auto") {
      store.clearOverrides(context, control.scope);
      if (["session", "all"].includes(control.scope)) store.setTaskMode(context, "automatic");
      store.observeHostModel(context, input.model, { detectChanges: false });
      controlResultContext(`Adaptive routing override cleared for scope ${control.scope}.`);
      return;
    }
    if (control.command === "lock") {
      if (control.scope === "global" && !store.getSettings(context).allowGlobalOverride) return;
      store.setOverride(context, {
        scope: control.scope,
        model: control.model,
        effort: control.effort,
      });
      if (["once", "session"].includes(control.scope)) store.setTaskMode(context, "automatic");
      store.observeHostModel(context, input.model, { detectChanges: false });
      controlResultContext(
        `Adaptive routing lock set for scope ${control.scope}: model=${control.model}, effort=${control.effort || "automatic"}.`,
      );
    }
  } finally {
    store.close();
  }
}

async function stopHook(input) {
  if (isBoundedSubagent(input)) return;
  const identity = requireIdentity(input, "Stop");
  if (!identity.contextId) return;
  const contextId = identity.contextId;
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId, authoritative: true });
    recordIdentity(identity, "identity_accepted");
    const result = store.handleStop(context, { stopHookActive: input.stop_hook_active === true });
    if (result.action === "block" && input.stop_hook_active !== true) {
      writeJsonLine(process.stdout, { decision: "block", reason: result.reason });
    }
  } finally {
    store.close();
  }
}

async function compactSessionHook(input) {
  if (input.source !== "compact") return;
  if (isBoundedSubagent(input)) {
    injectManagedSubagentContext(input, "SessionStart");
    return;
  }
  const identity = requireIdentity(input, "SessionStart");
  if (!identity.contextId) return;
  const contextId = identity.contextId;
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId, authoritative: true });
    const settings = store.getSettings(context);
    if (settings.autoActivate !== true || settings.enabled !== true) {
      store.observeHostModel(context, input.model, { detectChanges: false });
      recordIdentity(identity, "not_injected_router_inactive");
      return;
    }
    const resolved = store.resolveOverride(context, null, settings);
    const disabled = resolved.override?.mode === "disabled";
    store.observeHostModel(context, input.model, { detectChanges: !disabled });
    const state = store.hostModelState(context);
    const rootTask = store.rootTask(context);
    let message;
    if (state.taskMode === "pending_confirmation") message = pendingIntentContext(state, contextId);
    else if (state.taskMode === "manual_root") message = manualRootContext(rootTask, contextId);
    else if (disabled) message = disabledRoutingContext(rootTask, contextId);
    else message = automaticRoutingContext(rootTask, contextId);
    additionalContext(message, "SessionStart");
    recordIdentity(identity, "injected_after_compaction");
  } finally {
    store.close();
  }
}

function subagentStartHook(input) {
  injectManagedSubagentContext(input, "SubagentStart", { claim: true });
}

async function preToolUseHook(input) {
  const parsed = parseCarrierTaskName(input.tool_input?.task_name);
  if (!parsed.marked) {
    if (parseLegacyCarrierMessage(input.tool_input?.message).marked) {
      denyRouterAgent("Legacy Router message carriers are unsupported by this host; request a fresh route.");
    }
    return;
  }
  if (!parsed.valid) {
    denyRouterAgent("Router-marked Agent call has a malformed delegation ticket marker.");
    return;
  }
  const identity = requireIdentity(input, "PreToolUse");
  if (!identity.contextId) {
    denyRouterAgent("Router-marked Agent call is missing the trusted parent session identity.");
    return;
  }
  let store;
  try {
    store = new RouterStore();
    const context = store.context({
      cwd: input.cwd || process.cwd(),
      contextId: identity.contextId,
      authoritative: true,
      create: false,
    });
    const result = store.transaction(() => {
      const consumed = consumeDelegationTicket(store.db, context, {
        taskName: parsed.taskName,
        turnId: input.turn_id,
        toolUseId: input.tool_use_id,
        toolInput: input.tool_input,
      });
      if (consumed.allowed) observeQualificationHook(store.db, context, consumed.routeId, "pre", resolveLifecyclePluginRoot());
      return consumed;
    });
    if (!result.allowed) {
      denyRouterAgent(result.reason);
      return;
    }
    lifecycleDiagnostic("result", { claimed: true });
    // Direct v2 collaboration messages are host-encrypted. Do not emit an
    // updatedInput for a valid launch: even an equivalent rewrite can detach
    // host-owned ciphertext from its original envelope. Unsafe fork modes are
    // denied by consumeDelegationTicket instead of being normalized here.
    // Codex accepts deny here but rejects permissionDecision=allow. Continuing
    // with an empty result preserves the host's ordinary permission boundary.
    writeJsonLine(process.stdout, {});
  } catch {
    denyRouterAgent("Router-marked Agent call could not be validated against trusted durable state.");
  } finally {
    store?.close();
  }
}

async function postToolUseHook(input) {
  const identity = resolveHookIdentity(input, { event: "PostToolUse" });
  if (!identity.contextId) return;
  if (!existsSync(databasePath())) return;
  const store = new RouterStore();
  try {
    const context = store.context({
      cwd: input.cwd || process.cwd(),
      contextId: identity.contextId,
      authoritative: true,
      create: false,
    });
    store.transaction(() => {
      const observed = observeAgentResult(store.db, context, {
        turnId: input.turn_id,
        toolUseId: input.tool_use_id,
        toolInput: input.tool_input,
        toolResponse: input.tool_response,
      });
      if (observed.correlated) observeQualificationHook(store.db, context, observed.routeId, "post", resolveLifecyclePluginRoot());
      lifecycleDiagnostic("result", { correlated: observed.correlated === true });
    });
  } finally {
    store.close();
  }
}

function trustedTranscriptBytes(path) {
  if (typeof path !== "string" || !path) return null;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || !Number.isSafeInteger(stats.size)) return null;
    const allocated = Number.isSafeInteger(stats.blocks) && stats.blocks >= 0
      ? stats.blocks * 512
      : stats.size;
    return Number.isSafeInteger(allocated) ? Math.max(stats.size, allocated) : null;
  } catch {
    return null;
  }
}

async function subagentStopHook(input) {
  try {
    const spawn = readThreadSpawnIdentity(input, { pathField: "agent_transcript_path",
      onDiagnostic: (facts) => lifecycleDiagnostic("identity", facts) });
    const carrier = parseCarrierTaskName(spawn?.taskName);
    if (spawn && carrier.valid && existsSync(databasePath())) {
      const store = new RouterStore();
      try {
        const context = store.context({
          cwd: input.cwd || process.cwd(),
          contextId: spawn.parentContextId,
          authoritative: true,
          create: false,
        });
        store.transaction(() => {
          const observed = observeSubagentStop(
            store.db,
            context,
            spawn.taskName,
            input.agent_id,
            trustedTranscriptBytes(input.agent_transcript_path),
          );
          if (observed.routeId) observeQualificationHook(store.db, context, observed.routeId, "stop", resolveLifecyclePluginRoot());
          lifecycleDiagnostic("result", { stopped: Boolean(observed.routeId) });
        });
      } finally {
        store.close();
      }
    }
  } finally {
    // Official SubagentStop hooks require JSON on stdout for an exit-0 no-op.
    writeJsonLine(process.stdout, {});
  }
}

const startedAt = Date.now();
let stage = "runtime";
let input;

try {
  stage = "input";
  input = await readInput();
  lifecycleDiagnostic = createLifecycleDiagnostic(input, process.argv[2]);
  stage = "runtime";
  assertRuntime();
  stage = "database_import";
  ({ RouterStore } = await import("./lib/database.mjs"));
  if (process.argv[2] === "prompt") {
    stage = "prompt";
    await promptHook(input);
  } else if (process.argv[2] === "stop") {
    stage = "stop";
    await stopHook(input);
  } else if (process.argv[2] === "subagent-start") {
    stage = "subagent_start";
    subagentStartHook(input);
  } else if (process.argv[2] === "session-start") {
    stage = "session_start";
    await compactSessionHook(input);
  } else if (process.argv[2] === "pre-tool-use") {
    stage = "pre_tool_use";
    await preToolUseHook(input);
  } else if (process.argv[2] === "post-tool-use") {
    stage = "post_tool_use";
    await postToolUseHook(input);
  } else if (process.argv[2] === "subagent-stop") {
    stage = "subagent_stop";
    await subagentStopHook(input);
  }
  lifecycleDiagnostic("exit");
} catch (error) {
  lifecycleDiagnostic("exception");
  process.stderr.write("Adaptive Model Router hook failed safely.\n");
  const category = stage === "runtime" ? "runtime" : stage === "input" ? "invalid_input" : undefined;
  emitDiagnostic({ component: "hook", stage, error, category, startedAt });
  if (
    process.argv[2] === "pre-tool-use"
    && (
      parseCarrierTaskName(input?.tool_input?.task_name).marked
      || parseLegacyCarrierMessage(input?.tool_input?.message).marked
    )
  ) {
    denyRouterAgent("Router-marked Agent call was denied because the Router hook failed closed.");
  }
  process.exitCode = 0;
}
