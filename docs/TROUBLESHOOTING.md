# Troubleshooting

Start with the redacted `diagnose_router` tool. For source-tree development,
the equivalent command below diagnoses the current repository project:

```bash
node plugins/adaptive-model-router/scripts/codex-route.mjs doctor --context troubleshooting
```

For another project, keep that project as the working directory and invoke the
script by its absolute path.

Do not paste prompts, source files, secrets, absolute project paths, SQLite
files, or Codex credentials into a public issue.

## Plugin or tools are missing

1. Confirm the marketplace and plugin are visible:

   ```bash
   codex plugin marketplace list
   codex plugin list
   ```

2. Refresh and reinstall:

   ```bash
   codex plugin marketplace upgrade adaptive-model-router
   codex plugin add adaptive-model-router@adaptive-model-router
   ```

3. Start a new Codex task. If the ChatGPT desktop app still shows stale plugin
   state, restart the app and open another new task.

If a marketplace named `adaptive-model-router` points to a different source or
ref, the wrapper stops rather than replacing it. Inspect the marketplace list
and remove it only after confirming it belongs to this plugin.

## Hooks are installed but do not run

Plugin installation does not automatically trust command hooks. In Codex, open
`/hooks`, review the installed definitions, and trust the `UserPromptSubmit` and
`Stop` handlers. Trust is tied to the definition hash, so changed hooks require
review again.

Do not use `--dangerously-bypass-hook-trust` for normal installation or smoke
testing. Also check that hooks have not been disabled by local or managed Codex
configuration.

## Node.js is missing or too old

The router requires Node.js 24.15.0 or newer. Check both the interactive shell
and the runtime visible to Codex:

```bash
node --version
```

The launcher searches `ADAPTIVE_ROUTER_NODE`, `PATH`, common Node managers, and
standard Windows/macOS/Linux locations. Set `ADAPTIVE_ROUTER_NODE` to an
absolute qualifying executable only when Codex cannot discover the intended
runtime. The router never runs under an older Node release.

## PowerShell cannot run `install.ps1`

The primary installation path uses native `codex plugin` commands and does not
require the wrapper. If a reviewed local copy of `install.ps1` downloaded as an
archive is blocked, inspect it first and remove only that file's download mark:

```powershell
Unblock-File .\install.ps1
.\install.ps1
```

Avoid changing machine-wide execution policy solely for this plugin.

The wrapper prefers `codex.exe` or `codex.cmd`. A PowerShell-only shim without a
matching executable or command shim is rejected with exit code `2`.

## Legacy `adaptive-local` installation detected

Interactive wrappers ask before migrating the old installation. Non-interactive
mode makes no changes and prints these exact cleanup commands:

```bash
codex plugin remove adaptive-model-router@adaptive-local
codex plugin marketplace remove adaptive-local
```

Removing the old installation does not import its learning history. Supported
settings and an approved policy can be imported later with the explicitly
confirmed developer CLI described in [Tool reference](TOOLS.md#developer-cli).

## Routing returns `continue`

Inspect `reasonCodes`:

- `TRIVIAL_CONTINUE` or `NO_WORK_PRODUCT`: the stage was intentionally kept in
  the root task.
- `HOST_DELEGATION_UNAVAILABLE`: the current host cannot create the requested
  bounded subagent.
- `CATALOG_UNAVAILABLE`: no usable visible known-model catalog was available;
  the router failed open to the root task.
- `ROUTER_DISABLED`: routing is disabled at an active scope.
- `STORAGE_UNAVAILABLE`: local state failed and routing failed open.

Do not invent a model target after a fail-open result. Diagnose the catalog,
host capability, settings, or local storage first.

## Routing returns `ask_user`

Common reasons are `EXPLICIT_TARGET_UNAVAILABLE`,
`MONOTONIC_ESCALATION_UNAVAILABLE`, and `ESCALATION_LIMIT_REACHED`. The router
does not silently replace an unavailable explicit model or effort. Obtain a new
user choice, or fix model availability, before retrying.

## Classifier timed out or the circuit is open

The classifier has one eight-second total deadline. Three consecutive failures
open a ten-minute circuit breaker. Routing continues with the deterministic
local policy.

For zero classifier app-server calls, configure `classifierMode` as
`local-only` or `disabled`, or set:

```bash
ADAPTIVE_ROUTER_LOCAL_ONLY=1
```

## Outcome is rejected

`record_outcome` accepts delegated route IDs only. Use the same `contextId` as
the route, the exact verification-gate enum, an allowed status, and consistent
failure fields. Repeating an identical outcome is safe; changing an already
recorded final outcome is rejected.

## Data cleanup

Uninstalling leaves project learning data intact. To delete data, call
`clear_project_data` from the project with exact confirmation
`CLEAR_PROJECT_DATA`. It removes only that project's rows and preserves the
local HMAC salt and other projects.

For security issues, follow [SECURITY.md](../SECURITY.md) instead of opening a
public troubleshooting issue with sensitive details.
