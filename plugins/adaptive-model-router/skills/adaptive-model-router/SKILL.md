---
name: adaptive-model-router
description: Choose whether a substantive Codex task stage should continue locally, ask the user, or run as one bounded subagent with a specific available model and reasoning effort. Use at task-stage boundaries, after verification failures, when the user explicitly controls adaptive routing, or when they ask which bounded model target is active or request route/model history.
---

# Adaptive Model Router

Use the router at a meaningful stage boundary, not before every message. It does not change the root task model. It can recommend one bounded subagent model and reasoning effort while the root remains the orchestrator. A trusted plugin hook may automatically activate this workflow globally, so a user does not need to mention the skill on every substantive task.

## Route a stage

1. Call `route_stage` with:
   - a concise stage `goal`;
   - the current `phase`;
   - strictly factual boolean/integer `evidence`;
   - a stable task/thread identifier as `contextId`;
   - `previousRouteId` only when continuing or retrying a route returned earlier;
   - an `override` only when the user explicitly requested a model or effort for this call.
2. Follow the returned `action`:
   - `continue`: keep working in the current root task. Do not create a subagent.
   - `ask_user`: explain the reason code and obtain the missing decision.
   - `delegate`: create one bounded subagent by passing `target.model` to the host's `model` parameter and `target.effort` to the host's `reasoning_effort` parameter, if the host supports them.
3. Immediately after every successful `route_stage` call, show one compact route notice in commentary:
   - always say that the root-task model is unchanged and host-managed;
   - when `rootTask.modelVisibility` is `hook_observed`, show `rootTask.model`; its reasoning effort remains visible only in the Codex composer;
   - for `delegate`, show `target.model`, `target.effort`, and `routeId`;
   - for `continue` or `ask_user`, show the action, reason codes, and `routeId`;
   - never label a bounded subagent target as the current root-task model.
   Prefer the stable shape
   `Router · automatic · root=<observed-or-host-managed> (unchanged) · stage=<action/target> · route=<routeId>`
   and localize labels to the user's language.
4. When delegation is unavailable in the current host, fail open by continuing with the current model. Do not claim that the root task model changed.
5. Keep the delegated scope concrete and bounded. The root owns orchestration, integration, user communication, and verification. Never create overlapping writers.
6. Run the returned `verificationGate` at the root. Then call `record_outcome` once with the route ID and the exact final outcome schema.

Map the router's `target.effort` value to the current Codex subagent `reasoning_effort` parameter. Do not submit an `effort` parameter to a host that does not define one, and do not invent `agentType`, `agent_type`, or other unsupported parameters.

## Failures and escalation

On a verification failure, route the next attempt with the prior `routeId`, `verificationFailed: true`, and an enumerated `failureType`. Reasoning failures escalate monotonically. Environment and missing-information failures do not justify a stronger model. After the automatic limit, ask the user instead of silently changing targets.

## Controls and learning

Only prompts beginning exactly with `router:` or `路由器：` are control commands. Quoted text, code blocks, negations, and ordinary discussion do not change router state.

The global automatic activation setting is opt-in. `router: global on` / `路由器：全局开启` enables it for local Codex tasks sharing this plugin data. `router: global off` / `路由器：全局关闭` stops automatic activation but keeps explicit skill use available. `router: manual` / `路由器：本任务手动` keeps the current task root-only; `router: auto session` / `路由器：本任务自动` resumes automatic routing.

The hook may observe the active root-model slug, but never its reasoning effort. The first observation in a task is a baseline. If a later slug changes, the hook places the task in `pending_confirmation`: keep working in the root, never spawn a subagent, and remind the user to choose manual-root or keep-automatic. A `route_stage` call at a substantive boundary returns `continue` with `HOST_MODEL_INTENT_PENDING`; respect it. Continue root-only on later turns until the user explicitly answers. Then call `resolve_host_model_intent` with the pending `changeId`; never infer a decision from silence or unrelated text. `manual_root` lasts only for the current task and likewise forces `MANUAL_ROOT_SELECTED` plus `continue`.

Learning is project-local. A proposal never changes policy until the user explicitly calls `approve_policy_proposal`. Rejection advances the evidence window; rollback walks backward through immutable revisions. Do not approve, reject, roll back, import legacy settings, or clear project data without an explicit user instruction.

The auxiliary classifier receives only a redacted short summary, phase, and boolean signals. If it is disabled, local-only, timed out, or circuit-broken, use the deterministic route.

Use `get_route_status` when the user asks which model is in use. Explain that the
router never changes the root-task model. It can show the hook-observed root-model
slug when available, but not root reasoning effort; it also shows the latest
bounded-stage target and whether that route still lacks an outcome. Use
`get_route_history` for a timestamped current-project/current-context timeline
of route actions, delegated model/effort transitions, reasons, and outcomes.
Users can request the same visible reports with `router: status`,
`router: history 10`, `路由器：状态`, or `路由器：历史 10`.
