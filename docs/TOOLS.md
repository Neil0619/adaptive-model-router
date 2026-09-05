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

- `stageId`: stable logical-stage identity; omitted IDs use phase within this task.

- `previousRouteId`: only the ID returned by an earlier delegated route, and
  only when continuing a retry or escalation.
- `override`: a model, effort, or both for this call. An unavailable explicit
  target returns `ask_user`; it is never silently replaced.
- `hostCapabilities.delegation`: the current host's bounded-subagent
  capability, with `available`, `invocation`, and strict `targets[]` entries
  containing one model slug and its supported `efforts`. Use
  `invocation: "direct"` only for a native `spawn_agent` call available outside
  `functions.exec`. A tool visible only inside code mode must be reported as
  `available: false`, `invocation: "code_mode_nested"`, with no targets. When
  present, this is the only source of bounded targets. Do not derive it from
  the root picker or model cache.

Example for a host that exposes GPT-6 at all six efforts:

```json
{
  "hostCapabilities": {
    "delegation": {
      "available": true,
      "invocation": "direct",
      "targets": [
        {
          "model": "gpt-6-astra",
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
`irreversible`, `parallelWriteRisk`, `mechanical`, `exactOutputCheck`, `ambiguous`,
`grillWithDocs`, `planMode`, `exploration`, `review`, `batchSize`,
`hostCanDelegate`, `verificationFailed`, and enumerated `failureType`.
Set `grillWithDocs` and `planMode` only from actual host/skill state; text
mentions are not evidence. Each adds 18 diagnostic points; neither changes the GPT-6 work level.
`hostCanDelegate` is retained for older callers. Omit it when
`hostCapabilities.delegation` is supplied; contradictory values are rejected.

Output always contains:

- `schemaVersion: "6.0"` and `routeId`;
- `action`: `continue`, `delegate`, `ask_user`, or `busy`;
- optional `target { model, effort }` only for `delegate`;
- `category`, enumerated `reasonCodes`, and `verificationGate`;
- classifier and escalation status;
- `decision` when task conditions are evaluated: policyId, policyDigest, policyVersion, workLevel, rule.
- `taskMode`: `automatic`, `pending_confirmation`, or `manual_root`;
- `rootTask`, containing an optional hook-observed model slug, host-only effort
  visibility, and `changedByRouter: false`.

When `taskMode` is `pending_confirmation` or `manual_root`, `route_stage`
returns `continue` with `HOST_MODEL_INTENT_PENDING` or
`MANUAL_ROOT_SELECTED`; it never delegates in those modes.

If the action is `delegate`, create exactly one bounded subagent with the
direct native `spawn_agent` tool outside `functions.exec`, using
`target.model` and map `target.effort` to the host's `reasoning_effort`
parameter. The root integrates the result and runs the returned verification
gate. `delegate` is an instruction, not a recommendation. Under a conditional
host policy that permits subagents when an applicable skill explicitly requests
them, the Adaptive Model Router skill's `delegate` action is that authorization.
Do not reinterpret the conditional policy as a blanket prohibition, silently
continue the delegated stage in the root, or ask the user to authorize it again.
If the host cannot express those parameters through the direct tool, report delegation as unavailable
before routing; if the host tool rejects a declared target at startup, use the
tooling-failure flow below. Do not claim the root model changed.
Do not use `list_agents` or the absence of an existing child to infer whether
`spawn_agent` is callable. A completed direct child lifecycle is trusted
capability evidence for that task; a later unavailable declaration requires an
actual direct-call rejection with explicit no-child proof.

`delegate` with `HOST_LIFECYCLE_QUALIFICATION` is a one-time fixed no-tool
self-test, not the requested work stage. Follow its exact carrier once. The
source-owned `record_outcome` verifier must validate its native lifecycle and
complete raw child transcript before accepting `passed`. After success, route
the original stage again; its once override is still available. Failure or a
changed task/host/Hook/runtime binding cannot trigger a replacement self-test.
There is no caller-supplied proof parameter, and qualification is excluded from
learning.

Root, delegate and classifier catalogs are independent. Only explicit direct
interface capabilities authorize delegation; all Router calls also pass through
the active policy's exact allowed model/effort scope. Missing automatic targets
keep work local; explicit unavailable targets ask without substitution.

Record a tooling failure only after the dispatch handshake and authoritative
no-child evidence. Environment, information and tooling failures preserve the
previous target. Reasoning failures follow `low/medium → high → xhigh → max → ultra`,
at most twice per stage. Max requires three independent difficulty groups plus
high failure cost/irreversibility, or xhigh reasoning failure. Ultra requires
explicit choice or max reasoning failure with remaining budget; parallel writers
are still rejected. The [quality-first specification](MODEL-POLICY-GPT6.zh-CN.md)
details conditions, stable stage identity, scope and policy revisions.

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
  "retryBreakdown": {
    "reasoning": 0,
    "environment": 0,
    "information": 0,
    "tooling": 0
  },
  "escalations": 0,
  "userCorrection": false
}
```

