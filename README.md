# Adaptive Model Router

Adaptive Model Router is a local-first Codex plugin that decides, at meaningful task-stage boundaries, whether to keep working in the current task, ask the user, or delegate one bounded stage to an available model with a specific reasoning effort.

It does **not** hot-switch the root task model. The root remains the orchestrator and verifies any delegated work.

[中文说明](README.zh-CN.md)

## Install

Requirements: Codex Desktop or CLI, Git, and Node.js 24.15.0 or newer. Windows 11 native PowerShell, macOS, and Linux are supported.

The native Codex commands are the primary installation path; no remote script execution is required:

```bash
codex plugin marketplace add Neil0619/adaptive-model-router --ref stable
codex plugin add adaptive-model-router@adaptive-model-router
```

When Codex asks, review and trust the plugin hooks, then start a new task.

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

If a legacy `adaptive-local` installation is present, an interactive wrapper asks before removing it. Non-interactive mode stops before any mutation and prints the exact two cleanup commands. Legacy history is never added to v0.2 learning automatically.

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

## How routing works

`route_stage` returns one contract:

- `continue` for greetings, simple questions, and short tasks with no work product;
- `delegate` with `target.model` and `target.effort` for bounded substantive work;
- `ask_user` when an explicit target is unavailable or the reasoning-escalation limit is reached.

Priority is: request override, once override, session override, project override, optional global override, approved project policy, then the balanced default. Unknown or hidden models are never chosen automatically. Explicit unavailable targets are never silently substituted.

Every delegated route has a verification gate and one strict final outcome. Missing outcomes are reminded once by the Stop hook; on the continued stop they become `unknown`, which is excluded from learning.

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

The runtime has no third-party dependencies. See [architecture](docs/ARCHITECTURE.md), [privacy](docs/PRIVACY.md), [contributing](CONTRIBUTING.md), and [security](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
