# Architecture

Adaptive Model Router is a Codex plugin, not a model proxy. The root task invokes a local MCP tool at a stage boundary and remains responsible for orchestration.

The public tool contracts are documented in [Tool reference](TOOLS.md). The MCP
server is the installed interface; `scripts/codex-route.mjs` is a source-tree
operations and diagnostics CLI, not a global command.

```mermaid
flowchart LR
    Prompt["UserPromptSubmit hook"] --> OptIn["global automatic opt-in"]
    Prompt --> Observe["observe root-model slug"]
    Observe --> Intent["automatic / pending / manual_root"]
    OptIn --> Root["Root Codex task"]
    Intent --> Root
    Root --> Route["route_stage"]
    Route --> Deterministic["Deterministic scoring"]
    Deterministic -. "borderline only" .-> Classifier["Redacted auxiliary classifier"]
    Route --> SQLite["Project-local policy and outcomes"]
    Route --> Continue["continue"]
    Route --> Ask["ask_user"]
    Route --> Delegate["bounded subagent: model + effort"]
    Delegate --> Verify["Root verification gate"]
    Verify --> Outcome["record_outcome"]
    Outcome --> SQLite
    SQLite --> History["status + route history projection"]
    SQLite --> Proposal["manual policy proposal"]
    Intent -. "explicit confirmation" .-> Resolve["resolve_host_model_intent"]
    Resolve --> SQLite
```

## Components

- `skills/adaptive-model-router/` describes the stage-boundary orchestration contract.
- `scripts/node-launcher.mjs` is the task-pinned launch shell. It discovers a
  qualifying Node 24.15+ runtime, resolves a compatible installed Router
  runtime, and preserves stdio, arguments, environment, signals, and exit
  status across the handoff.
- `runtime.json`, `scripts/lib/runtime-loader.mjs`, and
  `scripts/runtime-probe.mjs` define the hot-runtime boundary. The shell accepts
  only matching shell/tool/storage contracts, validates the candidate with
  both the old shell and the candidate's own isolated probe, and persists an
  atomic active/previous/quarantine pointer.
- `scripts/mcp-server.mjs` exposes strict, closed JSON schemas and emits only
  JSON-RPC on stdout. The schema stays pinned for a task, while each tool call
  may import a newer contract-compatible service implementation.
- `scripts/lib/router.mjs` applies deterministic scoring, override priority, catalog capability checks, and monotonic escalation.
- `scripts/lib/scorer.mjs` evaluates an immutable scoring-profile definition;
  approved project category offsets remain a separate bounded layer.
- `scripts/lib/app-server.mjs` owns one short-lived classifier app-server process with a single total deadline and early-notification buffering.
- `scripts/lib/database.mjs` owns SQLite migrations, immutable scoring profiles
  and snapshots, short `BEGIN IMMEDIATE` transactions, exactly-once claims, and
  project/context isolation.
- `scripts/lib/learning.mjs` validates typed retry outcomes, filters eligible
  snapshots, and manages approval-gated immutable policy revisions.
- `scripts/hook.mjs` handles exact control prefixes, the global automatic
  opt-in, root-model observation, fixed model-visible context, visible
  status/history reports, and the two-pass Stop outcome reminder.
- `scripts/lib/presentation.mjs` formats user-visible reports while preserving
  the root-model versus bounded-target boundary.
- `hooks/hooks.json` supplies separate POSIX and `commandWindows` launch commands.
  Both resolve through the installed plugin root and the runtime launcher, so
  hook execution does not depend on a POSIX shell on Windows.

## Route lifecycle

1. Derive a project HMAC from the Git common directory, submodule common directory, or canonical non-Git working directory. Derive a second context HMAC from the task identifier.
2. When the global opt-in is enabled, the prompt hook observes the host-provided
   active model slug. The first valid value establishes a baseline. A later
   change creates one pending intent event for the task; no value or an invalid
   value remains host-managed and does not imply manual intent.
3. If the task is pending confirmation or `manual_root`, return `continue` with
   no bounded target. Resolving `keep_automatic` affects the next stage;
   resolving `manual_root` lasts only for the current task/context.
4. Resolve overrides in this order: request, once, session, project, optional global.
5. Continue immediately for trivial/no-output work unless an override explicitly requests delegation.
6. Load the root-visible catalog only for observation and conservative
   compatibility. Build the bounded delegate catalog from the current
   `hostCapabilities.delegation`; when absent, permit only known Sol/Terra
   entries from the visible catalog. Never infer Luna delegation from root
   visibility.
7. Score locally. Only substantive borderline stages may call the auxiliary
   classifier. Its independent ephemeral app-server calls `model/list` and
   chooses Luna, then Terra, then Sol from that classifier-only catalog.
8. Apply risk floors and any monotonic failure escalation.
9. Insert the route. A once override is claimed and deleted in the same transaction as a real `delegate` insert. The row snapshots the currently observed root-model slug separately from the bounded target.
10. For a `delegate` route, the root performs the verification gate and records
   exactly one outcome. `continue` and `ask_user` routes do not have outcomes.

The route stores the model target and decision metadata, not the prompt or
evidence payload. On retry, callers provide only `previousRouteId` and factual
failure evidence; they cannot submit a forged previous route object.

