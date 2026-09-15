# Adaptive Model Router

Adaptive Model Router is a local-first Codex plugin that decides, at meaningful task-stage boundaries, whether to keep working in the current task, ask the user, or delegate one bounded stage to an available model with a specific reasoning effort.

It does **not** hot-switch the root task model. The root remains the orchestrator and verifies any delegated work.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Tool reference](docs/TOOLS.md)

## Runtime protocol v2: isolated publication and controlled installation

This checkout implements explicit runtime publication and task/stage ownership.
The controlled macOS installation and retained-task delegation acceptance passed
on 2026-09-14; see the [installation evidence](docs/evidence/runtime-v2-shell-repair-20260914.zh-CN.md).
Native Windows logged-in acceptance remains pending. This does not certify
arbitrary runtime changes for hot publication.

Node.js 24.15.0 or newer is required. The v2 `manage-install.mjs install`,
`upgrade`, and `repair` actions intentionally refuse before changing the host.
Do not use `./install.sh`, `./install.sh upgrade`, or `./install.sh repair` with
this checkout. Historical v1 release instructions describe a different loader.

Use the [v2 installation and publication runbook](docs/RUNTIME-UPGRADE-ISOLATION-IMPLEMENTATION.zh-CN.md)
and the [package command reference](plugins/adaptive-model-router/RUNTIME.md).
The first transition needs a cold host window: prepare a stable native entry,
retain all old cache paths, qualify the exact installed v1 against v2 in an
isolated database, enroll both in the **same existing database**, register the
new entry, and restore retained historical paths before reopening Codex.
Original policy, global activation, GPT-6-only settings, outcomes, unknown work,
and the one global limit of 10 remain in that same data domain.

For later publications, start from ordinary source edits and inherit the
registered shell's materialized entry definitions:

```bash
node /absolute/stable-entry/plugin/scripts/runtime-admin.mjs prepare \
  --source=/absolute/development/plugins/adaptive-model-router \
  --shell-root=/absolute/stable-entry/plugin \
  --candidates=/absolute/offline-candidates
node /absolute/stable-entry/plugin/scripts/runtime-admin.mjs publish \
  --candidate=/absolute/offline-candidates/RETURNED_DIGEST \
  --home=/absolute/original-router-data
```

Preparation does not publish or register a candidate. Publication changes the
default for new task bindings; in-flight stages retain A. Existing v2 tasks can
move to B only after native completion and all pending responsibilities have
been checked. Failed or unknown qualification does not silently switch them.

The current compatible **code** boundary is deliberately narrow: validated
pure category branches in `inferCategory`, with executable alternating and
concurrent A/B writer checks. Other scorer code, shared writers, Hook code,
and native adapters are frozen. Changing those requires a separately
implemented and validated compatibility transition; v2 does not yet provide
a general hot-upgrade path for every runtime fix. Full-package integrity always
covers every regular file.

Ordinary native children remain unmanaged. Router failure does not deny
ordinary root diagnostic commands; Router-owned calls still fail closed and
missing command coverage never counts as completion.

Uninstallation remains available through the existing explicit uninstall
wrapper. Stop Router processes and retain needed old task entries first;
uninstall preserves shared learning and unrelated configuration. Do not remove
the marketplace merely to update a runtime: native removal can delete old
cache paths.

Automatic routing remains opt-in (`router: global on`). Neither preparation,
publication, nor installation silently changes that setting or the root model.

## How routing works

When global automatic activation is on, the trusted `UserPromptSubmit` hook
adds a small workflow instruction to ordinary prompts. Codex then uses the
router at substantive stage boundaries without requiring a
`$adaptive-model-router` mention. Greetings and simple no-work-product prompts
still stay in the root task without creating a subagent.

Once the root creates a bounded subagent, `SubagentStart` and the subagent's
prompt hook replace that automatic instruction with a fixed isolation
instruction. The child executes only its assigned stage: it does not observe
root-model intent, change router controls, call `route_stage` again, or own the
route outcome. Verification and `record_outcome` remain in the root task.

`route_stage` returns one of four actions:

