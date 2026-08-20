---
name: adaptive-model-router
description: Choose whether a substantive Codex task stage should continue locally, ask the user, or run as one bounded subagent with a specific available model and reasoning effort. Use at task-stage boundaries, after verification failures, when the user explicitly controls adaptive routing, or when they ask which bounded model target is active or request route/model history.
---

# Adaptive Model Router

Use the router at a meaningful stage boundary, not before every message. It does not change the root task model. It can select one bounded subagent model and reasoning effort while the root remains the orchestrator. A trusted plugin hook may automatically activate this workflow globally, so a user does not need to mention the skill on every substantive task.

This routing workflow belongs to the root task only. If the current agent is
already a bounded subagent, execute only the parent's assigned scope and return
the result. Do not call `route_stage` or `shadow_route_stage`, change router
controls or root-model intent, spawn another routed subagent, or call
`record_outcome`; the parent root task owns routing, verification, and outcome
recording.

## Frozen task tool inventory

Prefer the native Adaptive Model Router MCP tools whenever the host exposes
them. A task created while the MCP failed can retain a frozen tool inventory
even after the installed server is repaired. In that root task, do not call the
router unavailable and do not require a new task until the installed stdio
bridge has also been tried.

The bridge is allowed only when a trusted Router Hook injected the exact fixed
`contextId` for the current task. Never invent, derive, or replace that value.
Resolve `<plugin-root>` as the directory containing this skill's `skills/`
directory, read `<plugin-root>/.mcp.json`, and start its exact `command` with
`<plugin-root>/scripts/stdio-tool.mjs` as the sole argument. The helper accepts
one JSON document on stdin with this shape and exits after one call:

```json
{"name":"route_stage","arguments":{"goal":"...","phase":"...","evidence":{},"contextId":"hook-injected-id"}}
```

Prefer one atomic invocation that supplies the request inside the same command
execution. On POSIX shells, use a literal here-document; replace both paths and
the JSON values, but keep the quoted delimiter exactly as shown:

```sh
<exact-command> <plugin-root>/scripts/stdio-tool.mjs <<'ADAPTIVE_ROUTER_REQUEST'
{"name":"route_stage","arguments":{"goal":"...","phase":"...","evidence":{},"contextId":"hook-injected-id"}}
ADAPTIVE_ROUTER_REQUEST
```

This is a single command execution and does not require a `session_id` or
`write_stdin`. The quoted delimiter prevents the JSON from being interpreted by
the shell. On PowerShell, use the equivalent single-command PowerShell
here-string piped to the exact command and helper path. Never launch the helper
as a one-shot command with no input payload and wait for it to exit; that does
not call Router at all.

Only when literal input cannot be embedded in the command and the host actually
returns writable command sessions, call `exec_command` with `tty: true` and a
short yield, require its returned `session_id`, then immediately call
`write_stdin` for that session with the JSON as one line followed by a newline.
The helper processes the first line and exits without requiring the session
input stream to be closed.

If the helper reports that it "timed out before receiving JSON", classify that
as a caller input-delivery failure, not an MCP transport failure. Retry exactly
once with the atomic literal-input command above. Do not repeat a bare helper
launch or assume a command is writable merely because it stayed alive.
Do not apply this corrective retry to an internal `stdio bridge timed out`
failure after a request was received. The bridge invokes the installed MCP
`tools/call`; treat a response with
`transport="stdio-bridge"` and `isError=false` exactly like the corresponding
native tool result. Use the same bridge for `record_outcome` and approved
read-only Router tools when their native functions are absent. Include
`transport=stdio-bridge` in the compact route notice. A bridge transport
failure is not a Router `continue` result and must be reported separately.

Never use the bridge for a tool that is not explicitly marked
`approval_mode="approve"` in the installed `.mcp.json`. If neither the native
tool nor this bridge can run, fail open locally and report both concrete
transport failures without claiming that `route_stage` returned a decision.

## Route a stage

