# Routing triggers, model visibility, and history

Adaptive Model Router is not a model proxy and never hot-switches the root-task
model. At a meaningful task-stage boundary it records a route decision and can
ask the root task to create one bounded subagent with a selected model and
reasoning effort.

## What triggers routing

There are two independent paths:

1. The `UserPromptSubmit` hook runs for every submitted prompt, but only handles
   a control beginning at the first character with `router:` or `路由器：`.
   It does not route ordinary task prompts.
2. Task routing occurs when Codex uses the Adaptive Model Router skill for a
   substantive stage and calls `route_stage`. The skill calls at meaningful
   stage boundaries, not before every message.

Installing the plugin therefore does not mean that every prompt automatically
changes models. A route calculation exists only when `route_stage` is called.
After each call, the skill must show a visible notice that separates the
host-managed root task from the bounded-stage target.

## Decision order

`route_stage`:

1. validates the closed input and derives local HMAC project/context IDs;
2. resolves request → once → session → project → optional global overrides;
3. returns `continue` when routing is disabled;
4. returns `continue` when the host cannot express model/effort delegation;
5. without an override, continues for greetings, simple short questions, and
   explicit no-work-product tasks;
6. loads the visible known-model catalog and fails open to `continue` when none
   is available;
7. scores deterministically and uses the redacted auxiliary classifier only
   for substantive borderline stages;
8. applies risk floors, approved project policy, and monotonic escalation;
9. verifies model/effort capabilities and atomically records the route. A once
   override is consumed only with a committed `delegate`.

An unavailable explicit model or effort returns `ask_user`; it is never
silently replaced. Reasoning failures can strengthen automatically twice, then
return `ask_user`.

## Deterministic score

The base score is `40`.

| Signal | Adjustment |
| --- | ---: |
| Ambiguity, architecture, or trade-offs | `+18` |
| High-risk, production, public API, concurrency, and related risk | `+25` |
| Security or migration | `+10` |
| Cross-module or end-to-end change | `+15` |
| Implementation/risk without strong verification | `+8` |
| Review stage | `+10` |
| Mechanical batch | `-28` |
| Single mechanical task | `-20` |
| Settled requirements | `-10` |
| Settled requirements plus strong verification | another `-5` |
| Non-risk exploration | `-8` |
| Redacted task text longer than 2,000 characters | `+8` |
| Approved category policy | `-15` through `+15` |

The clamped `0..100` default mapping is:

| Score | Family | Effort |
| ---: | --- | --- |
| `0..25` | Luna | low |
| `26..45` | Terra | low |
| `46..60` | Terra | medium |
| `61..80` | Sol | medium |
| `81..92` | Sol | high |
| `93..100` | Sol | xhigh |

Hard rules keep non-risk mechanical batches on Luna low, keep implementation
off Luna, raise review to at least Sol medium, and raise risk/security/migration
to at least Sol high.

A substantive task is borderline when it is within 6 points of
`25/55/75/90`, or has at most one matched signal with a score in `30..80`.
The auxiliary classifier can adjust by only `-10/0/+10` and cannot cross the
deterministic risk floor.

## Viewing the current model boundary

Keep these concepts separate:

- **Root-task model:** managed by the Codex host. The router cannot read its
  exact name and never changes it.
- **Bounded-stage target:** `target.model` and `target.effort` on a `delegate`
  route.

Use:

```text
router: status
路由器：状态
```

The report shows the root boundary, latest action, pending delegated stage,
target model/effort, route timestamp, reasons, transition, outcome, and pending
outcome/proposal counts.

## Viewing delegation transitions

Use:

```text
router: history 10
路由器：历史 10
```

The count is `1..20`. Records include the route timestamp, action,
model/effort, `initial_delegate`, `target_unchanged`, or `target_changed`
transition, reason codes, route ID, and outcome.

The timestamp is the SQLite route-commit time. A record proves a stage routing
decision, not a root-model hot switch and not by itself that the host process
successfully started the subagent. The final outcome supplies subsequent
verification evidence.

Agents and automation can use the read-only `get_route_status` and
`get_route_history` MCP tools. The source-tree developer CLI supports:

```bash
node plugins/adaptive-model-router/scripts/codex-route.mjs status --context TASK_ID
node plugins/adaptive-model-router/scripts/codex-route.mjs history --context TASK_ID --limit 20
node plugins/adaptive-model-router/scripts/codex-route.mjs history --context TASK_ID --limit 20 --action delegate
```

History is limited to the current project and `contextId`. It does not expose
prompts, source code, absolute paths, environment variables, or secrets.