- `continue` for greetings, simple questions, and short tasks with no work product;
- `delegate` with `target.model` and `target.effort` for bounded substantive work;
- `busy` when this task already has one unresolved Router child, without creating another;
- `ask_user` when an explicit target is unavailable or the reasoning-escalation limit is reached.

Before returning an ordinary-work `delegate`, the plugin uses Codex's read-only `hooks/list`
surface to confirm that all seven Router hooks in the active installation match
the plugin definitions, are enabled, and are trusted. It separately requires a
source-owned native proof that this exact host's Agent path dispatches the full
`PreToolUse`/`PostToolUse` lifecycle. An untrusted definition returns
`HOOK_TRUST_REQUIRED`, a different set returns `HOST_HOOK_SET_MISMATCH`, an
unreadable status returns `HOST_HOOK_STATUS_UNAVAILABLE`, and a missing native
round-trip proof returns `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`. All four continue
root-only and issue no delegation ticket. The check never writes `config.toml`
or accepts hook trust for the user.

New calls are verified against their actual behavior contract. App/CLI version,
platform labels, disk executable hashes and paths are diagnostic, not a version
allowlist. A task without prior proof can first receive
`delegate / HOST_LIFECYCLE_QUALIFICATION`: exactly one policy-bound GPT-6/low child returning a
fixed marker without tools or original task content. The server independently
checks all four lifecycle events and the complete raw child transcript before
accepting its outcome. New proof is task-scoped and binds functional Hook
definitions and trust, actual entries, runtime source and required contracts.
Version/hash changes, presentation text or unrelated plugin changes do not
create another qualification child. Real functional changes still require
verification. Historical qualification and receipt bytes remain unchanged;
sufficient original evidence supports a separate adoption record without
rewriting an old result as a new-schema success.
Failed, pending, invalid, or ambiguous attempts are never automatically retried.
Qualification neither consumes a once override nor enters learning; after a
new source-verified success, route the original stage again normally.

The first installation of this change also needs explicit old-task runtime
handover; ordinary `publish` does not establish adoption. See the
[host-upgrade compatibility plan](docs/HOST-UPGRADE-COMPATIBILITY-PLAN.zh-CN.md)
and [development acceptance record](docs/evidence/host-upgrade-compatibility-20260914.zh-CN.md).
An old task without actual native entry evidence stays on its previous runtime.
Development tests do not mean the machine's global installation was changed.

Priority is: request override, once override, session override, project override, optional global override, then the quality-first model policy (default GPT-6/high). Unknown or hidden models are never chosen automatically. Explicit unavailable targets are never silently substituted.

Root visibility, bounded delegation, and auxiliary classification use separate
capability catalogs. A model shown in the Codex picker is not automatically a
valid subagent target. The caller supplies the current direct native
bounded-subagent models/efforts and invocation mode through `hostCapabilities`;
a spawn tool visible only inside `functions.exec` is treated as unavailable.
`list_agents` only reports agents that already exist, so an empty result is not
evidence that direct `spawn_agent` is unavailable. After this task has completed
a direct Router child dispatch, a later unavailable claim is rejected unless it
is tied to an actual direct-tool rejection that proves no child was created.
Missing direct interface capabilities permit no new delegation. Current routing
uses only GPT-6 at six allowed efforts, with high as the default. Conditions,
allowed models and target bindings are defined in [model-policy.json](plugins/adaptive-model-router/model-policy.json).
See [the GPT-6 specification](docs/MODEL-POLICY-GPT6.zh-CN.md) for preview, activation,
rollback and the evidence needed to select a lower or higher effort.

Every delegated route has a verification gate and one strict final outcome.
The first outcome write is accepted only after the matching `PreToolUse`
dispatch handshake consumes the route ticket; a route decision without an
attempt is not a verification result. An occupied gate returns `busy` before a
later capability claim is considered. If the root tries to finish with an
unlaunched delegated route, the Stop hook blocks the first stop and identifies
the required direct `spawn_agent` action; the hook re-entry is allowed only to
avoid an infinite Stop loop. If the ticket is still unconsumed on that guarded
re-entry, the Router marks the lifecycle ambiguous and retains the gate. It
does not create an outcome or a `no_child` claim, archive the attempt, or permit
a replacement child without authoritative no-child evidence.