An explicit current-turn user instruction that forbids subagents or delegation
suppresses automatic live routing for that stage. Continue in the root without
calling `route_stage`; a Router `delegate` result must never override that user
constraint. If the user explicitly asks to inspect what the router would have
preferred while still forbidding a launch, call `shadow_route_stage` only and
label it as a non-live preference with no route or outcome lifecycle. This
stage-local suppression does not change the global or session Router setting.

1. Call `route_stage` with:
   - a concise stage `goal`;
   - the current `phase`;
   - strictly factual boolean/integer `evidence`;
     set `grillWithDocs: true` only when the `grill-with-docs` skill is actually
     active for the current stage, and set `planMode: true` only when the host
     has actually placed the current task in Plan mode. Mere mentions do not
     activate either signal, and the two signals may be combined;
   - a stable task/thread identifier as `contextId`;
   - `previousRouteId` only when continuing or retrying a route returned earlier;
   - an `override` only when the user explicitly requested a model or effort for this call.
   - `hostCapabilities.delegation` whenever the host exposes the bounded
     subagent tool contract. Set `available` factually and copy only the
     supported model slugs and reasoning-effort enums into `targets`. Do not
     infer bounded-subagent support from the root model picker, the observed
     root slug, or `models_cache.json`. `evidence.hostCanDelegate` remains a
     deprecated compatibility signal; omit it when the richer capability is
     supplied.
2. Follow the returned `action`:
   - `continue`: keep working in the current root task. Do not create a subagent.
   - `ask_user`: explain the reason code and obtain the missing decision.
   - `delegate`: create exactly one bounded subagent by passing `target.model` to the host's `model` parameter and `target.effort` to the host's `reasoning_effort` parameter, if the host supports them.
     `delegate` is a required action, not a suggestion. This applicable skill
     instruction is the explicit request that satisfies conditional multi-agent policies
     which allow subagents when a skill requests delegation. When the declared host
     capability remains available, create the subagent immediately; do not reinterpret
     such a conditional policy as a blanket prohibition, continue the delegated stage in
     the root task, or ask the user to authorize it again. Only an actual host-tool
     rejection enters the tooling-failure flow below.
3. Immediately after every successful `route_stage` call, show one compact route notice in commentary:
   - always say that the root-task model is unchanged and host-managed;
   - when `rootTask.modelVisibility` is `hook_observed`, show `rootTask.model`; its reasoning effort remains visible only in the Codex composer;
   - for `delegate`, show `target.model`, `target.effort`, and `routeId`;
   - for `continue` or `ask_user`, show the action, reason codes, and `routeId`;
   - never label a bounded subagent target as the current root-task model.
   - never call a `delegate` result a recommendation or claim that a conditional
     no-proactive-subagent policy prevented the required launch.
   Prefer the stable shape
   `Router · automatic · root=<observed-or-host-managed> (unchanged) · stage=<action/target> · route=<routeId>`
   and localize labels to the user's language.
4. When delegation is unavailable in the current host, fail open by continuing with the current model. Do not claim that the root task model changed.
5. Keep the delegated scope concrete and bounded. The root owns orchestration, integration, user communication, and verification. Never create overlapping writers.
6. Run the returned `verificationGate` at the root. Then call `record_outcome` once with the route ID and the exact final outcome schema, including all four `retryBreakdown` counters whose sum equals `retries`.

Map the router's `target.effort` value to the current Codex subagent `reasoning_effort` parameter. Do not submit an `effort` parameter to a host that does not define one, and do not invent `agentType`, `agent_type`, or other unsupported parameters.

## Failures and escalation

On a verification failure, route the next attempt with the prior `routeId`, `verificationFailed: true`, and an enumerated `failureType`. Reasoning failures escalate monotonically at most twice in the exact effort order `high < xhigh < max < ultra`. Static routing never starts at Ultra, and Max requires the hard-signal gate. Environment, missing-information, and tooling failures do not justify a stronger effort. After the automatic limit, ask the user instead of silently changing targets. If an Ultra stage would create parallel writers, pass `parallelWriteRisk: true` and respect the returned `ask_user`.