Allowed statuses are `passed`, `failed`, and `unknown`. Allowed failure types
are `reasoning`, `environment`, `information`, `tooling`, or `null`. Identical
duplicate outcomes are idempotent; conflicting duplicates fail. `unknown`
outcomes do not participate in learning. `retryBreakdown` is required and must
sum exactly to `retries`.

The first outcome write also requires the matching delegation ticket to have
been consumed by the dispatch handshake. An unlaunched route cannot be labeled
passed, failed, or unknown. If the root tries to stop before dispatching a
returned `delegate`, the Stop hook blocks that first stop and requests the exact
direct `spawn_agent` action. The host's guarded Stop re-entry is allowed to
prevent an infinite hook loop. If the ticket remains unconsumed, that re-entry
marks the lifecycle ambiguous and retains its gate, carrier material, and
child-space reservation. Without authoritative no-child evidence it never
archives the attempt, creates an outcome, or permits a replacement child. The
hook never synthesizes an outcome.

## Status and controls

| Tool | Purpose | State change |
| --- | --- | --- |
| `get_model_policy` | Read active global policy, allowed scope, bindings and invalid locks visible in this context. | No |
| `preview_model_policy` | Validate a complete `definition`, compare scope and show current/candidate digests and active calls. | No |
| `activate_model_policy` | Atomically activate `definition` with `expectedDigest` and `confirm: ACTIVATE_MODEL_POLICY`; busy calls block. | Yes |
| `rollback_model_policy` | Restore the immutable parent with `expectedDigest` and `confirm: ROLLBACK_MODEL_POLICY`; busy calls block. | Yes |
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
| `rebase_policy_proposal` | Rebase a pending/stale offset proposal onto the current policy/profile while preserving its delta and advancing the old cursor. | Yes; explicit user instruction required |
| `get_learning_status` | Return current-project scoring profile, approved offsets, evidence eligibility, proposals, and safety events. | No |
| `shadow_route_stage` | Deterministically score a stage against the active or supplied profile without writing a route, outcome, proposal, or cursor. | No |
| `reanchor_scoring_profile` | Install a higher-version immutable offline profile and stale pending proposals. | Yes; exact `REANCHOR_SCORING_PROFILE` confirmation required |
| `clear_project_data` | Delete only the current project's router rows. | Yes; requires exact `CLEAR_PROJECT_DATA` confirmation |

Policy proposals are never approved automatically. Rejection and rollback are
also deliberate user actions; an agent must not infer them from routine work.

GPT-6 snapshots are observe-only and never apply legacy offsets. Historical
online proposals only use eligible legacy score snapshots. Explicit overrides,
classifier adjustments, escalated/tooling-retry routes, unknown outcomes, and
environment/information/tooling failures are excluded. A `+5` proposal needs
12 eligible outcomes across 4 contexts and 4 affected outcomes. A `-5`
proposal needs 20 clean outcomes across 5 contexts. Offline profile re-anchors
preserve approved category offsets. The sole automatic rollback is a hard
risk/security/migration floor violation.

`reanchor_scoring_profile` accepts only the named integer weights and ordered
thresholds from the documented deterministic profile. Its `profileVersion`
must be greater than the active version. On success it creates an immutable
child profile, preserves the current approved category offsets, marks pending
proposals stale, and advances their cursors. It never derives a profile from
live prompts or outcomes.

`shadow_route_stage` accepts the normal goal/phase/evidence fields plus an
optional closed scoring definition. It returns only the category, numeric
scores, hard-signal count, preferred action/workLevel/model/effort, and verification
gate. It also returns before/after numeric counts for current-context routes,
outcomes, Stop observations, and score snapshots plus current-project
proposals, cursors, policy revisions, and profiles; `sideEffects` is derived
from those counts rather than asserted. It does not create even an initial
project, profile, policy, route, outcome, proposal, or learning cursor. It
deliberately does not accept
`hostCapabilities`: the returned workLevel/model/effort is a policy preference, not a
live bounded target. Call it directly without a preceding `route_stage`. Use it
before an explicitly confirmed offline re-anchor.

An explicit direct request for `get_route_status`, `get_route_history`,
`list_policy_proposals`, `get_learning_status`, `get_model_policy`, `preview_model_policy`, `diagnose_router`, or
`shadow_route_stage` activates a short-lived, current-context guard. While it
is active, an accidental `route_stage` call is rejected before project
initialization, scoring, classification, or route persistence; repeated
attempts remain blocked. The next submitted prompt clears or replaces the
guard, and abandoned guards expire automatically. The guard stores only HMAC
identifiers, a format version, and an expiry timestamp.

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
6. active quality-first model policy. Legacy offsets do not choose the target.

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
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs learning --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs approve PROPOSAL_ID --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs reject PROPOSAL_ID --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs rebase PROPOSAL_ID --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs rollback --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs import-legacy --confirm IMPORT_LEGACY_SETTINGS_POLICY --context example
```

Legacy import copies supported settings and an already-approved policy only.
Legacy history is counted for archival reporting but never enters the v0.2
learning window.
