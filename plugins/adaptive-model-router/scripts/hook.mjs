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
import { childToolRestriction, isRouterChildTarget, observeManagedMessage, observeManagedStop, registerManagedChild, targetedChild } from "./lib/stage-closure.mjs";

import { observeCapacityList, observeCapacitySpawn, observeCapacityTurn, invalidateCapacityList } from "./lib/host-capacity-recovery.mjs";
import { rememberRootTranscript } from "./lib/stage-reconciliation.mjs";
import { isChildCommand, observeChildCommand } from "./lib/child-command-journal.mjs";

let RouterStore;
let diagnosticIdentity;
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
  if (diagnosticIdentity) recordIdentity(diagnosticIdentity, "context_emitted");
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
    recordHookIdentityDiagnostic(identity.audit, contextInjection, process.env, identity);
  } catch (error) {
    emitDiagnostic({ component: "hook", stage: "identity_diagnostic", error });
  }
}

function requireIdentity(input, event) {
  const identity = resolveHookIdentity(input, { event });
  diagnosticIdentity = identity;
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
    const child = targetedChild(store.db, context, spawn.childId);
    const maintenance = child && store.db.prepare("SELECT intent,state FROM delegation_maintenance WHERE route_id=?").get(child.route_id);
    if (maintenance) return { marked: true, managed: true, state: { managed: true, trusted: true,
      contextPackage: "This is an existing stage's bounded maintenance turn. Use no tools and execute no business work. Collect pending requirements, partial results and unresolved operation references for the root, then return a final reply. The original business authorization is closed." } };
    const state = claim
      ? store.transaction(() => {
          const result = claimDelegationSubagent(store.db, context, {
            taskName: spawn.taskName,
            agentId: spawn.childId,
            model: input.model,
          });
          if (result.allowed) {
            registerManagedChild(store.db, context, result.routeId, spawn, { trackCommands: true });
            observeCapacitySpawn(store.db, context, result.routeId);
            observeQualificationHook(store.db, context, result.routeId, "start", resolveLifecyclePluginRoot());
          }
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
    "For delegate, call the direct native spawn_agent tool outside functions.exec, pass carrier.taskName as the exact task_name, carrier.message as the exact message, fork_turns=none, target.model as model, and target.effort as reasoning_effort. All five parameters are required; never rely on inherited model or effort. Trusted hooks validate the non-encrypted task name without rewriting host-encrypted input and inject the bounded context only into that child.",
    "If PreToolUse rejects an ordinary Router launch for a model or reasoning-effort mismatch before ticket consumption, use the skill's native pre-dispatch recovery procedure. Do not retry that ticket or record an outcome; root-only continuation does not release its reservation.",
    "If direct spawn_agent returns exactly 'collab spawn failed: agent thread limit reached', use the skill's native capacity-rejection recovery procedure. A failed/tooling record_outcome automatically audits this exact failure; if it has not reconciled, inspect and apply native recovery for that route. Do not retry the ticket, invent lifecycle events, duplicate an outcome, or reuse a finished Router child for a new stage. Verified recovery releases only that reservation. HOST_AGENT_LIMIT_REACHED is retained history: call native list_agents for HOST_CAPACITY_RECHECK_REQUIRED, finish current work or bounded old-child maintenance, then request a new ticket for the same still-needed stage. One recovery startup per stage and native root turn is allowed; busy or exhausted recovery is temporary and later real delegation rechecks. Never raise the limit or replace a required independent review with root self-review.",
    "Never call record_outcome for a delegate route before its matching spawn_agent dispatch handshake; an unlaunched route has no verification outcome.",
    "Use manage_stage begin_maintenance for historical backlog or explicit cancellation/replacement/deferral before interrupting old business. Its actual child tool guard permits only a final collection reply; verify every input disposition and real pending operation before manage_stage verify_maintenance. Frozen inventories can call the installed stdio-tool.mjs bridge. The original outcome remains unchanged. On normal root exit and the next real stage, inspect stageClosure and complete its actionable responsibility.",
    "Router global reservations are capped at 10 across local tasks, separately from native per-root residency. Real full-capacity admission performs verified global reclamation; status/history reads never reclaim. ROUTER_GLOBAL_PENDING_LIMIT is a count limit, not disk exhaustion. Inspect get_route_status.globalReservations. A deferred reservation retains original work and its gate: read its disposition, verify the original result or begin bounded maintenance before followup, and reacquire capacity before resuming. Never treat deferred work as completed or raise the native residency limit.",
    "Use followup_task for necessary supplemental work in the same unfinalized stage, including when the child still appears running. Do not send courtesy messages into completed child queues. Before the final outcome, inspect get_route_status.stageClosure, handle its nextAction, and verify the result of the current requirements. Pass a ready closure token as record_outcome.closureToken after followups; an old Stop or successful send is not completion. A frozen outcome schema can use the installed one-shot stdio bridge with the current schema, without reopening the task.",
    "If the guarded Stop re-entry arrives while that ticket is still unconsumed, the Router marks the launch lifecycle ambiguous and retains the gate; without an authoritative no-child result it never archives the attempt or permits a replacement child.",
    "For busy, do not create or retry an Agent and do not record an outcome for the busy decision; continue root-only, explain the pending delegation, and retain blockingRouteId internally.",
    `The active root-task model observed by the hook is ${rootLabel(rootTask)}; its reasoning effort remains visible only in the Codex composer.`,
    "The router must never change the root-task model or label a bounded subagent target as the root model.",
    contextIdInstruction(contextId),
    "After each route, show a compact notice with the unchanged root model and a readable stage label; for delegate, show target.model / target.effort, adding service_tier only when directly observed for that child. Keep root reasoning effort host-managed.",
    "Omit routeId and blockingRouteId from routine conversation notices. Keep the exact IDs internally for lifecycle calls, history, and diagnostics; show them only for an explicit inspection, troubleshooting request, or a necessary user action that names an exact route.",
    "Omit the service_tier field from routine notices unless already available, direct host evidence identifies that exact child's tier. Never infer it from the parent task's Fast setting, model/effort, a supported service-tiers list, or an assumed default; an omitted tier does not mean Fast is off.",
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
    observeCapacityTurn(store.db, context, input.turn_id);
    rememberRootTranscript(store.db, context, input.transcript_path);
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
        } else if (/\$adaptive-model-router(?![A-Za-z0-9_-])/u.test(prompt)) {
          additionalContext([
            "Trusted Adaptive Model Router context is available for explicitly requested Router calls.",
            "This identity does not enable automatic routing or change Router controls.",
            `The root-task model is ${rootLabel(store.rootTask(context))} and remains host-managed.`,
            contextIdInstruction(contextId),
          ].join("\n"));
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
      const pending = store.status(context);
      const reminders = pending.stageClosure || pending.pendingStageWork?.length || pending.globalReservations?.retained?.length
        ? `\nExisting child responsibilities: ${JSON.stringify({ stageClosure: pending.stageClosure, pendingStageWork: pending.pendingStageWork,
          reservationDispositions: pending.globalReservations?.retained })}. Continue their concrete next actions in this task. Read preserved dispositions before resuming deferred work and check current user intent and workspace; do not redo completed operations.` : "";
      additionalContext(automaticRoutingContext(rootTask, contextId) + reminders);
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
  // Automatic continuations need not submit a new user prompt. An actually
  // dispatched root tool Hook can establish this exact turn without borrowing
  // an older receipt or inventing a UserPromptSubmit event.
  if (!isBoundedSubagent(input) && typeof input.tool_use_id === "string" && input.tool_use_id.trim()
    && typeof input.tool_name === "string" && input.tool_name.trim()) {
    const identity = resolveHookIdentity(input, { event: "PreToolUse" });
    if (identity.contextId && identity.turnId) recordIdentity(identity, "identity_accepted");
  }
  if (managedChildToolHook(input)) return;
  if (managedMessageHook(input, false)) return;
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
      rememberRootTranscript(store.db, context, input.transcript_path);
      observeCapacityTurn(store.db, context, input.turn_id);
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
  if (managedChildCommandResultHook(input)) return;
  if (!isBoundedSubagent(input) && /^(?:collaboration)?list_agents$/u.test(input.tool_name || "")) {
    if (existsSync(databasePath()) && input.session_id) {
      const store = new RouterStore();
      try {
        const context = store.context({ cwd: input.cwd || process.cwd(), contextId: input.session_id, authoritative: true, create: false });
        store.transaction(() => observeCapacityList(store.db, context, input));
      } finally { store.close(); }
    }
    return;
  }
  if (managedMessageHook(input, true)) return;
  if (!/^(?:Agent|(?:collaboration)?spawn_agent)$/u.test(input.tool_name || "")) return;
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
      if (observed.routeId) observeCapacitySpawn(store.db, context, observed.routeId);
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
          invalidateCapacityList(store.db, context);
          const managed = targetedChild(store.db, context, spawn.childId);
          if (managed) observeManagedStop(store.db, managed.route_id, { turnId: input.turn_id, lastAssistantMessage: input.last_assistant_message });
          const observed = observeSubagentStop(
            store.db,
            context,
            spawn.taskName,
            input.agent_id,
            trustedTranscriptBytes(input.agent_transcript_path),
            { turnId: input.turn_id, lastAssistantMessage: input.last_assistant_message },
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

function managedChildToolHook(input) {
  if (!isBoundedSubagent(input)) return false;
  const spawn = readThreadSpawnIdentity(input);
  if (spawn && !isRouterChildTarget(spawn.taskName)) return false;
  let store;
  try {
    store = new RouterStore();
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId: spawn?.parentContextId || input.session_id,
      authoritative: true, create: false });
    const restriction = store.transaction(() => {
      const target = spawn?.childId || input.agent_id;
      const restriction = childToolRestriction(store.db, context, target, input);
      if (restriction.restricted || !isChildCommand(input)) return restriction;
      const child = targetedChild(store.db, context, target);
      const command = observeChildCommand(store.db, child.route_id, input);
      return command.allowed ? restriction : { restricted: true, reason: command.reason };
    });
    if (!restriction.restricted) return false;
    denyRouterAgent(restriction.reason);
  } catch {
    denyRouterAgent("This bounded child's Router state is unavailable. Preserve its work and return the missing evidence to the root; do not run business tools.");
  } finally { store?.close(); }
  return true;
}

function managedChildCommandResultHook(input) {
  if (!isChildCommand(input) || !isBoundedSubagent(input)) return false;
  const spawn = readThreadSpawnIdentity(input);
  if (!spawn || !isRouterChildTarget(spawn.taskName)) return false;
  let store;
  try {
    store = new RouterStore();
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId: spawn.parentContextId,
      authoritative: true, create: false });
    store.transaction(() => {
      const child = targetedChild(store.db, context, spawn.childId);
      if (child) observeChildCommand(store.db, child.route_id, input, { post: true });
    });
  } finally { store?.close(); }
  return true;
}

