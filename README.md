# Adaptive Model Router

Adaptive Model Router is a local-first Codex plugin that decides, at meaningful task-stage boundaries, whether to keep working in the current task, ask the user, or delegate one bounded stage to an available model with a specific reasoning effort.

It does **not** hot-switch the root task model. The root remains the orchestrator and verifies any delegated work.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Tool reference](docs/TOOLS.md)

## Install

Requirements: Codex Desktop or CLI, Git, and Node.js 24.15.0 or newer. Windows 11 native PowerShell, macOS, and Linux are supported.

Codex Desktop can resolve a different `node` than an interactive shell. The plugin launcher keeps the 24.15+ requirement and discovers a qualifying runtime from `ADAPTIVE_ROUTER_NODE`, `PATH`, common Node managers, and standard Windows/macOS/Linux install locations. It never falls back to running the router on an older Node release.

The native Codex commands are the primary installation path; no remote script execution is required:

```bash
codex plugin marketplace add Neil0619/adaptive-model-router --ref stable
codex plugin add adaptive-model-router@adaptive-model-router
```

After installation, start a new task. Open `/hooks`, review the plugin-bundled
`UserPromptSubmit` and `Stop` command handlers, and trust their current
definitions. If the ChatGPT desktop app still shows stale plugin state, restart
the app and start another new task.

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
codex plugin marketplace upgrade adaptive-model-router
codex plugin add adaptive-model-router@adaptive-model-router
```

```bash
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
```

Wrapper equivalents are `./install.sh upgrade`, `./install.sh uninstall`, `.\install.ps1 -Action Upgrade`, and `.\install.ps1 -Action Uninstall`.

For Windows-specific setup and failure recovery, see
[troubleshooting](docs/TROUBLESHOOTING.md). Release maintainers should use the
[native Windows 11 smoke runbook](docs/WINDOWS_SMOKE.md), not improvise a release
test from the README.

## How routing works

`route_stage` returns one contract:

- `continue` for greetings, simple questions, and short tasks with no work product;
- `delegate` with `target.model` and `target.effort` for bounded substantive work;
- `ask_user` when an explicit target is unavailable or the reasoning-escalation limit is reached.

Priority is: request override, once override, session override, project override, optional global override, approved project policy, then the balanced default. Unknown or hidden models are never chosen automatically. Explicit unavailable targets are never silently substituted.

Every delegated route has a verification gate and one strict final outcome. Missing outcomes are reminded once by the Stop hook; on the continued stop they become `unknown`, which is excluded from learning.

`continue` and `ask_user` routes do not accept outcomes. See the
[tool reference](docs/TOOLS.md) for the strict route and outcome contracts, all
management tools, and the source-tree developer CLI.

## Current target and delegation history

The router cannot inspect or switch the root-task model; the model shown by the
Codex host remains host-managed. A `delegate` route's
`target.model`/`target.effort` is only the bounded-stage subagent target. The
skill visibly reports that boundary and the selected action after every
`route_stage` call.

Use either language to view current state or recent records:

```text
router: status
router: history 10
```

Chinese equivalents are `路由器：状态` and `路由器：历史 10`. History includes the
route commit time, action, model/effort, transition from the previous
delegation, reasons, route ID, and outcome, scoped to the current project and
task. See [routing triggers and history](docs/ROUTING.md) for the exact score
thresholds and the distinction between a route decision and a root-model
switch.

## Local learning

Learning data is isolated per project in one SQLite database. Git worktrees share a project identity through their Git common directory; submodules remain separate. Raw project paths are never stored.

Policy changes are proposals only:

- `+5` after at least 12 new category outcomes with at least 4 failed, corrected, or retried outcomes;
- `-5` after at least 20 new category outcomes with no failures, corrections, or retries;
- offsets are limited to `[-15, 15]`.

Approval and rejection both advance the evidence window. Revisions are immutable, and repeated rollback walks backward through their parent chain.

## Controls

Only a prompt beginning exactly with `router:` or `路由器：` can change state. Examples:

```text
router: lock gpt-5.6-sol high session
router: auto session
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

The runtime has no third-party dependencies. Start with the
[documentation index](docs/README.md), or go directly to
[architecture](docs/ARCHITECTURE.md), [privacy](docs/PRIVACY.md),
[troubleshooting](docs/TROUBLESHOOTING.md), [contributing](CONTRIBUTING.md), and
[security](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
