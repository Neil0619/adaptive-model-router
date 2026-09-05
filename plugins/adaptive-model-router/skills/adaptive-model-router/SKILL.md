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
The stable identity is the host-provided non-empty `session_id`; `turn_id` is
ephemeral audit metadata and must never be used as a fallback. After root-task
compaction, the trusted `SessionStart(source=compact)` Hook re-injects the same
task context before the immediate continuation. If it is absent, run
`node scripts/codex-route.mjs hook-doctor` from the installed plugin root to
distinguish an undispatched Hook from a dispatched Hook missing `session_id`.
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
   - the current `phase` and one stable `stageId` across all retries of the same logical stage;
     omit `previousRouteId` after success and reclassify the next stage;
   - strictly factual boolean/integer `evidence`; explicitly provide
     `requirementsSettled` and `strongVerification` only when established;
     `exactOutputCheck` means deterministic output acceptance, not merely a plan to test;
     set `grillWithDocs: true` only when the `grill-with-docs` skill is actually
     active for the current stage, and set `planMode: true` only when the host
     has actually placed the current task in Plan mode. Mere mentions do not
     activate either signal, and the two signals may be combined;
   - a stable task/thread identifier as `contextId`;
   - `previousRouteId` only when continuing or retrying a route returned earlier;
   - an `override` only when the user explicitly requested a model or effort for this call.
   - `hostCapabilities.delegation` whenever the host exposes the bounded
     subagent tool contract. Set `invocation: "direct"` only when
     `spawn_agent` is callable as a direct native tool outside
     `functions.exec`, then set `available` factually and copy only the
     supported model slugs and reasoning-effort enums into `targets`. A tool
     found only in `ALL_TOOLS` inside code mode is not a direct capability:
     report `available: false`, `invocation: "code_mode_nested"`, and an empty
     target list. Do not infer bounded-subagent support from the root model
     picker, the observed root slug, or `models_cache.json`.
     `evidence.hostCanDelegate` remains a deprecated compatibility signal;
     omit it when the richer capability is supplied.
2. Follow the returned `action`:
   - `continue`: keep working in the current root task. Do not create a subagent.
   - `ask_user`: explain the reason code and obtain the missing decision.
   - `busy`: another Router-managed delegation still owns this task context.
     Do not create an Agent, do not call `record_outcome` for the busy
     decision, and do not retry `route_stage`. Explain the pending delegation,
     retain `blockingRouteId` internally, and
     continue root-only until that exact delegation has a safely correlated
     child terminal event and recorded outcome.
   - `delegate`: create exactly one bounded subagent by calling the direct native `spawn_agent` tool outside `functions.exec`, passing `target.model` to the host's `model` parameter and `target.effort` to the host's `reasoning_effort` parameter. Make the `route_stage` `goal` and `phase` the complete bounded task capsule. The route also returns a one-shot `carrier`: pass `carrier.taskName` as the exact `task_name`, pass `carrier.message` as the exact `message`, and pass `fork_turns: "none"`. Codex encrypts the direct tool's message parameter; the trusted `PreToolUse` hook consumes and validates the ticket in the non-encrypted task name, verifies the target model, effort, and existing no-history mode, and deliberately emits no `updatedInput`, preserving the host-owned ciphertext. The trusted `SubagentStart` hook then correlates the child through host-written thread-spawn metadata and injects the bounded Router context package only into that exact child. Never route the carrier through a code-mode nested tool, omit, modify, reuse, or log the task-name ticket, or add caller text to the activation message.
     `list_agents` reports already-created agents; an empty list is never proof
     that direct `spawn_agent` is unavailable. Once this context has completed a
     direct child dispatch, do not downgrade the declared direct capability
     unless the current direct `spawn_agent` call actually rejects before a
     child is created.
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
   - use a readable stage label; for `delegate`, show `target.model` / `target.effort` / `service_tier`;
   - for `continue` or `ask_user`, show the action and a concise explanation of the reason; make any required user action explicit;
   - for `busy`, explain that an earlier delegation still owns the gate and the root is continuing; do not imply that a replacement child was launched;
   - omit `routeId` and `blockingRouteId` from routine conversation notices. Keep the exact IDs internally for lifecycle calls, outcomes, history, and diagnostics. Show them only for an explicit inspection, troubleshooting request, or a necessary user action that names an exact route; hiding them is not deleting or changing the recorded evidence;
   - show `service_tier=unknown` with a brief localized "host has not provided the child's tier" label unless already available, direct host evidence identifies that exact child's tier. Current route output does not attest a child's service tier. Neither the parent task's Fast setting, the selected model/effort, a supported service-tiers list, nor an assumed inheritance/default is proof. Unknown does not mean Fast is off;
   - distinguish an observed **requested** tier from an **actually served** tier; label requested-only evidence accordingly. This is display-only: do not change Fast, invent a `service_tier` spawn parameter, scan unrelated logs, or launch a probe just to populate the notice;
   - never label a bounded subagent target as the current root-task model.
   - never call a `delegate` result a recommendation or claim that a conditional
     no-proactive-subagent policy prevented the required launch.
   Prefer the stable shape
   `Router · root=<observed-or-host-managed> (unchanged) · <stage> · <model> / <effort> / service_tier=<observed-value-or-unknown>`
   for delegated stages, and localize labels to the user's language. For example:
   `Router · 主任务仍为 gpt-5.6-sol（思考档位由界面控制）· 最终差异审查 · gpt-6-astra / high / service_tier=unknown（宿主未提供）`.
