# Tool reference

Adaptive Model Router exposes local MCP tools through the installed plugin. The
root Codex task remains the orchestrator; these tools do not replace or
hot-switch the root task model.

All object schemas are closed. Unknown fields, permissive status strings, and
forged prior-route objects are rejected.

## Context and scope

Every project/session operation accepts a `contextId`. Use one stable task or
thread identifier for the complete route → verification → outcome lifecycle.
The router HMACs the project and context locally; status and diagnostics expose
only truncated opaque identifiers.

For Stop-hook outcome enforcement, use the current Codex session/task
identifier exposed by the host. Plugin hooks receive the current Codex
`session_id`; an unrelated invented `contextId` creates a separate context and
cannot be matched by that hook.

Learning and project overrides are project-local. Session and once overrides
are additionally isolated by `contextId`. A once override is consumed
atomically only when a `delegate` route is committed.

## Routing lifecycle

### `route_stage`

Required input:

| Field | Meaning |
| --- | --- |
| `goal` | Concise goal for one meaningful task stage. |
| `phase` | Short stage name such as `implementation`, `review`, or `verification`. |
| `evidence` | Strict factual signals; omit unknown signals instead of guessing. |
| `contextId` | Stable identifier for this task/session lifecycle. |

Optional input:

- `previousRouteId`: only the ID returned by an earlier delegated route, and
  only when continuing a retry or escalation.
- `override`: a model, effort, or both for this call. An unavailable explicit
  target returns `ask_user`; it is never silently replaced.
- `hostCapabilities.delegation`: the current host's bounded-subagent
  capability, with `available` plus strict `targets[]` entries containing one
  model slug and its supported `efforts`. When present, this is the only source
  of bounded targets. Do not derive it from the root picker or model cache.

Example for a host that currently exposes Sol and Terra:

```json
{
  "hostCapabilities": {
    "delegation": {
      "available": true,
      "targets": [
        {
          "model": "gpt-5.6-sol",
          "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]
        },
        {
          "model": "gpt-5.6-terra",
          "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]
        }
      ]
    }
  }
}
```

Important evidence fields include `workProduct`, `requirementsSettled`,
`strongVerification`, `highRisk`, `securitySensitive`, `migration`,
`crossCutting`, `publicContract`, `architectureTradeoff`, `highFailureCost`,
`irreversible`, `parallelWriteRisk`, `mechanical`, `ambiguous`, `exploration`,
`review`, `batchSize`, `hostCanDelegate`, `verificationFailed`, and enumerated
`failureType`.
`hostCanDelegate` is retained for older callers. Omit it when
`hostCapabilities.delegation` is supplied; contradictory values are rejected.

Output always contains:

- `schemaVersion: "3.0"` and `routeId`;
- `action`: `continue`, `delegate`, or `ask_user`;
- optional `target { model, effort }` only for `delegate`;
- `category`, enumerated `reasonCodes`, and `verificationGate`;
- classifier and escalation status.
- `taskMode`: `automatic`, `pending_confirmation`, or `manual_root`;
- `rootTask`, containing an optional hook-observed model slug, host-only effort
  visibility, and `changedByRouter: false`.

When `taskMode` is `pending_confirmation` or `manual_root`, `route_stage`
returns `continue` with `HOST_MODEL_INTENT_PENDING` or
`MANUAL_ROOT_SELECTED`; it never delegates in those modes.

If the action is `delegate`, create exactly one bounded subagent using
`target.model` and map `target.effort` to the host's `reasoning_effort`
parameter. The root integrates the result and runs the returned verification
gate. If the host cannot express those parameters, continue in the root and do
not claim the root model changed.

The root-visible catalog, bounded delegate catalog, and classifier catalog are
independent. A Luna entry in the root picker does not authorize Luna as a
subagent. When the policy prefers Luna but the delegate catalog does not
contain it, automatic routing selects Terra and includes
`MODEL_FAMILY_FALLBACK`. An explicit unavailable Luna target returns
`ask_user / EXPLICIT_TARGET_UNAVAILABLE`.

If the host rejects a returned target before startup, record that route as
`failed` with `failureType: tooling`. An automatic route may then be retried
once with `previousRouteId`; the rejected model is excluded. An explicit route
asks the user instead. If the automatic retry is also rejected, record it and
continue in the root. Do not treat a committed route as proof of startup.

Automatic static routing never starts at Ultra. Sol Max requires a score of at
least 98 and two independent hard-signal dimensions. Only a reasoning failure
may increase effort, at most twice, in the order
`high < xhigh < max < ultra`; environment, information, and tooling failures
hold effort. `parallelWriteRisk: true` prevents an Ultra delegation and returns
`ask_user`.

After every route, the skill emits a compact visible notice. It shows the
hook-observed root slug when available, always marks it unchanged, and notes
that root effort is available only in the composer; a delegated target is shown
as a bounded-stage model/effort, never as the current root model.