The gate is released only after the matching `PostToolUse`, child terminal
observation (`SubagentStop` or explicit no-child proof), and outcome are all
present. Missing, unknown, or ambiguous lifecycle evidence after dispatch
retains the gate.
The Stop hook never fabricates an `unknown` outcome.

The auxiliary classifier uses the host's existing authenticated App Server
state and creates only an `ephemeral` thread. It never redirects
`CODEX_SQLITE_HOME` to an empty temporary store, and its redacted input remains
subject to the same deadline and circuit breaker.

`continue`, `busy`, and `ask_user` routes do not accept outcomes. See the
[tool reference](docs/TOOLS.md) for the strict route and outcome contracts, all
management tools, and the source-tree developer CLI.

## Current target and delegation history

The Codex model picker remains the root-task model and never changes to show a
bounded subagent target. The hook can observe the active root-model slug, but
not its reasoning effort; the router never switches either. A `delegate` route's
`target.model`/`target.effort` is only the bounded-stage subagent target. The
skill visibly reports that boundary and the selected action after every
`route_stage` call.

Routine notices omit debugging route IDs and show delegated stages as
`stage · model / effort`. Exact IDs remain in route records,
status/history, and diagnostics for child correlation and verification.
When the host does not expose the child's tier, the notice omits `service_tier`.
The field appears only with direct evidence for that child; an omitted tier does
not mean Fast is off and is not inferred from the parent's Fast setting.
Requested-only tier evidence is labeled as such,
not presented as the actually served tier. Reporting never changes Fast.

The first observed model in a task is a baseline. If the slug changes later,
the current and subsequent unresolved turns continue root-only. Codex asks
whether to keep the task manual or resume automatic routing. A reasoning-only
change such as Sol High to Sol Max cannot be detected by the hook.

Use either language to view current state or recent records:

```text
router: status
router: history 10
```

Chinese equivalents are `路由器：状态` and `路由器：历史 10`. History includes the
route-time root-model snapshot, commit time, action, bounded model/effort,
transition from the previous delegation, reasons, route ID, and outcome,
scoped to the current project and task. See [routing triggers and history](docs/ROUTING.md) for the task conditions and the distinction between a route decision and a root-model
switch.

## Local learning

Learning data is isolated per project in one SQLite database. Git worktrees share a project identity through their Git common directory; submodules remain separate. Raw project paths are never stored.

The GPT-6 decision policy is observe-only: legacy offsets do not affect its
work levels and new routes do not generate offset proposals. The following
legacy proposal rules remain available for historical records:

- `+5` after at least 12 eligible category outcomes across at least 4 task
  contexts, with at least 4 failed, corrected, or reasoning-retried outcomes;
- `-5` after at least 20 eligible category outcomes across at least 5 task
  contexts, with no failures, corrections, or reasoning retries;
- offsets are limited to `[-15, 15]`.

Explicit overrides, classifier-adjusted and escalated routes, unknown results,
and environment/information/tooling failures do not anchor online learning.
Every delegated route stores a prompt-free score snapshot so eligibility is
auditable after restart.

Approval and rejection both advance the evidence window. Revisions are
immutable, and repeated rollback walks backward through their parent chain.
Offline re-anchoring installs a manually confirmed, higher-version immutable
scoring profile; it never auto-approves category offsets. Shadow scoring does
not create routes or learning records. A hard risk-floor violation is the only
automatic rollback trigger.

## Controls

Only a prompt beginning exactly with `router:` or `路由器：` can change state. Examples:

```text
router: global on
router: global off
router: manual
router: auto session
router: lock gpt-6-astra high session
router: off
路由器：启用
```

Quoted commands, code blocks, negations, prefixes later in a prompt, and unknown commands are ignored.

## Development

```bash
cd plugins/adaptive-model-router
npm test
npm run validate
npm run eval
```

After using the Codex plugin cachebuster helper for a local build, run
`npm run sync-runtime-version` before validation so `runtime.json` matches the
cache version.

The runtime has no third-party dependencies. Start with the
[documentation index](docs/README.md), or go directly to
[architecture](docs/ARCHITECTURE.md), [privacy](docs/PRIVACY.md),
[troubleshooting](docs/TROUBLESHOOTING.md), [contributing](CONTRIBUTING.md), and
[security](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