4. When delegation is unavailable in the current host, fail open by continuing with the current model. Do not claim that the root task model changed.
5. Keep the delegated scope concrete and bounded. The root owns orchestration, integration, user communication, and verification. Never create overlapping writers.
6. Run the returned `verificationGate` at the root. Call `record_outcome` once
   only after the matching `spawn_agent` dispatch handshake has consumed the
   route ticket; a route decision by itself is not an executable attempt and
   must not receive an outcome. Use the delegated route ID and the exact final
   outcome schema, including all four `retryBreakdown` counters whose sum equals
   `retries`. A recorded outcome does not release the context gate by itself:
   release also requires a safely correlated `PostToolUse` plus `SubagentStop`
   (or an explicit host proof that no child was created). On direct v2 hosts, a
   task-name-only `PostToolUse` may arrive before `SubagentStart`; it keeps the
   gate occupied while the trusted child claim supplies the agent identity and
   is not by itself an ambiguity or release signal. If the root tries to stop
   before dispatching a delegated route, the Stop hook blocks that stop once
   and names the required `spawn_agent` action; the re-entered stop is allowed
   only to prevent a hook loop. If the ticket is still unconsumed on that
   guarded re-entry, the Router marks the lifecycle ambiguous and retains its
   gate, one-shot carrier material, and child-space reservation. Without
   authoritative no-child evidence it never archives the attempt or permits a
   replacement child. This creates neither an outcome nor a `no_child` claim
   and is not a successful verification. Consumed or ambiguous attempts remain
   fail-closed. The root `Stop` hook never fabricates an `unknown` outcome.

Map the router's `target.effort` value to the current Codex subagent `reasoning_effort` parameter. Do not submit an `effort` parameter to a host that does not define one, and do not invent `agentType`, `agent_type`, or other unsupported parameters.

## Failures and escalation

On a verification failure, route the next attempt with the prior `routeId`, `verificationFailed: true`, and an enumerated `failureType`. Reasoning failures escalate monotonically at most twice in the exact effort order `low/medium → high → xhigh → max → ultra`. Default routing uses only GPT-6, normally medium/high/xhigh, and defaults to high.
Check higher conditions before considering a downgrade. Low needs settled,
mechanical, low-risk work with strong verification and an exact output check;
medium needs settled, strongly verified work without review, risk, ambiguity,
cross-module impact or architecture trade-offs. Xhigh needs cross-module work
plus ambiguity/architecture trade-offs, or two independent difficulty groups.
Max needs three groups plus high failure cost/irreversibility, or an xhigh
reasoning failure. Groups are security-or-migration, high-risk-or-high-failure-cost,
cross-module-public-contract, architecture trade-offs and irreversibility.
Correlated labels count once. Ultra requires explicit choice or max reasoning
failure with remaining budget. Text length, old score offsets, active Plan/grill
and diagnostic classifier adjustments do not independently select effort. Environment, missing-information, and tooling failures do not justify a stronger effort. After the automatic limit, ask the user instead of silently changing targets. If an Ultra stage would create parallel writers, pass `parallelWriteRisk: true` and respect the returned `ask_user`.