If the host rejects a returned bounded target before the subagent starts,
record that route immediately as `failed` with `failureType: tooling`. For an
automatic route, call `route_stage` once more with that `previousRouteId` and
the tooling-failure evidence; the router excludes the rejected model. For an
explicit route, it returns `ask_user` instead of substituting. If the one
automatic retry is also rejected, record it as `failed/tooling` and continue in
the root; never loop. A route decision is not proof that the subagent started.

Root, delegate, and classifier model availability are separate. Luna may be
visible as a root model or usable by the classifier's independent ephemeral
app-server without being available to the current host's bounded subagent
tool. Only `hostCapabilities.delegation.targets` authorizes a bounded target.

## Controls and learning

Only prompts beginning exactly with `router:` or `路由器：` are control commands. Quoted text, code blocks, negations, and ordinary discussion do not change router state.

The installed `UserPromptSubmit` hook executes every recognized exact control
atomically before the model handles that turn. When its additional context says
that the control was applied, report that result only: do not replay the
control through `configure_router`, `set_route_override`,
`resolve_host_model_intent`, or any other MCP tool. Never invent a `contextId`.
For ordinary stage and inspection MCP calls, use only the exact fixed
`contextId` injected by the hook. If a control turn has no trusted hook result,
do not guess a task identifier or claim success; explain that the control could
not be applied safely and advise the user to re-trust or diagnose the hook.

The global automatic activation setting is opt-in. `router: global on` / `路由器：全局开启` enables it for local Codex tasks sharing this plugin data. `router: global off` / `路由器：全局关闭` stops automatic activation but keeps explicit skill use available. `router: manual` / `路由器：本任务手动` keeps the current task root-only; `router: auto session` / `路由器：本任务自动` resumes automatic routing.

The hook may observe the active root-model slug, but never its reasoning effort. The first observation in a task is a baseline. If a later slug changes, the hook places the task in `pending_confirmation`: keep working in the root, never spawn a subagent, and remind the user to choose manual-root or keep-automatic. A `route_stage` call at a substantive boundary returns `continue` with `HOST_MODEL_INTENT_PENDING`; respect it. Continue root-only on later turns until the user explicitly answers. Then call `resolve_host_model_intent` with the pending `changeId`; never infer a decision from silence or unrelated text. `manual_root` lasts only for the current task and likewise forces `MANUAL_ROOT_SELECTED` plus `continue`.

Learning is project-local. A proposal never changes policy until the user explicitly calls `approve_policy_proposal`. Rejection advances the evidence window; rollback walks backward through immutable revisions. `get_learning_status` is read-only. `shadow_route_stage` must remain free of route/outcome/proposal/cursor writes. Rebase and offline scoring-profile re-anchor require an explicit user instruction; re-anchor also requires the exact confirmation. Do not approve, reject, rebase, re-anchor, roll back, import legacy settings, or clear project data without an explicit user instruction. The only automatic learning mutation beyond proposal creation is a hard risk-floor rollback.

Read-only router inspection is not a substantive stage boundary. When the user
requests `get_route_status`, `get_route_history`, `list_policy_proposals`,
`get_learning_status`, `diagnose_router`, or `shadow_route_stage`, call only
the requested inspection tool and do not call `route_stage` merely to precede
it. In particular, call `shadow_route_stage` directly, do not create a
subagent or outcome for its preference, and do not pass `hostCapabilities`;
shadow scoring returns a preferred family/effort rather than a live bounded
target.

The auxiliary classifier receives only a redacted short summary, phase, and boolean signals. If it is disabled, local-only, timed out, or circuit-broken, use the deterministic route.

Use `get_route_status` when the user asks which model is in use. Explain that the
router never changes the root-task model. It can show the hook-observed root-model
slug when available, but not root reasoning effort; it also shows the latest
bounded-stage target and whether that route still lacks an outcome. Use
`get_route_history` for a timestamped current-project/current-context timeline
of route actions, delegated model/effort transitions, reasons, and outcomes.
Users can request the same visible reports with `router: status`,
`router: history 10`, `路由器：状态`, or `路由器：历史 10`.
