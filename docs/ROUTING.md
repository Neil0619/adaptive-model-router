# Routing triggers, model visibility, and history

Adaptive Model Router is not a model proxy and never hot-switches the root-task
model. At a meaningful task-stage boundary it records a route decision and can
ask the root task to create one bounded subagent with a selected model and
reasoning effort.

## What triggers routing

There are two cooperating paths:

1. The `UserPromptSubmit` hook handles exact-prefix controls. After the user
   explicitly enables global automatic activation, it also injects a compact
   router workflow instruction into ordinary prompts; it never sends the task
   text to the router database.
2. Task routing occurs when Codex uses the Adaptive Model Router skill for a
   substantive stage and calls `route_stage`. The skill calls at meaningful
   stage boundaries, not before every message.

Installation alone does not activate ordinary prompts. Send `router: global on`
or `路由器：全局开启` once after trusting the hook. Automatic activation means
that substantive stages call `route_stage`; it does not mean that every prompt
creates a subagent or changes the root model.
After each call, the skill must show a visible notice that separates the
host-managed root task from the bounded-stage target.

A returned `delegate` action is the applicable skill's explicit authorization
under conditional host policies that permit skill-requested subagents. It is a
required action, not a recommendation: the root must immediately create exactly
one bounded subagent. It must not describe the route as merely suggested,
silently keep the delegated stage root-only, claim that the conditional policy
is a blanket subagent ban, or ask the user to re-authorize it. Only an actual
host-tool rejection enters the documented tooling-failure retry flow.

The hook retains only a validated active root-model slug when one is available;
missing or invalid values display as host-managed. It treats slug changes as
manual-intent signals only while automatic activation is effective. The first
valid observation in a task is a baseline. A later slug change
places the task in `pending_confirmation`: the current request continues in the
root, and no subagent may start until the user explicitly chooses manual-root or
keep-automatic. Silence keeps later turns root-only. Reverting to the baseline
cancels the pending change; another model change supersedes the old event.

## Decision order

The router keeps the existing manual-root, pending intent, delegation gate,
Hook trust and outcome requirements. It reads one immutable model policy,
classifies task evidence, then intersects the selected binding with the actual
execution interface. Missing direct delegation capabilities keep work local.
An explicit unavailable or out-of-scope target is rejected without substitution.
A once override is consumed only by a committed delegate.

## GPT-6 quality-first conditions

The default [model-policy.json](../plugins/adaptive-model-router/model-policy.json)
allows only `gpt-6-astra` at low, medium, high, xhigh, max and ultra. High is the
default; ordinary automatic selection concentrates on medium/high/xhigh.

| Work level | Entry condition |
| --- | --- |
| low | Settled, low-risk, mechanical work with strong verification and an exact output check; not code implementation |
| medium | Settled and strongly verified, without risk, review, ambiguity, cross-module impact or architectural trade-offs |
| high | Default, including normal design/review/risk work and insufficient downgrade evidence |
| xhigh | Cross-module with ambiguity or architecture trade-offs, or two independent difficulty groups |
| max | Three independent difficulty groups plus high failure cost or irreversibility; or an xhigh reasoning failure |
| ultra | A max reasoning failure with remaining budget, or an explicit user choice |

Higher conditions take priority over downgrades. The five independent groups
are security-or-migration, explicit high-risk-or-high-failure-cost,
cross-module-public-contract, architecture trade-offs, and irreversibility.
Correlated tags count once. Downgrades require explicit `requirementsSettled`
and `strongVerification`; low additionally requires `mechanical` and
`exactOutputCheck`. Greetings and single mechanical steps stay in the root.

Use one stable `stageId` for a logical stage; omitted IDs use the phase within
the current task. Until success, rewording, text length and score changes do
not independently switch targets. Recorded failures are recovered even when
the caller omits `previousRouteId`. Reasoning escalation follows
`low/medium → high → xhigh → max → ultra`, at most twice per logical stage.
Environment, information and tooling failures hold the target. Success resets
classification for the next stage. Explicit overrides still obey scope,
capability and risk floors; ultra cannot be used for overlapping writers.

Scores remain diagnostic. Legacy profiles, weights, score bands and approved
offsets retain their historical interpretation; they do not select the new
work level. New snapshots are observe-only and apply no legacy offset.
The classifier defaults to `local-only`. An explicitly enabled auxiliary
classifier uses its own live catalog and the same allowed scope; its adjustment
changes only the diagnostic score.

Allowed candidates, conditions, bindings, fallback levels and escalation edges
are configured independently. Adding five candidates or reordering a catalog
does not redistribute traffic. Use `get_model_policy` / `preview_model_policy`
for inspection and `activate_model_policy` / `rollback_model_policy` for explicit
compare-and-swap changes. Active delegation or inference blocks activation.
See the [complete configuration and acceptance specification](MODEL-POLICY-GPT6.zh-CN.md).

## Viewing the current model boundary

Keep these concepts separate:

- **Root-task model:** managed by the Codex host. A trusted hook can observe its
  slug, but not its reasoning effort; the router never changes either. The
  bottom-right picker continues to represent this root task.
- **Bounded-stage target:** `target.model` and `target.effort` on a `delegate`
  route.

Use:

```text
router: status
路由器：状态
```

The report shows global automatic activation, task mode, observed root slug or
host-managed fallback, pending model-intent confirmation, latest action,
bounded target, route timestamp, reasons, outcome, and pending counts.

## Viewing delegation transitions

Use:

```text
router: history 10
路由器：历史 10
```

The count is `1..20`. Records include the root-model snapshot, route timestamp,
action, bounded model/effort, `initial_delegate`, `target_unchanged`, or `target_changed`
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
