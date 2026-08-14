# Adaptive Model Router

Adaptive Model Router is a local-first Codex plugin that decides, at meaningful task-stage boundaries, whether to keep working in the current task, ask the user, or delegate one bounded stage to an available model with a specific reasoning effort.

It does **not** hot-switch the root task model. The root remains the orchestrator and verifies any delegated work.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Tool reference](docs/TOOLS.md)

## Install

Requirements: Codex Desktop or CLI, Git, and Node.js 24.15.0 or newer. Windows 11 native PowerShell, macOS, and Linux are supported.

Codex Desktop can expose a smaller `PATH` than an interactive shell. The installer therefore materializes a qualifying absolute Node executable into the installed MCP transport and all active-platform Hook commands, then verifies those exact commands with an empty `PATH`. After startup, the plugin launcher keeps the 24.15+ requirement and discovers a qualifying runtime from `ADAPTIVE_ROUTER_NODE`, `PATH`, common Node managers, and standard Windows/macOS/Linux install locations. It never falls back to running the router on an older Node release.

If a task was created while MCP startup was broken, its native function inventory can remain frozen. Compatible upgrades keep that task usable through a verified one-call stdio bridge to the same installed MCP `tools/call`; reopening Desktop or creating a replacement task is not required.

The native Codex commands are the primary installation path; no remote script execution is required:

```bash
codex plugin marketplace add Neil0619/adaptive-model-router --ref stable
codex plugin add adaptive-model-router@adaptive-model-router
```

After installation, start a new task. Open `/hooks`, review the plugin-bundled
`SubagentStart`, `UserPromptSubmit`, and `Stop` command handlers, and trust
their current definitions. If the ChatGPT desktop app still shows stale plugin
state, restart the app and start another new task.

Automatic routing is opt-in. In that new task, send this standalone control
once to enable it for all local Codex projects sharing the same plugin data:

```text
router: global on
```

Installing or upgrading the plugin never enables this setting silently.

Optional local wrappers provide preflight checks and legacy-install detection:

```bash
./install.sh
./install.sh --patch-agents
```

```powershell
.\install.ps1
.\install.ps1 -PatchAgents
```

The wrappers do not edit `~/.codex/AGENTS.md` unless `--patch-agents` or `-PatchAgents` is explicit. The owned marker block is idempotent and can be removed without overwriting surrounding edits.

If a legacy `adaptive-local` installation is present, an interactive wrapper asks before removing it. Non-interactive mode stops before any mutation and prints the exact two cleanup commands. Legacy history is never added to the current learning window automatically.

## Upgrade and uninstall

```bash
./install.sh upgrade
```

```powershell
.\install.ps1 -Action Upgrade
```

```bash
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
```

Uninstall wrapper equivalents are `./install.sh uninstall` and `.\install.ps1 -Action Uninstall`.

The installer always verifies the immutable installed package, the registered
MCP command, and the installed MCP tool contract. On a cold first install,
after the current Hook definitions are trusted, `--verify-task-tools` on
macOS/Linux or `-VerifyTaskTools` on Windows also runs a disposable logged-in
Codex CLI task that must call `diagnose_router` and `route_stage`. On a
compatible hot upgrade, the same flag runs only pinned in-place MCP, Hook, and
stdio-bridge probes: starting a new CLI task there can make the host reconcile
the live cache. Neither result proves that an already-created Desktop task
retained or received native tools.

v0.4.0 introduces a stable launch shell for compatible runtime upgrades.
After a v0.4.x-or-newer package is installed, an already-open task can pick up
the newer compatible Hook/MCP implementation on its next invocation without
changing the root model or reopening the task. The pinned shell first checks the
candidate's shell, tool, and storage contracts, runs isolated health probes,
and atomically activates it; a failed candidate is quarantined and the previous
runtime remains active.

A compatible upgrade must use the repository wrapper. It refreshes marketplace
metadata, reloads the resulting host registration, atomically stages the
reviewed package as a new immutable sibling, and verifies that the previously
pinned MCP shell activates that exact runtime. Before marketplace refresh it
archives every verified compatible shell in a strict, atomic vault under stable
plugin data. If Codex reconciliation prunes an old host-managed cache, the
wrapper restores the indexed shell to the same immutable path before repairing
its live bridge. If reconciliation fails after pruning, restoration runs before
the failure is returned. A plugin-data SQLite transaction serializes the whole
lifecycle across installers and releases automatically if an installer exits;
index updates occur under that lock, and a valid immutable archive is never
replaced in place. Cold installation seeds the same vault. The wrapper
deliberately does not call `codex plugin add` or request plugin
re-registration. A direct `plugin add` is a cold install/replacement operation,
not a hot-upgrade primitive.

