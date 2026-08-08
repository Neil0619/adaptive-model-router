#!/usr/bin/env node
import { parseControlPrompt, parseReadOnlyInspectionPrompt } from "./lib/control.mjs";
import { writeJsonLine } from "./lib/io.mjs";
import { formatRouteHistory, formatRouteStatus } from "./lib/presentation.mjs";
import { assertRuntime } from "./lib/runtime.mjs";
import { emitDiagnostic } from "./lib/diagnostics.mjs";

let RouterStore;

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

function isBoundedSubagent(input) {
  return [input.agent_id, input.agent_type].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function boundedSubagentContext() {
  return [
    "Adaptive Model Router: this agent is already a bounded subagent selected by its parent root task.",
    "Execute only the bounded work assigned by the parent and return the result to that parent.",
    "Never call route_stage, shadow_route_stage, resolve_host_model_intent, configure_router, learning-policy tools, or spawn another routed subagent.",
    "Do not interpret this subagent model as the root-task model and do not change router controls or root-model intent state.",
    "The parent root task owns route reporting, verification, record_outcome, and the routed-stage Stop lifecycle.",
  ].join("\n");
}

function automaticRoutingContext(rootTask, contextId) {
  return [
    "Adaptive Model Router global automatic activation is enabled for this local Codex task.",
    "For every meaningful substantive stage boundary, use the adaptive-model-router skill and call route_stage without requiring the user to mention the skill.",
    "Do not route greetings, simple questions, or messages with no work product merely to create a subagent.",
    "Read-only router inspection is not a substantive stage. For get_route_status, get_route_history, list_policy_proposals, get_learning_status, diagnose_router, or shadow_route_stage requests, call only the requested inspection tool and never call route_stage merely to precede it.",
    "An action=delegate result is an explicit request from the applicable adaptive-model-router skill and satisfies conditional multi-agent policies that allow skill-requested delegation.",
    "With declared host delegation still available, action=delegate is required, not a suggestion: immediately create exactly one bounded subagent; do not continue root-only, ask the user, or claim a blanket no-subagent constraint.",
    "Only an actual host-tool rejection may prevent that launch; follow the skill's failed/tooling flow when it occurs.",
    `The active root-task model observed by the hook is ${rootLabel(rootTask)}; its reasoning effort remains visible only in the Codex composer.`,
    "The router must never change the root-task model or label a bounded subagent target as the root model.",
    contextIdInstruction(contextId),
    "After each route, show the unchanged root model, action or bounded target, effort, and routeId. For delegate only, verify the work and record exactly one outcome; continue and ask_user routes have no outcome.",
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
    additionalContext(boundedSubagentContext());
    return;
  }
  const prompt = String(input.prompt || "");
  const control = parseControlPrompt(prompt);
  const locale = prompt.startsWith("路由器：") ? "zh" : "en";
  const contextId = String(input.session_id || input.turn_id || "");
  if (!contextId) return;
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId, authoritative: true });
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
  const contextId = String(input.session_id || input.turn_id || "");
  if (!contextId) return;
  const store = new RouterStore();
  try {
    const context = store.context({ cwd: input.cwd || process.cwd(), contextId, authoritative: true });
    store.handleStop(context);
  } finally {
    store.close();
  }
}

function subagentStartHook() {
  additionalContext(boundedSubagentContext(), "SubagentStart");
}

const startedAt = Date.now();
let stage = "runtime";

try {
  assertRuntime();
  stage = "database_import";
  ({ RouterStore } = await import("./lib/database.mjs"));
  stage = "input";
  const input = await readInput();
  if (process.argv[2] === "prompt") {
    stage = "prompt";
    await promptHook(input);
  } else if (process.argv[2] === "stop") {
    stage = "stop";
    await stopHook(input);
  } else if (process.argv[2] === "subagent-start") {
    stage = "subagent_start";
    subagentStartHook();
  }
} catch (error) {
  process.stderr.write("Adaptive Model Router hook failed safely.\n");
  const category = stage === "runtime" ? "runtime" : stage === "input" ? "invalid_input" : undefined;
  emitDiagnostic({ component: "hook", stage, error, category, startedAt });
  process.exitCode = 0;
}