`get_route_status` and `get_route_history` are read-only projections over the
same route/outcome rows. Consecutive delegated targets are compared at read
time to classify an initial, unchanged, or changed target. No second log is
maintained, so visible history cannot drift from learning/outcome state. The
projection explicitly reports the hook-observed root model when available,
that reasoning effort remains host-only, and that the router did not change the
root model. The Codex model selector therefore continues to describe the root
task, never the bounded-stage target.

SQLite `user_version` 3 preserves the v2 task/root-model tables and adds:

- immutable per-project scoring profiles with parent links;
- a prompt-free score snapshot keyed one-to-one with every scored delegated
  route;
- typed reasoning/environment/information/tooling retry counts;
- distinct-context and affected-result proposal statistics;
- redacted profile re-anchor, proposal rebase, and safety rollback events.

Migration falls through transactionally from v1 to v2 to v3. Pre-v3 routes
without score snapshots remain visible in history but are ineligible for new
learning windows.

## Compatible runtime upgrades

Codex resolves Hook definitions, MCP schemas, and skill instructions when a
task starts. v0.4.0 therefore keeps those host-facing contracts in a small
stable shell and separates them from the runtime implementation:

1. A normal plugin upgrade installs another immutable sibling cache directory.
2. The next Hook launch or MCP tool call scans only those sibling Router
   versions and reads each strict `runtime.json`.
3. A candidate is eligible only when its shell protocol, tool contract, and
   storage contract equal the pinned shell. Its manifest name/version and
   entrypoints must also validate.
4. The pinned probe compares exact tool names and input schemas, then the
   candidate probe opens a fresh temporary database and runs redacted
   diagnostics.
5. The first successful real Hook or MCP store initialization atomically moves
   the active pointer. Failed provisional or active runtimes are quarantined,
   and the previous compatible runtime is selected on the next invocation.

The pointer stores only cache directory names, versions, and a bounded failed
list under plugin data; it never stores an absolute cache path. Concurrent
shells serialize the short pointer update through an exclusive local lock and
converge through atomic replacement. Quarantine wins over a later success from
the same immutable cache directory. Database transactions continue to provide
process-level state safety.

This mechanism deliberately does not hot-reload task-pinned skill prose or add
new MCP tools. A changed shell protocol, tool schema, storage contract, Hook
definition, or skill workflow requires a new task. The v0.3.x → v0.4.0 upgrade
is the one-time bootstrap transition because v0.3 has no stable loader.

Storage contract 1 permits only forward-compatible, additive database
migrations: existing tables and columns remain, and additions must not make old
writes invalid. A v0.4 shell may read a newer `user_version` only after checking
its required table/column shape; otherwise it stops instead of guessing.

## Scoring evolution

Online learning remains deliberately narrow: it proposes only category offsets
within `[-15, 15]`. Routes with overrides, classifier adjustments, escalation,
tooling retry, or unknown/non-reasoning outcomes are quarantined. Evidence must
span distinct task contexts so one repeated session cannot anchor policy.

Offline re-anchoring installs a higher-version profile only after explicit
confirmation. The profile is immutable, links to its predecessor, preserves
approved category offsets, marks pending proposals stale, and advances their
evidence cursors. Shadow scoring runs the same deterministic scorer but writes
no route, outcome, proposal, or cursor.

After a final outcome, the database checks the persisted boolean snapshot
against the non-negotiable risk floor. A risk/security/migration stage below
Sol high is a hard invariant violation and rolls an active offline profile back
to its parent. Ordinary failures, agreement drift, or weak statistical signals
never trigger automatic rollback.

## Concurrency

The database uses WAL, `synchronous=NORMAL`, foreign keys, `trusted_schema=OFF`, a busy timeout, and bounded retry around short `BEGIN IMMEDIATE` transactions. No classifier, model discovery, file traversal, or other external work occurs inside a write transaction.

Uniqueness constraints protect route outcomes, pending proposals, and the one
effective pending host-model event per project/context. Concurrent hook
processes observing the same change converge on that event. Identical duplicate
outcomes and identical intent resolutions are idempotent; conflicting
duplicates fail. Approval checks the proposal's base revision in the same
transaction that creates its immutable child revision.

## Failure behavior

- Missing catalog or unavailable host delegation: continue with the current root model.
- A preferred automatic family missing from the delegate catalog falls forward
  to the next capable family; explicit unavailable targets ask the user.
- A host tooling rejection excludes the failed automatic target for one retry.
  Explicit routes never substitute, and a second automatic rejection continues
  in the root.
- Pending host-model intent or current-task manual mode: continue with the root
  model and never create a bounded subagent.
- Explicit unavailable target: ask the user; never silently substitute.
- Classifier failure: deterministic local route, followed by a three-failure/ten-minute circuit breaker.
- Storage failure during routing or hooks: sanitized fail-open behavior; outcome writes report an error because silently losing a final outcome would be misleading.
- Two completed automatic reasoning escalations: ask the user on the following failure.
- Node below 24.15: the launcher probes bounded standard runtime locations and either re-executes with a qualifying Node or exits with one generic error; router code never runs on the older runtime.

For operational symptoms and recovery steps, see
[Troubleshooting](TROUBLESHOOTING.md).