function managedMessageHook(input, post) {
  if (!/^(?:collaboration)?(?:send_message|followup_task|interrupt_agent)$/u.test(input.tool_name || "")) return false;
  const marked = isRouterChildTarget(input.tool_input?.target) || /^[a-f0-9-]{36}$/u.test(input.tool_input?.target || "");
  const denyUnavailable = () => {
    if (!post) denyRouterAgent("Router message ownership or durable registration is unavailable. Preserve the requirement at the root and reconcile before native delivery.");
    else writeJsonLine(process.stdout, {});
    return true;
  };
  if (!existsSync(databasePath())) return marked ? denyUnavailable() : false;
  const identity = resolveHookIdentity(input, { event: post ? "PostToolUse" : "PreToolUse" });
  if (!identity.contextId) return marked ? denyUnavailable() : false;
  const spawn = isBoundedSubagent(input) ? readThreadSpawnIdentity(input) : null;
  const author = isBoundedSubagent(input) ? spawn?.agentPath || null : "/root";
  let store;
  try {
    store = new RouterStore();
    const context = store.context({ cwd: input.cwd || process.cwd(),
      contextId: spawn?.parentContextId || identity.contextId, authoritative: true, create: false });
    const result = store.transaction(() => {
      if (author === "/root") rememberRootTranscript(store.db, context, input.transcript_path);
      return observeManagedMessage(store.db, context, input, { post, author });
    });
    if (!result.matched) return false;
    if (!post && !result.allowed) denyRouterAgent(result.reason);
    else writeJsonLine(process.stdout, {});
    return true;
  } catch (error) {
    if (marked) return denyUnavailable();
    throw error;
  } finally { store?.close(); }
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
      isBoundedSubagent(input)
      || isRouterChildTarget(input?.tool_input?.target)
      || /^[a-f0-9-]{36}$/u.test(input?.tool_input?.target || "")
      || parseCarrierTaskName(input?.tool_input?.task_name).marked
      || parseLegacyCarrierMessage(input?.tool_input?.message).marked
    )
  ) {
    denyRouterAgent("Router-marked Agent call was denied because the Router hook failed closed.");
  }
  process.exitCode = 0;
}
