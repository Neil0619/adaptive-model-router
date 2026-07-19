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

Important evidence fields include `workProduct`, `requirementsSettled`,
`strongVerification`, `highRisk`, `securitySensitive`, `migration`,
`crossCutting`, `mechanical`, `ambiguous`, `exploration`, `review`, `batchSize`,
`hostCanDelegate`, `verificationFailed`, and enumerated `failureType`.

Output always contains:

- `schemaVersion` and `routeId`;
- `action`: `continue`, `delegate`, or `ask_user`;
- optional `target { model, effort }` only for `delegate`;
- `category`, enumerated `reasonCodes`, and `verificationGate`;
- classifier and escalation status.

If the action is `delegate`, create exactly one bounded subagent using
`target.model` and map `target.effort` to the host's `reasoning_effort`
parameter. The root integrates the result and runs the returned verification
gate. If the host cannot express those parameters, continue in the root and do
not claim the root model changed.

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
| `get_route_status` | Return redacted state for the current project/context. | No |
| `diagnose_router` | Check database health, classifier circuit state, current redacted status, and legacy-state presence. | No |
| `set_route_override` | Lock, clear, enable, or disable routing at `once`, `session`, `project`, optional `global`, or `all` scope where supported. | Yes |
| `configure_router` | Configure project/global enablement, classifier mode, and whether global overrides are allowed. | Yes |
| `list_policy_proposals` | List pending proposals for the current project. | No |
| `approve_policy_proposal` | Create an immutable policy revision from a proposal. | Yes; explicit user approval required |
| `reject_policy_proposal` | Reject a proposal and advance its evidence window. | Yes; explicit user instruction required |
| `rollback_policy` | Move backward to the current revision's immutable parent. | Yes; explicit user instruction required |
| `clear_project_data` | Delete only the current project's router rows. | Yes; requires exact `CLEAR_PROJECT_DATA` confirmation |

Policy proposals are never approved automatically. Rejection and rollback are
also deliberate user actions; an agent must not infer them from routine work.

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

## Developer CLI

The repository includes a source-tree CLI for diagnostics and explicit legacy
import. It is not installed globally. Project identity is derived from the
current working directory, so run it from the project being diagnosed and
refer to the script by repository-relative or absolute path:

```bash
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs doctor --context example
node /path/to/adaptive-model-router/plugins/adaptive-model-router/scripts/codex-route.mjs status --context example
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