If the host explicitly proves that no Agent was created, record the delegated
route as `failed` with `failureType: tooling`; a safely correlated
`PostToolUse` proof and that outcome release the gate. If ticket validation is
denied, the launch result is ambiguous, the transcript cannot be measured, or
the lifecycle hooks fail, fail closed: do not retry Agent, do not invent an
outcome merely to release the gate, and do not call `route_stage` again into a
known `busy` gate. Continue root-only and report the concrete Router/host
failure. A route decision or generic tool error is not proof that no subagent
started.

Root, delegate and classifier capabilities are independent and all Router calls
intersect the active model policy's exact allowed scope. Only direct
`hostCapabilities.delegation.targets` authorizes a bounded target. Missing
capabilities do not imply any allowed subagent. Explicit targets outside scope,
unavailable efforts and risk-floor conflicts must not be silently substituted.

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

The default policy is stored in `model-policy.json`: allowed scope, conditions,
bindings, fallbacks and escalation are independent. `get_model_policy` and
`preview_model_policy` are read-only; do not route or delegate their inspection.
Activate a reviewed definition with its expected active digest, or explicitly
roll back to its parent, only within the user's requested scope. Active calls
block changes; never clear a gate or inference lease to force activation.
Candidate count and catalog order must not create new task categories.
The two-enhancement limit applies to automatic retries. A current explicit user
target can select ultra after that budget is exhausted, subject to scope,
capabilities and the risk floor; it neither spends nor resets the budget.

GPT-6 outcomes are observe-only. Old scores, offsets and histories keep their
meaning but do not choose GPT-6 effort. Legacy learning is project-local. A proposal never changes policy until the user explicitly calls `approve_policy_proposal`. Rejection advances the evidence window; rollback walks backward through immutable revisions. `get_learning_status` is read-only. `shadow_route_stage` must remain free of route/outcome/proposal/cursor writes. Rebase and offline scoring-profile re-anchor require an explicit user instruction; re-anchor also requires the exact confirmation. Do not approve, reject, rebase, re-anchor, roll back, import legacy settings, or clear project data without an explicit user instruction. New decisions do not generate legacy proposals or trigger legacy score rollbacks.

Read-only router inspection is not a substantive stage boundary. When the user
requests `get_route_status`, `get_route_history`, `list_policy_proposals`,
`get_learning_status`, `get_model_policy`, `preview_model_policy`, `diagnose_router`, or `shadow_route_stage`, call only
the requested inspection tool and do not call `route_stage` merely to precede
it. In particular, call `shadow_route_stage` directly, do not create a
subagent or outcome for its preference, and do not pass `hostCapabilities`;
shadow scoring returns a preferred workLevel/model/effort rather than a live bounded
target.

The classifier defaults to local-only. When explicitly enabled, the auxiliary classifier receives only a redacted short summary, phase, and boolean signals. If it is disabled, local-only, timed out, or circuit-broken, use the deterministic route.

Use `get_route_status` when the user asks which model is in use. Explain that the
router never changes the root-task model. It can show the hook-observed root-model
slug when available, but not root reasoning effort; it also shows the latest
bounded-stage target and whether that route still lacks an outcome. Use
`get_route_history` for a timestamped current-project/current-context timeline
of route actions, delegated model/effort transitions, reasons, and outcomes.
Users can request the same visible reports with `router: status`,
`router: history 10`, `路由器：状态`, or `路由器：历史 10`.