The vault contains only validated copies of the plugin package plus an index of
runtime directory names. It is outside Codex's host-managed cache, never stores
prompts or project data, and is not an alternate executable source: restored
trees must pass the current runtime, host-surface, symlink, and compatibility
checks before an atomic directory rename. An invalid index or entry fails the
upgrade closed.

The upgrade boundary is explicit:

| Operation | Existing task with native Router tools | Existing task with a frozen native inventory |
| --- | --- | --- |
| Compatible hot upgrade | Keeps its native functions and activates the compatible sibling on its next call | Keeps the same task and uses the approved stdio bridge; the upgrade does not inject native tools |
| Cold install/replacement | Review changed Hooks/contracts and start a genuinely new non-forked task | Review changed Hooks/contracts and start a genuinely new non-forked task |

The v0.3.x to v0.4.0 transition is a cold replacement because v0.3 did not
contain the stable loader. The Skill name and description remain fixed host
identity. Compatible changes to its live-read workflow body and bridge are
allowed only when the candidate declares matching
`liveWorkflowContractVersion` and `stdioBridgeContractVersion` values in the
plugin-root `compatibility.json`. Hook JSON, MCP schemas, storage semantics,
Skill identity, UI metadata, or either workflow contract changing incompatibly
must return `HOST_RELOAD_REQUIRED` before any host registration is changed.
Restarting Desktop or forking never mutates a task's native inventory; the
bridge is the continuity path for a compatible upgrade, not native-tool
injection.

For Windows-specific setup and failure recovery, see
[troubleshooting](docs/TROUBLESHOOTING.md). Release maintainers should use the
[native Windows 11](docs/WINDOWS_SMOKE.md) and
[native macOS](docs/MACOS_SMOKE.md) smoke runbooks, not improvise a release test
from the README.

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

`route_stage` returns one contract:

- `continue` for greetings, simple questions, and short tasks with no work product;
- `delegate` with `target.model` and `target.effort` for bounded substantive work;
- `ask_user` when an explicit target is unavailable or the reasoning-escalation limit is reached.

Priority is: request override, once override, session override, project override, optional global override, approved project policy, then the balanced default. Unknown or hidden models are never chosen automatically. Explicit unavailable targets are never silently substituted.

Root visibility, bounded delegation, and auxiliary classification use separate
capability catalogs. A model shown in the Codex picker is not automatically a
valid subagent target. The caller supplies the current bounded-subagent
models/efforts through `hostCapabilities`; older callers conservatively permit
only known Sol and Terra targets. When the policy prefers Luna but the host
does not expose Luna for bounded delegation, automatic routing falls back to
Terra and reports `MODEL_FAMILY_FALLBACK`. An explicit Luna target instead
returns `ask_user`.

Every delegated route has a verification gate and one strict final outcome. If
the root still omits an outcome, the Stop hook records `unknown` and allows the
user-facing reply to finish without creating a continuation prompt. Unknown
outcomes are excluded from learning.

`continue` and `ask_user` routes do not accept outcomes. See the
[tool reference](docs/TOOLS.md) for the strict route and outcome contracts, all
management tools, and the source-tree developer CLI.

## Current target and delegation history

The Codex model picker remains the root-task model and never changes to show a
bounded subagent target. The hook can observe the active root-model slug, but
not its reasoning effort; the router never switches either. A `delegate` route's
`target.model`/`target.effort` is only the bounded-stage subagent target. The
skill visibly reports that boundary and the selected action after every
`route_stage` call.

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
scoped to the current project and task. See [routing triggers and history](docs/ROUTING.md) for the exact score
thresholds and the distinction between a route decision and a root-model
switch.

## Local learning

Learning data is isolated per project in one SQLite database. Git worktrees share a project identity through their Git common directory; submodules remain separate. Raw project paths are never stored.

Policy changes are proposals only:

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
router: lock gpt-5.6-sol high session
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