`continue` and `ask_user` routes do not accept outcomes.

### `record_outcome`

Records the one final result for a delegated route:

```json
{
  "routeId": "returned-route-id",
  "contextId": "same-context-id",
  "status": "passed",
  "gate": "targeted-tests",
  "failureType": null,
  "retries": 0,
  "escalations": 0,
  "userCorrection": false
}
```

Allowed statuses are `passed`, `failed`, and `unknown`. Allowed failure types
are `reasoning`, `environment`, `information`, `tooling`, or `null`. Identical
duplicate outcomes are idempotent; conflicting duplicates fail. `unknown`
outcomes do not participate in learning.

The Stop hook reminds once when a delegated route lacks an outcome. If the task
continues and stops again without one, the hook records `unknown`.

## Status and controls

| Tool | Purpose | State change |
| --- | --- | --- |
| `get_route_status` | Return global auto activation, task mode, root boundary, pending host-model intent, and latest route/target/outcome. | No |
| `get_route_history` | Return a timestamped current-project/context route timeline, optionally filtered by action. | No |
| `diagnose_router` | Check database health, classifier circuit state, current redacted status, and legacy-state presence. | No |
| `set_route_override` | Lock, clear, enable, or disable routing at `once`, `session`, `project`, optional `global`, or `all` scope where supported. | Yes |
| `configure_router` | Configure project/global enablement, global-only `autoActivate`, classifier mode, and whether global overrides are allowed. | Yes |
| `resolve_host_model_intent` | Resolve one current-context pending change as `manual_root` or `keep_automatic`; identical repeats are idempotent and conflicts fail. | Yes; explicit user answer required |
| `list_policy_proposals` | List pending proposals for the current project. | No |
| `approve_policy_proposal` | Create an immutable policy revision from a proposal. | Yes; explicit user approval required |
| `reject_policy_proposal` | Reject a proposal and advance its evidence window. | Yes; explicit user instruction required |
| `rollback_policy` | Move backward to the current revision's immutable parent. | Yes; explicit user instruction required |
| `clear_project_data` | Delete only the current project's router rows. | Yes; requires exact `CLEAR_PROJECT_DATA` confirmation |

Policy proposals are never approved automatically. Rejection and rollback are
also deliberate user actions; an agent must not infer them from routine work.

`get_route_history` accepts optional `limit` (`1..100`, default `20`) and
`action` (`all`, `delegate`, `continue`, or `ask_user`). Each newest-first item
contains:

- route ID, commit timestamp, root-model snapshot, action, category, reasons, verification gate,
  classifier state, escalation count, and prior route ID;
- an optional bounded-stage `target {model, effort}`;
- `transition.state`: `initial_delegate`, `target_unchanged`,
  `target_changed`, or `not_delegated`, with `from`/`to` targets where useful;
- the strict final outcome and recorded timestamp, or `null` while pending.

The top-level and per-route `rootTask` use
`modelVisibility: "hook_observed"` plus `model` when the hook supplied a valid
slug, otherwise `modelVisibility: "host_managed"`. Both include
`reasoningEffortVisibility: "host_only"` and `changedByRouter: false`. A history
timestamp proves that a route decision was committed; it does not by itself
prove that the host successfully started the subagent.

## Override priority

The fixed priority is:

1. override in the current `route_stage` request;
2. once override;
3. session override;
4. project override;
5. optional global override;
6. approved project policy;
7. balanced default policy.

Only prompts beginning at the first character with `router:` or `路由器：` are
hook control commands. Quotes, code blocks, negations, later-line prefixes, and
ordinary discussion do not change state.

Automatic activation and task-mode controls are:

```text
router: global on
router: global off
router: manual
router: auto session
路由器：全局开启
路由器：全局关闭
路由器：本任务手动
路由器：本任务自动
```

The first valid root-model slug in a task is only a baseline. Later changes
create a current-project/context `changeId`. `resolve_host_model_intent`
accepts that ID and no other task's ID. Root reasoning effort is not part of
the Hook input and cannot trigger this flow.

The read-only visible reports are:

```text
router: status
router: history 10
路由器：状态
路由器：历史 10
```

Hook history limits are `1..20` to keep the user-facing report compact.

## Developer CLI

The repository includes a source-tree CLI for diagnostics and explicit legacy
import. It is not installed globally. Project identity is derived from the
current working directory, so run it from the project being diagnosed and
refer to the script by repository-relative or absolute path:

```bash
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs doctor --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs status --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs history --context example --limit 20
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs history --context example --limit 20 --action delegate
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs catalog
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs proposals --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs approve PROPOSAL_ID --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs reject PROPOSAL_ID --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs rollback --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs import-legacy --confirm IMPORT_LEGACY_SETTINGS_POLICY --context example
```

Legacy import copies supported settings and an already-approved policy only.
Legacy history is counted for archival reporting but never enters the v0.2
learning window.
